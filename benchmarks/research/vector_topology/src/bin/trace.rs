// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    path::Path,
    time::Instant,
};
use writerslogic_warm::core::qgraph::{
    diagnostics::TraversalDiagnostic, BuildParams, Graph, SearchKnobs, VGraph, VSearchParams,
};

const ROWS: usize = 100_000;
const DIM: usize = 100;
const QUERIES: usize = 1000;
const K: usize = 10;
const FETCH: usize = K + 8;

fn matrix(path: &Path, rows: usize) -> Result<Vec<f32>> {
    let bytes = fs::read(path)?;
    ensure!(bytes.len() == rows * DIM * 4, "incorrect matrix length");
    let values: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    ensure!(values.iter().all(|x| x.is_finite()), "nonfinite input");
    Ok(values)
}

fn normalized(row: &[f32]) -> Result<Vec<f64>> {
    let scale = row.iter().map(|&x| f64::from(x).abs()).fold(0.0, f64::max);
    ensure!(scale > 0.0, "zero input");
    let norm = row
        .iter()
        .map(|&x| (f64::from(x) / scale).powi(2))
        .sum::<f64>()
        .sqrt();
    Ok(row.iter().map(|&x| (f64::from(x) / scale) / norm).collect())
}

fn oracle(path: &Path) -> Result<Vec<Vec<u32>>> {
    let mut queries = BTreeMap::new();
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let row: Value = serde_json::from_str(&line?)?;
        if row["type"] != "oracle" || row["state"] != "baseline" || row["filter"] != "all" {
            continue;
        }
        let query = row["query"].as_u64().context("oracle query")? as usize;
        ensure!(
            query < QUERIES
                && row["dataset"] == "glove-100000"
                && row["queryId"] == format!("query-{query}"),
            "invalid oracle query identity"
        );
        let hits = row["hits"]
            .as_array()
            .context("oracle hits")?
            .iter()
            .map(|hit| {
                hit["ordinal"]
                    .as_u64()
                    .context("oracle ordinal")
                    .and_then(|id| u32::try_from(id).context("oracle ordinal overflow"))
            })
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            hits.len() == K && hits.iter().all(|&id| id < ROWS as u32),
            "invalid oracle hits"
        );
        let mut unique = hits.clone();
        unique.sort_unstable();
        unique.dedup();
        ensure!(
            unique.len() == K && queries.insert(query, hits).is_none(),
            "duplicate oracle data"
        );
    }
    ensure!(
        queries.len() == QUERIES && queries.keys().copied().eq(0..QUERIES),
        "incomplete oracle"
    );
    Ok(queries.into_values().collect())
}

fn rank(ids: &[u32], stored: &[f32], q: &[f64]) -> Result<Vec<u32>> {
    ensure!(
        ids.len() == FETCH && ids.iter().all(|&id| id < ROWS as u32),
        "invalid candidates"
    );
    let mut distinct = ids.to_vec();
    distinct.sort_unstable();
    distinct.dedup();
    ensure!(distinct.len() == FETCH, "duplicate candidates");
    let mut ranked: Vec<_> = ids
        .iter()
        .map(|&id| {
            let score = stored[id as usize * DIM..(id as usize + 1) * DIM]
                .iter()
                .zip(q)
                .map(|(&x, &y)| f64::from(x) * y)
                .sum::<f64>()
                .clamp(-1.0, 1.0);
            (id, score)
        })
        .collect();
    ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    Ok(ranked.iter().take(K).map(|&(id, _)| id).collect())
}

fn first_missing(id: u32, stages: [&[u32]; 5]) -> usize {
    stages
        .iter()
        .position(|stage| !stage.contains(&id))
        .unwrap_or(stages.len())
}

fn trace(report: &TraversalDiagnostic, selected: &[u32], truth: &[u32]) -> Result<Value> {
    let stages: [&[u32]; 5] = [
        &report.evaluated,
        &report.retained,
        &report.rerank_candidates,
        &report.results,
        selected,
    ];
    let mut classes = [0usize; 6];
    for &id in truth {
        let first = first_missing(id, stages);
        for stage in &stages[first.min(stages.len())..] {
            ensure!(
                !stage.contains(&id),
                "oracle neighbor reappeared after missing a stage"
            );
        }
        classes[first] += 1;
    }
    let coverage: Vec<Vec<u32>> = stages
        .iter()
        .map(|stage| {
            truth
                .iter()
                .copied()
                .filter(|id| stage.contains(id))
                .collect()
        })
        .collect();
    Ok(
        json!({"classes":classes, "oracleCoverage":coverage, "evaluatedCount":report.evaluated.len(), "beamCount":report.beam.len(), "retainedCount":report.retained.len(), "rerankCount":report.rerank_candidates.len(), "shortlist":report.results, "selected":selected}),
    )
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    ensure!(
        args.len() == 6,
        "usage: trace CORPUS QUERIES ORACLE OUTPUT default|degree64"
    );
    let mode = args[5].to_str().context("mode")?;
    let (degree, build_ef, efs): (usize, usize, &[usize]) = match mode {
        "default" => (32, 128, &[512, 2048]),
        "degree64" => (64, 500, &[512]),
        _ => anyhow::bail!("unsupported diagnostic mode"),
    };
    let corpus = matrix(Path::new(&args[1]), ROWS)?;
    let queries = matrix(Path::new(&args[2]), QUERIES)?;
    let truth = oracle(Path::new(&args[3]))?;
    let stored = corpus
        .chunks_exact(DIM)
        .map(normalized)
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .flatten()
        .map(|x| x as f32)
        .collect::<Vec<_>>();
    let q64 = queries
        .chunks_exact(DIM)
        .map(normalized)
        .collect::<Result<Vec<_>>>()?;
    let q32: Vec<Vec<f32>> = q64
        .iter()
        .map(|q| q.iter().map(|&x| x as f32).collect())
        .collect();
    let start = Instant::now();
    let graph = Graph::build_owned(
        stored.clone(),
        DIM,
        &BuildParams {
            degree,
            build_ef,
            ..Default::default()
        },
    )?;
    let build_ns = start.elapsed().as_nanos();
    let graph_hash = format!("{:016x}", graph.structure_hash());
    let start = Instant::now();
    let mut index = VGraph::from_graph(&graph, true)?;
    let encode_ns = start.elapsed().as_nanos();
    let mut output = BufWriter::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&args[4])?,
    );
    writeln!(
        output,
        "{}",
        json!({"type":"start", "mode":mode, "degree":degree, "buildEf":build_ef, "graphHash":graph_hash, "buildNs":build_ns, "encodeNs":encode_ns, "indexBytes":index.index_bytes(), "indexBreakdown":index.memory_breakdown(), "scope":"shared-host standalone diagnostic; not study timing"})
    )?;
    for &ef in efs {
        let params = VSearchParams {
            ef,
            rerank: ef,
            ..Default::default()
        };
        for query in 0..QUERIES {
            let coded = index.diagnose(&graph, &q32[query], FETCH, params, None, false)?;
            let selected = rank(&coded.results, &stored, &q64[query])?;
            let exact = index.diagnose(&graph, &q32[query], FETCH, params, None, true)?;
            let exact_selected = rank(&exact.results, &stored, &q64[query])?;
            writeln!(
                output,
                "{}",
                json!({"type":"trace", "ef":ef, "query":query, "coded":trace(&coded, &selected, &truth[query])?, "exactRouting":trace(&exact, &exact_selected, &truth[query])?})
            )?;
        }
        output.flush()?;
        for repetition in 0..3 {
            let mut searcher = index.searcher_with(SearchKnobs::OFF);
            let mut ids = Vec::new();
            for query in 0..20 {
                searcher.search(&q32[query], FETCH, params, &mut ids)?;
                std::hint::black_box(rank(&ids, &stored, &q64[query])?);
            }
            for query in 0..QUERIES {
                let start = Instant::now();
                searcher.search(&q32[query], FETCH, params, &mut ids)?;
                let selected = rank(&ids, &stored, &q64[query])?;
                let elapsed = start.elapsed().as_nanos();
                writeln!(
                    output,
                    "{}",
                    json!({"type":"timing", "ef":ef, "repetition":repetition, "query":query, "ns":elapsed, "selected":selected})
                )?;
            }
            output.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_absence_classifies_each_boundary() {
        let a = [1, 2, 3, 4, 5];
        let b = [1, 2, 3, 4];
        let c = [1, 2, 3];
        let d = [1, 2];
        let e = [1];
        let stages = [&a[..], &b[..], &c[..], &d[..], &e[..]];
        for (id, expected) in [(6, 0), (5, 1), (4, 2), (3, 3), (2, 4), (1, 5)] {
            assert_eq!(first_missing(id, stages), expected);
        }
    }
}
