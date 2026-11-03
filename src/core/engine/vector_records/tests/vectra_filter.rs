// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn migrated(id: &str, bucket: usize) -> VectorRecordInput {
    VectorRecordInput {
        id: id.into(),
        vector: vec![1.0, bucket as f64 / 10.0, 0.1],
        metadata: json!({"warmVectraMigration":1,"metadata":{"bucket":bucket,"hidden":true},"indexedMetadata":{"bucket":bucket}}),
    }
}

fn assert_matches_exact(core: &WarmCore, bucket: usize, expected: Vec<String>) -> Result<()> {
    let actual = core.query_vectra_records(
        &[1.0, 0.0, 0.1],
        10,
        &json!({"bucket":bucket}),
        &Default::default(),
    )?;
    let exact = core.query_vector_records(
        &[1.0, 0.0, 0.1],
        10,
        &VectorRecordQueryOptions {
            document_ids: Some(expected),
            ..Default::default()
        },
    )?;
    assert_eq!(serde_json::to_value(actual)?, serde_json::to_value(exact)?);
    Ok(())
}

#[test]
fn equality_postings_follow_atomic_updates_deletes_and_reopen() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = open(root.path())?;
    let inserted = core.mutate_vector_records(
        (0..1001)
            .map(|i| VectorRecordOperation::Insert {
                record: migrated(&format!("row-{i:04}"), i % 10),
            })
            .collect(),
        &Default::default(),
    )?;
    let ids = |bucket| {
        (0..1001)
            .filter(|i| i % 10 == bucket)
            .map(|i| format!("row-{i:04}"))
            .collect::<Vec<_>>()
    };
    assert_matches_exact(&core, 8, ids(8))?;
    assert!(core
        .query_vectra_records(
            &[1.0, 0.0, 0.1],
            1,
            &json!({"hidden":true}),
            &Default::default()
        )?
        .results
        .is_empty());
    assert!(core
        .mutate_vector_records(
            vec![
                VectorRecordOperation::Upsert {
                    record: migrated("row-0008", 9)
                },
                VectorRecordOperation::Insert {
                    record: migrated("row-0009", 9)
                },
            ],
            &Default::default()
        )
        .is_err());
    assert_matches_exact(&core, 8, ids(8))?;
    core.mutate_vector_records(
        vec![
            VectorRecordOperation::Upsert {
                record: migrated("row-0008", 9),
            },
            VectorRecordOperation::Delete {
                id: "row-0018".into(),
            },
        ],
        &Default::default(),
    )?;
    let expected: Vec<_> = ids(8)
        .into_iter()
        .filter(|id| id != "row-0008" && id != "row-0018")
        .collect();
    assert_matches_exact(&core, 8, expected.clone())?;
    assert!(core
        .query_vectra_records(
            &[1.0, 0.0, 0.1],
            1,
            &json!({"bucket":8}),
            &VectorRecordQueryOptions {
                if_revision: Some(inserted.revision),
                ..Default::default()
            }
        )
        .unwrap_err()
        .is::<VectorRecordRevisionConflict>());
    core.compact()?;
    drop(core);
    let reopened = open(root.path())?;
    assert_matches_exact(&reopened, 8, expected)?;
    Ok(())
}

#[test]
fn equality_eligibility_is_recomputed_after_concurrent_change() -> Result<()> {
    let root = tempfile::tempdir()?;
    let core = Arc::new(open(root.path())?);
    let initial = upsert(&core, migrated("a", 1))?;
    let changed = Arc::clone(&core);
    AFTER_RANKING.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            upsert(&changed, migrated("a", 2)).unwrap();
        }));
    });
    let found = core.query_vectra_records(
        &[1.0, 0.0, 0.1],
        1,
        &json!({"bucket":1}),
        &Default::default(),
    )?;
    assert!(found.results.is_empty());
    assert_ne!(found.revision, initial.revision);
    let changed = Arc::clone(&core);
    AFTER_RANKING.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            upsert(&changed, migrated("a", 1)).unwrap();
        }));
    });
    assert!(core
        .query_vectra_records(
            &[1.0, 0.0, 0.1],
            1,
            &json!({"bucket":2}),
            &VectorRecordQueryOptions {
                if_revision: Some(found.revision),
                ..Default::default()
            }
        )
        .unwrap_err()
        .is::<VectorRecordRevisionConflict>());
    Ok(())
}

#[test]
fn indexed_eligibility_retains_id_byte_limit() -> Result<()> {
    for delta in [-1isize, 0, 1] {
        let root = tempfile::tempdir()?;
        let core = open(root.path())?;
        let mut operations = Vec::new();
        for i in 0..129 {
            let length = if i < 128 {
                65523
            } else {
                (MAX_BATCH_METADATA as isize - 128 * 65523 + delta) as usize
            };
            let prefix = format!("{i:03}-");
            let id = prefix.clone() + &"x".repeat(length - prefix.len());
            operations.push(VectorRecordOperation::Insert {
                record: migrated(&id, 1),
            });
            if operations.len() == 100 || i == 128 {
                core.mutate_vector_records(std::mem::take(&mut operations), &Default::default())?;
            }
        }
        let result = core.query_vectra_records(
            &[1.0, 0.0, 0.1],
            1,
            &json!({"bucket":1}),
            &Default::default(),
        );
        if delta <= 0 {
            assert_eq!(result?.results.len(), 1);
        } else {
            assert!(result
                .unwrap_err()
                .to_string()
                .contains("eligibility exceeds 8 MiB"));
        }
    }
    Ok(())
}
