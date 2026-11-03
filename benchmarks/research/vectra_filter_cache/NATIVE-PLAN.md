<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native equality-filter development validation

Run `run.mjs /absolute/new-output --native-filter` once after regression checks
and the release addon build. This is a local development diagnostic using the
same exposed 100,000-vector GloVe fixture and fixed ten alternating `bucket100`
queries as the preceding cache diagnostic. It is not either frozen study and
does not admit timing or held-out quality claims.

The baseline adapter is the hash-pinned eight-entry cache implementation in
`warm-filter-cache-compare-20261102-v1/package-candidate/vectra.js`; the candidate
is the working native-filter adapter. Both use an identical snapshot of the new
native addon, so both incur native index construction. This isolates the query
route, not the old/new addon's total startup or memory cost. The native source
files, adapters, addon and harness are copied and hashed before execution.

Use separately verified clones of the existing fixture. Run baseline then
candidate, once each, with the existing seven-thousand-two-hundred-second
deadline, 8 GiB per-process RSS ceiling and no automatic retry. Record host load
without quiet-host admission; elapsed samples remain diagnostic only. Require
all twenty exact-cosine audits, unchanged full-result hashes across arms,
baseline page calls 100 on its first two queries and zero thereafter, and zero
candidate page calls for every query. Verify the source fixture is unchanged.

The native derived index has a 64 MiB accounted-storage budget and switches to
exact native scanning if exceeded. Accounted storage is not process RSS. The
diagnostic's zero Node page calls alone cannot distinguish indexed lookup from
that native scan; postings selection and budget fallback have separate Rust
tests. Synthetic Node regressions cover cold distinct filters, updates,
deletions, projection, numeric identity, stale revisions and separate-process
reopen. No data/model download, paid service, publication or official study
restart is authorized by this plan.
