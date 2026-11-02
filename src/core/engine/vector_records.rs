// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use super::{
    mutation::{validate_public_id, Mutation},
    WarmCore,
};
use crate::core::documents::{self, VectorIndexMode, VectorQueryOptions};
use crate::core::vector_records::{self as records, *};
use anyhow::{ensure, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

const MAX_TRANSACTION_BYTES: usize = 32 * 1024 * 1024;
const MAX_BATCH_METADATA: usize = 8 * 1024 * 1024;
const MAX_EMBEDDING_VALUES: usize = 1_048_576;

impl WarmCore {
    fn vector_record_revision(&self, revision: u64) -> String {
        let instance: String = self
            .vector_record_instance
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("vr1:{instance}:{revision:016x}")
    }

    fn check_vector_record_revision(&self, expected: Option<&str>) -> Result<u64> {
        let revision = self.revision();
        if expected.is_some_and(|expected| {
            expected.len() != 53 || expected != self.vector_record_revision(revision)
        }) {
            return Err(VectorRecordRevisionConflict.into());
        }
        Ok(revision)
    }

    fn require_vector_records(&self) -> Result<usize> {
        ensure!(self.schema >= crate::core::format::VECTOR_RECORDS_SCHEMA_VERSION,
            "vector records require store schema 7; create with vectorRecords or use warm-format upgrade to create an upgraded copy");
        self.config
            .embedding_space
            .as_ref()
            .map(|space| space.dimensions)
            .ok_or_else(|| anyhow::anyhow!("vector records require an embedding space"))
    }

    pub fn mutate_vector_records(
        &self,
        operations: Vec<VectorRecordOperation>,
        options: &VectorRecordRevisionOptions,
    ) -> Result<VectorRecordMutationResult> {
        let embedding_dimensions = self.require_vector_records()?;
        ensure!(
            (1..=documents::MAX_BATCH_ITEMS).contains(&operations.len()),
            "vector record transaction requires 1..=4096 operations"
        );
        let mut mutations = Vec::with_capacity(operations.len());
        let mut metadata_bytes = 0usize;
        let mut embedding_values = 0usize;
        let mut id_bytes = 0usize;
        for operation in &operations {
            let (id, record) = match operation {
                VectorRecordOperation::Insert { record }
                | VectorRecordOperation::Upsert { record } => (&record.id, Some(record)),
                VectorRecordOperation::Delete { id } => (id, None),
            };
            validate_public_id(id)?;
            ensure!(
                id.len() <= u16::MAX as usize - "hms:chunk::0".len(),
                "vector record ID exceeds chunk ID bound"
            );
            id_bytes = id_bytes
                .checked_add(id.len())
                .filter(|&n| n <= MAX_BATCH_METADATA)
                .ok_or_else(|| anyhow::anyhow!("vector record batch ID bytes exceed 8 MiB"))?;
            if let Some(record) = record {
                documents::serialized_size(&record.metadata, MAX_RECORD_BYTES)?;
                embedding_values = embedding_values
                    .checked_add(record.vector.len())
                    .filter(|&n| n <= MAX_EMBEDDING_VALUES)
                    .ok_or_else(|| {
                        anyhow::anyhow!("vector record batch exceeds 1048576 embedding values")
                    })?;
                let document =
                    records::prepare(record.clone(), self.dimensions, embedding_dimensions)?;
                metadata_bytes = metadata_bytes
                    .checked_add(documents::serialized_size(
                        &document.metadata,
                        MAX_RECORD_BYTES,
                    )?)
                    .filter(|&n| n <= MAX_BATCH_METADATA)
                    .ok_or_else(|| anyhow::anyhow!("vector record batch metadata exceeds 8 MiB"))?;
                mutations.push(Mutation::Document(Arc::new(document)));
            } else {
                mutations.push(Mutation::DeleteDocument { id: id.clone() });
            }
        }
        let payload = self.transaction_payload(&mutations)?;
        ensure!(
            payload.len() <= MAX_TRANSACTION_BYTES,
            "vector record transaction exceeds 32 MiB"
        );
        self.hydrate_documents()?;
        let (revision, outcomes) = self.commit_serialized_checked(&mutations, &payload, || {
            self.check_vector_record_revision(options.if_revision.as_deref())?;
            let store = self.documents.read();
            let mut staged: BTreeMap<&str, bool> = BTreeMap::new();
            let mut outcomes = Vec::with_capacity(operations.len());
            for operation in &operations {
                let (op, id) = match operation {
                    VectorRecordOperation::Insert { record } => ("insert", record.id.as_str()),
                    VectorRecordOperation::Upsert { record } => ("upsert", record.id.as_str()),
                    VectorRecordOperation::Delete { id } => ("delete", id.as_str()),
                };
                let exists = if let Some(exists) = staged.get(id) {
                    *exists
                } else {
                    let previous = store.get(id);
                    ensure!(
                        previous.is_none_or(|document| records::is_record(document)),
                        "vector record ID belongs to an ordinary document"
                    );
                    previous.is_some()
                };
                ensure!(
                    op != "insert" || !exists,
                    "vector record insert requires an absent ID"
                );
                staged.insert(id, op != "delete");
                outcomes.push(VectorRecordOutcome {
                    op: op.into(),
                    id: id.into(),
                    created: (op != "delete").then_some(!exists),
                    deleted: (op == "delete").then_some(exists),
                });
            }
            Ok(outcomes)
        })?;
        Ok(VectorRecordMutationResult {
            revision: self.vector_record_revision(revision),
            outcomes,
        })
    }

    pub fn get_vector_record(
        &self,
        id: &str,
        options: &VectorRecordRevisionOptions,
    ) -> Result<VectorRecordGetResult> {
        self.require_vector_records()?;
        validate_public_id(id)?;
        self.hydrate_documents()?;
        let _read = self.mutation_gate.read();
        let revision = self.check_vector_record_revision(options.if_revision.as_deref())?;
        let store = self.documents.read();
        let record = store
            .get(id)
            .filter(|document| records::is_record(document))
            .map(|document| read_input(document))
            .transpose()?;
        Ok(VectorRecordGetResult {
            revision: self.vector_record_revision(revision),
            record,
        })
    }

    /// `from` is inclusive; pass `nextFrom` unchanged to continue the same revision.
    pub fn list_vector_records(
        &self,
        options: &VectorRecordListOptions,
    ) -> Result<VectorRecordListResult> {
        self.require_vector_records()?;
        let limit = options.limit.unwrap_or(100.0);
        ensure!(
            limit.is_finite() && limit.fract() == 0.0 && (1.0..=1000.0).contains(&limit),
            "limit must be an integer in 1..=1000"
        );
        if let Some(from) = &options.from {
            validate_public_id(from)?;
        }
        self.hydrate_documents()?;
        let _read = self.mutation_gate.read();
        let revision = self.check_vector_record_revision(options.if_revision.as_deref())?;
        let store = self.documents.read();
        let mut documents = store
            .shared_values_from(options.from.as_deref().unwrap_or(""))
            .filter(|document| records::is_record(document));
        let records = documents
            .by_ref()
            .take(limit as usize)
            .map(|document| records::read(&document, options.include_vectors.unwrap_or(true)))
            .collect::<Result<Vec<_>>>()?;
        let next_from = documents.next().map(|document| document.id.clone());
        Ok(VectorRecordListResult {
            revision: self.vector_record_revision(revision),
            records,
            next_from,
        })
    }

    pub fn query_vector_records(
        &self,
        vector: &[f64],
        k: usize,
        options: &VectorRecordQueryOptions,
    ) -> Result<VectorRecordQueryResult> {
        self.require_vector_records()?;
        let mode = options
            .mode
            .as_deref()
            .map_or(Some(VectorIndexMode::Exact), VectorIndexMode::parse)
            .ok_or_else(|| anyhow::anyhow!("mode must be exact, auto or graph"))?;
        let ef = options.ef.unwrap_or(documents::DEFAULT_EF as f64);
        ensure!(
            ef.is_finite() && ef.fract() == 0.0 && (1.0..=documents::MAX_EF as f64).contains(&ef),
            "ef must be an integer in 1..=4096"
        );
        let requested = options
            .document_ids
            .as_ref()
            .map(|ids| {
                let mut bytes = 0usize;
                ensure!(
                    ids.len() <= MAX_EMBEDDING_VALUES,
                    "vector record eligibility exceeds 1048576 IDs"
                );
                let mut unique = BTreeSet::new();
                for id in ids {
                    validate_public_id(id)?;
                    bytes = bytes
                        .checked_add(id.len())
                        .filter(|&n| n <= MAX_BATCH_METADATA)
                        .ok_or_else(|| {
                            anyhow::anyhow!("vector record eligibility exceeds 8 MiB")
                        })?;
                    ensure!(
                        unique.insert(id.as_str()),
                        "vector record eligibility IDs must be unique"
                    );
                }
                Ok(unique)
            })
            .transpose()?;
        self.hydrate_documents()?;
        for attempt in 0..3 {
            let (revision, document_ids) = {
                let _read = self.mutation_gate.read();
                let revision = self.check_vector_record_revision(options.if_revision.as_deref())?;
                let store = self.documents.read();
                let ids = match &requested {
                    None if store.only_vector_records() => None,
                    Some(ids) if ids.len() < documents::count(&store) => Some(
                        ids.iter()
                            .filter(|id| {
                                store
                                    .get(id)
                                    .is_some_and(|document| records::is_record(document))
                            })
                            .map(|id| (*id).to_owned())
                            .collect::<Vec<_>>(),
                    ),
                    _ => Some(
                        store
                            .shared_values()
                            .filter_map(|document| {
                                (records::is_record(&document)
                                    && requested
                                        .as_ref()
                                        .is_none_or(|ids| ids.contains(document.id.as_str())))
                                .then(|| document.id.clone())
                            })
                            .collect::<Vec<_>>(),
                    ),
                };
                (revision, ids)
            };
            let found = self.search_vectors_with_report(
                vector,
                k,
                &VectorQueryOptions {
                    mode,
                    ef: ef as usize,
                    min_score: options.min_score.unwrap_or(-1.0),
                    document_ids,
                    ..Default::default()
                },
            )?;
            #[cfg(test)]
            tests::after_ranking();
            let _read = self.mutation_gate.read();
            if revision != self.revision() {
                if options.if_revision.is_some() || attempt == 2 {
                    return Err(VectorRecordRevisionConflict.into());
                }
                continue;
            }
            let store = self.documents.read();
            let mut results = Vec::with_capacity(found.results.len());
            for hit in found.results {
                let document = store.get(&hit.document_id).ok_or_else(|| {
                    anyhow::anyhow!("ranked vector record disappeared without a revision change")
                })?;
                ensure!(
                    records::is_record(document),
                    "ranked result is not a vector record"
                );
                results.push(VectorRecordHit {
                    item: read_input(document)?,
                    score: hit.score,
                });
            }
            return Ok(VectorRecordQueryResult {
                revision: self.vector_record_revision(revision),
                results,
                diagnostics: found.diagnostics,
            });
        }
        unreachable!("last changed attempt returns conflict")
    }
}

fn read_input(document: &documents::StoredDocument) -> Result<VectorRecordInput> {
    let record = records::read(document, true)?;
    Ok(VectorRecordInput {
        id: record.id,
        vector: record.vector.expect("requested vector"),
        metadata: record.metadata,
    })
}

#[cfg(test)]
mod tests;
