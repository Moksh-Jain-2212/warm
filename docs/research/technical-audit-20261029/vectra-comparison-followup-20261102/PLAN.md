<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# WARM retrieval follow-up comparison

This is a new attempt authorized by the user's request to implement the review,
add competitors and restart testing. It is not a retry or continuation of the
user-stopped attempt. That attempt, its raw results, and the failed prefix results
remain unchanged. The source, addon, driver, dependencies, inputs, host and schedule
must be frozen and verified before execution. This document is a plan, not a result.

The [original Vectra comparison protocol](../vectra-comparison-20261102/PLAN.md)
defines the data, reference, filters, quality and timing gates, workloads, processes,
resource ceilings, and no-retry behavior for this separate attempt. Its historical
statement that no earlier run had started describes the original planning point.
The user has now authorized a new local run; no paid service, inference, model
download, pruning, npm publication or ToIP work is authorized. The source is the
final integrated code of this attempt. A cold exact query can now defer graph
construction; a later auto/graph query or maintenance may construct it. Repeated
identical Vectra filters can reuse bounded eligibility results after a revision
check; the timing schedule measures the actual public adapter including this cache.
Report these lifecycle and cache policies with the results, and do not treat them
as equivalent to an uncached query or a cold graph. Continue to report source IDs,
all observed failures, actual routes and workload-specific quality.

Quality means use compensated summation; equality comparisons allow four machine
epsilons for floating-point representation. The declared recall and relevance
thresholds are otherwise unchanged and values are not rounded before comparison.
Experimental `WARM_QGRAPH_*` environment knobs must be unset at freeze and in
each phase, so the graph settings recorded by this plan are not silently altered.

This attempt adds `ef=2048` to the original 128/256/512 graph arms and to the
standalone competitor schedule. It also adds WARM's opt-in degree-64/build-ef-500
profile at search ef 512, built in separate stores and checked against its reported
construction diagnostics. Both were selected after development on the same
GloVe queries, where they met the original quality gates; neither is a held-out
selection. Together the two arms contribute 18,400 static-quality, 55,200
lifecycle, 19,200 timed and 1,440 warmup vector queries, plus three additional
fixture imports and graph builds. The complete timed-phase schedule is 334,080
queries before graph-first calls, opens, builds, writes, copies and accounting;
two hours would permit only 21.55 ms per query if all other work were free. This
is an arithmetic ceiling, not a duration estimate. Preparation and measurement
remain bounded to two hours each and must report partial results on timeout.
The stopped attempt's completed preparation workers consumed 63.04 minutes in
aggregate through its first 100,000-row graph quality arm; that earlier
implementation lacked this attempt's filter cache and ranking changes, so this is
not a reliable duration projection for the new build. It does establish a material
timeout risk. Do not infer a successful complete run from the arithmetic ceiling.

As a separate companion, the [standalone Node ANN plan](../../../../benchmarks/public/vectra_comparison/competitors/README.md)
adds hnswlib-node and USearch on the same numeric GloVe subsets and oracle. Its
index-only API lacks the migration workload's metadata, vector payload, lifecycle
and durability contract: its timing is not directly comparable with the main
adapter. Each study has a separate frozen schedule, output, resource monitoring,
and no-retry admission. Do not run them concurrently during timed measurements.
The existing public test queries informed development and are not held-out proof.
