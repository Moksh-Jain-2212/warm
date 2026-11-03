<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Alternating-filter cache development diagnostic

In separate processes, compare the committed single-filter adapter and the
working-tree bounded multi-filter adapter using separately cloned copies of the
existing 100,000-row WARM fixture. Verify source and clone file hashes; never
write the frozen fixture. Both use the same current native addon, runtime,
existing GloVe vectors, first exposed query, and public migration API.

Run exactly ten sequential vector queries with metadata filters
alternating `bucket100 = 0` and `bucket100 = 1`, k=10, exact mode. Each filter
matches 1,000 rows. Count actual native listing page calls for every query and
validate every returned ID, original vector, metadata, score, ordering and
membership against independently computed exact cosine results with the
existing 2e-6 tie rule. Require the two adapters' complete payload hashes to
match for corresponding calls. Record every query and elapsed time, all process
receipts and host observations. Each process starts with an empty adapter cache;
the first two queries are therefore cache misses and are retained.

This is a local development workload on already-exposed data. The isolated
copies, per-process 8 GiB/two-sample ceiling, two-hour deadline and no automatic
retry apply. Timing occurs on a shared host without the study preflight and is
not qualified evidence of end-to-end or competitor speed. Page-call counts are
workload-specific observations. Both frozen studies and their receipts remain
untouched; no paid calls or downloads are used.
