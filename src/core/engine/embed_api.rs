// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

//! The local embedder in the engine (feature `local-embed`): with an embedder installed,
//! `memorize_document(s)` embeds chunks that arrive without embeddings and `search_documents`
//! embeds text queries that arrive without one. With `TextEncoder::LocalEmbedV1` the sparse
//! vectors of `encode_text` and of stored chunks are sketches of the same embeddings.

use anyhow::{ensure, Result};
use std::sync::Arc;

use super::WarmCore;
use crate::core::config::WarmConfig;
use crate::core::documents::{self, DocumentInput, IngestOptions, SearchOptions};
use crate::core::embed::Embedder;
use crate::core::encoding::TextEncoder;
use crate::core::entangled::EntangledHVec;

/// Builds the embedder `TextEncoder::LocalEmbedV1` needs and fills in the store embedding space.
pub(super) fn prepare(mut config: WarmConfig) -> Result<(WarmConfig, Option<Arc<Embedder>>)> {
    if config.text_encoder != TextEncoder::LocalEmbedV1 {
        return Ok((config, None));
    }
    let embedder = Arc::new(Embedder::new(
        &config.local_embed.clone().unwrap_or_default(),
    )?);
    match &config.embedding_space {
        None => config.embedding_space = Some(embedder.space()),
        Some(space) => check_space(space, &embedder)?,
    }
    Ok((config, Some(embedder)))
}

fn check_space(space: &crate::core::EmbeddingSpace, embedder: &Embedder) -> Result<()> {
    ensure!(
        *space == embedder.space(),
        "the store embedding space ({} {} {}d) does not match the embedder ({} {} {}d)",
        space.model,
        space.revision,
        space.dimensions,
        embedder.space().model,
        embedder.space().revision,
        embedder.dimensions()
    );
    Ok(())
}

impl WarmCore {
    /// Installs (or with `None` removes) the embedder used by the document API. The store's
    /// embedding space must be the embedder's own (`Embedder::space`).
    pub fn set_text_embedder(&self, embedder: Option<Arc<Embedder>>) -> Result<()> {
        match &embedder {
            Some(e) => match &self.config.embedding_space {
                Some(space) => check_space(space, e)?,
                None => anyhow::bail!(
                    "configure the store embedding space with Embedder::space() before installing an embedder"
                ),
            },
            None => ensure!(
                self.config.text_encoder != TextEncoder::LocalEmbedV1,
                "the local-embed-v1 text encoder cannot run without its embedder"
            ),
        }
        *self.text_embedder.write() = embedder;
        Ok(())
    }

    pub fn text_embedder(&self) -> Option<Arc<Embedder>> {
        self.text_embedder.read().clone()
    }

    pub(super) fn encode_texts_with_embedder(&self, texts: &[&str]) -> Result<Vec<EntangledHVec>> {
        let embedder = self
            .text_embedder()
            .ok_or_else(|| anyhow::anyhow!("local text encoder has no installed embedder"))?;
        embedder.validate_inputs(texts, crate::core::embed::EmbedKind::Passage)?;
        let nonempty: Vec<_> = texts
            .iter()
            .copied()
            .enumerate()
            .filter(|(_, text)| !text.trim().is_empty())
            .collect();
        let inputs: Vec<_> = nonempty.iter().map(|(_, text)| *text).collect();
        let embedded = if inputs.is_empty() {
            Vec::new()
        } else {
            embedder.embed_passages(&inputs)?
        };
        let mut vectors =
            vec![EntangledHVec::from_indices(Vec::new(), self.dimensions); texts.len()];
        for ((index, _), dense) in nonempty.into_iter().zip(embedded) {
            vectors[index] = EntangledHVec::from_dense(&dense, self.dimensions);
        }
        Ok(vectors)
    }

    /// Fills `embeddings` of every input that has none, embedding all their chunks in one pass.
    pub(super) fn embed_document_inputs(
        inputs: &mut [DocumentInput],
        options: &IngestOptions,
        embedder: Option<&Embedder>,
        keys: Option<&[Option<Vec<String>>]>,
    ) -> Result<()> {
        let Some(embedder) = embedder else {
            return Ok(());
        };
        let mut texts: Vec<&str> = Vec::new();
        let mut spans = Vec::with_capacity(inputs.len());
        if let Some(keys) = keys {
            ensure!(keys.len() == inputs.len(), "document key count mismatch");
        }
        for (index, input) in inputs.iter().enumerate() {
            if input.embeddings.is_some() {
                spans.push(None);
                continue;
            }
            let start = texts.len();
            if let Some(keys) = keys.and_then(|keys| keys[index].as_ref()) {
                ensure!(
                    keys.len() == documents::chunk_spans_with(input, options)?.len(),
                    "document key count does not match its chunks"
                );
                texts.extend(keys.iter().map(String::as_str));
            } else {
                texts.extend(
                    documents::chunk_spans_with(input, options)?
                        .into_iter()
                        .map(|(start, end)| &input.text[start as usize..end as usize]),
                );
            }
            spans.push(Some(start..texts.len()));
        }
        if texts.is_empty() {
            return Ok(());
        }
        let vectors = embedder.embed_passages(&texts)?;
        for (input, span) in inputs.iter_mut().zip(spans) {
            if let Some(span) = span {
                input.embeddings = Some(
                    vectors[span]
                        .iter()
                        .map(|v| v.iter().copied().map(f64::from).collect())
                        .collect(),
                );
            }
        }
        Ok(())
    }

    /// The query embedding for a text search that carries none, when an embedder is installed.
    pub(super) fn embed_search_text(
        &self,
        text: &str,
        options: &SearchOptions,
    ) -> Result<Option<Vec<f64>>> {
        if options.embedding.is_some() || text.trim().is_empty() {
            return Ok(None);
        }
        let Some(embedder) = self.text_embedder() else {
            return Ok(None);
        };
        let v = embedder.embed_query(&[text])?;
        Ok(Some(v[0].iter().copied().map(f64::from).collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::embed::testing::write_tiny;
    use crate::core::embed::{EmbedOptions, Pooling, Quantization};
    use serde_json::json;

    #[test]
    fn document_embedding_uses_expanded_keys_and_preserves_supplied_vectors() -> Result<()> {
        let directory = tempfile::tempdir()?;
        let (pack, sha) = write_tiny(directory.path(), Quantization::F32, Pooling::Mean);
        let embedder = Embedder::from_pack(&pack, Some(&sha), &EmbedOptions::default())?;
        let document = |id| serde_json::from_value(json!({"id": id, "text": "cat"}));
        let mut inputs: Vec<DocumentInput> = vec![document("expanded")?, document("raw")?];
        let keys = vec![Some(vec!["dog cat".to_string()]), None];
        WarmCore::embed_document_inputs(
            &mut inputs,
            &IngestOptions::default(),
            Some(&embedder),
            Some(&keys),
        )?;
        let expected = embedder.embed_passages(&["dog cat", "cat"])?;
        for (input, vector) in inputs.iter().zip(expected) {
            assert_eq!(
                input.embeddings.as_ref().unwrap()[0],
                vector.into_iter().map(f64::from).collect::<Vec<_>>()
            );
        }
        assert_ne!(inputs[0].embeddings, inputs[1].embeddings);
        let supplied = inputs[0].embeddings.clone();
        WarmCore::embed_document_inputs(
            &mut inputs,
            &IngestOptions::default(),
            Some(&embedder),
            Some(&keys),
        )?;
        assert_eq!(inputs[0].embeddings, supplied);
        let mut invalid = vec![document("invalid")?];
        assert!(WarmCore::embed_document_inputs(
            &mut invalid,
            &IngestOptions::default(),
            Some(&embedder),
            Some(&[Some(vec!["one".into(), "two".into()])]),
        )
        .is_err());
        assert!(invalid[0].embeddings.is_none());
        Ok(())
    }
}
