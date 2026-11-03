<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Graph profile updates and post-hoc result union

The separate [update diagnostic](../../../../benchmarks/research/vector_topology/UPDATE-PLAN.md)
cloned the prior 100,000-row default and high-recall WARM fixtures into
`/Volumes/A/.hms-bench-cache/warm-graph-updates-20261102-v2`. Source and clone
hashes matched before work; the source hashes matched again afterward. Each
profile acknowledged one batch of 100 upserts, preserved all 100 original-vector
values and metadata after mutation, and preserved them after flush and a
separate-process reopen. No records were deleted. Three existing queries were
checked against exact mode before and after maintenance and after reopen; all
three graph results contained the same ten IDs as exact mode at each boundary.
Three queries are not a quality certification.
The `finished.json` SHA-256 is
`2403448ca27d44da9828e9ee1a3c881603e88cf4adec013ac579d8866bc9cd8e`.

These are single shared-host development observations, without a quiet admission.
The two profiles ran in fixed order in separate processes, using the existing
exposed corpus. They do not establish production latency or competitive speed:

| Operation | Default, ef 2048 | Degree 64, ef 512 |
|---|---:|---:|
| Initial maintenance | 19.762 s | 71.356 s |
| Acknowledged 100-record batch | 45.975 ms | 38.004 ms |
| Post-update maintenance | 19.766 s | 71.156 s |
| Flush | 209.169 ms | 152.767 ms |
| Maintenance after separate-process reopen | 19.910 s | 71.559 s |
| Sampled update process-tree RSS peak | 825,098,240 bytes | 863,354,880 bytes |

The initial and post-update maintenance costs include real graph work. The
current snapshot policy recommends a rebuild at 64 mutations; a batch of 100
crosses that threshold. The diagnostic does not show that lowering rebuild
frequency would preserve recall, freshness, or tail latency. Process RSS includes
the loaded corpus, native code, adapter and graph; one-second samples can miss
short peaks. External CPU sampling and all per-query and operation receipts are
in the output directory. The first diagnostic directory,
`/Volumes/A/.hms-bench-cache/warm-graph-updates-20261102-v1`, preserves an
earlier failure before copying a fixture: the controller treated an omitted
optional `highRecall` property as different from false. A separate synthetic
integration test also caught that explicit initial maintenance is needed before
a graph-only query; the corrected test passed before the completed diagnostic.
Neither diagnostic was a frozen study phase.

Separately, a **post-hoc offline analysis**, chosen after seeing the trace,
combined already saved top-ten IDs and rescored their union using the same
normalized f32 rows and f64 accumulation as the standalone trace. It first
reproduced each saved input ordering. No new graph search was performed:

| Saved result sets combined | Mean / worst recall on the exposed queries | Queries with a miss |
|---|---:|---:|
| default ef 512 + degree 64 ef 512 | 0.9988 / 0.90 | 12 |
| default ef 2048 + degree 64 ef 512 | 1.00 / 1.00 | 0 |

This describes one previously inspected query set, not held-out evidence. Two
graphs need additional construction, memory, updates and searches; there is no
implemented combined query, measured merge cost, or established performance
improvement. Raw merged IDs and reproducible checks are retained in
`/Volumes/A/.hms-bench-cache/warm-graph-union-posthoc-20261102-v1`.
The union `summary.json` SHA-256 is
`bc469ccc93f6233299dbe857ede188704318806c3773d0b4a29ee098d0febce5`.

Run with the pinned Node binary and new, nonexistent output paths:

```sh
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node --test benchmarks/research/vector_topology/update-test.mjs
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vector_topology/update-run.mjs /absolute/new-update-output
/opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vector_topology/analyze-updates.mjs /absolute/new-update-output /absolute/new-update-analysis.json
/opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vector_topology/analyze-union.mjs /absolute/completed-trace-output /absolute/new-union-output
```
