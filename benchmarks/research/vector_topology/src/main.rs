// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Write},
    path::Path,
};
use writerslogic_warm::core::qgraph::{BuildParams, Graph, VGraph, VSearchParams};

const ROWS: usize = 100_000;
const DIM: usize = 100;
const QUERIES: usize = 1000;
const K: usize = 10;

fn matrix(path: &Path, rows: usize) -> Result<Vec<f32>> {
    let bytes = fs::read(path)?;
    ensure!(bytes.len() == rows * DIM * 4, "incorrect matrix length");
    let values: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    ensure!(
        values.iter().all(|value| value.is_finite()),
        "nonfinite input"
    );
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
        ensure!(unique.len() == K, "duplicate oracle hit");
        ensure!(
            queries.insert(query, hits).is_none(),
            "duplicate oracle query"
        );
    }
    ensure!(
        queries.len() == QUERIES && queries.keys().copied().eq(0..QUERIES),
        "incomplete oracle"
    );
    Ok(queries.into_values().collect())
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    ensure!(args.len() == 6, "usage: warm-vector-topology-development CORPUS QUERIES ORACLE OUTPUT default|degree48|degree64");
    let mode = args[5].to_str().context("mode is not UTF-8")?;
    let (degree, build_ef) = match mode {
        "default" => (32, 128),
        "degree48" => (48, 400),
        "degree64" => (64, 500),
        _ => anyhow::bail!("unsupported development configuration"),
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
        .map(|value| value as f32)
        .collect::<Vec<_>>();
    let graph = Graph::build_owned(
        stored.clone(),
        DIM,
        &BuildParams {
            degree,
            build_ef,
            ..Default::default()
        },
    )?;
    let graph_hash = format!("{:016x}", graph.structure_hash());
    let index = VGraph::from_graph(&graph, true)?;
    let mut output = BufWriter::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&args[4])?,
    );
    writeln!(
        output,
        "{}",
        json!({"type":"start", "mode":mode, "degree":degree, "buildEf":build_ef, "graphHash":graph_hash, "rows":ROWS, "queries":QUERIES, "scope":"unfiltered development quality; no timings or competitive claims"})
    )?;
    for ef in [128, 256, 512] {
        let mut total = 0usize;
        let mut worst = K;
        let mut below90 = 0usize;
        let mut searcher = index.searcher();
        let mut ids = Vec::new();
        for (query_id, row) in queries.chunks_exact(DIM).enumerate() {
            let q = normalized(row)?;
            let q32: Vec<_> = q.iter().map(|&v| v as f32).collect();
            searcher.search(
                &q32,
                K + 8,
                VSearchParams {
                    ef,
                    rerank: ef,
                    ..Default::default()
                },
                &mut ids,
            )?;
            ensure!(
                ids.len() == K + 8 && ids.iter().all(|&id| id < ROWS as u32),
                "invalid graph candidate"
            );
            let mut distinct = ids.clone();
            distinct.sort_unstable();
            distinct.dedup();
            ensure!(distinct.len() == ids.len(), "duplicate graph candidate");
            let mut ranked: Vec<_> = ids
                .iter()
                .map(|&id| {
                    let score = stored[id as usize * DIM..(id as usize + 1) * DIM]
                        .iter()
                        .zip(&q)
                        .map(|(&x, &y)| f64::from(x) * y)
                        .sum::<f64>()
                        .clamp(-1.0, 1.0);
                    (id, score)
                })
                .collect();
            ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
            let selected: Vec<_> = ranked.iter().take(K).map(|&(id, _)| id).collect();
            let matched = selected
                .iter()
                .filter(|id| truth[query_id].contains(id))
                .count();
            total += matched;
            worst = worst.min(matched);
            below90 += usize::from(matched < 9);
            writeln!(
                output,
                "{}",
                json!({"type":"query", "ef":ef, "query":query_id, "ids":selected, "matched":matched})
            )?;
        }
        writeln!(
            output,
            "{}",
            json!({"type":"summary", "ef":ef, "meanRecall": total as f64 / (QUERIES * K) as f64, "worstRecall": worst as f64 / K as f64, "below90":below90})
        )?;
        output.flush()?;
    }
    Ok(())
}
