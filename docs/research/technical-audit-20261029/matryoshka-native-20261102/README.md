# Fresh native Matryoshka evaluation

This study is in progress. No fresh SciFact retrieval quality or query latency
result has been collected yet. The approved workload and gates are in
[PLAN.md](PLAN.md); the historical cached-vector study does not set defaults.

Generation was frozen in signed commit `22559c12` before inference. Its native
source is `ee10156c` (generic Documents task from `104a014b`), with exact source,
executable, environment and input identities in [generation-freeze.json](generation-freeze.json).
The generator is running once on local Metal at batch 1, with a two-hour ceiling
and preserved progress. The exact pinned tokenizer found no truncated inputs:
maximum 1,929 document tokens and 73 query tokens, both below the 2,048-token cap.

The native search implementation is `23c0774d` (opt-in candidate API from
`ad399188`), with all stored vectors and the effective embedding space retained
at 1,024 dimensions. Retrieval source/executable freeze and results follow after
the focused harness checks and fresh generation finish. Query timing additionally
requires a coordinator grant and the predeclared quiet-host observations.

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
The process peak can include these phases, while serving RSS is sampled after
build and warmup. Owner/scratch/allocator bytes are not independently instrumented.
No independent persistent graph file is claimed: the derived graph is rebuilt
after restart, and complete durable store sizes are listed.

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

Host CPU observations use process CPU-time deltas over five-second intervals with
a ten-CPU denominator. Benchmark and supervisor PIDs are explicitly excluded from
external load. New/vanished PIDs are recorded; very short-lived exited processes
can escape sampling. This is observed quietness, not exclusive host isolation.
All raw results are retained if monitoring fails or load exceeds the threshold;
there are no favorable-result exclusions or retry-to-pass.
