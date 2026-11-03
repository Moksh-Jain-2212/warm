<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Proposed comparison after the Node binding repair

This is a proposed new attempt, not authorization to run it. The previous
[follow-up](PLAN.md) remains incomplete: its SciFact preparation failed at the
Node JSON conversion limit, and the separately frozen competitor timing phase
failed its quiet-host preflight. Preserve both complete receipts, all partial
results and their failures. Do not restart either frozen attempt.

If the user explicitly requests a further attempt, freeze the repaired source,
addon, inputs, dependencies, host, scripts and this plan, then use the same
fixed schedule, per-phase deadlines, 8 GiB per-process ceiling, correctness and
quality gates, two-interval host-load preflight, and one start per phase as the
prior [follow-up protocol](PLAN.md). Use a fresh output for each study; do not
overlap timing with the other study or builds. Preserve any failure without
retrying, selecting the best attempt, changing thresholds or excluding samples.
The standalone competitor study remains index-only and its timings cannot be
compared directly with the WARM/Vectra migration API.

The prior attempts exposed the GloVe queries and several recall results. A
repaired run is therefore exploratory on reused data, not independent validation.
Report both attempts and their limitations together; no WARM performance
advantage is established by the existing data. No paid calls, model downloads,
memory pruning, npm publication or ToIP work is authorized.
