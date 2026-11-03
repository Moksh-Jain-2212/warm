<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native equality filtering

The adapter now recognizes conjunctions of up to 64 literal metadata fields
with string, finite-number or boolean equality, including a sole `$eq` operand.
It sends those predicates to the new native `queryVectraRecords` API. Unsupported
selectors retain the pinned JavaScript selector and existing bounded cache;
no partial predicate extraction changes operator order or exceptions. An older
addon without the method retains the complete adapter scan.

Native postings cover the effective imported filter view, including an explicitly
empty view. Numeric keys use JavaScript double identity, with negative zero equal
to zero. The new map shares the existing document index's insertion, replacement
and deletion lifecycle without changing the generic metadata index's scalar
semantics. It is reconstructed on reopen, so no store format change is required.
Eligibility and exact scoring retain the existing ID/byte limits and revision
checks. All migration envelopes are accounted for: an invalid unrelated record
still fails the query instead of disappearing behind an index lookup.

Derived postings are capped at 64 MiB of accounted key/value/ID bytes plus
structural charges. This is not an RSS bound. Once exceeded, postings are released
and native exact scanning supplies eligibility until the store is reconstructed.
No stored vector or metadata is removed. Unsupported legacy filter views return
to the JavaScript selector. Returned payloads and the `filteredExact` route remain
unchanged; this does not make filtered search approximate or improve its recall.

Synthetic validation logs are retained at
`/Volumes/A/.hms-bench-cache/warm-native-filter-dev-20261102-v1`. Focused checks
cover index budget boundaries, filter bounds, numeric identity, atomic updates,
the 8 MiB eligibility boundary, revision changes during scoring, queued writes,
projection, exact-result parity, old-addon fallback and separate-process reopen.
The prechange Node log records the missing native API. An initial harness
invocation omitted required local package environment variables and failed before
the vector/hybrid suites; its log is retained separately.

The [100,000-row development plan](../../../../benchmarks/research/vectra_filter_cache/NATIVE-PLAN.md)
completed at `/Volumes/A/.hms-bench-cache/warm-native-filter-compare-20261102-v1`.
The preceding eight-entry adapter read 200 metadata pages over ten alternating
queries; native equality routing read zero. All twenty independent exact-cosine
audits passed, every returned payload hash matched between arms, and the source
fixture hashes remained unchanged. Both arms use the same new addon; this isolates routing
and cannot measure old-versus-new native startup cost or memory. Its fixed exact
audits and metadata-page counts are the acceptance criteria. Sampled process RSS
peaked at 770,998,272 bytes for the baseline and 669,188,096 for the candidate;
one-second sampling may miss transient peaks and does not isolate index memory.
The few host samples remained below 0.20, but there was no quiet-host admission;
these observations do not qualify elapsed timings or establish a speed advantage.
The `finished.json` SHA-256 is
`8096acab02bda39567e4b71f191ff0b1567de0b139b51b5838d0112ff9a406fa`.

Final validation passed 36 Node tests, with three optional embedding tests
skipped; 41 vector/hybrid/competitor harness checks; strict TypeScript; and
scoped Node/security Clippy with warnings denied. Rust checks passed 20 engine
vector-record tests, five new filter-index tests and 144 document tests; the
existing lexical latency microbenchmark remained ignored. Formatting and
`git diff --check` passed. Logs and a source/hash inventory are retained in the
development validation directory above. The release addon SHA-256 is
`4cd5a000f7e611f922f5e24074d69129f4130bc7041c1df85bfdb0f1adde4ae5`.

All prior frozen attempts and their gates
remain unchanged, and another official attempt requires explicit authorization.
