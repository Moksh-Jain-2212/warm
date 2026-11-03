<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# High-recall adjacency encoding diagnostic

This is local development on the already-exposed 100,000-row GloVe corpus and
1,000 queries, not a frozen study or held-out validation. Build the existing
degree-64/build-ef-500 graph once, then encode the same graph with existing
four-byte and three-byte neighbor IDs, keeping all other settings identical.
The three-byte sentinel limits that encoding to fewer than 2^24-1 rows; no
truncation or partial graph is permitted. No paid services or downloads are used.

Verify that every 18-ID candidate sequence is identical for both encodings,
and that each final top-ten ranking matches the earlier degree-64/ef-512 trace.
Validate the three-byte representation through a save and separate index reopen
and repeat all 1,000 candidate checks. Record logical component bytes, graph
construction and encoding observations, and three fixed-query timing repetitions
for each representation, alternating which one goes first on each query. These
timings are shared-host, same-process native diagnostics with both indexes
resident: no public API, full memory, update, held-out, or competitor performance
claim is permitted. Retain every sample and host observation.

Use a new exclusive output, source/binary/input/reference hashes, the existing
8 GiB per-process/two-consecutive-sample monitor and two-hour deadline, and no
automatic retries. Stop and preserve the run if any parity or reference check
fails. The user-frozen comparison attempts remain untouched.
