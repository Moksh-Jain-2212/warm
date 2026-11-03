// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{ensure, Context, Result};
use serde_json::{Map, Value};

use crate::core::documents::{serialized_size, StoredDocument};

const MAX_FIELDS: usize = 64;
const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
// Accounted storage includes UTF-8 payloads and conservative structural charges, not RSS.
const POSTING_BYTES: usize = 128;
const ASSOCIATION_BYTES: usize = 64;

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
enum Scalar {
    Bool(bool),
    Number(u64),
    String(String),
}

fn number(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .map(|value| if value == 0.0 { 0 } else { value.to_bits() })
}

impl Scalar {
    fn from(value: &Value) -> Option<Self> {
        match value {
            Value::Bool(value) => Some(Self::Bool(*value)),
            Value::Number(_) => number(value).map(Self::Number),
            Value::String(value) => Some(Self::String(value.clone())),
            _ => None,
        }
    }

    fn matches(&self, value: &Value) -> bool {
        match self {
            Self::Bool(expected) => value.as_bool() == Some(*expected),
            Self::Number(expected) => number(value) == Some(*expected),
            Self::String(expected) => value.as_str() == Some(expected.as_str()),
        }
    }

    fn bytes(&self) -> usize {
        match self {
            Self::Bool(_) => 1,
            Self::Number(_) => 8,
            Self::String(value) => value.len(),
        }
    }
}

fn supported_key(key: &str) -> bool {
    !matches!(
        key,
        "$and"
            | "$or"
            | "__proto__"
            | "constructor"
            | "__defineGetter__"
            | "__defineSetter__"
            | "__lookupGetter__"
            | "__lookupSetter__"
            | "hasOwnProperty"
            | "isPrototypeOf"
            | "propertyIsEnumerable"
            | "toLocaleString"
            | "toString"
            | "valueOf"
    )
}

pub(crate) struct Filter {
    fields: Vec<(String, Scalar)>,
}

impl Filter {
    pub(crate) fn parse(value: &Value) -> Result<Self> {
        let object = value
            .as_object()
            .context("native Vectra filter must be an object")?;
        ensure!(
            (1..=MAX_FIELDS).contains(&object.len()),
            "native Vectra filter requires 1..=64 fields"
        );
        for (key, value) in object {
            ensure!(supported_key(key), "unsupported native Vectra filter field");
            ensure!(
                matches!(value, Value::Bool(_) | Value::String(_)) || number(value).is_some(),
                "native Vectra filter values must be finite scalar values"
            );
        }
        serialized_size(value, super::MAX_RECORD_BYTES)?;
        Ok(Self {
            fields: object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        Scalar::from(value).expect("validated native Vectra scalar"),
                    )
                })
                .collect(),
        })
    }

    pub(crate) fn matches(&self, document: &StoredDocument) -> bool {
        let View::Fields(metadata) = view(document) else {
            return false;
        };
        self.fields.iter().all(|(key, expected)| {
            metadata
                .get(key)
                .is_some_and(|value| expected.matches(value))
        })
    }
}

enum View<'a> {
    Ordinary,
    Invalid,
    Unsupported,
    Fields(&'a Map<String, Value>),
}

fn view(document: &StoredDocument) -> View<'_> {
    if !super::is_record(document) {
        return View::Ordinary;
    }
    let Ok((_, envelope)) = super::envelope(document) else {
        return View::Invalid;
    };
    if envelope.get("warmVectraMigration").and_then(Value::as_f64) != Some(1.0) {
        return View::Invalid;
    }
    let Some(metadata) = envelope.get("metadata").and_then(Value::as_object) else {
        return View::Invalid;
    };
    match envelope.get("indexedMetadata") {
        None | Some(Value::Null) => View::Fields(metadata),
        Some(Value::Object(metadata)) => View::Fields(metadata),
        Some(_) => View::Unsupported,
    }
}

pub(crate) struct Index {
    postings: BTreeMap<(String, Scalar), BTreeSet<String>>,
    bytes: usize,
    limit: usize,
    disabled: bool,
    invalid: usize,
    unsupported: usize,
}

impl Default for Index {
    fn default() -> Self {
        Self {
            postings: BTreeMap::new(),
            bytes: 0,
            limit: MAX_INDEX_BYTES,
            disabled: false,
            invalid: 0,
            unsupported: 0,
        }
    }
}

impl Index {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            self.invalid == 0,
            "store contains a record outside the Vectra migration profile"
        );
        ensure!(self.unsupported == 0, "native Vectra filter unavailable");
        Ok(())
    }

    pub(crate) fn candidates(&self, filter: &Filter) -> Option<&BTreeSet<String>> {
        static EMPTY: BTreeSet<String> = BTreeSet::new();
        if self.disabled {
            return None;
        }
        let mut smallest: Option<&BTreeSet<String>> = None;
        for key in &filter.fields {
            let Some(ids) = self.postings.get(key) else {
                return Some(&EMPTY);
            };
            if smallest.is_none_or(|current| ids.len() < current.len()) {
                smallest = Some(ids);
            }
        }
        smallest
    }

    pub(crate) fn insert(&mut self, document: &StoredDocument) {
        let metadata = match view(document) {
            View::Ordinary => return,
            View::Invalid => {
                self.invalid = self
                    .invalid
                    .checked_add(1)
                    .expect("invalid profile count overflow");
                return;
            }
            View::Unsupported => {
                self.unsupported = self
                    .unsupported
                    .checked_add(1)
                    .expect("unsupported view count overflow");
                return;
            }
            View::Fields(metadata) => metadata,
        };
        if self.disabled {
            return;
        }
        for (field, value) in metadata {
            if !supported_key(field) {
                continue;
            }
            let Some(scalar) = Scalar::from(value) else {
                continue;
            };
            let key = (field.clone(), scalar);
            let additional = ASSOCIATION_BYTES
                .checked_add(document.id.len())
                .and_then(|bytes| {
                    if self.postings.contains_key(&key) {
                        Some(bytes)
                    } else {
                        bytes
                            .checked_add(POSTING_BYTES)
                            .and_then(|bytes| bytes.checked_add(field.len()))
                            .and_then(|bytes| bytes.checked_add(key.1.bytes()))
                    }
                });
            let Some(next) = additional
                .and_then(|bytes| self.bytes.checked_add(bytes))
                .filter(|bytes| *bytes <= self.limit)
            else {
                self.postings.clear();
                self.bytes = 0;
                self.disabled = true;
                return;
            };
            assert!(
                self.postings
                    .entry(key)
                    .or_default()
                    .insert(document.id.clone()),
                "duplicate Vectra filter association"
            );
            self.bytes = next;
        }
    }

    pub(crate) fn remove(&mut self, document: &StoredDocument) {
        let metadata = match view(document) {
            View::Ordinary => return,
            View::Invalid => {
                self.invalid = self
                    .invalid
                    .checked_sub(1)
                    .expect("invalid profile count underflow");
                return;
            }
            View::Unsupported => {
                self.unsupported = self
                    .unsupported
                    .checked_sub(1)
                    .expect("unsupported view count underflow");
                return;
            }
            View::Fields(metadata) => metadata,
        };
        if self.disabled {
            return;
        }
        for (field, value) in metadata {
            if !supported_key(field) {
                continue;
            }
            let Some(scalar) = Scalar::from(value) else {
                continue;
            };
            let key = (field.clone(), scalar);
            let ids = self
                .postings
                .get_mut(&key)
                .expect("missing Vectra filter posting");
            assert!(
                ids.remove(&document.id),
                "missing Vectra filter association"
            );
            let mut removed = ASSOCIATION_BYTES + document.id.len();
            if ids.is_empty() {
                removed += POSTING_BYTES + field.len() + key.1.bytes();
                self.postings.remove(&key);
            }
            self.bytes = self
                .bytes
                .checked_sub(removed)
                .expect("Vectra filter byte accounting underflow");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn document(id: &str, metadata: Value) -> StoredDocument {
        super::super::prepare(
            super::super::VectorRecordInput {
                id: id.into(),
                vector: vec![1.0, 0.0],
                metadata,
            },
            256,
            2,
        )
        .unwrap()
    }

    fn migration(id: &str, metadata: Value) -> StoredDocument {
        document(id, json!({"warmVectraMigration": 1, "metadata": metadata}))
    }

    fn matches(index: &Index, filter: &Value, documents: &[&StoredDocument]) -> Vec<String> {
        index.validate().unwrap();
        let filter = Filter::parse(filter).unwrap();
        documents
            .iter()
            .filter(|document| {
                index
                    .candidates(&filter)
                    .is_none_or(|ids| ids.contains(&document.id))
                    && filter.matches(document)
            })
            .map(|document| document.id.clone())
            .collect()
    }

    #[test]
    fn postings_follow_replacement_deletion_and_projection() {
        let first = migration("a", json!({"group": "x", "score": 1}));
        let second = document(
            "b",
            json!({"warmVectraMigration":1,"metadata":{"group":"hidden"},"indexedMetadata":{"group":"x","score":2}}),
        );
        let replacement = migration("a", json!({"group": "y", "score": 2}));
        let empty = document(
            "c",
            json!({"warmVectraMigration":1,"metadata":{"group":"x"},"indexedMetadata":{}}),
        );
        let mut index = Index::default();
        for document in [&first, &second, &empty] {
            index.insert(document);
        }
        assert_eq!(
            matches(&index, &json!({"group":"x"}), &[&first, &second, &empty]),
            ["a", "b"]
        );
        assert_eq!(
            matches(&index, &json!({"group":"x", "score":2}), &[&first, &second]),
            ["b"]
        );
        index.remove(&first);
        index.insert(&replacement);
        assert_eq!(
            matches(&index, &json!({"group":"x"}), &[&replacement, &second]),
            ["b"]
        );
        index.remove(&second);
        assert!(matches(&index, &json!({"group":"x"}), &[&replacement, &empty]).is_empty());
        index.remove(&replacement);
        index.remove(&empty);
        assert_eq!(index.bytes, 0);
        assert!(index.postings.is_empty());
    }

    #[test]
    fn scalar_keys_follow_javascript_numeric_identity_and_type() {
        let integer = migration("integer", json!({"n":1}));
        let float = migration("float", json!({"n":1.0}));
        let zero = migration("zero", json!({"n":-0.0}));
        let large = migration("large", json!({"n":9_007_199_254_740_993u64}));
        let boolean = migration("boolean", json!({"n":true}));
        let string = migration("string", json!({"n":"1"}));
        let null = migration("null", json!({"n":null}));
        let documents = [&integer, &float, &zero, &large, &boolean, &string, &null];
        let mut index = Index::default();
        for document in documents {
            index.insert(document);
        }
        assert_eq!(
            matches(&index, &json!({"n":1}), &documents),
            ["integer", "float"]
        );
        assert_eq!(matches(&index, &json!({"n":0.0}), &documents), ["zero"]);
        assert_eq!(
            matches(&index, &json!({"n":9_007_199_254_740_992u64}), &documents),
            ["large"]
        );
        assert_eq!(matches(&index, &json!({"n":true}), &documents), ["boolean"]);
        assert_eq!(matches(&index, &json!({"n":"1"}), &documents), ["string"]);
        assert!(matches(&index, &json!({"missing":1}), &documents).is_empty());
    }

    #[test]
    fn malformed_profiles_and_unsupported_views_survive_budget_fallback() {
        let good = migration("good", json!({"group":"x"}));
        let invalid = document("invalid", json!({"group":"x"}));
        let unsupported = document(
            "unsupported",
            json!({"warmVectraMigration":1,"metadata":{},"indexedMetadata":[]}),
        );
        let mut ordinary = invalid.clone();
        ordinary.vector_record = false;
        let mut index = Index {
            limit: 0,
            ..Default::default()
        };
        index.insert(&good);
        index.insert(&ordinary);
        assert!(index.disabled);
        index.validate().unwrap();
        index.insert(&invalid);
        assert!(index
            .validate()
            .unwrap_err()
            .to_string()
            .contains("outside the Vectra migration profile"));
        index.remove(&invalid);
        index.insert(&unsupported);
        assert_eq!(
            index.validate().unwrap_err().to_string(),
            "native Vectra filter unavailable"
        );
        index.remove(&unsupported);
        index.remove(&ordinary);
        index.validate().unwrap();
        assert_eq!(matches(&index, &json!({"group":"x"}), &[&good]), ["good"]);
    }

    #[test]
    fn budget_boundary_disables_only_derived_postings() {
        for length in [61, 62, 63] {
            let value = "v".repeat(length);
            let document = migration("a", json!({"k":value}));
            let mut index = Index {
                limit: 256,
                ..Default::default()
            };
            index.insert(&document);
            assert_eq!(index.disabled, length == 63);
            assert_eq!(matches(&index, &json!({"k":value}), &[&document]), ["a"]);
            if length == 63 {
                assert_eq!(index.bytes, 0);
                assert!(index.postings.is_empty());
            } else {
                assert_eq!(index.bytes, 194 + length);
            }
            index.remove(&document);
            assert_eq!(index.bytes, 0);
        }
    }

    #[test]
    fn filter_limits_and_unsupported_shapes_are_rejected() {
        for count in [63, 64, 65] {
            let fields: Map<String, Value> =
                (0..count).map(|i| (format!("key{i}"), json!(1))).collect();
            assert_eq!(Filter::parse(&Value::Object(fields)).is_ok(), count <= 64);
        }
        for length in [65_527, 65_528, 65_529] {
            assert_eq!(
                Filter::parse(&json!({"x":"a".repeat(length)})).is_ok(),
                length <= 65_528
            );
        }
        for value in [
            json!({}),
            json!([]),
            json!({"x":null}),
            json!({"x":{}}),
            json!({"x":[]}),
            json!({"x":{"$eq":1}}),
            json!({"$and":true}),
            json!({"constructor":1}),
            json!({"__proto__":"x"}),
        ] {
            assert!(Filter::parse(&value).is_err());
        }
        assert!(Filter::parse(&json!({"a.b":1, "":false, "$ordinary":"value"})).is_ok());
    }
}
