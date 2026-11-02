# Fresh native Matryoshka evaluation

**Neither projected setting qualified.** On all 300 official SciFact test queries,
256 dimensions with 100 candidates reached 98.33% mean recall of the native full
exact top 10; 512 dimensions with 50 candidates reached 99.10%. Both had a worst
query of 70%, below the frozen 80% minimum, and exceeded the allowed loss against
their matched full graph controls. Full-vector defaults remain unchanged.
No speed claim is supported: the one timing attempt failed its CPU preflight and
collected zero query timings. The original gates are preserved in [PLAN.md](PLAN.md).

Generation was frozen in signed commit `22559c12` before inference. Its native
source is `ee10156c` (generic Documents task from `104a014b`), with exact source,
executable, environment and input identities in [generation-freeze.json](generation-freeze.json).
The generator completed once on local Metal at batch 1: 5,183 corpus vectors and
300 query vectors, all finite, full width and normalized. Elapsed process time was
1,733 seconds; preparation/builds overlapped generation, so this is not an isolated
inference benchmark. The exact pinned tokenizer found no truncated inputs:
maximum 1,929 document tokens and 73 query tokens, both below the 2,048-token cap.

The native search implementation is `23c0774d` (opt-in candidate API from
`ad399188`), with all stored vectors and the effective embedding space retained
at 1,024 dimensions. Retrieval source was frozen in `fcd0eb53` and `fa2a87be`, then
bound to the fresh arrays in `a839277c` before retrieval. The effective Documents
space is `hms-embedding-v1:752e3391eac1ccf5e16ba4b79ab914c9f696eebef2ebf5c76552f85b77b88061`.

## Quality and correctness results

| Native arm | Mean exact-top-10 recall | Worst query | Exact ordered top 10 | Qrel recall@10 | Qrel nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full exact | 100.00% | 100% | 300/300 | 0.833889 | 0.701846 |
| Full graph, 100 candidates | 99.93% | 90% | 298/300 | 0.833889 | 0.701846 |
| Full graph, 50 candidates | 99.93% | 90% | 298/300 | 0.833889 | 0.701846 |
| 256 dimensions, 100 candidates | 98.33% | 70% | 261/300 | 0.823889 | 0.698336 |
| 512 dimensions, 50 candidates | 99.10% | 70% | 277/300 | 0.827222 | 0.699771 |

The 256/100 arm missed the 99% mean threshold. Both projected arms missed the 80%
worst-query threshold, the maximum 0.005 mean-recall loss against their matched
full graph, and the maximum 0.005 qrel-recall loss. Both met the nDCG-loss limit.
The full graph controls themselves missed two of the 3,000 exact top-10 IDs;
256/100 missed 50, and 512/50 missed 27. These are observed retrieval metrics,
not answer accuracy or a guarantee on other workloads.

| Projected arm | Worst query ID | Missed full-exact document IDs |
| --- | --- | --- |
| 256/100 | 1279 | 15405204, 8354687, 14834714 |
| 256/100 | 324 | 18348376, 33076846, 21185923 |
| 512/50 | 1175 | 10029970, 26283293, 15548965 |

Every initial unfiltered response took the declared route. All arms' exact-mode
results matched the full exact oracle's IDs and canonical score bits. Both
selective filters returned the exact eligible ranking for all 300 queries in all
five arms. Their eligible-positive qrel denominators were 31 queries for modulo
10 and three for modulo 100; all 300 remained in exact-ranking agreement. These
artificial filters are correctness/selectivity checks, not natural SciFact groups.

All five arms passed 21 replacements, 21 deletions, stale exact queries, explicit
flush, a distinct-process restart, and explicit rebuild. Returned IDs, text spans,
versions and metadata stayed current, and deleted IDs stayed absent. Stale and
filtered exact results matched their authoritative oracle. Graph recall after
restart/rebuild remained approximate; all misses are retained in the raw receipts.

## Timing result

After the quality failures, the coordinator explicitly authorized the original
timing workload only as diagnostic tradeoff evidence; overall qualification was
already failed. The two five-second preflights observed 26.14% and 52.55% external
CPU capacity against the unchanged 20% maximum. Spotlight indexing processes
accounted for most observed load. The runner collected **zero query timings**,
performed no retry, and stopped no unrelated process. Therefore p50/p95/p99 and
the latency-improvement gates are **unmeasured**, not passed or failed. The complete
observations and grant are in [timing-window.json](timing-window.json).

## Observed accounting

| Native arm | Logical graph bytes | Retained full-vector bytes | Store file bytes (logical) | RSS after open/build | Process peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full exact | 0 | 21,229,568 | 74,887,910 | 154,943,488 | 169,902,080 |
| Full graph, 100 candidates | 11,339,012 | 21,229,568 | 74,887,910 | 161,251,328 | 176,177,152 |
| Full graph, 50 candidates | 11,339,012 | 21,229,568 | 74,887,910 | 161,792,000 | 176,685,056 |
| 256/100 | 3,374,800 | 21,229,568 | 74,887,910 | 158,351,360 | 173,277,184 |
| 512/50 | 6,029,456 | 21,229,568 | 74,887,910 | 172,113,920 | 187,006,976 |

RSS values are single observations from the untimed quality process, not a
controlled memory comparison. Native ingest acknowledgements took 2.70–3.78 s,
explicit flush 0.18–0.24 s, and graph construction 0.11–0.28 s; these separate
setup durations are preserved as observations, not qualified performance claims.
Full per-file storage, phase durations, graph residual bytes and lifecycle records
are in [summary.json](summary.json).
Store file bytes sum regular-file logical lengths after flush, including the
64 MiB arena segment capacity and derived `documents.text` cache. Allocated disk
blocks and filesystem metadata were not measured.

## Measurement boundaries

Each measured latency covers only one synchronous native
`search_vectors_with_report` call. Query vectors, store open, derived-index build,
one full warmup, result/eligibility/text validation, JSON conversion/output and
RSS sampling are outside that interval. Reported latency is therefore the warm
native retrieval call, not query embedding or end-to-end application latency.
All initial quality, warmup and timed responses must report the arm's declared
route; filtered calls must report full filtered exact. Fallbacks cannot qualify
a projected arm.

Lifecycle verification uses a copy of the prepared store. One subprocess applies
21 replacements and 21 deletions, checks the stale exact response and flushes.
After that process exits, a distinct subprocess opens the durable store, checks
all queries and then explicitly rebuilds the derived index and checks again.
The combined receipt records and checks distinct process IDs. Timing stores are
never modified by lifecycle tests.

## Memory and storage interpretation

Every arm retains the same 5,183 full f32 vectors: 21,229,568 logical bytes.
The driver also retains original source strings and full f64 corpus/query arrays
(44,916,736 bytes of vector payload), so process RSS is not a standalone index
size. Workload-only RSS, serving RSS, process peak RSS and individual store-file
sizes are reported separately. No subtraction of noisy RSS samples is presented
as exact component memory.

Native `graph_index_bytes` counts logical retained graph buffers;
`graph_residual_bytes` is already included in that value. These fields exclude
document owners, row/embedding-handle arrays, membership tables, allocator
overhead, query scratch and transient build memory. Snapshot embedding handles
share the retained full vectors; they do not constitute another full matrix.
Graph construction temporarily materializes the normalized candidate matrix and
builder structures. Publication/rebuild can overlap old and new snapshot owners.
The process peak can include these phases. RSS in the table was sampled after
open/build before quality queries; the frozen timing driver would sample after
warmup, but that stage never ran. Owner/scratch/allocator bytes are not independently instrumented.
No independent persistent graph file is claimed: the derived graph is rebuilt
after restart, and complete logical store file sizes are listed.

Reducing graph candidate width does not reduce ordinary full-model inference,
the retained full-vector matrix, or the document records. Both graph traversal
and reduced-dimension shortlisting can miss full-space neighbors. The study
compares with a full exact oracle and matched-shortlist full graph controls;
it makes no answer-accuracy, 100K scale, or unconditional recall claim.

## Reproduction

Use the recorded commits and existing local model/data; no download or inference
service is part of the workflow. All commands run from the research worktree.
The checked-in absolute local paths are provenance; a separate explicitly planned
reproduction must use new output directories because the runners reject reuse.

```sh
export CARGO_TARGET_DIR=/Volumes/A/warm-matryoshka-fresh/target/native-eval
export CARGO_BUILD_JOBS=2
export STUDY=docs/research/technical-audit-20261029/matryoshka-native-20261102
cargo +1.99.0 test --offline --locked --release --manifest-path "$STUDY/driver/Cargo.toml" --bin generate --bin evaluate
cargo +1.99.0 build --offline --locked --release --manifest-path "$STUDY/driver/Cargo.toml" --bins
uv --offline run --python /Volumes/A/.hms-bench-cache/competitive/envs/stdlib/bin/python --no-project -m unittest discover -s "$STUDY" -p 'test_*.py' -v
```

`prepare.py` verifies the three unpacked SciFact hashes and writes exact ordered
input and ID/qrel mapping. `run_generation.py` verifies the frozen generator and
input, invokes the native generator exactly once, and preserves failure/timeout
receipts. `run_retrieval.py quality` invokes ingestion, quality and separate
mutation/restart processes. `run_retrieval.py timing` requires the explicit grant,
performs the two CPU preflights, and records the fixed five-replicate Latin order.
`analyze.py` verifies result counts, cross-arm exact IDs and score bits, eligibility,
routes and lifecycle PIDs before calculating the frozen gates.

The hash-verified original input, fresh arrays, native receipts and executables are
preserved locally at `/Volumes/A/.hms-bench-cache/matryoshka-native-20261102-22559c12`;
[generation-archive.json](generation-archive.json) records every checksum. Corpus
text and large arrays are not committed. [results/](results/) contains lossless
compressed native outputs, [per-query.json.gz](per-query.json.gz) contains compact
metrics and all missed IDs, and [validation.json](validation.json) identifies raw
checksums and completed checks. No configuration, threshold or production default
was changed after the results. This existing public benchmark/test split is not
held-out production proof, and its 5K scale does not establish 100K behavior.

Host CPU observations use process CPU-time deltas over five-second intervals with
a ten-CPU denominator. Benchmark and supervisor PIDs are explicitly excluded from
external load. New/vanished PIDs are recorded; very short-lived exited processes
can escape sampling. This is observed quietness, not exclusive host isolation.
All raw results are retained if monitoring fails or load exceeds the threshold;
there are no favorable-result exclusions or retry-to-pass.
