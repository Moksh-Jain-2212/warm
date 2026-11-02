// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use anyhow::{anyhow, ensure, Result};
use rayon::prelude::*;
use std::sync::Arc;

use super::{
    mutation::{validate_id, Mutation},
    ShardSet, WarmCore,
};
use crate::core::documents::{
    self, DocumentInput, DocumentResult, IngestOptions, SearchOptions, VectorIndexMode,
    VectorIndexStatus, VectorQueryOptions, VectorState,
};

/// Documents per `EncodeDocument` transaction of a lazy encoding pass (the journal takes at
/// most 4096 mutations per frame).
const ENCODE_BATCH: usize = 1024;
use crate::core::types::MemorizeBatchItem;

impl WarmCore {
    pub fn security_status(&self) -> serde_json::Value {
        serde_json::json!({
            "securityCompiled": cfg!(feature = "security"),
            "encryptionActive": self.config.security.encryption_enabled,
            "signingActive": self.config.security.signing_enabled,
            "auditActive": self.config.security.audit_enabled,
            "differentialPrivacyActive": self.config.privacy.dp_enabled,
            "epsilon": self.config.privacy.epsilon,
            "privacyMechanism": "clipped-full-domain-laplace-top-k",
            "embeddingSpace": self.config.embedding_space,
        })
    }

    pub fn memorize_document(&self, input: DocumentInput) -> Result<u32> {
        self.memorize_document_with(input, &IngestOptions::default())
    }

    /// [`Self::memorize_document`] with per-call options: [`IngestOptions::encode`] chooses
    /// whether the chunk hypervectors are computed now, on first vector use, or never.
    pub fn memorize_document_with(
        &self,
        input: DocumentInput,
        options: &IngestOptions,
    ) -> Result<u32> {
        #[cfg(feature = "local-models")]
        let stages = self.model_stages();
        #[cfg(all(feature = "local-models", feature = "local-embed"))]
        let mut stage_keys = None;
        #[cfg(all(feature = "local-models", not(feature = "local-embed")))]
        let stage_keys: Option<Vec<String>> = None;
        #[cfg(feature = "local-embed")]
        let input = {
            let mut input = input;
            #[cfg(feature = "local-models")]
            let model_embedder = stages.as_ref().is_some_and(|s| s.embedder.is_some());
            #[cfg(not(feature = "local-models"))]
            let model_embedder = false;
            let embedder = self.text_embedder().filter(|_| !model_embedder);
            #[cfg(feature = "local-models")]
            if let (Some(stages), Some(embedder)) = (
                stages.as_ref().filter(|stages| {
                    input.embeddings.is_none() && stages.extract_facts && stages.generator.is_some()
                }),
                embedder.as_ref(),
            ) {
                let spans = documents::chunk_spans_with(&input, options)?;
                let texts: Vec<&str> = spans
                    .iter()
                    .map(|&(start, end)| &input.text[start as usize..end as usize])
                    .collect();
                embedder.validate_inputs(&texts, crate::core::embed::EmbedKind::Passage)?;
                stage_keys = Some(
                    Self::model_fact_keys(&input, &spans, stages)?
                        .ok_or_else(|| anyhow!("enabled fact extraction produced no keys"))?,
                );
            }
            Self::embed_document_inputs(
                std::slice::from_mut(&mut input),
                options,
                embedder.as_deref(),
                #[cfg(feature = "local-models")]
                Some(std::slice::from_ref(&stage_keys)),
                #[cfg(not(feature = "local-models"))]
                None,
            )?;
            input
        };
        #[cfg(feature = "local-models")]
        if let Some(stages) = stages {
            return self.memorize_document_with_models(
                input,
                &stages,
                options,
                stage_keys.as_deref(),
            );
        }
        // The store's kept interner, as batches use: a single write otherwise stems and copies
        // every word of the document afresh. It is a pure cache; the terms do not depend on it.
        let mut memo = self.stem_memos.take();
        let document = {
            let _memo = memo.install();
            documents::prepare_with_options(
                input,
                self.dimensions,
                self.config.embedding_space.as_ref().map(|s| s.dimensions),
                None,
                self.config.text_encoder,
                options,
            )?
        };
        drop(memo);
        let count = document.chunks.len() as u32;
        self.commit(&[Mutation::Document(Arc::new(document))])?;
        Ok(count)
    }

    pub fn memorize_documents(&self, inputs: Vec<DocumentInput>) -> Result<Vec<u32>> {
        self.memorize_documents_with(inputs, &IngestOptions::default())
    }

    /// [`Self::memorize_documents`] with per-call options. Documents are prepared in parallel
    /// and committed as one transaction in input order; the encoder's per-thread memo tables
    /// are pure caches, so the stored vectors do not depend on the thread count.
    pub fn memorize_documents_with(
        &self,
        inputs: Vec<DocumentInput>,
        options: &IngestOptions,
    ) -> Result<Vec<u32>> {
        let (mutations, payload) = self.prepare_batch(inputs, options)?;
        let counts = mutations
            .iter()
            .map(|mutation| match mutation {
                Mutation::Document(document) => document.chunks.len() as u32,
                _ => unreachable!("document preparation produced a non-document mutation"),
            })
            .collect();
        self.commit_serialized(&mutations, &payload)?;
        Ok(counts)
    }

    /// The prepared documents of a batch, in input order, and their serialized journal
    /// transaction.
    pub(super) fn prepare_batch(
        &self,
        inputs: Vec<DocumentInput>,
        options: &IngestOptions,
    ) -> Result<(Vec<Mutation>, Vec<u8>)> {
        #[cfg(feature = "local-models")]
        let stages = self.model_stages();
        #[cfg(feature = "local-models")]
        let inferred_dimensions = stages
            .as_ref()
            .and_then(|stages| stages.embedder.as_ref())
            .map(|embedder| embedder.dimensions());
        #[cfg(not(feature = "local-models"))]
        let inferred_dimensions = None;
        #[cfg(feature = "local-embed")]
        let text_embedder = self.text_embedder();
        #[cfg(feature = "local-embed")]
        let inferred_dimensions =
            inferred_dimensions.or_else(|| text_embedder.as_ref().map(|e| e.dimensions()));
        let spans =
            super::document_batch::validate_inputs_with(&inputs, inferred_dimensions, options)?;
        #[cfg(all(feature = "local-models", feature = "local-embed"))]
        let stage_keys = if let (Some(stages), Some(embedder)) = (
            stages.as_ref().filter(|stages| {
                stages.embedder.is_none() && stages.extract_facts && stages.generator.is_some()
            }),
            text_embedder.as_ref(),
        ) {
            let texts: Vec<&str> = inputs
                .iter()
                .zip(&spans)
                .filter(|(input, _)| input.embeddings.is_none())
                .flat_map(|(input, spans)| {
                    spans
                        .iter()
                        .map(|&(start, end)| &input.text[start as usize..end as usize])
                })
                .collect();
            embedder.validate_inputs(&texts, crate::core::embed::EmbedKind::Passage)?;
            let mut keys = Vec::with_capacity(inputs.len());
            let mut count = 0usize;
            let mut bytes = 0usize;
            for (input, spans) in inputs.iter().zip(&spans) {
                if input.embeddings.is_some() {
                    keys.push(None);
                    continue;
                }
                let expanded = Self::model_fact_keys(input, spans, stages)?
                    .ok_or_else(|| anyhow!("enabled fact extraction produced no keys"))?;
                ensure!(expanded.len() == spans.len(), "document key count mismatch");
                count = count
                    .checked_add(expanded.len())
                    .ok_or_else(|| anyhow!("embedding input count overflow"))?;
                for key in &expanded {
                    bytes = bytes
                        .checked_add(key.len())
                        .ok_or_else(|| anyhow!("embedding input size overflow"))?;
                }
                embedder.validate_input_sizes(
                    count,
                    bytes,
                    crate::core::embed::EmbedKind::Passage,
                )?;
                keys.push(Some(expanded));
            }
            Some(keys)
        } else {
            None
        };
        #[cfg(all(feature = "local-models", not(feature = "local-embed")))]
        let stage_keys: Option<Vec<Option<Vec<String>>>> = None;
        #[cfg(feature = "local-embed")]
        let inputs = {
            let mut inputs = inputs;
            #[cfg(feature = "local-models")]
            let model_embedder = stages.as_ref().is_some_and(|s| s.embedder.is_some());
            #[cfg(not(feature = "local-models"))]
            let model_embedder = false;
            Self::embed_document_inputs(
                &mut inputs,
                options,
                text_embedder.as_deref().filter(|_| !model_embedder),
                #[cfg(feature = "local-models")]
                stage_keys.as_deref(),
                #[cfg(not(feature = "local-models"))]
                None,
            )?;
            inputs
        };
        let mutations = inputs
            .into_par_iter()
            .zip(spans)
            .enumerate()
            .map_init(
                || self.stem_memos.take(),
                |memo, (_index, (input, spans))| {
                    let _memo = memo.install();
                    #[cfg(feature = "local-models")]
                    if let Some(stages) = stages.as_deref() {
                        return self
                            .prepare_document_spans_with_models(
                                input,
                                spans,
                                stages,
                                options,
                                stage_keys.as_ref().and_then(|keys| keys[_index].as_deref()),
                            )
                            .map(|document| Mutation::Document(Arc::new(document)));
                    }
                    documents::prepare_spans(
                        input,
                        spans,
                        self.dimensions,
                        self.config.embedding_space.as_ref().map(|s| s.dimensions),
                        None,
                        self.config.text_encoder,
                        options,
                    )
                    .map(|document| Mutation::Document(Arc::new(document)))
                },
            )
            .collect::<Result<Vec<_>>>();
        // Every split has returned its interner; keep the warmest within the memory bound.
        self.stem_memos.trim();
        let mutations = mutations?;
        let payload = super::document_batch::serialize_transaction(self, &mutations)?;
        Ok((mutations, payload))
    }

    pub fn search_documents(
        &self,
        text: &str,
        options: &SearchOptions,
    ) -> Result<Vec<DocumentResult>> {
        // A text query goes through the installed model stages; a vector-only query does not.
        #[cfg(feature = "local-models")]
        if let Some(stages) = self.model_stages().filter(|_| !text.trim().is_empty()) {
            return self.search_documents_with_models(text, "", options, &stages);
        }
        #[cfg(feature = "local-embed")]
        let embedded = self
            .embed_search_text(text, options)?
            .map(|embedding| SearchOptions {
                embedding: Some(embedding),
                ..options.clone()
            });
        #[cfg(feature = "local-embed")]
        let options = embedded.as_ref().unwrap_or(options);
        let prepared = documents::prepare_search(
            text,
            options,
            self.config.embedding_space.as_ref().map(|s| s.dimensions),
        )?;
        Ok(self.run_searches(vec![prepared])?.pop().expect("one query"))
    }

    /// Captures `prepared`, ranks each query with no lock held, then reads the hits' text under
    /// the mutation gate, which excludes the writes that scrub replaced or deleted text. If a
    /// hit's text was scrubbed since the capture, the queries run again with the gate held
    /// throughout, so a result never pairs a version with empty or other text. Queries a store
    /// served from its checkpoint answers are captured from it without rebuilding the store.
    fn run_searches(
        &self,
        prepared: Vec<documents::PreparedSearch>,
    ) -> Result<Vec<Vec<DocumentResult>>> {
        let mut prepared = Some(prepared);
        let from_checkpoint = self.capture_from_checkpoint(|store| {
            let queries = prepared.as_deref().expect("queries not taken yet");
            documents::overlay_serves(store, queries).then(|| {
                documents::capture_overlaid_search(store, prepared.take().expect("taken once"))
            })
        });
        let captured = match from_checkpoint {
            Some(captured) => captured?,
            None => {
                self.hydrate_documents()?;
                let _transaction = self.mutation_gate.read();
                let prepared = prepared.expect("queries not taken");
                documents::capture_search(&self.documents.read(), prepared)
            }
        };
        let ranked: Vec<_> = (0..captured.len())
            .map(|i| documents::rank_search(&captured, i))
            .collect();
        {
            let _transaction = self.mutation_gate.read();
            let read: Option<Vec<_>> = ranked
                .into_iter()
                .enumerate()
                .map(|(i, hits)| documents::read_ranked(&captured, i, hits))
                .collect::<Result<_>>()?;
            if let Some(results) = read {
                return Ok(results);
            }
        }
        self.hydrate_documents()?;
        let _transaction = self.mutation_gate.read();
        let captured = documents::capture_search(&self.documents.read(), captured.into_prepared());
        (0..captured.len())
            .map(|i| documents::execute_search(&captured, i))
            .collect()
    }

    /// The number of documents containing at least one word of `text`: every document an
    /// unfiltered lexical [`Self::search_documents`] can return, counted exactly rather than
    /// ranked.
    pub fn count_documents(&self, text: &str) -> Result<usize> {
        self.hydrate_documents()?;
        let _transaction = self.mutation_gate.read();
        documents::count_matches(&self.documents.read(), text)
    }

    /// Executes an explicit Boolean/phrase query over one live document generation.
    pub fn search_lexical(
        &self,
        query: &documents::LexicalQuery,
        options: &documents::LexicalOptions,
    ) -> Result<documents::LexicalResults> {
        self.hydrate_documents()?;
        let _transaction = self.mutation_gate.read();
        documents::execute_lexical(&self.documents.read(), query, options)
    }

    /// Counts matching live parent documents without scoring.
    pub fn count_lexical(&self, query: &documents::LexicalQuery) -> Result<usize> {
        let result = self.search_lexical(
            query,
            &documents::LexicalOptions {
                k: 0,
                count: true,
                ..Default::default()
            },
        )?;
        Ok(result.count.expect("count requested"))
    }

    pub fn document_index_trained(&self) -> bool {
        self.documents.read().dense_index_trained()
    }

    pub fn document_embedding_count(&self) -> usize {
        self.documents.read().embedded_count()
    }

    /// Nearest embedded chunks to `embedding` by cosine, best first; `score` and
    /// `semantic_score` both carry the cosine. Unfiltered vector queries are answered from the
    /// vector snapshot (`documents::vector_index`) when one is built: the graph index under
    /// `Auto`/`Graph`, the contiguous exact scan under `Exact`. Without a snapshot, or when the
    /// snapshot is too stale for this query, the generic exact path answers. `Graph` without a
    /// graph index fails with [`documents::GraphUnavailable`]. Filters always use complete
    /// full-dimensional eligibility before ranking. Projected stale or zero-prefix queries
    /// use the full exact route.
    pub fn search_vectors(
        &self,
        embedding: &[f64],
        k: usize,
        options: &VectorQueryOptions,
    ) -> Result<Vec<DocumentResult>> {
        Ok(self
            .search_vectors_with_report(embedding, k, options)?
            .results)
    }

    /// Vector results with the route actually used, including full exact fallbacks.
    pub fn search_vectors_with_report(
        &self,
        embedding: &[f64],
        k: usize,
        options: &VectorQueryOptions,
    ) -> Result<documents::VectorSearchResults> {
        let Some(space) = &self.config.embedding_space else {
            anyhow::bail!("configure an embedding space before vector search");
        };
        ensure!(
            (1..=documents::MAX_K).contains(&k),
            "require 1 <= k <= {}",
            documents::MAX_K
        );
        ensure!(
            (1..=documents::MAX_EF).contains(&options.ef),
            "require 1 <= ef <= {}",
            documents::MAX_EF
        );
        ensure!(
            options.min_score.is_finite() && (-1.0..=1.0).contains(&options.min_score),
            "minScore must be in [-1,1]"
        );
        let normalized = documents::normalize_embedding(embedding, space.dimensions)?;
        let query: Vec<f32> = normalized.iter().map(|&value| value as f32).collect();
        let filtered = options.source_uri.is_some()
            || options.document_ids.is_some()
            || options
                .filter
                .as_ref()
                .is_some_and(|filter| filter.as_object().is_none_or(|object| !object.is_empty()));
        if !filtered {
            match self.vector_index.get() {
                Some(snapshot) => {
                    if snapshot.matches_embedding_space(space) {
                        if let Some(results) = documents::search_vector_snapshot_with_report(
                            &snapshot,
                            &self.documents,
                            &query,
                            &normalized,
                            k,
                            options,
                        )? {
                            return Ok(results);
                        }
                    }
                }
                None if options.mode == VectorIndexMode::Graph => {
                    return Err(anyhow::Error::new(documents::GraphUnavailable));
                }
                None => {
                    // First vector query over a store without a snapshot: publish one now so an
                    // unfiltered query answers from the same scan before and after maintenance
                    // (the fallback below scores `f64` rows and would differ in the last digits).
                    if self.rebuild_vector_index(documents::DEFAULT_GRAPH_MIN_ROWS)? {
                        if let Some(snapshot) = self.vector_index.get() {
                            if let Some(results) = documents::search_vector_snapshot_with_report(
                                &snapshot,
                                &self.documents,
                                &query,
                                &normalized,
                                k,
                                options,
                            )? {
                                return Ok(results);
                            }
                        }
                    }
                }
            }
        }
        let fallback = SearchOptions {
            k: Some(k as u32),
            candidate_limit: Some((k as u32).max(100)),
            embedding: Some(embedding.to_vec()),
            lexical_weight: Some(0.0),
            semantic_weight: Some(1.0),
            min_semantic_score: Some(options.min_score),
            filter: options.filter.clone(),
            source_uri: options.source_uri.clone(),
            document_ids: options.document_ids.clone(),
            ..SearchOptions::default()
        };
        let mut hits = self.search_documents("", &fallback)?;
        for hit in &mut hits {
            hit.score = hit.semantic_score.unwrap_or(hit.score);
        }
        Ok(documents::VectorSearchResults {
            results: hits,
            diagnostics: documents::VectorSearchDiagnostics {
                route: if filtered {
                    documents::VectorSearchRoute::FilteredExact
                } else {
                    documents::VectorSearchRoute::FallbackExact
                },
                candidate_dimensions: space.dimensions,
                shortlist_limit: None,
            },
        })
    }

    pub fn vector_index_status(&self) -> VectorIndexStatus {
        let snapshot = self.vector_index.get();
        documents::vector_index_status(snapshot.as_deref(), &self.documents.read())
    }

    /// Captures the embedded chunks and publishes a fresh vector snapshot, with the graph
    /// index when the store has at least `graph_min_rows` of them. `false` when the store has
    /// no embedding space or too few embedded chunks (the snapshot is dropped then), or when
    /// another build is running (the published snapshot stays). The capture holds the store's
    /// read lock; the graph build holds no lock.
    pub fn rebuild_vector_index(&self, graph_min_rows: usize) -> Result<bool> {
        if self.config.embedding_space.is_none() {
            return Ok(false);
        }
        let Some(_building) = self.vector_index.try_build() else {
            return Ok(self.vector_index.get().is_some());
        };
        self.rebuild_vector_index_locked(graph_min_rows)
    }

    /// [`Self::rebuild_vector_index`] that waits for a running build instead of keeping its
    /// result, so the snapshot published on return was captured after the call began.
    pub(super) fn rebuild_vector_index_waiting(&self, graph_min_rows: usize) -> Result<bool> {
        let _building = self.vector_index.build();
        self.rebuild_vector_index_locked(graph_min_rows)
    }

    fn rebuild_vector_index_locked(&self, graph_min_rows: usize) -> Result<bool> {
        let Some(space) = &self.config.embedding_space else {
            return Ok(false);
        };
        let capture = {
            let _transaction = self.mutation_gate.read();
            documents::capture_vector_rows(&self.documents.read(), space.dimensions)?
        };
        let Some(capture) = capture else {
            self.vector_index.clear();
            return Ok(false);
        };
        let snapshot = match &self.config.vector_candidates {
            Some(candidates) => documents::build_projected_vector_snapshot(
                capture,
                graph_min_rows,
                space,
                candidates,
            )?,
            None => documents::build_vector_snapshot(capture, graph_min_rows)?,
        };
        self.vector_index.publish(Arc::new(snapshot));
        Ok(true)
    }

    /// [`Self::rebuild_vector_index`] when the status recommends it (no snapshot over a store
    /// with enough embedded chunks, or `REBUILD_AFTER_MUTATIONS` mutations since the capture);
    /// otherwise reports whether a snapshot exists.
    pub fn maintain_vector_index(&self, graph_min_rows: usize) -> Result<bool> {
        if self.vector_index_status().rebuild_recommended {
            return self.rebuild_vector_index(graph_min_rows);
        }
        Ok(self.vector_index.get().is_some())
    }

    pub fn train_document_index(&self) -> Result<()> {
        self.encode_pending_documents()?;
        self.maintain_vector_index(documents::DEFAULT_GRAPH_MIN_ROWS)?;
        self.train_dense_index()
    }

    /// Trains and publishes the dense document index over the current embedded chunks.
    pub(super) fn train_dense_index(&self) -> Result<()> {
        let Some(space) = &self.config.embedding_space else {
            return Ok(());
        };
        let _building = self.vector_index.try_build().ok_or_else(|| {
            anyhow!("document index maintenance already in progress; retry maintenance")
        })?;
        let snapshot = {
            let _transaction = self.mutation_gate.read();
            documents::capture_dense_index(&self.documents.read(), space.dimensions)?
        };
        let Some(snapshot) = snapshot else {
            return Ok(());
        };
        let Some(trained) = documents::build_dense_index(snapshot)? else {
            return Ok(());
        };
        let published = {
            let _transaction = self.mutation_gate.read();
            documents::publish_dense_index(&mut self.documents.write(), &trained)
        };
        ensure!(
            published,
            "store changed during document index training; retry maintenance"
        );
        Ok(())
    }

    /// Encodes and persists the hypervectors of every document memorized with
    /// [`documents::EncodeMode::Deferred`] that is still awaiting them, and returns how many
    /// documents that was. Vectors are computed from the stored chunk text exactly as eager
    /// ingest computes them. Idempotent; concurrent callers serialize on the store's encode
    /// gate and the second one finds nothing left. Vector queries attempt this when the
    /// document store is available; call it explicitly to catch up before querying.
    pub fn encode_pending_documents(&self) -> Result<usize> {
        // A checkpoint holds no pending encodings, so a store served from one is read as it is
        // (its pending documents are all among those written since).
        if self.documents.read().pending_vector_count() == 0 {
            return Ok(0);
        }
        let gate = self.documents.read().encode_gate();
        let _encoding = gate.lock();
        let encoder = self.config.text_encoder;
        ensure!(
            !encoder.is_embedding(),
            "deferred encoding needs a text encoder, not {}",
            encoder.name()
        );
        // The snapshot: each pending document with the text of its pending chunks and the
        // fingerprint the installed vectors are bound to.
        let pending: Vec<(Arc<documents::StoredDocument>, u64, Vec<Option<String>>)> = {
            let _transaction = self.mutation_gate.read();
            let store = self.documents.read();
            if store.pending_vector_count() == 0 {
                return Ok(0);
            }
            let mut pending = Vec::new();
            for document in store.shared_values() {
                if !document
                    .chunks
                    .iter()
                    .any(|chunk| chunk.vector_state == VectorState::Pending)
                {
                    continue;
                }
                let mut texts = Vec::with_capacity(document.chunks.len());
                for chunk in &document.chunks {
                    texts.push(if chunk.vector_state == VectorState::Pending {
                        Some(store.try_chunk_text(chunk)?.ok_or_else(|| {
                            anyhow!(
                                "document {} awaits deferred encoding but has no stored text",
                                document.id
                            )
                        })?)
                    } else {
                        None
                    });
                }
                let fingerprint = documents::document_fingerprint(&store, &document)?
                    .ok_or_else(|| anyhow!("document {} has no stored text", document.id))?;
                pending.push((document, fingerprint, texts));
            }
            pending
        };
        let dimensions = self.dimensions;
        let mut encoded = 0;
        for batch in pending.chunks(ENCODE_BATCH) {
            let mutations: Vec<Mutation> = batch
                .par_iter()
                .map(|(document, fingerprint, texts)| {
                    let vectors = document
                        .chunks
                        .iter()
                        .zip(texts)
                        .map(|(chunk, text)| match text {
                            Some(text) => encoder.encode(text, dimensions),
                            None => chunk.vector.clone(),
                        })
                        .collect();
                    Mutation::EncodeDocument {
                        id: document.id.clone(),
                        version: document.version.clone(),
                        fingerprint: *fingerprint,
                        vectors,
                    }
                })
                .collect();
            self.commit(&mutations)?;
            encoded += batch.len();
        }
        Ok(encoded)
    }

    /// Whether this id is present, without decoding its metadata or reading retained text.
    pub fn has_document(&self, id: &str) -> bool {
        let _transaction = self.mutation_gate.read();
        self.documents.read().contains_key(id)
    }

    /// Whether the word interner built while preparing a document batch is kept for the next
    /// batch (the default). Keeping it saves re-stemming a corpus's vocabulary across batches at
    /// a cost bounded by 2^18 distinct words (tens of MB at worst); a process holding many open
    /// stores, such as a multi-tenant server, can turn it off to free each batch's interner
    /// with the batch. Turning it off frees the kept interner now.
    pub fn set_keep_ingest_interner(&self, keep: bool) {
        self.stem_memos.set_keep(keep);
    }

    /// Number of stored documents.
    pub fn document_count(&self) -> usize {
        let _transaction = self.mutation_gate.read();
        documents::count(&self.documents.read())
    }

    pub(crate) fn verified_document_count(&self) -> Result<usize> {
        self.hydrate_documents()?;
        Ok(self.document_count())
    }

    /// One document's identity, provenance and metadata without copying its stored text.
    pub fn get_document_info(&self, id: &str) -> Result<Option<documents::DocumentInfo>> {
        let _transaction = self.mutation_gate.read();
        documents::get_info(&self.documents.read(), id)
    }

    /// Up to `limit` document summaries with ids at or after `from`, in id order.
    /// This does not copy stored chunk text.
    pub fn list_document_info(
        &self,
        from: Option<&str>,
        limit: usize,
    ) -> Result<Vec<documents::DocumentInfo>> {
        let _transaction = self.mutation_gate.read();
        documents::list_info(&self.documents.read(), from, limit)
    }

    /// Reads one retained chunk without hydrating the store or holding locks during file I/O.
    /// Returns `None` for a missing document or chunk; concurrent changes may require retry.
    pub fn read_document_chunk(
        &self,
        id: &str,
        index: usize,
    ) -> Result<Option<documents::DocumentChunkRecord>> {
        self.read_document_chunk_with(id, index, || {})
    }

    fn read_document_chunk_with(
        &self,
        id: &str,
        index: usize,
        mut after_capture: impl FnMut(),
    ) -> Result<Option<documents::DocumentChunkRecord>> {
        validate_id(id)?;
        for _ in 0..3 {
            let captured = {
                let _transaction = self.mutation_gate.read();
                documents::capture_chunk(&self.documents.read(), id, index, self.revision())?
            };
            let Some(captured) = captured else {
                return Ok(None);
            };
            after_capture();
            let (identity, result) = captured.read();
            let _transaction = self.mutation_gate.read();
            if identity.is_current(&self.documents.read()) {
                return result.map(Some);
            }
        }
        Err(documents::DocumentReadChanged.into())
    }

    /// One stored document; retained-text failures are errors, not absent text.
    pub fn get_document(&self, id: &str) -> Result<Option<documents::DocumentRecord>> {
        validate_id(id)?;
        self.read_document_records(|store| {
            Ok(documents::get_record(store, id)?.into_iter().collect())
        })
        .map(|mut records| records.pop())
    }

    /// Up to `limit` stored documents with ids at or after `from`, in id order. Resume after id
    /// `X` with `from = X + "\0"` (document ids cannot contain NUL).
    /// Text is read without holding store locks; concurrent changes may require retry.
    pub fn list_documents(
        &self,
        from: Option<&str>,
        limit: usize,
    ) -> Result<Vec<documents::DocumentRecord>> {
        self.read_document_records(|store| documents::list_records(store, from, limit))
    }

    fn read_document_records(
        &self,
        capture: impl Fn(&documents::DocumentStore) -> Result<Vec<documents::CapturedDocumentRead>>,
    ) -> Result<Vec<documents::DocumentRecord>> {
        self.read_document_records_with(capture, || {})
    }

    fn read_document_records_with(
        &self,
        capture: impl Fn(&documents::DocumentStore) -> Result<Vec<documents::CapturedDocumentRead>>,
        mut after_capture: impl FnMut(),
    ) -> Result<Vec<documents::DocumentRecord>> {
        for _ in 0..3 {
            let captured = {
                let _transaction = self.mutation_gate.read();
                capture(&self.documents.read())?
            };
            after_capture();
            let reads: Vec<_> = captured.into_iter().map(|record| record.read()).collect();
            let _transaction = self.mutation_gate.read();
            let store = self.documents.read();
            if reads
                .iter()
                .all(|(identity, _)| identity.is_current(&store))
            {
                return reads.into_iter().map(|(_, result)| result).collect();
            }
        }
        Err(documents::DocumentReadChanged.into())
    }

    pub fn delete_document(&self, id: &str) -> Result<bool> {
        validate_id(id)?;
        // The store answers for a checkpoint it is served from without being rebuilt.
        let exists = self.documents.read().contains_key(id);
        self.commit(&[Mutation::DeleteDocument { id: id.into() }])?;
        Ok(exists)
    }

    /// Makes scrubbed text records durable. Deleting zeroes them in the page cache, like the
    /// journal frame that records the delete; `forget` and a scrubbing compaction call this so
    /// the zeros are on stable storage before they return.
    pub(crate) fn sync_text_segment(&self) -> Result<()> {
        let segment = self.documents.read().text_segment();
        segment.map_or(Ok(()), |segment| segment.sync())
    }

    pub(super) fn remove_document_from_memory(&self, id: &str, shards: &ShardSet) -> Result<()> {
        // A store served from a checkpoint marks a checkpoint document dead (its text leaves
        // with the checkpoint at the next compaction) without being rebuilt.
        // The chunk vectors leave with the document even when zeroing its text fails.
        let mut store = self.documents.write();
        let removed = store.remove(id);
        if let Some(old) = &removed {
            for chunk in &old.chunks {
                shards.remove(&chunk.id, self.dimensions)?;
            }
        }
        store.scrub_removed(removed).map(drop)
    }

    /// One bounded transaction; either every item is logged or none is.
    pub fn memorize_batch(&self, items: &[MemorizeBatchItem]) -> Result<()> {
        ensure!(
            !items.is_empty() && items.len() <= 4096,
            "batch requires 1..=4096 items"
        );
        ensure!(
            items
                .iter()
                .map(|item| item.id.len() + item.text.len())
                .sum::<usize>()
                <= documents::MAX_DOCUMENT_BYTES,
            "batch exceeds 8 MiB; split the input into bounded batches"
        );
        for item in items {
            super::mutation::validate_public_id(&item.id)?;
            ensure!(
                !item.id.starts_with(documents::CHUNK_PREFIX),
                "chunk IDs are reserved"
            );
        }
        let texts: Vec<_> = items.iter().map(|item| item.text.as_str()).collect();
        let vectors = self.try_encode_texts(&texts)?;
        let mutations: Vec<_> = items
            .iter()
            .zip(vectors)
            .map(|(item, vector)| Mutation::Vector {
                id: item.id.clone(),
                vector,
            })
            .collect();
        self.commit(&mutations)
    }

    pub fn query_vector(&self, dense: &[f32], k: u32) -> Result<Vec<crate::RetrievalResult>> {
        self.validate_dense(dense)?;
        let vector = crate::EntangledHVec::from_dense(dense, self.dimensions);
        self.query(&vector, k)
    }

    pub(super) fn validate_dense(&self, dense: &[f32]) -> Result<()> {
        ensure!(
            !dense.is_empty()
                && dense.len() <= 65536
                && dense.iter().all(|v| v.is_finite())
                && dense.iter().any(|&v| v != 0.0),
            "dense vectors require 1..=65536 finite values and nonzero magnitude"
        );
        if let Some(space) = &self.config.embedding_space {
            ensure!(
                dense.len() == space.dimensions,
                "dense embedding dimensions do not match the store schema"
            );
        }
        Ok(())
    }
}

#[cfg(feature = "local-models")]
impl WarmCore {
    /// Installs (or with `None` removes) the on-device model stages `memorize_document` and
    /// `search_documents` use. An embedder must match the store's embedding space.
    pub fn set_model_stages(
        &self,
        stages: Option<std::sync::Arc<crate::core::models::ModelStages>>,
    ) -> Result<()> {
        if let Some(stages) = &stages {
            stages.params.validate()?;
        }
        if let Some(e) = stages.as_ref().and_then(|s| s.embedder.as_ref()) {
            self.validate_model_embedder(e)?;
        }
        *self.model_stages.write() = stages;
        Ok(())
    }

    pub fn model_stages(&self) -> Option<std::sync::Arc<crate::core::models::ModelStages>> {
        self.model_stages.read().clone()
    }

    fn validate_model_embedder(&self, embedder: &crate::core::models::Embedder) -> Result<()> {
        ensure!(
            self.config.embedding_space.as_ref() == Some(&embedder.space()),
            "the embedder's effective model identity does not match the store embedding space; reopen with the original model or re-embed original source documents into a new store"
        );
        Ok(())
    }

    fn memorize_document_with_models(
        &self,
        input: DocumentInput,
        stages: &crate::core::models::ModelStages,
        options: &IngestOptions,
        keys: Option<&[String]>,
    ) -> Result<u32> {
        let document = self.prepare_document_with_models(input, stages, options, keys)?;
        let count = document.chunks.len() as u32;
        self.commit(&[Mutation::Document(Arc::new(document))])?;
        Ok(count)
    }

    fn prepare_document_with_models(
        &self,
        input: DocumentInput,
        stages: &crate::core::models::ModelStages,
        options: &IngestOptions,
        keys: Option<&[String]>,
    ) -> Result<documents::StoredDocument> {
        let spans = documents::chunk_spans_with(&input, options)?;
        self.prepare_document_spans_with_models(input, spans, stages, options, keys)
    }

    #[cfg(feature = "local-embed")]
    fn model_fact_keys(
        input: &DocumentInput,
        spans: &[(u32, u32)],
        stages: &crate::core::models::ModelStages,
    ) -> Result<Option<Vec<String>>> {
        let chunks: Vec<String> = spans
            .iter()
            .map(|&(start, end)| input.text[start as usize..end as usize].to_owned())
            .collect();
        stages.fact_keys(&chunks)
    }

    fn prepare_document_spans_with_models(
        &self,
        mut input: DocumentInput,
        spans: Vec<(u32, u32)>,
        stages: &crate::core::models::ModelStages,
        options: &IngestOptions,
        keys: Option<&[String]>,
    ) -> Result<documents::StoredDocument> {
        let chunks: Vec<String> = spans
            .iter()
            .map(|&(start, end)| input.text[start as usize..end as usize].to_owned())
            .collect();
        let generated_keys;
        let keys = match keys {
            Some(keys) => Some(keys),
            None => {
                generated_keys = stages.fact_keys(&chunks)?;
                generated_keys.as_deref()
            }
        };
        if let (Some(embedder), None) = (&stages.embedder, &input.embeddings) {
            let texts = keys.unwrap_or(&chunks);
            input.embeddings = Some(
                embedder
                    .embed(texts, false)?
                    .into_iter()
                    .map(|e| e.into_iter().map(f64::from).collect())
                    .collect(),
            );
        }
        documents::prepare_spans(
            input,
            spans,
            self.dimensions,
            self.config.embedding_space.as_ref().map(|s| s.dimensions),
            keys,
            self.config.text_encoder,
            options,
        )
    }

    /// Search through the model stages: the optional LLM rewrite (`today` is the date relative
    /// times resolve against), a hybrid search per query variant with on-device query
    /// embeddings, weighted RRF across variants, then the re-rank of the fused head.
    pub fn search_documents_with_models(
        &self,
        text: &str,
        today: &str,
        options: &SearchOptions,
        stages: &crate::core::models::ModelStages,
    ) -> Result<Vec<DocumentResult>> {
        stages.params.validate()?;
        let k = options.k.unwrap_or(10) as usize;
        ensure!((1..=1000).contains(&k), "require 1 <= k <= 1000");
        let pool = k.max(stages.params.rerank_n) as u32;
        let mut base_options = options.clone();
        base_options.k = Some(pool);
        base_options.lexical_weight = base_options
            .lexical_weight
            .or(Some(stages.params.lexical_weight));
        base_options.semantic_weight = base_options
            .semantic_weight
            .or(Some(stages.params.semantic_weight));
        self.validate_document_search(text, &base_options)?;
        let semantic = base_options.semantic_weight != Some(0.0);
        if semantic {
            if let (Some(embedder), None) = (&stages.embedder, &options.embedding) {
                self.validate_model_embedder(embedder)?;
            }
        }
        let variants = stages.query_variants(text, today)?;
        let embeddings = match (&stages.embedder, &options.embedding, semantic) {
            (Some(e), None, true) => {
                let queries: Vec<&str> = variants.iter().map(|v| v.0.as_str()).collect();
                Some(e.embed(&queries, true)?)
            }
            #[cfg(feature = "local-embed")]
            (None, None, true) => {
                let queries: Vec<&str> = variants.iter().map(|v| v.0.as_str()).collect();
                self.text_embedder()
                    .map(|embedder| embedder.embed_query(&queries))
                    .transpose()?
            }
            _ => None,
        };
        let mut prepared = Vec::with_capacity(variants.len());
        for (i, (query, _)) in variants.iter().enumerate() {
            let mut opts = base_options.clone();
            if let Some(e) = &embeddings {
                opts.embedding = Some(e[i].iter().copied().map(f64::from).collect());
            }
            prepared.push(documents::prepare_search(
                query,
                &opts,
                self.config.embedding_space.as_ref().map(|s| s.dimensions),
            )?);
        }
        let lists = variants
            .iter()
            .map(|(_, weight)| *weight)
            .zip(self.run_searches(prepared)?)
            .collect();
        stages.fuse(text, lists, k)
    }
}

#[cfg(test)]
mod chunk_read_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn document(version: &str) -> DocumentInput {
        serde_json::from_value(serde_json::json!({
            "id": "doc", "text": format!("text {version}"), "version": version,
            "metadata": {"version": version}
        }))
        .unwrap()
    }

    fn run(test: impl FnOnce(&WarmCore) -> Result<()> + Send + 'static) {
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let dir = tempfile::tempdir().unwrap();
            let core = WarmCore::new(256, Some(dir.path().display().to_string()), None).unwrap();
            core.memorize_document_with(
                document("old"),
                &IngestOptions {
                    encode: documents::EncodeMode::Lexical,
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(core.documents.read().get("doc").unwrap().chunks[0]
                .text_at
                .is_some());
            tx.send(test(&core)).unwrap();
        });
        let result = rx
            .recv_timeout(Duration::from_secs(30))
            .expect("chunk read worker failed or stalled");
        worker.join().unwrap();
        result.unwrap();
    }

    #[test]
    fn document_reads_retry_replacements_and_report_continuous_change() {
        run(|core| {
            let mut replaced = false;
            let records = core.read_document_records_with(
                |store| documents::list_records(store, None, 10),
                || {
                    if !replaced {
                        core.memorize_document(document("new")).unwrap();
                        replaced = true;
                    }
                },
            )?;
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].version, "new");
            assert_eq!(records[0].metadata, serde_json::json!({"version": "new"}));
            assert_eq!(records[0].text.as_deref(), Some("text new"));
            let mut attempts = 0;
            let error = core
                .read_document_records_with(
                    |store| documents::list_records(store, None, 10),
                    || {
                        attempts += 1;
                        core.memorize_document(document(&format!("v{attempts}")))
                            .unwrap();
                    },
                )
                .unwrap_err();
            assert!(error
                .downcast_ref::<documents::DocumentReadChanged>()
                .is_some());
            assert_eq!(attempts, 3);
            Ok(())
        });
    }

    #[test]
    fn document_reads_retry_deletion_without_returning_scrubbed_text() {
        run(|core| {
            let records = core.read_document_records_with(
                |store| documents::list_records(store, None, 10),
                || {
                    core.delete_document("doc").unwrap();
                },
            )?;
            assert!(records.is_empty());
            assert!(core.get_document("doc")?.is_none());
            Ok(())
        });
    }

    #[test]
    fn chunk_read_retries_replacement_without_mixing_versions() {
        run(|core| {
            let mut replaced = false;
            let chunk = core
                .read_document_chunk_with("doc", 0, || {
                    if !replaced {
                        core.memorize_document_with(
                            document("new"),
                            &IngestOptions {
                                encode: documents::EncodeMode::Lexical,
                                ..Default::default()
                            },
                        )
                        .unwrap();
                        replaced = true;
                    }
                })?
                .unwrap();
            assert_eq!(chunk.revision, core.revision().to_string());
            assert_eq!(chunk.document.version, "new");
            assert_eq!(
                chunk.document.metadata,
                serde_json::json!({"version": "new"})
            );
            assert_eq!(chunk.text.as_deref(), Some("text new"));
            Ok(())
        });
    }

    #[test]
    fn chunk_read_does_not_return_scrubbed_text_after_delete() {
        run(|core| {
            assert!(core
                .read_document_chunk_with("doc", 0, || {
                    core.delete_document("doc").unwrap();
                })?
                .is_none());
            Ok(())
        });
    }

    #[test]
    fn chunk_read_survives_text_segment_replacement_without_revision_change() {
        run(|core| {
            let before = core.revision();
            let mut compacted = false;
            let chunk = core
                .read_document_chunk_with("doc", 0, || {
                    if !compacted {
                        let _maintenance = core.mutation_gate.maintenance();
                        core.documents
                            .write()
                            .rebuild_canonical(&core.storage_path.join("documents.text"))
                            .unwrap();
                        compacted = true;
                    }
                })?
                .unwrap();
            assert_eq!(core.revision(), before);
            assert_eq!(chunk.text.as_deref(), Some("text old"));
            Ok(())
        });
    }

    #[test]
    fn chunk_read_bounds_retries_and_propagates_real_io_errors() {
        run(|core| {
            let mut version = 0;
            let error = core
                .read_document_chunk_with("doc", 0, || {
                    version += 1;
                    core.memorize_document_with(
                        document(&version.to_string()),
                        &IngestOptions {
                            encode: documents::EncodeMode::Lexical,
                            ..Default::default()
                        },
                    )
                    .unwrap();
                })
                .unwrap_err();
            assert!(error.is::<documents::DocumentReadChanged>());
            assert_eq!(version, 3);
            std::fs::OpenOptions::new()
                .write(true)
                .open(core.storage_path.join("documents.text"))?
                .set_len(8)?;
            let error = core.read_document_chunk("doc", 0).unwrap_err();
            assert!(format!("{error:#}").contains("reading chunk text"));
            Ok(())
        });
    }
    #[test]
    fn chunk_read_reports_a_scrubbed_live_record_as_corrupt_not_empty() {
        run(|core| {
            let (segment, at, len) = {
                let store = core.documents.read();
                let (at, len, _) = store.get("doc").unwrap().chunks[0].text_at.unwrap();
                (store.text_segment().unwrap(), at, len)
            };
            segment.scrub(at, len)?;
            let error = core.read_document_chunk("doc", 0).unwrap_err();
            assert!(error.to_string().contains("text length disagrees"));
            Ok(())
        });
    }
}
