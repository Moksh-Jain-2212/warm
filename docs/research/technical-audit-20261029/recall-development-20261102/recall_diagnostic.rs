use std::{fs, io::{BufRead, BufReader}, time::Instant};
use writerslogic_warm::core::qgraph::{BuildParams, Graph, VGraph, VSearchParams};
const D: usize = 100;
fn read_rows(path: &str) -> Vec<f32> {
    fs::read(path).unwrap().chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect()
}
fn normalize(row: &[f32]) -> Vec<f64> {
    let scale = row.iter().map(|x| f64::from(x.abs())).fold(0f64, f64::max);
    let norm = row.iter().map(|&x| (f64::from(x) / scale).powi(2)).sum::<f64>().sqrt();
    row.iter().map(|&x| (f64::from(x) / scale) / norm).collect()
}
fn main() {
    let root = "/Volumes/A/.hms-bench-cache/competitive/data/glove-100-angular-n100000-q1000";
    let mut rows = read_rows(&format!("{root}/train.f32")); rows.truncate(100_000 * D);
    let queries = read_rows(&format!("{root}/test.f32"));
    for row in rows.chunks_exact_mut(D) { let n = normalize(row); for (x, v) in row.iter_mut().zip(n) { *x = v as f32; } }
    let file = fs::File::open("/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen/results/preparation-0030-glove-100000-oracle-oracle.ndjson").unwrap();
    let mut truth = vec![Vec::new(); 1000];
    for line in BufReader::new(file).lines() { let l = line.unwrap(); let v: serde_json::Value = serde_json::from_str(&l).unwrap(); if v["type"] == "oracle" && v["state"] == "baseline" && v["filter"] == "all" { let q = v["query"].as_u64().unwrap() as usize; truth[q] = v["hits"].as_array().unwrap().iter().map(|h| h["ordinal"].as_u64().unwrap() as u32).collect(); } }
    assert!(truth.iter().all(|v| v.len() == 10));
    let start = Instant::now(); eprintln!("building");
    let mut params = BuildParams::default();
    params.degree = std::env::var("RECALL_DEGREE").ok().and_then(|v| v.parse().ok()).unwrap_or(params.degree);
    params.build_ef = std::env::var("RECALL_BUILD_EF").ok().and_then(|v| v.parse().ok()).unwrap_or(params.build_ef);
    params.alpha = std::env::var("RECALL_ALPHA").ok().and_then(|v| v.parse().ok()).unwrap_or(params.alpha);
    eprintln!("degree={} build_ef={} alpha={}", params.degree, params.build_ef, params.alpha);
    let graph = Graph::build(&rows, D, &params).unwrap();
    let index = VGraph::from_graph(&graph, true).unwrap(); drop(graph); eprintln!("built in {:?}", start.elapsed());
    let arms = [(128,18),(256,18),(512,18),(1024,18),(2048,18),(4096,18)];
    for (ef, shortlist) in arms {
        let mut total = 0; let mut worst = 10; let mut misses = Vec::new(); let start=Instant::now(); let mut searcher=index.searcher(); let mut ids=Vec::new();
        for (qi, query) in queries.chunks_exact(D).enumerate() {
            let q=normalize(query); let qf:Vec<f32>=q.iter().map(|v|*v as f32).collect();
            searcher.search(&qf,shortlist,VSearchParams{ef,rerank:ef,..Default::default()},&mut ids).unwrap();
            ids.sort_unstable_by(|&a,&b| { let score=|id:u32| rows[(id as usize)*D..(id as usize+1)*D].iter().zip(&q).map(|(&x,&y)| f64::from(x)*y).sum::<f64>(); score(b).total_cmp(&score(a)).then(a.cmp(&b)) });
            let hits=ids.iter().take(10).filter(|id|truth[qi].contains(id)).count(); total+=hits; worst=worst.min(hits); if hits<10 { misses.push((qi,hits)); }
        }
        println!("ef={ef} shortlist={shortlist} recall={:.5} worst={} missed_queries={} q241={:?} elapsed={:?}", total as f64/10000.,worst,misses.len(),misses.iter().find(|(q,_)|*q==241),start.elapsed());
    }
}
