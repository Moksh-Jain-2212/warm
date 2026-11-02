// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

//! Native vector records preserve the caller's finite f64 values separately from the normalized
//! search embedding. The versioned envelope is internal and shares the 64 KiB metadata budget.

use anyhow::{ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::documents::{Embedding, StoredChunk, StoredDocument, VectorState};

pub const MAX_RECORD_BYTES: usize = 64 * 1024;
pub(crate) const VERSION: &str = "warm-vector-record-v1";
const ENVELOPE: &str = "$warm_vector_record";

#[cfg_attr(feature = "node-api", napi_derive::napi(object))]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorRecordInput {
    pub id: String,
    pub vector: Vec<f64>,
    #[cfg_attr(feature = "node-api", napi(ts_type = "Record<string, unknown>"))]
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum VectorRecordOperation {
    Insert { record: VectorRecordInput },
    Upsert { record: VectorRecordInput },
    Delete { id: String },
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object))]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorRecordRevisionOptions {
    pub if_revision: Option<String>,
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object))]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorRecordListOptions {
    pub from: Option<String>,
    pub limit: Option<f64>,
    pub if_revision: Option<String>,
    pub include_vectors: Option<bool>,
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object))]
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VectorRecordQueryOptions {
    pub document_ids: Option<Vec<String>>,
    pub if_revision: Option<String>,
    pub min_score: Option<f64>,
    pub mode: Option<String>,
    pub ef: Option<f64>,
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorRecordOutcome {
    pub op: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object))]
#[derive(Clone, Debug, Serialize)]
pub struct VectorRecordMutationResult {
    pub revision: String,
    pub outcomes: Vec<VectorRecordOutcome>,
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object, use_nullable = true))]
#[derive(Clone, Debug, Serialize)]
pub struct VectorRecordGetResult {
    pub revision: String,
    #[cfg_attr(feature = "node-api", napi(ts_type = "VectorRecordInput"))]
    pub record: Option<VectorRecordInput>,
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object))]
#[derive(Clone, Debug, Serialize)]
pub struct ListedVectorRecord {
    pub id: String,
    #[cfg_attr(feature = "node-api", napi(ts_type = "Record<string, unknown>"))]
    pub metadata: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector: Option<Vec<f64>>,
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object, use_nullable = true))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorRecordListResult {
    pub revision: String,
    pub records: Vec<ListedVectorRecord>,
    #[cfg_attr(feature = "node-api", napi(ts_type = "string"))]
    pub next_from: Option<String>,
}

#[cfg_attr(feature = "node-api", napi_derive::napi(object))]
#[derive(Clone, Debug, Serialize)]
pub struct VectorRecordHit {
    pub item: VectorRecordInput,
    pub score: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct VectorRecordQueryResult {
    pub revision: String,
    pub results: Vec<VectorRecordHit>,
    pub diagnostics: super::documents::VectorSearchDiagnostics,
}

#[derive(Debug, thiserror::Error)]
#[error("vector record revision conflict: the store instance or revision changed")]
pub struct VectorRecordRevisionConflict;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    f64le: String,
    metadata: Value,
}

pub(crate) fn is_record(document: &StoredDocument) -> bool {
    document.vector_record
}

fn envelope(document: &StoredDocument) -> Result<Envelope> {
    ensure!(document.version == VERSION, "invalid vector record version");
    ensure!(
        document
            .metadata
            .as_object()
            .is_some_and(|object| object.len() == 1),
        "invalid vector record envelope"
    );
    super::documents::serialized_size(&document.metadata, MAX_RECORD_BYTES)?;
    let envelope: Envelope = serde_json::from_value(
        document
            .metadata
            .get(ENVELOPE)
            .context("missing vector record envelope")?
            .clone(),
    )?;
    ensure!(
        envelope.version == 1 && envelope.metadata.is_object(),
        "invalid vector record envelope version or metadata"
    );
    Ok(envelope)
}

pub(crate) fn read(document: &StoredDocument, include_vector: bool) -> Result<ListedVectorRecord> {
    let envelope = envelope(document)?;
    let vector = if include_vector {
        let bytes = STANDARD.decode(envelope.f64le)?;
        ensure!(
            !bytes.is_empty() && bytes.len() % 8 == 0,
            "invalid vector record f64 byte length"
        );
        let values: Vec<_> = bytes
            .as_chunks::<8>()
            .0
            .iter()
            .map(|bytes| f64::from_le_bytes(*bytes))
            .collect();
        ensure!(
            values.iter().all(|value| value.is_finite()),
            "vector record values must be finite"
        );
        Some(values)
    } else {
        None
    };
    Ok(ListedVectorRecord {
        id: document.id.clone(),
        metadata: envelope.metadata,
        vector,
    })
}

pub(crate) fn prepare(
    record: VectorRecordInput,
    dimensions: usize,
    embedding_dimensions: usize,
) -> Result<StoredDocument> {
    ensure!(
        record.metadata.is_object(),
        "vector record metadata must be an object"
    );
    ensure!(
        record.vector.len() <= MAX_RECORD_BYTES / 8,
        "vector record exceeds 64 KiB envelope limit"
    );
    let normalized = super::documents::normalize_embedding(&record.vector, embedding_dimensions)?;
    let bytes: Vec<_> = record
        .vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    let metadata = serde_json::json!({(ENVELOPE): Envelope { version: 1, f64le: STANDARD.encode(bytes), metadata: record.metadata }});
    super::documents::serialized_size(&metadata, MAX_RECORD_BYTES)?;
    Ok(StoredDocument {
        vector_record: true,
        id: record.id.clone(),
        source_uri: None,
        version: VERSION.into(),
        metadata,
        chunks: vec![StoredChunk {
            id: format!("hms:chunk:{}:0", record.id),
            text: None,
            text_at: None,
            start_byte: 0,
            end_byte: 0,
            vector: super::entangled::EntangledHVec {
                dim: dimensions,
                indices: Vec::new(),
            },
            embedding: Some(Embedding::from_f32(
                normalized.into_iter().map(|value| value as f32).collect(),
            )),
            terms: Default::default(),
            word_count: 0,
            stemmed: false,
            vector_state: VectorState::Lexical,
        }],
    })
}

pub(crate) fn validate(
    document: &StoredDocument,
    dimensions: usize,
    embedding_dimensions: Option<usize>,
) -> Result<()> {
    ensure!(
        document.vector_record
            && !document.id.is_empty()
            && document.id.len() <= u16::MAX as usize - 12
            && !document.id.contains('\0')
            && !document.id.starts_with("hms:chunk:")
            && !document.id.starts_with("hms:meaning:"),
        "invalid vector record identity"
    );
    let record = read(document, true)?;
    let vector = record.vector.expect("requested vector");
    let expected = prepare(
        VectorRecordInput {
            id: record.id,
            vector,
            metadata: record.metadata,
        },
        dimensions,
        embedding_dimensions.unwrap_or_else(|| {
            document
                .chunks
                .first()
                .and_then(|chunk| chunk.embedding.as_ref())
                .map_or(0, |embedding| embedding.len())
        }),
    )?;
    ensure!(
        document.source_uri.is_none() && document.chunks.len() == 1,
        "vector records require exactly one chunk and no source URI"
    );
    let chunk = &document.chunks[0];
    let reference = &expected.chunks[0];
    ensure!(
        chunk.id == reference.id
            && chunk.text.is_none()
            && chunk.text_at.is_none()
            && chunk.start_byte == 0
            && chunk.end_byte == 0
            && chunk.vector.dim == dimensions
            && chunk.vector.indices.is_empty()
            && chunk.vector_state == VectorState::Lexical
            && chunk.terms.is_empty()
            && chunk.word_count == 0
            && !chunk.stemmed
            && chunk.embedding.as_ref().is_some_and(|values| values
                .iter()
                .map(|v| v.to_bits())
                .eq(reference
                    .embedding
                    .as_ref()
                    .unwrap()
                    .iter()
                    .map(|v| v.to_bits()))),
        "invalid vector-only record shape or normalized embedding"
    );
    Ok(())
}
