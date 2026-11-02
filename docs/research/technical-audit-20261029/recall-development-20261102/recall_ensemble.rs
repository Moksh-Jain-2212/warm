use std::{fs, io::{BufRead,BufReader}, time::Instant};
use writerslogic_warm::core::qgraph::{BuildParams,Graph,VGraph,VSearchParams};
const D:usize=100;
fn read_rows(p:&str)->Vec<f32>{fs::read(p).unwrap().chunks_exact(4).map(|b|f32::from_le_bytes(b.try_into().unwrap())).collect()}
fn norm(row:&[f32])->Vec<f64>{let s=row.iter().map(|x|f64::from(x.abs())).fold(0f64,f64::max);let n=row.iter().map(|&x|(f64::from(x)/s).powi(2)).sum::<f64>().sqrt();row.iter().map(|&x|(f64::from(x)/s)/n).collect()}
fn main(){
 let root="/Volumes/A/.hms-bench-cache/competitive/data/glove-100-angular-n100000-q1000";
 let mut rows=read_rows(&format!("{root}/train.f32"));rows.truncate(100_000*D);let queries=read_rows(&format!("{root}/test.f32"));
 for row in rows.chunks_exact_mut(D){let normalized=norm(row);for (x,v) in row.iter_mut().zip(normalized){*x=v as f32;}}
 let file=fs::File::open("/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen/results/preparation-0030-glove-100000-oracle-oracle.ndjson").unwrap();let mut truth=vec![Vec::new();1000];
 for l in BufReader::new(file).lines(){let v:serde_json::Value=serde_json::from_str(&l.unwrap()).unwrap();if v["type"]=="oracle"&&v["state"]=="baseline"&&v["filter"]=="all"{truth[v["query"].as_u64().unwrap() as usize]=v["hits"].as_array().unwrap().iter().map(|h|h["ordinal"].as_u64().unwrap() as u32).collect();}}
 assert!(truth.iter().all(|v|v.len()==10));let count:usize=std::env::var("ENSEMBLE_COUNT").ok().and_then(|v|v.parse().ok()).unwrap_or(8);let mut graphs=Vec::new();
 for i in 0..count{let p=BuildParams{seed:0x5EED + i as u64, ..Default::default()};let start=Instant::now();let g=Graph::build(&rows,D,&p).unwrap();graphs.push(VGraph::from_graph(&g,true).unwrap());eprintln!("graph {i} built {:?}",start.elapsed());}
 for count in [1usize,2,4,8].into_iter().filter(|&n|n<=graphs.len()){for ef in [128,256,512]{let start=Instant::now();let mut searchers:Vec<_>=graphs[..count].iter().map(VGraph::searcher).collect();let(mut total,mut worst,mut miss)=(0,10,0);let mut ids=Vec::new();let mut all=Vec::new();
 for (qi,query) in queries.chunks_exact(D).enumerate(){let q=norm(query);let qf:Vec<f32>=q.iter().map(|v|*v as f32).collect();all.clear();for s in &mut searchers{s.search(&qf,18,VSearchParams{ef,rerank:ef,..Default::default()},&mut ids).unwrap();all.extend_from_slice(&ids);}all.sort_unstable();all.dedup();let mut scored:Vec<_>=all.iter().map(|&id|{let score=rows[id as usize*D..(id as usize+1)*D].iter().zip(&q).map(|(&x,&y)|f64::from(x)*y).sum::<f64>();(id,score)}).collect();scored.sort_unstable_by(|a,b|b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));let hits=scored.iter().take(10).filter(|(id,_)|truth[qi].contains(id)).count();total+=hits;worst=worst.min(hits);if hits<10{miss+=1;}}
 println!("graphs={count} ef={ef} recall={:.5} worst={} missed_queries={} elapsed={:?}",total as f64/10000.,worst,miss,start.elapsed());}}
}
