<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# High-recall adjacency encoding

The [predeclared local diagnostic](../../../../benchmarks/research/vector_topology/ADJACENCY-PLAN.md)
encoded the same degree-64 graph with four-byte and three-byte neighbor IDs.
For all 1,000 previously exposed GloVe queries, the ordered 18-candidate
sequences matched, all final top-ten rankings matched the saved high-recall
reference, and the three-byte index returned the same candidates after saving
and reopening. These checks are development evidence, not held-out proof.

The logical graph index decreased from **49,234,176 to 42,834,176 bytes**:
6,400,000 bytes, or about 13.0% of the graph index. This excludes stored vectors,
allocator overhead, query scratch and other process memory. The standalone
diagnostic had both encodings and the original graph resident simultaneously,
so its sampled process RSS is not the saving in a real WARM process. The
three-byte representation is limited to fewer than 2^24−1 rows; larger graphs
need the existing four-byte representation.

Search timing is **not qualified**: 23 of 84 external CPU observations exceeded
the study's 0.20 limit, with a maximum of 0.2598. The paired same-process
development timings and their outliers remain in the receipt, but do not show
whether this encoding improves or regresses public-API latency or p99. No
production encoding or default has been changed on that basis.

The complete source, binary, saved index, per-query parity/timing output and
monitoring receipts are retained at
`/Volumes/A/.hms-bench-cache/warm-graph-adjacency-20261102-v1`.
The `finished.json` SHA-256 is
`e9a6d80c442615e3ed9feb47e643a2ed49a29b8ed62bced61e23c20b4c7f8c78`.
The run did not restart either frozen comparison attempt.
The retained source is exact for the run; the repository version subsequently
changed only the equivalent warmup-loop iteration to satisfy scoped Clippy.

Reproduce with existing local inputs, the completed trace receipt, and fresh
absolute build/output paths:

```sh
CARGO_TARGET_DIR=/absolute/new-build cargo test --release --offline --locked --manifest-path benchmarks/research/vector_topology/Cargo.toml --bin adjacency
CARGO_TARGET_DIR=/absolute/new-build cargo build --release --offline --locked --manifest-path benchmarks/research/vector_topology/Cargo.toml --bin adjacency
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vector_topology/adjacency-run.mjs /absolute/new-output /absolute/new-build/release/adjacency
```
