<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Filter cache ID-count boundary diagnostic

Clone the existing 100,000-row WARM fixture into a fresh directory, verify its
hashes, and insert one synthetic record into the clone only. The extra record
duplicates the first input vector and has ordinal 100,000; do not remove or
modify any original records. Verify that its exact score lies more than 2e-6
below the saved independent query-0 oracle cutoff and that all ten oracle IDs
have ordinals below 99,999.

Using the current adapter and native addon, query the exposed first GloVe query
twice for each ordinal filter selecting exactly 99,999, 100,000 and 100,001
records. Require each returned payload and score to pass the existing exact
oracle and 2e-6 tie audit. Record native metadata-page calls per query: the
first two counts should cache after one full scan, while 100,001 must scan on
both calls. The 2 MiB aggregate ID/key budget also remains enforced. Check the
source fixture hash after the process exits and preserve all output, code,
hashes and resource receipts.

This is a local correctness and cache-boundary diagnostic, not a frozen study,
held-out result or latency claim. Use the existing two-hour and 8 GiB
per-process/two-consecutive-sample limits with no automatic retry; do not run a
quiet-host preflight. No paid calls, model downloads or memory pruning occur.
