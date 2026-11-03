<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Graph miss and matched-quality development diagnostic

This is an offline development experiment, not a study attempt. Use the already
exposed 100,000-row GloVe corpus, its 1,000 existing queries, the retained exact
oracle and fixed graph configurations. Preserve both failed comparison attempts.
No paid calls or downloads are used. Results cannot establish held-out recall,
public-API latency or an advantage over another product.

Reconstruct WARM's graph inputs and normalization as in the existing topology
diagnostic. Build the diagnostic with the `writerslogic_warm/experimental`
feature, which exposes the trace API; all returned rankings must still match
the saved production-path controls. Compare default degree 32/build ef 128 at search ef 512 and 2048,
and degree 64/build ef 500 at search ef 512, all with 18 candidates and
full-vector final rescoring. For all 1,000 queries in each cell, require the
ordered final IDs to match the previously retained matching configuration. Stop
on any mismatch. Against the exact oracle, classify each missed neighbor by its
first absence from evaluated vertices, retained vertices, residual-rerank input,
18-candidate shortlist, or final top ten. Separately repeat the trace with exact
routing scores on the same topology, preserving the compact residual rerank;
this is a diagnostic counterfactual, not a production result. Record every
query and stage, evaluated counts and both traces, not just aggregates.

As a preliminary matched-quality comparison, record per-configuration graph
build and index-encoding duration, logical index bytes, one-second monitored
process-tree RSS, and three fixed source-order repetitions of 1,000 searches
with 20 warmups. The per-query timer covers only the standalone native graph
search, candidate integrity checks and canonical candidate rescore. It excludes
process/open, normalization, public API, metadata, oracle validation, and
serialization. The two graphs run in
separate processes in fixed order on a shared host with no quiet admission:
these are exploratory diagnostic timings, vulnerable to ordering and host load,
not the pending frozen study or evidence of a speed advantage. Retain every
sample and host observation. Report all configurations, including those that
fail quality, using the original unrounded mean >=0.99 and worst >=0.90 gates.
Measure update, end-to-end latency and held-out relevance only in a later
appropriately scoped experiment; none is established here.

Use one new output directory, the existing per-process 8 GiB/two-sample RSS
monitor, two-hour deadline, and no automatic retry. Hash the corpus, oracle,
prior references, binary, sources, lockfiles and configuration; save the exact
diagnostic sources and all process receipts. Quality controls must pass before
reporting matched-quality timing observations. Stop and retain errors on a
failed control rather than changing thresholds or selecting a favorable result.
