use super::*;
use serde_json::json;
use std::sync::Barrier;

mod vectra_filter;

fn config() -> crate::core::WarmConfig {
    crate::core::WarmConfig {
        vector_records: true,
        embedding_space: Some(crate::EmbeddingSpace {
            model: "vector-record-test".into(),
            revision: "1".into(),
            dimensions: 3,
            normalization: "l2".into(),
            metric: "cosine".into(),
        }),
        ..Default::default()
    }
}

fn open(path: &std::path::Path) -> Result<WarmCore> {
    WarmCore::new(256, Some(path.display().to_string()), Some(config()))
}

fn record(id: &str) -> VectorRecordInput {
    VectorRecordInput {
        id: id.into(),
        vector: vec![-0.0, 0.1, f64::MIN_POSITIVE],
        metadata: json!({"category":"a", "$warm_vector_record":"user-owned"}),
    }
}

fn upsert(core: &WarmCore, item: VectorRecordInput) -> Result<VectorRecordMutationResult> {
    core.mutate_vector_records(
        vec![VectorRecordOperation::Upsert { record: item }],
        &Default::default(),
    )
}

#[test]
fn ordered_operations_round_trip_original_bits_without_text_or_hdc() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = open(root.path())?;
    let input = record("a");
    let committed = core.mutate_vector_records(
        vec![
            VectorRecordOperation::Insert {
                record: input.clone(),
            },
            VectorRecordOperation::Upsert {
                record: input.clone(),
            },
            VectorRecordOperation::Delete { id: "a".into() },
            VectorRecordOperation::Insert {
                record: input.clone(),
            },
            VectorRecordOperation::Delete {
                id: "absent".into(),
            },
        ],
        &Default::default(),
    )?;
    assert_eq!(
        committed
            .outcomes
            .iter()
            .map(|outcome| (outcome.created, outcome.deleted))
            .collect::<Vec<_>>(),
        vec![
            (Some(true), None),
            (Some(false), None),
            (None, Some(true)),
            (Some(true), None),
            (None, Some(false))
        ]
    );
    let stored = core
        .get_vector_record(
            "a",
            &VectorRecordRevisionOptions {
                if_revision: Some(committed.revision.clone()),
            },
        )?
        .record
        .unwrap();
    assert_eq!(
        stored
            .vector
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>(),
        input
            .vector
            .iter()
            .map(|value| value.to_bits())
            .collect::<Vec<_>>()
    );
    assert_eq!(stored.metadata, input.metadata);
    assert_eq!(core.shards.read().count(), 0);
    assert_eq!(
        core.documents.read().get("a").unwrap().chunks[0].word_count,
        0
    );
    assert!(core.documents.read().get("a").unwrap().chunks[0]
        .text
        .is_none());
    assert!(core.documents.read().only_vector_records());
    core.compact()?;
    drop(core);
    let reopened = open(root.path())?;
    let stored = reopened
        .get_vector_record("a", &Default::default())?
        .record
        .unwrap();
    assert_eq!(stored.vector[0].to_bits(), (-0.0f64).to_bits());
    assert_eq!(stored.vector[2].to_bits(), f64::MIN_POSITIVE.to_bits());
    assert!(reopened
        .get_vector_record(
            "a",
            &VectorRecordRevisionOptions {
                if_revision: Some(committed.revision)
            }
        )
        .unwrap_err()
        .is::<VectorRecordRevisionConflict>());
    assert!(reopened.documents.read().only_vector_records());
    assert_eq!(
        crate::core::format::verify_path(root.path(), &Default::default())?.verdict,
        crate::core::format::Verdict::Ok
    );
    Ok(())
}

#[test]
fn failed_ordered_preconditions_leave_journal_and_live_state_unchanged() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = open(root.path())?;
    let before = core.revision();
    let checkpoint = core.arena.checkpoint();
    assert!(core
        .mutate_vector_records(
            vec![
                VectorRecordOperation::Insert {
                    record: record("a")
                },
                VectorRecordOperation::Insert {
                    record: record("a")
                }
            ],
            &Default::default()
        )
        .is_err());
    assert_eq!(core.revision(), before);
    assert_eq!(core.arena.checkpoint(), checkpoint);
    assert_eq!(core.document_count(), 0);
    let mut invalid = record("bad");
    invalid.vector = vec![0.0; 3];
    assert!(core
        .mutate_vector_records(
            vec![
                VectorRecordOperation::Insert {
                    record: record("a")
                },
                VectorRecordOperation::Upsert { record: invalid }
            ],
            &Default::default()
        )
        .is_err());
    assert_eq!(core.revision(), before);
    assert_eq!(core.arena.checkpoint(), checkpoint);
    drop(core);
    assert_eq!(open(root.path())?.document_count(), 0);
    Ok(())
}

#[test]
fn metadata_and_operation_limits_are_exact_and_atomic() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = open(root.path())?;
    let mut input = record("bounded");
    input.metadata = json!({"pad":""});
    let fixed = documents::serialized_size(
        &records::prepare(input.clone(), 256, 3)?.metadata,
        MAX_RECORD_BYTES,
    )?;
    for delta in [-1isize, 0, 1] {
        input.metadata = json!({"pad":"x".repeat((MAX_RECORD_BYTES as isize - fixed as isize + delta) as usize)});
        let before = core.revision();
        let result = upsert(&core, input.clone());
        assert_eq!(result.is_ok(), delta <= 0);
        if delta > 0 {
            assert_eq!(core.revision(), before);
        }
    }
    for count in [4095, 4096, 4097] {
        let before = core.revision();
        let result = core.mutate_vector_records(
            vec![
                VectorRecordOperation::Delete {
                    id: "absent".into()
                };
                count
            ],
            &Default::default(),
        );
        assert_eq!(result.is_ok(), count <= 4096);
        if count > 4096 {
            assert_eq!(core.revision(), before);
        }
    }
    for vector in [
        vec![0.0, 0.0, 0.0],
        vec![1.0, 2.0],
        vec![f64::NAN, 1.0, 0.0],
        vec![f64::INFINITY, 1.0, 0.0],
    ] {
        let before = core.revision();
        let mut item = record("invalid");
        item.vector = vector;
        assert!(upsert(&core, item).is_err());
        assert_eq!(core.revision(), before);
    }
    Ok(())
}

#[test]
fn paging_and_complete_eligibility_share_one_revision() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = open(root.path())?;
    for id in ["a", "b", "c"] {
        upsert(&core, record(id))?;
    }
    let first = core.list_vector_records(&VectorRecordListOptions {
        limit: Some(1.0),
        include_vectors: Some(false),
        ..Default::default()
    })?;
    assert_eq!(first.records[0].id, "a");
    assert!(first.records[0].vector.is_none());
    assert_eq!(first.next_from.as_deref(), Some("b"));
    let second = core.list_vector_records(&VectorRecordListOptions {
        from: first.next_from,
        limit: Some(1.0),
        if_revision: Some(first.revision.clone()),
        ..Default::default()
    })?;
    assert_eq!(second.records[0].id, "b");
    assert_eq!(second.next_from.as_deref(), Some("c"));
    let options = VectorRecordQueryOptions {
        document_ids: Some(vec!["c".into()]),
        if_revision: Some(first.revision.clone()),
        ..Default::default()
    };
    let results = core.query_vector_records(&[0.0, 1.0, 0.0], 1, &options)?;
    assert_eq!(results.results.len(), 1);
    assert_eq!(results.results[0].item.id, "c");
    assert!(core
        .query_vector_records(
            &[0.0, 1.0, 0.0],
            1,
            &VectorRecordQueryOptions {
                document_ids: Some(vec![]),
                ..Default::default()
            }
        )?
        .results
        .is_empty());
    upsert(&core, record("d"))?;
    assert!(core
        .query_vector_records(&[0.0, 1.0, 0.0], 1, &options)
        .unwrap_err()
        .is::<VectorRecordRevisionConflict>());
    for limit in [0.0, 1.0, 1000.0, 1001.0, 0.5, f64::INFINITY] {
        assert_eq!(
            core.list_vector_records(&VectorRecordListOptions {
                limit: Some(limit),
                ..Default::default()
            })
            .is_ok(),
            limit == 1.0 || limit == 1000.0
        );
    }
    Ok(())
}

#[test]
fn empty_eligibility_still_validates_query_and_revision() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = open(root.path())?;
    upsert(&core, record("a"))?;
    let mut options = VectorRecordQueryOptions {
        document_ids: Some(vec![]),
        ..Default::default()
    };
    assert!(core
        .query_vector_records(&[0.0, 1.0, 0.0], 1, &options)?
        .results
        .is_empty());
    for vector in [
        &[0.0, 0.0, 0.0][..],
        &[1.0, 0.0][..],
        &[f64::NAN, 0.0, 1.0][..],
    ] {
        assert!(core.query_vector_records(vector, 1, &options).is_err());
    }
    assert!(core
        .query_vector_records(&[0.0, 1.0, 0.0], 0, &options)
        .is_err());
    options.min_score = Some(f64::NAN);
    assert!(core
        .query_vector_records(&[0.0, 1.0, 0.0], 1, &options)
        .is_err());
    options.min_score = None;
    options.if_revision = Some("invalid".into());
    assert!(core
        .query_vector_records(&[0.0, 1.0, 0.0], 1, &options)
        .unwrap_err()
        .is::<VectorRecordRevisionConflict>());
    Ok(())
}

#[test]
fn filtered_record_ranking_matches_canonical_vector_search() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = open(root.path())?;
    let inputs = [
        ("negative", [-1.0, 0.0, 0.0]),
        ("positive-b", [1.0, 0.0, 0.0]),
        ("positive-a", [1.0, 0.0, 0.0]),
        ("angled", [0.5, 0.5, 0.0]),
        ("orthogonal", [0.0, 1.0, 0.0]),
    ];
    for (id, vector) in inputs {
        let mut item = record(id);
        item.vector = vector.into();
        upsert(&core, item)?;
    }
    let ids = vec![
        "negative".into(),
        "positive-b".into(),
        "positive-a".into(),
        "angled".into(),
        "orthogonal".into(),
        "missing".into(),
    ];
    for k in [1, 4, 5, 6, 1000] {
        for minimum in [-1.0, 0.0, 1.0] {
            let actual = core.query_vector_records(
                &[1.0, 0.0, 0.0],
                k,
                &VectorRecordQueryOptions {
                    document_ids: Some(ids.clone()),
                    mode: Some("graph".into()),
                    min_score: Some(minimum),
                    ..Default::default()
                },
            )?;
            let expected = core.search_vectors_with_report(
                &[1.0, 0.0, 0.0],
                k,
                &VectorQueryOptions {
                    document_ids: Some(ids.clone()),
                    mode: VectorIndexMode::Graph,
                    min_score: minimum,
                    ..Default::default()
                },
            )?;
            assert_eq!(
                actual.diagnostics.route,
                documents::VectorSearchRoute::FilteredExact
            );
            assert_eq!(
                actual
                    .results
                    .iter()
                    .map(|hit| (&hit.item.id, hit.score))
                    .collect::<Vec<_>>(),
                expected
                    .results
                    .iter()
                    .map(|hit| (&hit.document_id, hit.score))
                    .collect::<Vec<_>>()
            );
        }
    }
    Ok(())
}

#[test]
fn cold_exact_defers_graph_until_automatic_or_graph_search() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = open(root.path())?;
    let operations = (0..documents::DEFAULT_GRAPH_MIN_ROWS)
        .map(|i| VectorRecordOperation::Insert {
            record: record(&format!("id-{i:04}")),
        })
        .collect();
    core.mutate_vector_records(operations, &Default::default())?;
    let exact = core.query_vector_records(&[0.0, 1.0, 0.0], 1, &Default::default())?;
    assert_eq!(
        exact.diagnostics.route,
        documents::VectorSearchRoute::FullExact
    );
    let status = core.vector_index_status();
    assert!(!status.graph && status.rebuild_recommended);
    let graph = core.query_vector_records(
        &[0.0, 1.0, 0.0],
        1,
        &VectorRecordQueryOptions {
            mode: Some("graph".into()),
            ..Default::default()
        },
    )?;
    assert_eq!(
        graph.diagnostics.route,
        documents::VectorSearchRoute::FullGraph
    );
    assert!(core.vector_index_status().graph);
    Ok(())
}

#[test]
fn metadata_only_reads_validate_envelope_without_decoding_vector() -> Result<()> {
    let mut doc = records::prepare(record("a"), 256, 3)?;
    let full = records::read(&doc, true)?;
    let metadata_only = records::read(&doc, false)?;
    assert_eq!(metadata_only.metadata, full.metadata);
    assert!(metadata_only.vector.is_none());
    let envelope = doc
        .metadata
        .get_mut("$warm_vector_record")
        .unwrap()
        .as_object_mut()
        .unwrap();
    envelope.insert("f64le".into(), json!("invalid base64"));
    assert!(records::read(&doc, false).is_ok());
    assert!(records::read(&doc, true).is_err());
    for (field, value) in [
        ("version", json!(2)),
        ("f64le", json!(3)),
        ("metadata", json!([])),
        ("extra", json!(true)),
    ] {
        let mut malformed = records::prepare(record("a"), 256, 3)?;
        malformed.metadata.get_mut("$warm_vector_record").unwrap()[field] = value;
        assert!(records::read(&malformed, false).is_err(), "{field}");
    }
    Ok(())
}

#[test]
fn ordinary_documents_keep_marker_metadata_and_cannot_be_mutated_as_vectors() -> Result<()> {
    let root = tempfile::tempdir()?;
    let source = root.path().join("source");
    let mut cfg = config();
    cfg.vector_records = false;
    let core = WarmCore::new(256, Some(source.display().to_string()), Some(cfg.clone()))?;
    let input: documents::DocumentInput = serde_json::from_value(
        json!({"id":"ordinary","text":"owned text","version":records::VERSION,"metadata":{"$warm_vector_record":{"version":99}},"embeddings":[[0.0,1.0,0.0]]}),
    )?;
    core.memorize_document(input)?;
    drop(core);
    let reopened = WarmCore::new(256, Some(source.display().to_string()), Some(cfg))?;
    assert_eq!(
        reopened.get_document_info("ordinary")?.unwrap().metadata,
        json!({"$warm_vector_record":{"version":99}})
    );
    assert!(reopened
        .get_vector_record("ordinary", &Default::default())
        .is_err());
    drop(reopened);
    let upgraded = root.path().join("upgraded");
    crate::core::format::upgrade_store(&source, &upgraded, false)?;
    let core = open(&upgraded)?;
    upsert(&core, record("native"))?;
    assert!(!core.documents.read().only_vector_records());
    assert!(core
        .get_vector_record("ordinary", &Default::default())?
        .record
        .is_none());
    let before = core.revision();
    for operation in [
        VectorRecordOperation::Insert {
            record: record("ordinary"),
        },
        VectorRecordOperation::Upsert {
            record: record("ordinary"),
        },
        VectorRecordOperation::Delete {
            id: "ordinary".into(),
        },
    ] {
        assert!(core
            .mutate_vector_records(vec![operation], &Default::default())
            .is_err());
        assert_eq!(core.revision(), before);
    }
    let result = core.query_vector_records(
        &[0.0, 1.0, 0.0],
        1,
        &VectorRecordQueryOptions {
            document_ids: Some(vec!["ordinary".into()]),
            ..Default::default()
        },
    )?;
    assert!(result.results.is_empty());
    drop(core);
    Ok(())
}

#[test]
fn concurrent_inserts_and_revision_preconditions_are_atomic() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = Arc::new(open(root.path())?);
    let barrier = Arc::new(Barrier::new(5));
    let writers: Vec<_> = (0..4)
        .map(|_| {
            let core = core.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                core.mutate_vector_records(
                    vec![VectorRecordOperation::Insert {
                        record: record("one"),
                    }],
                    &Default::default(),
                )
                .is_ok()
            })
        })
        .collect();
    barrier.wait();
    assert_eq!(
        writers
            .into_iter()
            .map(|thread| usize::from(thread.join().unwrap()))
            .sum::<usize>(),
        1
    );
    let token = core.get_vector_record("one", &Default::default())?.revision;
    let other_root = tempfile::tempdir()?;
    let other = open(other_root.path())?;
    assert!(other
        .get_vector_record(
            "one",
            &VectorRecordRevisionOptions {
                if_revision: Some(token.clone())
            }
        )
        .unwrap_err()
        .is::<VectorRecordRevisionConflict>());
    let barrier = Arc::new(Barrier::new(3));
    let writers: Vec<_> = (0..2)
        .map(|n| {
            let core = core.clone();
            let barrier = barrier.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                barrier.wait();
                core.mutate_vector_records(
                    vec![VectorRecordOperation::Upsert {
                        record: record(&format!("revision-{n}")),
                    }],
                    &VectorRecordRevisionOptions {
                        if_revision: Some(token),
                    },
                )
            })
        })
        .collect();
    barrier.wait();
    let outcomes: Vec<_> = writers
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(outcomes
        .iter()
        .filter_map(|result| result.as_ref().err())
        .all(|error| error.is::<VectorRecordRevisionConflict>()));
    Ok(())
}

#[test]
fn native_shape_schema_and_envelope_corruption_fail_consistently() -> Result<()> {
    let document = records::prepare(record("a"), 256, 3)?;
    let valid = serde_json::json!([{"Document":document}]);
    let bytes = serde_json::to_vec(&valid)?;
    for schema in [6, 7] {
        let result = crate::core::format::scan::check_transaction_with_schema(
            &bytes,
            Some(256),
            schema,
            &mut Default::default(),
        );
        assert_eq!(result.is_ok(), schema == 7);
    }
    for field in ["span", "embedding", "body", "terms", "kind"] {
        let mut value = valid.clone();
        match field {
            "span" => value[0]["Document"]["chunks"][0]["end_byte"] = json!(1),
            "embedding" => value[0]["Document"]["chunks"][0]["embedding"] = json!([1.0, 0.0, 0.0]),
            "body" => {
                value[0]["Document"]["metadata"]["$warm_vector_record"]["f64le"] = json!("AAAA")
            }
            "terms" => value[0]["Document"]["chunks"][0]["terms"] = json!({"fabricated":1}),
            _ => value[0]["Document"]["vector_record"] = json!("true"),
        }
        assert!(
            crate::core::format::scan::check_transaction_with_schema(
                &serde_json::to_vec(&value)?,
                Some(256),
                7,
                &mut Default::default()
            )
            .is_err(),
            "{field}"
        );
    }
    Ok(())
}

thread_local! {
    static AFTER_RANKING: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn after_ranking() {
    if let Some(hook) = AFTER_RANKING.with(|slot| slot.borrow_mut().take()) {
        hook();
    }
}

#[test]
fn revision_is_rechecked_after_scoring_and_only_clean_reads_retry() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let core = Arc::new(open(directory.path())?);
    let first = upsert(&core, record("a"))?;
    let changed = Arc::clone(&core);
    AFTER_RANKING.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            upsert(&changed, record("b")).unwrap();
        }));
    });
    let error = core
        .query_vector_records(
            &[0.0, 1.0, 0.0],
            2,
            &VectorRecordQueryOptions {
                if_revision: Some(first.revision),
                ..Default::default()
            },
        )
        .unwrap_err();
    assert!(error.is::<VectorRecordRevisionConflict>());
    let changed = Arc::clone(&core);
    AFTER_RANKING.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            upsert(&changed, record("c")).unwrap();
        }));
    });
    let found = core.query_vector_records(&[0.0, 1.0, 0.0], 3, &Default::default())?;
    assert_eq!(found.results.len(), 3);
    assert_eq!(
        found.revision,
        core.list_vector_records(&Default::default())?.revision
    );
    let changed = Arc::clone(&core);
    AFTER_RANKING.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            let mut updated = record("a");
            updated.vector = vec![1.0, 0.0, 0.0];
            upsert(&changed, updated).unwrap();
        }));
    });
    let found = core.query_vector_records(
        &[1.0, 0.0, 0.0],
        1,
        &VectorRecordQueryOptions {
            document_ids: Some(vec!["a".into(), "b".into()]),
            ..Default::default()
        },
    )?;
    assert_eq!(found.results[0].item.id, "a");
    assert_eq!(found.results[0].item.vector, vec![1.0, 0.0, 0.0]);
    Ok(())
}

#[test]
fn native_only_graph_route_and_mixed_ownership_survive_kind_changes() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let core = open(directory.path())?;
    core.mutate_vector_records(
        (0..32)
            .map(|index| VectorRecordOperation::Insert {
                record: VectorRecordInput {
                    id: format!("v{index:02}"),
                    vector: vec![1.0, index as f64 / 32.0, 0.1],
                    metadata: json!({}),
                },
            })
            .collect(),
        &Default::default(),
    )?;
    assert!(core.documents.read().only_vector_records());
    assert_eq!(core.encode_pending_documents()?, 0);
    assert_eq!(core.shards.read().count(), 0);
    let options = VectorRecordQueryOptions {
        mode: Some("graph".into()),
        ..Default::default()
    };
    assert!(core
        .query_vector_records(&[1.0, 0.0, 0.1], 3, &options)
        .unwrap_err()
        .is::<documents::GraphUnavailable>());
    assert!(core.rebuild_vector_index(1)?);
    let found = core.query_vector_records(&[1.0, 0.0, 0.1], 3, &options)?;
    assert_eq!(
        found.diagnostics.route,
        documents::VectorSearchRoute::FullGraph
    );
    assert_eq!(found.results[0].item.id, "v00");
    let ordinary: documents::DocumentInput = serde_json::from_value(json!({
        "id":"v00", "text":"ordinary replacement", "embeddings":[[1.0,0.0,0.1]],
    }))?;
    core.memorize_document(ordinary)?;
    assert!(!core.documents.read().only_vector_records());
    let found = core.query_vector_records(&[1.0, 0.0, 0.1], 32, &options)?;
    assert_eq!(
        found.diagnostics.route,
        documents::VectorSearchRoute::FilteredExact
    );
    assert_eq!(found.results.len(), 31);
    assert!(found.results.iter().all(|hit| hit.item.id != "v00"));
    core.delete_document("v00")?;
    assert!(core.documents.read().only_vector_records());
    core.compact()?;
    assert!(core.documents.read().only_vector_records());
    drop(core);
    let reopened = open(directory.path())?;
    assert!(reopened.documents.read().only_vector_records());
    assert_eq!(
        reopened
            .list_vector_records(&Default::default())?
            .records
            .len(),
        31
    );
    Ok(())
}

#[test]
fn offline_verifier_and_replay_reject_wrong_or_missing_embedding_configuration() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let core = open(directory.path())?;
    upsert(&core, record("a"))?;
    drop(core);
    let path = directory.path().join("store.json");
    let mut schema: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    for dimensions in [Some(2), None] {
        schema["embedding_space"] = if let Some(dimensions) = dimensions {
            let mut space = serde_json::to_value(config().embedding_space.unwrap())?;
            space["dimensions"] = json!(dimensions);
            space
        } else {
            serde_json::Value::Null
        };
        std::fs::write(&path, serde_json::to_vec(&schema)?)?;
        let report = crate::core::format::verify_path(directory.path(), &Default::default())?;
        assert_ne!(
            report.verdict,
            crate::core::format::Verdict::Ok,
            "{dimensions:?}"
        );
        let mut cfg = config();
        cfg.embedding_space = serde_json::from_value(schema["embedding_space"].clone())?;
        assert!(
            WarmCore::new(256, Some(directory.path().display().to_string()), Some(cfg)).is_err()
        );
    }
    Ok(())
}

#[test]
fn checkpoint_hydration_preserves_ordinary_metadata_and_native_journal_recovery() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let core = open(directory.path())?;
    core.memorize_document_with(
        serde_json::from_value(json!({
            "id":"ordinary", "text":"retained words", "version":records::VERSION,
            "metadata":{"$warm_vector_record":{"version":1,"f64le":"user-owned"}},
        }))?,
        &documents::IngestOptions {
            encode: documents::EncodeMode::Lexical,
            ..Default::default()
        },
    )?;
    core.compact()?;
    drop(core);
    let core = open(directory.path())?;
    assert!(core.documents.read().has_base());
    let before = core.list_vector_records(&Default::default())?;
    assert!(before.records.is_empty());
    assert!(core
        .get_vector_record("ordinary", &Default::default())?
        .record
        .is_none());
    assert!(core.documents.read().has_base());
    for operation in [
        VectorRecordOperation::Insert {
            record: record("ordinary"),
        },
        VectorRecordOperation::Upsert {
            record: record("ordinary"),
        },
        VectorRecordOperation::Delete {
            id: "ordinary".into(),
        },
    ] {
        assert!(core
            .mutate_vector_records(vec![operation], &Default::default())
            .is_err());
        assert!(core.documents.read().has_base());
    }
    upsert(&core, record("native"))?;
    assert!(core.documents.read().has_base());
    assert!(core
        .list_vector_records(&VectorRecordListOptions {
            if_revision: Some(before.revision),
            ..Default::default()
        })
        .unwrap_err()
        .is::<VectorRecordRevisionConflict>());
    assert!(core.documents.read().has_base());
    assert_eq!(
        core.list_vector_records(&Default::default())?.records.len(),
        1
    );
    assert!(core
        .get_vector_record("ordinary", &Default::default())?
        .record
        .is_none());
    assert!(core.documents.read().has_base());
    let found = core.query_vector_records(&[0.0, 1.0, 0.0], 1, &Default::default())?;
    assert_eq!(found.results.len(), 1);
    assert_eq!(found.results[0].item.id, "native");
    assert_eq!(
        found.diagnostics.route,
        documents::VectorSearchRoute::FullExact
    );
    assert!(core.documents.read().has_base());
    let filtered = core.query_vector_records(
        &[0.0, 1.0, 0.0],
        1,
        &VectorRecordQueryOptions {
            document_ids: Some(vec!["ordinary".into(), "native".into()]),
            mode: Some("graph".into()),
            ..Default::default()
        },
    )?;
    assert_eq!(
        filtered.diagnostics.route,
        documents::VectorSearchRoute::FilteredExact
    );
    assert_eq!(filtered.results[0].item.id, "native");
    assert!(core.documents.read().has_base());
    assert!(core.rebuild_vector_index(1)?);
    let graph = core.query_vector_records(
        &[0.0, 1.0, 0.0],
        1,
        &VectorRecordQueryOptions {
            mode: Some("graph".into()),
            ..Default::default()
        },
    )?;
    assert_eq!(graph.results[0].item.id, "native");
    assert_eq!(
        graph.diagnostics.route,
        documents::VectorSearchRoute::FullGraph
    );
    assert!(core.documents.read().has_base());
    drop(core);
    let core = open(directory.path())?;
    assert!(core.documents.read().has_base());
    assert_eq!(
        core.list_vector_records(&Default::default())?.records[0].id,
        "native"
    );
    assert!(core.documents.read().has_base());
    let found = core.query_vector_records(&[0.0, 1.0, 0.0], 1, &Default::default())?;
    assert_eq!(found.results[0].item.id, "native");
    assert!(core.documents.read().has_base());
    assert!(core.get_document("ordinary")?.is_some());
    assert_eq!(
        crate::core::format::verify_path(directory.path(), &Default::default())?.verdict,
        crate::core::format::Verdict::Ok
    );
    Ok(())
}

#[test]
fn native_id_boundaries_and_extreme_finite_bits_are_preserved() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let core = open(directory.path())?;
    let maximum = u16::MAX as usize - 12;
    for length in [maximum - 1, maximum, maximum + 1] {
        let input = VectorRecordInput {
            id: "x".repeat(length),
            vector: vec![f64::MAX, -f64::MAX, -0.0],
            metadata: json!({}),
        };
        let result = upsert(&core, input.clone());
        assert_eq!(result.is_ok(), length <= maximum);
        if result.is_ok() {
            let stored = core
                .get_vector_record(&input.id, &Default::default())?
                .record
                .unwrap();
            assert_eq!(
                stored
                    .vector
                    .iter()
                    .map(|v| v.to_bits())
                    .collect::<Vec<_>>(),
                input.vector.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
            );
        }
    }
    let input = VectorRecordInput {
        id: "tiny".into(),
        vector: vec![f64::from_bits(1), 0.0, -0.0],
        metadata: json!({}),
    };
    upsert(&core, input.clone())?;
    let stored = core
        .get_vector_record(&input.id, &Default::default())?
        .record
        .unwrap();
    assert_eq!(
        stored
            .vector
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        input.vector.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    for id in ["", "\0", "hms:chunk:owned", "hms:meaning:owned"] {
        assert!(upsert(&core, record(id)).is_err());
    }
    Ok(())
}

#[cfg(feature = "security")]
#[test]
fn encrypted_native_records_survive_compaction_and_reopen() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut cfg = config();
    cfg.security.encryption_enabled = true;
    cfg.security.encryption_passphrase = Some("native-record-test-fixture".into());
    let core = WarmCore::new(
        256,
        Some(directory.path().display().to_string()),
        Some(cfg.clone()),
    )?;
    let input = record("encrypted");
    upsert(&core, input.clone())?;
    core.compact()?;
    drop(core);
    let core = WarmCore::new(256, Some(directory.path().display().to_string()), Some(cfg))?;
    let stored = core
        .get_vector_record("encrypted", &Default::default())?
        .record
        .unwrap();
    assert_eq!(stored.metadata, input.metadata);
    assert_eq!(
        stored
            .vector
            .iter()
            .map(|v| v.to_bits())
            .collect::<Vec<_>>(),
        input.vector.iter().map(|v| v.to_bits()).collect::<Vec<_>>()
    );
    assert_eq!(
        core.query_vector_records(&[0.0, 1.0, 0.0], 1, &Default::default())?
            .results[0]
            .item
            .id,
        "encrypted"
    );
    Ok(())
}
