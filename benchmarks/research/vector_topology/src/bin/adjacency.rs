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
    BuildParams, Graph, Residency, SearchKnobs, VGraph, VSearchParams,
};

const ROWS: usize = 100_000;
const DIM: usize = 100;
const QUERIES: usize = 1000;
const DEGREE: usize = 64;
const EF: usize = 512;
const FETCH: usize = 18;
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

fn reference(path: &Path) -> Result<Vec<Vec<u32>>> {
    let mut queries = BTreeMap::new();
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let row: Value = serde_json::from_str(&line?)?;
        if row["type"] != "trace" || row["ef"] != EF {
            continue;
        }
        let query = row["query"].as_u64().context("reference query")? as usize;
        ensure!(query < QUERIES, "reference query outside bounds");
        let ids = row["coded"]["selected"]
            .as_array()
            .context("reference ids")?
            .iter()
            .map(|id| {
                id.as_u64()
                    .context("reference id")
                    .and_then(|id| u32::try_from(id).context("reference id overflow"))
            })
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            ids.len() == K && ids.iter().all(|&id| id < ROWS as u32),
            "invalid reference ids"
        );
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        ensure!(
            unique.len() == K && queries.insert(query, ids).is_none(),
            "duplicate reference data"
        );
    }
    ensure!(
        queries.len() == QUERIES && queries.keys().copied().eq(0..QUERIES),
        "incomplete reference"
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

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args_os().collect();
    ensure!(
        args.len() == 6,
        "usage: adjacency CORPUS QUERIES REFERENCE OUTPUT SAVED_INDEX"
    );
    let corpus = matrix(Path::new(&args[1]), ROWS)?;
    let queries = matrix(Path::new(&args[2]), QUERIES)?;
    let expected = reference(Path::new(&args[3]))?;
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
            degree: DEGREE,
            build_ef: 500,
            ..Default::default()
        },
    )?;
    let build_ns = start.elapsed().as_nanos();
    let graph_hash = format!("{:016x}", graph.structure_hash());
    let start = Instant::now();
    let index4 = VGraph::from_graph(&graph, true)?;
    let encode4_ns = start.elapsed().as_nanos();
    let start = Instant::now();
    let index3 = VGraph::from_graph_with(&graph, 8, 8, false, false, 3, false)?;
    let encode3_ns = start.elapsed().as_nanos();
    ensure!(
        index4.index_bytes().checked_sub(index3.index_bytes()) == Some(ROWS * DEGREE),
        "unexpected index byte difference"
    );
    ensure!(!Path::new(&args[5]).exists(), "saved index already exists");
    index3.save(Path::new(&args[5]))?;
    let reopened = VGraph::open(Path::new(&args[5]), Residency::Heap)?;
    ensure!(
        reopened.index_bytes() == index3.index_bytes(),
        "reopened index byte count changed"
    );
    let mut output = BufWriter::new(
        OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&args[4])?,
    );
    writeln!(
        output,
        "{}",
        json!({"type":"start", "graphHash":graph_hash, "buildNs":build_ns, "encode4Ns":encode4_ns, "encode3Ns":encode3_ns, "index4Bytes":index4.index_bytes(), "index3Bytes":index3.index_bytes(), "index4Breakdown":index4.memory_breakdown(), "index3Breakdown":index3.memory_breakdown(), "savedBytes":fs::metadata(Path::new(&args[5]))?.len(), "scope":"shared-host standalone development; both encodings resident"})
    )?;
    let params = VSearchParams {
        ef: EF,
        rerank: EF,
        ..Default::default()
    };
    let (mut s4, mut s3, mut sr) = (
        index4.searcher_with(SearchKnobs::OFF),
        index3.searcher_with(SearchKnobs::OFF),
        reopened.searcher_with(SearchKnobs::OFF),
    );
    let (mut a, mut b, mut c) = (Vec::new(), Vec::new(), Vec::new());
    for query in 0..QUERIES {
        s4.search(&q32[query], FETCH, params, &mut a)?;
        s3.search(&q32[query], FETCH, params, &mut b)?;
        sr.search(&q32[query], FETCH, params, &mut c)?;
        ensure!(
            a == b && a == c,
            "candidate order changed for query {query}"
        );
        let selected = rank(&a, &stored, &q64[query])?;
        ensure!(
            selected == expected[query],
            "saved ranking differs for query {query}"
        );
        writeln!(
            output,
            "{}",
            json!({"type":"parity", "query":query, "candidates":a, "selected":selected})
        )?;
    }
    output.flush()?;
    for repetition in 0..3 {
        for query in q32.iter().take(20) {
            s4.search(query, FETCH, params, &mut a)?;
            s3.search(query, FETCH, params, &mut b)?;
        }
        for query in 0..QUERIES {
            let first4 = (query + repetition) % 2 == 0;
            let mut ns = [0u128; 2];
            for which in if first4 { [0usize, 1] } else { [1usize, 0] } {
                let start = Instant::now();
                if which == 0 {
                    s4.search(&q32[query], FETCH, params, &mut a)?;
                    std::hint::black_box(rank(&a, &stored, &q64[query])?);
                } else {
                    s3.search(&q32[query], FETCH, params, &mut b)?;
                    std::hint::black_box(rank(&b, &stored, &q64[query])?);
                }
                ns[which] = start.elapsed().as_nanos();
            }
            ensure!(a == b, "timed candidate order changed for query {query}");
            writeln!(
                output,
                "{}",
                json!({"type":"timing", "repetition":repetition, "query":query, "first4":first4, "index4Ns":ns[0], "index3Ns":ns[1]})
            )?;
        }
        output.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_validation_checks_size_uniqueness_and_id_bounds() {
        let mut stored = vec![0.0; FETCH * DIM];
        for i in 0..FETCH {
            stored[i * DIM] = i as f32 / 100.0;
        }
        let mut query = vec![0.0; DIM];
        query[0] = 1.0;
        let ids: Vec<u32> = (0..FETCH as u32).collect();
        assert_eq!(
            rank(&ids, &stored, &query).unwrap(),
            (8..18).rev().collect::<Vec<_>>()
        );
        assert!(rank(&ids[..FETCH - 1], &stored, &query).is_err());
        assert!(rank(&[ids.as_slice(), &[18]].concat(), &stored, &query).is_err());
        let mut duplicate = ids.clone();
        duplicate[FETCH - 1] = duplicate[0];
        assert!(rank(&duplicate, &stored, &query).is_err());
        let mut out_of_range = ids;
        out_of_range[0] = ROWS as u32;
        assert!(rank(&out_of_range, &stored, &query).is_err());
    }
}
