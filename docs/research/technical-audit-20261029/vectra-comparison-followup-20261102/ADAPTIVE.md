<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Post-hoc selective fallback

The [fixed analysis](../../../../benchmarks/research/vector_topology/ADAPTIVE-PLAN.md)
asked whether a score-derived rule could identify queries where the existing
degree-64/ef-512 result would benefit from adding the default/ef-2048 result.
It reused saved candidates and the earlier offline union; no new graph queries
or timings were run. All 1,000 queries were previously exposed. The source-order
500/500 split is an internal check, not independent validation.

Of eight fixed low/high-tail policies, the fitting partition selected low top-1
score, with a threshold of 0.5063485961157469 and fallback for 50 of 500
queries. This recovered five of the nine missing oracle neighbors in that
partition. Applying the same threshold to the second partition triggered 49
fallbacks but recovered **none** of its six missing neighbors. Mean/worst
recall in that partition remained 0.9988/0.90. Other policies and all per-query
decisions are retained; they were not selected using the second partition.

This small, previously inspected dataset does not establish that every
confidence signal is ineffective. It does show that this selected rule did not
generalize even to the internal split, and the two-graph cost is unknown. Do
not use it as an automatic fallback or a reliability guarantee. One tested
feature also needs the eleventh internally rescored candidate, which the current
k=10 public API does not expose.

The per-query features, all policy outcomes, hashes and source snapshots are at
`/Volumes/A/.hms-bench-cache/warm-graph-adaptive-posthoc-20261102-v1`.
The `summary.json` SHA-256 is
`083317f6df9c61ad0727e2bccee0a003a6c1a316f1ac79ff501804b10b89ae73`.

Reproduce from the retained trace and post-hoc union into a fresh output path:

```sh
/opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vector_topology/analyze-adaptive.mjs /Volumes/A/.hms-bench-cache/warm-graph-trace-20261102-v1 /Volumes/A/.hms-bench-cache/warm-graph-union-posthoc-20261102-v1 /absolute/new-output
/opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vector_topology/verify-adaptive.mjs /absolute/new-output
```
