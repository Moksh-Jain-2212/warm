<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Revision-consistent filter cache

The migration adapter now keeps up to eight recently used complete eligibility
sets for one revision, with at most 100,000 IDs per entry and a combined 2 MiB
of UTF-8 filter keys and ID bytes. The byte accounting excludes JavaScript
object overhead. Reuse still supplies the cached revision to the native query;
a clean conflict clears every cached entry and follows the existing bounded
retry policy. Explicit `documentIds` bypass the cache. A cache miss still scans
all metadata pages and validates the existing Vectra selector semantics; this
is not a persistent metadata index.

In a [fixed local development workload](../../../../benchmarks/research/vectra_filter_cache/PLAN.md),
the committed single-entry adapter and updated adapter queried separate verified
clones of the same 100,000-row fixture. Ten sequential queries alternated two
filters. Both adapters returned identical complete payload hashes, and every
result passed the independent exact-cosine audit. The original adapter read
1,000 metadata pages; the updated adapter read 200: 100 on each of the first two
queries and none on the remaining eight. This is an 80% reduction in page calls
for that specific sequence, not a general speed or accuracy claim. The original
fixture hashes were unchanged after both workers finished.

Both workers observed external CPU above the fixed study threshold, and no
quiet-host admission occurred. Their elapsed times are retained for diagnosis
but are not qualified latency evidence. The existing frozen comparison attempts
were not resumed. Full source and native-addon snapshots, cloned fixtures, every
query result hash, audits, host observations and receipts are in
`/Volumes/A/.hms-bench-cache/warm-filter-cache-compare-20261102-v1`;
`finished.json` SHA-256 is
`4469c4219a25a0d04d74a4ff5aab59cfec802f89942aba499390ae6275d3b94c`.

A separate [ID-count boundary diagnostic](../../../../benchmarks/research/vectra_filter_cache/LIMIT-PLAN.md)
used a fresh clone and added one synthetic record to that clone only. Repeated
filters selecting 99,999 and 100,000 IDs read 101 pages on the first query and
zero on the second; selecting 100,001 IDs read 101 pages on both. All six
queries passed the saved exact oracle and score audit. Source-fixture hashes
were unchanged. The receipt is at
`/Volumes/A/.hms-bench-cache/warm-filter-cache-id-boundary-20261102-v1`, with
`finished.json` SHA-256
`51bf5fe5ada1281557b3958ea4ad079d4a447f445b6d866fbd214946a889c70e`.

Regression tests cover eight-entry LRU eviction, 2 MiB key-plus-ID admission at
limit−1/limit/limit+1, empty eligibility, explicit stale revisions, queued
write/read ordering, missing native revisions, and differential selector
behavior against the pinned Vectra implementation. The two new baseline tests
failed on the original single-entry implementation; their retained log is
`/Volumes/A/.hms-bench-cache/warm-filter-cache-dev-20261102-v1/prechange-tests.log`.

The development scripts use only local files and no paid service or model
download. Their fresh output directories, fixed deadlines, per-process RSS
ceiling and no-automatic-retry behavior are specified in the linked plans. A
new qualified comparison still needs fresh frozen source, an arranged quiet
host and explicit user authorization.
