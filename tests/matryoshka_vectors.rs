// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use anyhow::Result;
use serde_json::json;
use writerslogic_warm::core::documents::{VectorIndexMode, VectorQueryOptions, VectorSearchRoute};
use writerslogic_warm::core::{VectorCandidateConfig, WarmConfig};
use writerslogic_warm::{DocumentInput, DocumentResult, EmbeddingSpace, WarmCore};

fn config(candidates: Option<(usize, usize)>) -> WarmConfig {
    WarmConfig {
        embedding_space: Some(EmbeddingSpace {
            model: "synthetic-full-vector".into(),
            revision: "fixture-v1".into(),
            dimensions: 4,
            normalization: "l2".into(),
            metric: "cosine".into(),
        }),
        vector_candidates: candidates.map(|(dimensions, rerank_candidates)| {
            VectorCandidateConfig {
                dimensions,
                rerank_candidates,
            }
        }),
        ..Default::default()
    }
}

fn item(id: &str, vector: [f64; 4], group: &str) -> DocumentInput {
    serde_json::from_value(json!({
        "id": id, "text": format!("retained text {id}"), "version": "original",
        "sourceUri": format!("source:{group}"), "metadata": {"group": group},
        "embeddings": [vector],
    }))
    .unwrap()
}

fn signatures(hits: &[DocumentResult]) -> Vec<(&str, &str, f64)> {
    hits.iter()
        .map(|hit| (hit.document_id.as_str(), hit.version.as_str(), hit.score))
        .collect()
}

fn populate(core: &WarmCore) -> Result<()> {
    core.memorize_documents(vec![
        item("prefix-winner", [1.0, 0.0, 10.0, 0.0], "other"),
        item("full-winner", [0.9, 0.1, 0.0, 9.0], "keep"),
        item("third", [0.0, 1.0, 0.0, 0.0], "keep"),
    ])?;
    assert!(core.rebuild_vector_index(1)?);
    Ok(())
}

#[test]
fn high_recall_graph_is_opt_in_and_reports_its_build_settings() -> Result<()> {
    for high_recall in [false, true] {
        let directory = tempfile::tempdir()?;
        let mut cfg = config(None);
        cfg.vector_high_recall = high_recall;
        let core = WarmCore::new(
            1024,
            Some(directory.path().display().to_string()),
            Some(cfg),
        )?;
        populate(&core)?;
        let status = core.vector_index_status();
        assert_eq!(status.graph_degree, Some(64));
        assert_eq!(
            status.graph_build_ef,
            Some(if high_recall { 500 } else { 256 })
        );
        let found = core.search_vectors_with_report(
            &[1.0, 0.0, 0.0, 10.0],
            2,
            &VectorQueryOptions {
                mode: VectorIndexMode::Graph,
                ..Default::default()
            },
        )?;
        assert_eq!(found.diagnostics.graph_degree, status.graph_degree);
        assert_eq!(found.diagnostics.graph_build_ef, status.graph_build_ef);
        assert_eq!(found.results[0].document_id, "full-winner");
    }
    let directory = tempfile::tempdir()?;
    assert!(WarmCore::new(
        1024,
        Some(directory.path().display().to_string()),
        Some(WarmConfig {
            vector_high_recall: true,
            ..Default::default()
        })
    )
    .is_err());
    Ok(())
}

#[test]
fn cold_exact_defers_only_graph_sized_snapshots_and_maintenance_finishes_them() -> Result<()> {
    use writerslogic_warm::core::documents::DEFAULT_GRAPH_MIN_ROWS;
    use writerslogic_warm::core::vector_records::{
        VectorRecordInput, VectorRecordOperation, VectorRecordQueryOptions,
    };

    for rows in [
        DEFAULT_GRAPH_MIN_ROWS - 1,
        DEFAULT_GRAPH_MIN_ROWS,
        DEFAULT_GRAPH_MIN_ROWS + 1,
    ] {
        let directory = tempfile::tempdir()?;
        let mut cfg = config(None);
        cfg.vector_records = true;
        let core = WarmCore::new(256, Some(directory.path().display().to_string()), Some(cfg))?;
        let operations: Vec<_> = (0..rows)
            .map(|i| VectorRecordOperation::Insert {
                record: VectorRecordInput {
                    id: format!("id-{i:04}"),
                    vector: vec![1.0, 0.0, 0.0, 0.0],
                    metadata: json!({}),
                },
            })
            .collect();
        for batch in operations.chunks(4096) {
            core.mutate_vector_records(batch.to_vec(), &Default::default())?;
        }
        let result = core.query_vector_records(
            &[1.0, 0.0, 0.0, 0.0],
            1,
            &VectorRecordQueryOptions::default(),
        )?;
        assert_eq!(result.diagnostics.route, VectorSearchRoute::FullExact);
        let status = core.vector_index_status();
        assert!(!status.graph);
        assert_eq!(status.rebuild_recommended, rows >= DEFAULT_GRAPH_MIN_ROWS);
        assert!(core.maintain_vector_index(usize::MAX)?);
        assert!(!core.vector_index_status().graph);
        assert!(core.maintain_vector_index(DEFAULT_GRAPH_MIN_ROWS)?);
        assert_eq!(
            core.vector_index_status().graph,
            rows >= DEFAULT_GRAPH_MIN_ROWS
        );
    }
    Ok(())
}

#[test]
fn projected_graph_reranks_full_vectors_and_full_width_is_a_matched_control() -> Result<()> {
    let query = [1.0, 0.0, 0.0, 10.0];
    let exact_options = VectorQueryOptions {
        mode: VectorIndexMode::Exact,
        ..Default::default()
    };
    let mut expected = None;
    for candidate in [None, Some((2, 3)), Some((4, 3))] {
        let directory = tempfile::tempdir()?;
        let core = WarmCore::new(
            1024,
            Some(directory.path().display().to_string()),
            Some(config(candidate)),
        )?;
        populate(&core)?;
        let report = core.search_vectors_with_report(&query, 2, &VectorQueryOptions::default())?;
        assert_eq!(
            report.diagnostics.route,
            if candidate.is_some_and(|(dimensions, _)| dimensions < 4) {
                VectorSearchRoute::ProjectedGraph
            } else {
                VectorSearchRoute::FullGraph
            }
        );
        assert_eq!(
            report.diagnostics.candidate_dimensions,
            candidate.map_or(4, |c| c.0)
        );
        assert_eq!(report.diagnostics.shortlist_limit, Some(3));
        let exact = core.search_vectors_with_report(&query, 2, &exact_options)?;
        assert_eq!(exact.diagnostics.route, VectorSearchRoute::FullExact);
        assert_eq!(signatures(&report.results), signatures(&exact.results));
        assert_eq!(report.results[0].document_id, "full-winner");
        assert_eq!(
            report.results[0].text.as_deref(),
            Some("retained text full-winner")
        );
        assert!(report.results[0].score > 0.99);
        assert_eq!(
            report.results[0].score,
            report.results[0].semantic_score.unwrap()
        );
        let values = serde_json::to_value(&report.results)?;
        if let Some(expected) = &expected {
            assert_eq!(expected, &values);
        } else {
            expected = Some(values);
        }
        let status = core.vector_index_status();
        assert!(
            status.graph
                && status.graph_index_bytes.unwrap() >= status.graph_residual_bytes.unwrap()
        );
        if let Some((width, limit)) = candidate {
            let identity = status.candidate_identity.unwrap();
            assert_eq!(
                identity.embedding_space,
                config(None).embedding_space.unwrap()
            );
            assert_eq!(identity.dimensions, width);
            assert_eq!(identity.normalization, "prefix-l2-v1");
            assert_eq!(status.rerank_candidates, Some(limit));
        } else {
            assert!(status.candidate_identity.is_none());
        }
        let threshold = VectorQueryOptions {
            min_score: 0.9,
            ..Default::default()
        };
        assert_eq!(core.search_vectors(&query, 3, &threshold)?.len(), 1);
    }
    Ok(())
}

#[test]
fn candidate_prefixes_are_normalized_for_rows_and_queries() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let core = WarmCore::new(
        1024,
        Some(directory.path().display().to_string()),
        Some(config(Some((2, 1)))),
    )?;
    core.memorize_documents(vec![
        item("small-prefix", [0.01, 0.0, 1.0, 0.0], "g"),
        item("large-prefix", [0.9, 0.1, 0.0, 0.5], "g"),
        item("other", [0.0, 1.0, 0.0, 0.0], "g"),
    ])?;
    assert!(core.rebuild_vector_index(1)?);
    for scale in [0.1, 1.0, 100.0] {
        let report = core.search_vectors_with_report(
            &[0.01 * scale, 0.0, scale, 0.0],
            1,
            &VectorQueryOptions::default(),
        )?;
        assert_eq!(report.diagnostics.route, VectorSearchRoute::ProjectedGraph);
        assert_eq!(report.results[0].document_id, "small-prefix");
        assert!((report.results[0].score - 1.0).abs() < 1e-6);
    }
    Ok(())
}

#[test]
fn projected_configuration_and_shortlists_are_bounded() -> Result<()> {
    for width in [0, 1, 3, 4, 5] {
        for limit in [0, 1, 4095, 4096, 4097] {
            let directory = tempfile::tempdir()?;
            let core = WarmCore::new(
                1024,
                Some(directory.path().display().to_string()),
                Some(config(Some((width, limit)))),
            );
            assert_eq!(
                core.is_ok(),
                (1..=4).contains(&width) && (1..=4096).contains(&limit),
                "width={width}, limit={limit}"
            );
        }
    }
    let directory = tempfile::tempdir()?;
    let mut missing_space = config(Some((2, 3)));
    missing_space.embedding_space = None;
    assert!(WarmCore::new(
        1024,
        Some(directory.path().display().to_string()),
        Some(missing_space)
    )
    .is_err());
    let core = WarmCore::new(
        1024,
        Some(directory.path().display().to_string()),
        Some(config(Some((2, 2)))),
    )?;
    populate(&core)?;
    for k in [1, 2] {
        let report = core.search_vectors_with_report(
            &[1.0, 0.0, 0.0, 1.0],
            k,
            &VectorQueryOptions::default(),
        )?;
        assert_eq!(report.diagnostics.shortlist_limit, Some(2));
        assert_eq!(report.results.len(), k);
    }
    assert!(core
        .search_vectors(&[1.0, 0.0, 0.0, 1.0], 3, &VectorQueryOptions::default())
        .unwrap_err()
        .to_string()
        .contains("rerank candidates"));
    let exact = VectorQueryOptions {
        mode: VectorIndexMode::Exact,
        ..Default::default()
    };
    assert_eq!(
        core.search_vectors(&[1.0, 0.0, 0.0, 1.0], 3, &exact)?.len(),
        3
    );
    for query in [
        vec![1.0; 3],
        vec![f64::NAN, 1.0, 0.0, 0.0],
        vec![1.0, f64::INFINITY, 0.0, 0.0],
    ] {
        assert!(core
            .search_vectors(&query, 1, &VectorQueryOptions::default())
            .is_err());
    }
    Ok(())
}

#[test]
fn zero_prefix_rows_and_queries_use_full_exact_scores() -> Result<()> {
    for zero_row in [false, true] {
        let directory = tempfile::tempdir()?;
        let core = WarmCore::new(
            1024,
            Some(directory.path().display().to_string()),
            Some(config(Some((2, 3)))),
        )?;
        populate(&core)?;
        if zero_row {
            core.memorize_document(item("zero-prefix", [0.0, 0.0, 1.0, 0.0], "keep"))?;
            assert!(core.rebuild_vector_index(1)?);
            assert!(!core.vector_index_status().graph);
        }
        let query = if zero_row {
            [1.0, 0.0, 1.0, 0.0]
        } else {
            [0.0, 0.0, 1.0, 0.0]
        };
        let report = core.search_vectors_with_report(
            &query,
            2,
            &VectorQueryOptions {
                mode: VectorIndexMode::Graph,
                ..Default::default()
            },
        )?;
        let exact = core.search_vectors(
            &query,
            2,
            &VectorQueryOptions {
                mode: VectorIndexMode::Exact,
                ..Default::default()
            },
        )?;
        assert_eq!(report.diagnostics.route, VectorSearchRoute::FallbackExact);
        assert_eq!(report.diagnostics.candidate_dimensions, 4);
        assert_eq!(report.diagnostics.shortlist_limit, None);
        assert_eq!(signatures(&report.results), signatures(&exact));
    }
    Ok(())
}

#[test]
fn projected_filters_apply_before_top_k_and_preserve_negative_scores() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let core = WarmCore::new(
        1024,
        Some(directory.path().display().to_string()),
        Some(config(Some((2, 1)))),
    )?;
    core.memorize_documents(vec![
        item("excluded", [1.0, 0.0, 0.0, 0.0], "other"),
        item("eligible-a", [-0.5, 0.8, 0.0, 0.0], "keep"),
        item("eligible-b", [-1.0, 0.0, 0.0, 0.0], "keep"),
    ])?;
    assert!(core.rebuild_vector_index(1)?);
    for filter in [
        VectorQueryOptions {
            filter: Some(json!({"group": "keep"})),
            ..Default::default()
        },
        VectorQueryOptions {
            source_uri: Some("source:keep".into()),
            ..Default::default()
        },
        VectorQueryOptions {
            document_ids: Some(vec!["eligible-b".into(), "eligible-a".into()]),
            ..Default::default()
        },
    ] {
        let report = core.search_vectors_with_report(
            &[1.0, 0.0, 0.0, 0.0],
            2,
            &VectorQueryOptions {
                mode: VectorIndexMode::Graph,
                ..filter
            },
        )?;
        assert_eq!(report.diagnostics.route, VectorSearchRoute::FilteredExact);
        assert_eq!(
            report
                .results
                .iter()
                .map(|h| h.document_id.as_str())
                .collect::<Vec<_>>(),
            ["eligible-a", "eligible-b"]
        );
        assert!(report
            .results
            .iter()
            .all(|h| h.score < 0.0 && Some(h.score) == h.semantic_score));
    }
    let empty = VectorQueryOptions {
        document_ids: Some(vec![]),
        ..Default::default()
    };
    assert!(core
        .search_vectors(&[1.0, 0.0, 0.0, 0.0], 2, &empty)?
        .is_empty());
    let malformed = VectorQueryOptions {
        filter: Some(json!([])),
        ..Default::default()
    };
    assert!(core
        .search_vectors(&[1.0, 0.0, 0.0, 0.0], 2, &malformed)
        .is_err());
    Ok(())
}

#[test]
fn projected_churn_and_reopen_preserve_full_vectors_text_and_store_identity() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let path = directory.path().display().to_string();
    let core = WarmCore::new(1024, Some(path.clone()), Some(config(Some((2, 3)))))?;
    populate(&core)?;
    let schema = std::fs::read(directory.path().join("store.json"))?;
    let mut updated = item("full-winner", [0.2, 0.1, 0.0, 10.0], "keep");
    updated.text = "updated text stays complete".into();
    updated.version = Some("updated".into());
    core.memorize_document(updated)?;
    core.delete_document("prefix-winner")?;
    core.memorize_document(item("new", [0.1, 1.0, 0.0, 0.0], "keep"))?;
    let query = [1.0, 0.0, 0.0, 10.0];
    let report = core.search_vectors_with_report(&query, 2, &VectorQueryOptions::default())?;
    assert_eq!(report.diagnostics.route, VectorSearchRoute::StaleExact);
    assert_eq!(report.diagnostics.shortlist_limit, None);
    let exact = core.search_vectors(
        &query,
        2,
        &VectorQueryOptions {
            mode: VectorIndexMode::Exact,
            ..Default::default()
        },
    )?;
    assert_eq!(signatures(&report.results), signatures(&exact));
    assert_eq!(report.results[0].version, "updated");
    assert_eq!(
        report.results[0].text.as_deref(),
        Some("updated text stays complete")
    );
    let expected = serde_json::to_value(exact)?;
    core.flush()?;
    drop(core);
    for candidates in [None, Some((4, 3)), Some((1, 3))] {
        let reopened = WarmCore::new(1024, Some(path.clone()), Some(config(candidates)))?;
        assert!(reopened.rebuild_vector_index(1)?);
        let found = reopened.search_vectors(&query, 2, &VectorQueryOptions::default())?;
        assert_eq!(serde_json::to_value(found)?, expected);
        assert_eq!(std::fs::read(directory.path().join("store.json"))?, schema);
        drop(reopened);
    }
    let mut incompatible = config(Some((2, 3)));
    incompatible.embedding_space.as_mut().unwrap().revision = "different-full-space".into();
    assert!(WarmCore::new(1024, Some(path), Some(incompatible)).is_err());
    Ok(())
}
