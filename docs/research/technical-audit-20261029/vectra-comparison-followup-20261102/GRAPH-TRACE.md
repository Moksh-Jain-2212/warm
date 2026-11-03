<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Graph traversal and profile comparison

The [predeclared local diagnostic](../../../../benchmarks/research/vector_topology/TRACE-PLAN.md)
completed at `/Volumes/A/.hms-bench-cache/warm-graph-trace-20261102-v1`.
It used the same 100,000 GloVe vectors and 1,000 already-exposed queries as the
previous development work. All 3,000 traced ordered rankings matched the
corresponding saved results, and graph structure hashes matched the prior builds.
The raw trace, every timing sample, inputs and reference hashes, source copies,
binary, resource observations and receipts are retained in that directory.
This is not held-out quality evidence or a restarted study.
The `finished.json` SHA-256 is
`f01dc8cf15bb3db97f2991ba9015a7cdcf07fc8f7b8cbca4272208cb5529fab6`.

| Profile | Search ef | Mean / worst recall | Missing oracle neighbors | First missing at evaluation |
|---|---:|---:|---:|---:|
| degree 32, build ef 128 | 512 | 0.9859 / 0.60 | 141 | 141 |
| degree 32, build ef 128 | 2048 | 0.9993 / 0.90 | 7 | 7 |
| degree 64, build ef 500 | 512 | 0.9985 / 0.90 | 15 | 15 |

For these queries, no missed oracle neighbor was evaluated and then lost at
retention, residual-rerank input, the 18-candidate shortlist, or the final
rescore. The ef-512 default fails both fixed quality criteria; the other two
pass them on this exposed set. The diagnostic's "evaluated" set includes
upper-layer and base traversal. It does not prove why a particular neighbor was
not reached, or rule out loss mechanisms on other inputs.

With the same graph topology and uncompressed routing scores substituted only in
the diagnostic (f64 accumulation cast to f32), default ef 512 missed 140 oracle neighbors versus 141 with coded
routing; 139 misses were shared, two occurred only with coded routing and one
only with exact routing. At ef 2048 the same seven were missed by both. The
degree-64 ef-512 control had 14 shared misses and one coded-only miss. This
counterfactual still uses the compact residual rerank and is not production
exact search. It suggests that replacing routing scores alone is unlikely to
resolve most of these observed misses. The independently reproducible overlap
analysis is `coverage-analysis.json` in the diagnostic directory.

The following are **exploratory shared-host diagnostics**, not qualified
benchmark results. Each search used a reused standalone graph searcher and
included candidate integrity checks and full-vector rescoring; it excluded the
Node/native API, materialized payloads, normalization, process startup and
oracle validation. The arms ran in separate processes in fixed order; no quiet
admission was performed. All samples, including outliers, are retained.

| Profile / ef | Graph build | Logical index bytes | Sampled process-tree RSS peak | p50 range across 3 repetitions | p95 range |
|---|---:|---:|---:|---:|---:|
| degree 32 / 512 | 20.0 s | 36,426,392 | 320,700,416 | 0.246–0.248 ms | 0.291–0.295 ms |
| degree 32 / 2048 | same build | same index | same process | 1.041–1.045 ms | 1.243–1.255 ms |
| degree 64 / 512 | 72.2 s | 49,234,176 | 353,124,352 | 0.370–0.373 ms | 0.432–0.433 ms |

The p99 ranges were respectively 0.303–0.306 ms, 1.308–1.318 ms, and
0.444–0.447 ms. Build duration includes the graph input clone; index encoding
was separately observed at 15.5 and 18.1 ms. Logical index bytes exclude stored
vectors, object/allocator overhead and scratch. The RSS peak includes the
controller and diagnostic-only source graph, and one-second sampling can miss
short peaks. External CPU observations peaked at 0.0455 and 0.1422 of logical
capacity for the two workers; those observations are not an admission preflight
and do not establish isolation. The numbers motivate a qualified public-API
comparison; they do not establish a speed advantage.

The separate [update and post-hoc union results](GRAPH-UPDATES.md) document
maintenance, reopen, and the cost and limitations of combining profiles.

The original frozen 100K arms required mean recall >=0.99 and worst-query recall
>=0.90. The [saved quality analysis](../vectra-comparison-20261102/saved-quality-analysis.json)
records 765 missed oracle neighbors at ef 128 (mean 0.9235, worst 0.10,
210 queries below 0.90) and 366 at ef 256 (mean 0.9634, worst 0.50,
95 queries below 0.90). WARM exact matched every oracle top ten in both arms.
The separate default ef-512 development trace missed 141 neighbors, all before
evaluation; its worst query was 274 with six of ten neighbors found after
evaluating 11,314 vertices. Query 241 found seven of ten after evaluating 12,774
vertices, and exact routing retained the same three misses on that query.

This identifies insufficient traversal coverage on the original degree-32,
build-128 graph. It rules out later retention/reranking losses for the traced
misses and shows that routing quantization explains little of this observed loss.
The trace did not record each missed neighbor's incoming edges or each bridge
vertex's admission/eviction history. It therefore cannot isolate graph topology
from finite-beam exclusion for every miss. Stage attribution was directly traced
at ef 512 and 2048, not at the original failed ef-128/256 settings. Wider beams
and stronger builds provide development evidence of recovery, not independent
quality or latency qualification.

Reproduction requires the existing local inputs and oracle. Use new output
directories and the pinned local toolchain; the experimental feature exposes
diagnostics and the saved-ranking controls guard against path drift.

```sh
CARGO_TARGET_DIR=/absolute/new-build cargo test --release --offline --locked --manifest-path benchmarks/research/vector_topology/Cargo.toml --features writerslogic_warm/experimental --bin trace
CARGO_TARGET_DIR=/absolute/new-build cargo build --release --offline --locked --manifest-path benchmarks/research/vector_topology/Cargo.toml --features writerslogic_warm/experimental --bin trace
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vector_topology/trace-run.mjs /absolute/new-output /absolute/new-build/release/trace
/opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vector_topology/analyze-trace.mjs /absolute/new-output /absolute/new-analysis.json
```
