use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use warm::core::documents::{
    VectorIndexMode, VectorQueryOptions, VectorSearchResults, VectorSearchRoute,
};
use warm::core::{VectorCandidateConfig, WarmConfig};
use warm::{DocumentInput, EmbeddingSpace, WarmCore};

const DIM: usize = 1024;
const K: usize = 10;

#[derive(Clone, Deserialize)]
struct Row {
    id: String,
    text: String,
}

#[derive(Deserialize)]
struct Input {
    documents: Vec<Row>,
    queries: Vec<Row>,
}

#[derive(Deserialize)]
struct Config {
    input: PathBuf,
    vectors: PathBuf,
    store: PathBuf,
    arm: String,
    output: PathBuf,
}

struct Workload {
    input: Input,
    corpus: Vec<Vec<f64>>,
    queries: Vec<Vec<f64>>,
    space: EmbeddingSpace,
    rows_by_id: HashMap<String, usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Hit {
    id: String,
    score_bits: u64,
}

fn vectors(path: &Path, count: usize) -> Result<Vec<Vec<f64>>> {
    let bytes = fs::read(path)?;
    ensure!(bytes.len() == count * DIM * 4, "vector file shape mismatch");
    let rows: Vec<Vec<f64>> = bytes
        .as_chunks::<{ DIM * 4 }>()
        .0
        .iter()
        .map(|row| {
            row.as_chunks::<4>()
                .0
                .iter()
                .map(|v| f64::from(f32::from_le_bytes(*v)))
                .collect()
        })
        .collect();
    for row in &rows {
        ensure!(row.iter().all(|v| v.is_finite()), "non-finite vector");
        ensure!(
            (row.iter().map(|v| v * v).sum::<f64>().sqrt() - 1.0).abs() < 1e-4,
            "non-unit vector"
        );
    }
    Ok(rows)
}

fn load(config: &Config) -> Result<Workload> {
    let input: Input = serde_json::from_slice(&fs::read(&config.input)?)?;
    ensure!(
        input.documents.len() == 5183 && input.queries.len() == 300,
        "unexpected workload"
    );
    let receipt: Value = serde_json::from_slice(&fs::read(config.vectors.join("complete.json"))?)?;
    let space: EmbeddingSpace =
        serde_json::from_value(receipt["configuration"]["embedding_space"].clone())?;
    ensure!(space.dimensions == DIM, "wrong effective space width");
    let rows_by_id = input
        .documents
        .iter()
        .enumerate()
        .map(|(i, row)| (row.id.clone(), i))
        .collect();
    Ok(Workload {
        corpus: vectors(&config.vectors.join("corpus.f32"), input.documents.len())?,
        queries: vectors(&config.vectors.join("queries.f32"), input.queries.len())?,
        input,
        space,
        rows_by_id,
    })
}

fn candidates(arm: &str) -> Result<Option<VectorCandidateConfig>> {
    Ok(match arm {
        "exact" => None,
        "full100" => Some(VectorCandidateConfig {
            dimensions: 1024,
            rerank_candidates: 100,
        }),
        "full50" => Some(VectorCandidateConfig {
            dimensions: 1024,
            rerank_candidates: 50,
        }),
        "prefix256" => Some(VectorCandidateConfig {
            dimensions: 256,
            rerank_candidates: 100,
        }),
        "prefix512" => Some(VectorCandidateConfig {
            dimensions: 512,
            rerank_candidates: 50,
        }),
        _ => anyhow::bail!("unknown arm"),
    })
}

fn open(config: &Config, workload: &Workload) -> Result<WarmCore> {
    WarmCore::new(
        DIM as u32,
        Some(config.store.to_string_lossy().into_owned()),
        Some(WarmConfig {
            embedding_space: Some(workload.space.clone()),
            vector_candidates: candidates(&config.arm)?,
            ..WarmConfig::default()
        }),
    )
}

fn document(
    workload: &Workload,
    id_row: usize,
    content_row: usize,
    replaced: bool,
) -> DocumentInput {
    DocumentInput {
        id: workload.input.documents[id_row].id.clone(),
        text: workload.input.documents[content_row].text.clone(),
        source_uri: Some(format!("scifact:{}", workload.input.documents[id_row].id)),
        version: Some(
            if replaced {
                "replacement-v2"
            } else {
                "fresh-v1"
            }
            .into(),
        ),
        metadata: Some(json!({"bucket10": id_row % 10, "bucket100": id_row % 100, "row": id_row})),
        chunk_words: Some(4096),
        overlap_words: Some(0),
        store_text: Some(true),
        embeddings: Some(vec![workload.corpus[content_row].clone()]),
        title_weight: None,
    }
}

fn options(arm: &str, condition: usize, query_row: usize, exact: bool) -> VectorQueryOptions {
    let filter = match condition {
        0 => None,
        10 => Some(json!({"bucket10": query_row % 10})),
        100 => Some(json!({"bucket100": query_row % 100})),
        _ => unreachable!(),
    };
    VectorQueryOptions {
        mode: if exact || arm == "exact" {
            VectorIndexMode::Exact
        } else {
            VectorIndexMode::Graph
        },
        ef: 128,
        min_score: -1.0,
        filter,
        ..VectorQueryOptions::default()
    }
}

fn compact(result: &VectorSearchResults) -> Result<Vec<Hit>> {
    let hits: Vec<_> = result
        .results
        .iter()
        .map(|hit| Hit {
            id: hit.document_id.clone(),
            score_bits: hit.score.to_bits(),
        })
        .collect();
    ensure!(
        hits.iter().map(|h| &h.id).collect::<HashSet<_>>().len() == hits.len(),
        "duplicate document hit"
    );
    ensure!(hits.len() == K, "wrong hit count");
    Ok(hits)
}

fn validate_text(source: &str, start: usize, end: usize, text: Option<&str>) -> Result<()> {
    let span = source.get(start..end).context("invalid document span")?;
    ensure!(text == Some(span), "stale document text");
    ensure!(
        source[..start].trim().is_empty() && source[end..].trim().is_empty(),
        "incomplete single chunk"
    );
    Ok(())
}

fn validate_live(
    result: &VectorSearchResults,
    workload: &Workload,
    condition: usize,
    query: usize,
    modified: bool,
) -> Result<()> {
    for hit in &result.results {
        let row = *workload
            .rows_by_id
            .get(hit.document_id.as_str())
            .context("unknown document ID")?;
        ensure!(
            condition == 0 || row % condition == query % condition,
            "ineligible result"
        );
        let deleted = modified && row >= 125 && (row - 125) % 250 == 0;
        ensure!(!deleted, "deleted document returned");
        let replaced = modified && row % 250 == 0;
        let content_row = if replaced { row + 1 } else { row };
        validate_text(
            &workload.input.documents[content_row].text,
            hit.start_byte as usize,
            hit.end_byte as usize,
            hit.text.as_deref(),
        )?;
        ensure!(
            hit.version
                == if replaced {
                    "replacement-v2"
                } else {
                    "fresh-v1"
                },
            "stale document version"
        );
        ensure!(hit.metadata["row"] == row, "wrong document metadata");
    }
    Ok(())
}

fn build(core: &WarmCore, arm: &str) -> Result<()> {
    ensure!(
        core.rebuild_vector_index(if arm == "exact" { 5184 } else { 1 })?,
        "snapshot build failed"
    );
    ensure!(
        core.vector_index_status().graph == (arm != "exact"),
        "wrong graph state"
    );
    Ok(())
}

fn rss() -> Result<u64> {
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()?;
    ensure!(output.status.success(), "RSS sample failed");
    Ok(String::from_utf8(output.stdout)?.trim().parse::<u64>()? * 1024)
}

fn peak_rss() -> Result<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    ensure!(
        unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } == 0,
        "getrusage failed"
    );
    let value = unsafe { usage.assume_init() }.ru_maxrss as u64;
    Ok(if cfg!(target_os = "macos") {
        value
    } else {
        value * 1024
    })
}

fn disk(path: &Path) -> Result<BTreeMap<String, u64>> {
    fn visit(base: &Path, path: &Path, out: &mut BTreeMap<String, u64>) -> Result<()> {
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_dir() {
                visit(base, &entry.path(), out)?;
            } else if kind.is_file() {
                out.insert(
                    entry
                        .path()
                        .strip_prefix(base)?
                        .to_string_lossy()
                        .into_owned(),
                    entry.metadata()?.len(),
                );
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    visit(path, path, &mut out)?;
    Ok(out)
}

fn ingest(config: &Config, workload: &Workload) -> Result<Value> {
    ensure!(!config.store.exists(), "ingest requires a new store");
    let started = Instant::now();
    let core = open(config, workload)?;
    let open_seconds = started.elapsed().as_secs_f64();
    let started = Instant::now();
    for first in (0..workload.input.documents.len()).step_by(128) {
        let end = (first + 128).min(workload.input.documents.len());
        let counts = core.memorize_documents(
            (first..end)
                .map(|i| document(workload, i, i, false))
                .collect(),
        )?;
        ensure!(counts.iter().all(|&n| n == 1), "unexpected chunk count");
    }
    let acknowledgement_seconds = started.elapsed().as_secs_f64();
    let started = Instant::now();
    core.flush()?;
    let flush_seconds = started.elapsed().as_secs_f64();
    let started = Instant::now();
    build(&core, &config.arm)?;
    Ok(
        json!({"arm": config.arm, "open_seconds": open_seconds, "ingest_acknowledgement_seconds": acknowledgement_seconds,
        "flush_seconds": flush_seconds, "build_seconds": started.elapsed().as_secs_f64(),
        "index_status": core.vector_index_status(), "serving_rss_bytes": rss()?, "peak_rss_bytes": peak_rss()?,
        "retained_full_vector_bytes": workload.input.documents.len() * DIM * 4, "store_files": disk(&config.store)?}),
    )
}

fn query_pass(
    core: &WarmCore,
    config: &Config,
    workload: &Workload,
    measured: bool,
    oracle: bool,
) -> Result<Vec<Value>> {
    let mut records = Vec::new();
    for condition in [0, 10, 100] {
        for (qi, query) in workload.queries.iter().enumerate() {
            let opts = options(&config.arm, condition, qi, false);
            let started = measured.then(Instant::now);
            let result = core.search_vectors_with_report(query, K, &opts)?;
            let latency_ns = started.map(|s| s.elapsed().as_nanos() as u64);
            let hits = compact(&result)?;
            validate_live(&result, workload, condition, qi, false)?;
            if condition != 0 {
                ensure!(
                    result.diagnostics.route == VectorSearchRoute::FilteredExact,
                    "filter did not take exact route"
                );
            } else {
                let expected_route = match config.arm.as_str() {
                    "exact" => VectorSearchRoute::FullExact,
                    "full100" | "full50" => VectorSearchRoute::FullGraph,
                    "prefix256" | "prefix512" => VectorSearchRoute::ProjectedGraph,
                    _ => anyhow::bail!("unknown arm"),
                };
                ensure!(
                    result.diagnostics.route == expected_route,
                    "initial query used an unexpected route: {:?}",
                    result.diagnostics.route
                );
            }
            let reference = if oracle {
                let exact = core.search_vectors_with_report(
                    query,
                    K,
                    &options(&config.arm, condition, qi, true),
                )?;
                let expected = compact(&exact)?;
                if condition != 0 || config.arm == "exact" {
                    ensure!(hits == expected, "exact eligibility/ranking mismatch");
                }
                Some(expected)
            } else {
                None
            };
            records.push(json!({"query_id": workload.input.queries[qi].id, "condition": condition,
                "hits": hits, "exact_hits": reference, "diagnostics": result.diagnostics, "latency_ns": latency_ns}));
        }
    }
    Ok(records)
}

fn query(config: &Config, workload: &Workload, measured: bool) -> Result<Value> {
    ensure!(config.store.exists(), "missing prepared store");
    let workload_rss = rss()?;
    let started = Instant::now();
    let core = open(config, workload)?;
    let open_seconds = started.elapsed().as_secs_f64();
    let started = Instant::now();
    build(&core, &config.arm)?;
    let build_seconds = started.elapsed().as_secs_f64();
    if measured {
        query_pass(&core, config, workload, false, false)?;
    }
    let serving_rss = rss()?;
    let records = query_pass(&core, config, workload, measured, !measured)?;
    Ok(
        json!({"arm": config.arm, "measured": measured, "open_seconds": open_seconds, "build_seconds": build_seconds,
        "index_status": core.vector_index_status(), "serving_rss_bytes": serving_rss, "peak_rss_bytes": peak_rss()?,
        "workload_only_rss_bytes": workload_rss,
        "harness_f64_vector_bytes": (workload.corpus.len() + workload.queries.len()) * DIM * 8,
        "store_files": disk(&config.store)?, "records": records}),
    )
}

fn lifecycle_stage(
    core: &WarmCore,
    config: &Config,
    workload: &Workload,
    stage: &str,
) -> Result<Value> {
    let mut routes = BTreeMap::<String, usize>::new();
    let mut mismatches = Vec::new();
    for condition in [0, 10, 100] {
        for (qi, query) in workload.queries.iter().enumerate() {
            let exact = core.search_vectors_with_report(
                query,
                K,
                &options(&config.arm, condition, qi, true),
            )?;
            let expected = compact(&exact)?;
            validate_live(&exact, workload, condition, qi, true)?;
            let result = core.search_vectors_with_report(
                query,
                K,
                &options(&config.arm, condition, qi, false),
            )?;
            let hits = compact(&result)?;
            validate_live(&result, workload, condition, qi, true)?;
            *routes
                .entry(format!("{:?}", result.diagnostics.route))
                .or_default() += 1;
            let must_match = stage == "stale" || condition != 0 || config.arm == "exact";
            if must_match {
                ensure!(hits == expected, "lifecycle authoritative exact mismatch");
            }
            if stage == "stale" && condition == 0 && config.arm != "exact" {
                ensure!(
                    result.diagnostics.route == VectorSearchRoute::StaleExact,
                    "stale configured graph did not fall back to exact"
                );
            }
            if condition != 0 {
                ensure!(
                    result.diagnostics.route == VectorSearchRoute::FilteredExact,
                    "filtered lifecycle route"
                );
            }
            let found: HashSet<_> = hits.iter().map(|h| h.id.as_str()).collect();
            let missing: Vec<_> = expected
                .iter()
                .filter(|h| !found.contains(h.id.as_str()))
                .map(|h| &h.id)
                .collect();
            if !missing.is_empty() {
                mismatches.push(json!({"query_id": workload.input.queries[qi].id,
                "condition": condition, "missed_exact_ids": missing}));
            }
        }
    }
    Ok(
        json!({"stage": stage, "queries_checked": 900, "routes": routes, "graph_misses": mismatches,
        "index_status": core.vector_index_status()}),
    )
}

fn mutate(config: &Config, workload: &Workload) -> Result<Value> {
    ensure!(config.store.exists(), "missing lifecycle store copy");
    let core = open(config, workload)?;
    build(&core, &config.arm)?;
    for i in (0..workload.input.documents.len()).step_by(250) {
        core.memorize_document(document(workload, i, i + 1, true))?;
    }
    for i in (125..workload.input.documents.len()).step_by(250) {
        ensure!(
            core.delete_document(&workload.input.documents[i].id)?,
            "delete absent row"
        );
    }
    ensure!(
        core.vector_index_status().stale_mutations == 42,
        "unexpected mutation count"
    );
    let stale = lifecycle_stage(&core, config, workload, "stale")?;
    core.flush()?;
    Ok(
        json!({"arm":config.arm,"pid":std::process::id(),"stages":[stale],"flushed":true,"peak_rss_bytes":peak_rss()?}),
    )
}

fn reopen(config: &Config, workload: &Workload) -> Result<Value> {
    ensure!(config.store.exists(), "missing mutated lifecycle store");
    let core = open(config, workload)?;
    // Exact first makes the normal reopen-derived snapshot available before graph calls.
    core.search_vectors_with_report(&workload.queries[0], K, &options(&config.arm, 0, 0, true))?;
    let reopened = lifecycle_stage(&core, config, workload, "reopened")?;
    build(&core, &config.arm)?;
    let rebuilt = lifecycle_stage(&core, config, workload, "rebuilt")?;
    Ok(
        json!({"arm": config.arm, "pid":std::process::id(), "stages": [reopened, rebuilt], "peak_rss_bytes": peak_rss()?}),
    )
}

fn main() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    let command = args
        .next()
        .context("usage: evaluate COMMAND CONFIG.json")?
        .into_string()
        .map_err(|_| anyhow::anyhow!("invalid command"))?;
    let config: Config =
        serde_json::from_slice(&fs::read(args.next().context("missing config")?)?)?;
    ensure!(!config.output.exists(), "refusing to replace run output");
    let workload = load(&config)?;
    let result = match command.as_str() {
        "ingest" => ingest(&config, &workload)?,
        "quality" => query(&config, &workload, false)?,
        "bench" => query(&config, &workload, true)?,
        "mutate" => mutate(&config, &workload)?,
        "reopen" => reopen(&config, &workload)?,
        _ => anyhow::bail!("unknown command"),
    };
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&config.output)?;
    serde_json::to_writer(&mut file, &result)?;
    file.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_text_validation_preserves_source_offsets_and_boundary_whitespace() {
        let source = " \nα study\n ";
        validate_text(source, 2, source.len() - 2, Some("α study")).unwrap();
        assert!(validate_text(source, 3, source.len() - 2, Some("study")).is_err());
        assert!(validate_text(source, 5, source.len() - 2, Some("study")).is_err());
        assert!(validate_text(source, 2, source.len() - 2, Some("old study")).is_err());
    }

    fn fixture_document(id: usize, values: &[f64]) -> DocumentInput {
        DocumentInput {
            id: format!("doc-{id:03}"),
            text: format!("retained fixture {id}"),
            source_uri: None,
            version: Some("v1".into()),
            metadata: Some(json!({"group": id % 2})),
            chunk_words: Some(4096),
            overlap_words: Some(0),
            store_text: Some(true),
            embeddings: Some(vec![values.to_vec()]),
            title_weight: None,
        }
    }

    fn scalar_cosine(query: &[f64], raw: &[f64]) -> f64 {
        let qnorm = query.iter().map(|v| v * v).sum::<f64>().sqrt();
        let dnorm = raw.iter().map(|v| v * v).sum::<f64>().sqrt();
        query
            .iter()
            .zip(raw)
            .map(|(&q, &d)| (q / qnorm) * f64::from((d / dnorm) as f32))
            .sum::<f64>()
            .clamp(-1.0, 1.0)
    }

    #[test]
    fn native_modes_match_independent_scalar_oracle_with_complete_shortlist() {
        for width in [256, 512, 1024] {
            let directory = tempfile::tempdir().unwrap();
            let config = WarmConfig {
                embedding_space: Some(EmbeddingSpace {
                    model: "synthetic".into(),
                    revision: "fixture-v1".into(),
                    dimensions: DIM,
                    normalization: "l2".into(),
                    metric: "cosine".into(),
                }),
                vector_candidates: Some(VectorCandidateConfig {
                    dimensions: width,
                    rerank_candidates: 32,
                }),
                ..WarmConfig::default()
            };
            let core = WarmCore::new(
                DIM as u32,
                Some(directory.path().to_string_lossy().into_owned()),
                Some(config.clone()),
            )
            .unwrap();
            let raw: Vec<Vec<f64>> = (0..24)
                .map(|i| {
                    let mut v = vec![0.0; DIM];
                    v[0] = 1.0;
                    v[1] = (i as f64 - 11.0) / 8.0;
                    v[DIM - 1] = (i % 3) as f64 / 5.0;
                    v
                })
                .collect();
            core.memorize_documents(
                raw.iter()
                    .enumerate()
                    .map(|(i, v)| fixture_document(i, v))
                    .collect(),
            )
            .unwrap();
            core.rebuild_vector_index(1).unwrap();
            let mut query = vec![0.0; DIM];
            query[0] = 1.0;
            query[1] = 0.37;
            query[DIM - 1] = 0.2;
            let mut reference: Vec<_> = raw
                .iter()
                .enumerate()
                .map(|(i, v)| (format!("doc-{i:03}"), scalar_cosine(&query, v)))
                .collect();
            reference.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
            for mode in [VectorIndexMode::Exact, VectorIndexMode::Graph] {
                let result = core
                    .search_vectors_with_report(
                        &query,
                        K,
                        &VectorQueryOptions {
                            mode,
                            ..VectorQueryOptions::default()
                        },
                    )
                    .unwrap();
                assert_eq!(
                    result
                        .results
                        .iter()
                        .map(|h| h.document_id.as_str())
                        .collect::<Vec<_>>(),
                    reference
                        .iter()
                        .take(K)
                        .map(|r| r.0.as_str())
                        .collect::<Vec<_>>()
                );
                for (hit, expected) in result.results.iter().zip(&reference) {
                    assert!((hit.score - expected.1).abs() < 1e-12);
                }
                if mode == VectorIndexMode::Graph {
                    assert_eq!(
                        result.diagnostics.route,
                        if width == DIM {
                            VectorSearchRoute::FullGraph
                        } else {
                            VectorSearchRoute::ProjectedGraph
                        }
                    );
                }
            }
            let filtered = core
                .search_vectors_with_report(
                    &query,
                    K,
                    &VectorQueryOptions {
                        mode: VectorIndexMode::Graph,
                        filter: Some(json!({"group":1})),
                        ..VectorQueryOptions::default()
                    },
                )
                .unwrap();
            assert_eq!(filtered.diagnostics.route, VectorSearchRoute::FilteredExact);
            let expected: Vec<_> = reference
                .iter()
                .filter(|r| r.0[4..].parse::<usize>().unwrap() % 2 == 1)
                .take(K)
                .map(|r| r.0.as_str())
                .collect();
            assert_eq!(
                filtered
                    .results
                    .iter()
                    .map(|h| h.document_id.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
            core.memorize_document(fixture_document(3, &raw[17]))
                .unwrap();
            core.delete_document("doc-005").unwrap();
            let stale = core
                .search_vectors_with_report(
                    &query,
                    K,
                    &VectorQueryOptions {
                        mode: VectorIndexMode::Graph,
                        ..VectorQueryOptions::default()
                    },
                )
                .unwrap();
            assert_eq!(stale.diagnostics.route, VectorSearchRoute::StaleExact);
            assert!(!stale.results.iter().any(|h| h.document_id == "doc-005"));
            let exact = core
                .search_vectors_with_report(
                    &query,
                    K,
                    &VectorQueryOptions {
                        mode: VectorIndexMode::Exact,
                        ..VectorQueryOptions::default()
                    },
                )
                .unwrap();
            assert_eq!(compact(&stale).unwrap(), compact(&exact).unwrap());
            core.flush().unwrap();
            drop(core);
            let reopened = WarmCore::new(
                DIM as u32,
                Some(directory.path().to_string_lossy().into_owned()),
                Some(config),
            )
            .unwrap();
            reopened.rebuild_vector_index(1).unwrap();
            let result = reopened
                .search_vectors_with_report(
                    &query,
                    K,
                    &VectorQueryOptions {
                        mode: VectorIndexMode::Graph,
                        ..VectorQueryOptions::default()
                    },
                )
                .unwrap();
            assert_eq!(compact(&result).unwrap(), compact(&exact).unwrap());
        }
    }

    #[test]
    fn native_zero_prefix_and_ties_use_full_space_stable_order() {
        let directory = tempfile::tempdir().unwrap();
        let core = WarmCore::new(
            DIM as u32,
            Some(directory.path().to_string_lossy().into_owned()),
            Some(WarmConfig {
                embedding_space: Some(EmbeddingSpace {
                    model: "synthetic".into(),
                    revision: "zero-prefix".into(),
                    dimensions: DIM,
                    normalization: "l2".into(),
                    metric: "cosine".into(),
                }),
                vector_candidates: Some(VectorCandidateConfig {
                    dimensions: 256,
                    rerank_candidates: 20,
                }),
                ..WarmConfig::default()
            }),
        )
        .unwrap();
        let mut vector = vec![0.0; DIM];
        vector[DIM - 1] = 1.0;
        core.memorize_documents(
            (0..12)
                .rev()
                .map(|i| fixture_document(i, &vector))
                .collect(),
        )
        .unwrap();
        core.rebuild_vector_index(1).unwrap();
        let result = core
            .search_vectors_with_report(
                &vector,
                K,
                &VectorQueryOptions {
                    mode: VectorIndexMode::Graph,
                    ..VectorQueryOptions::default()
                },
            )
            .unwrap();
        assert_eq!(result.diagnostics.route, VectorSearchRoute::FallbackExact);
        assert_eq!(
            result
                .results
                .iter()
                .map(|h| h.document_id.clone())
                .collect::<Vec<_>>(),
            (0..K).map(|i| format!("doc-{i:03}")).collect::<Vec<_>>()
        );
    }
}
