# Vector comparison harness

This is an implementation of the preregistered [comparison plan](../../../docs/research/technical-audit-20261029/vectra-comparison-20261102/PLAN.md), not a benchmark result. It uses the public Vectra 0.15.0 and WARM migration APIs, existing numeric embeddings, and an independent f64 cosine oracle. It makes no model calls. Do not execute either study phase until the coordinator has reviewed the final source, workload, fixed budgets, and frozen receipt and supplied the matching grant.

**Preparation only.** Timed results are gated per repetition against matched exact and oracle quality, result and reference sets must have every expected query exactly once, and all routes check score order. Synthetic regressions cover these checks. Freeze and execution remain contingent on integrated measurement-accounting review, a final addon build and the protocol admission gates. No study freeze, input scoring, timing or model run has occurred.

## Development verification

Use the pinned Node executable and actual installed Vectra package, integrated WARM JS source, and qualified native addon. Tests copy the WARM JS files and addon into an isolated temporary package. The real-data fixtures are never opened by these tests. Synthetic workers suppress operation latency fields; test-runner durations are development observations only.

```sh
VECTRA_TEST_PACKAGE=/absolute/node_modules/vectra \
WARM_TEST_PACKAGE=/absolute/warm-source \
WARM_TEST_ADDON=/absolute/warm-sdk.darwin-arm64.node \
/absolute/node --test benchmarks/public/vectra_comparison/test_vector.mjs
```

The checks cover an independently calculated oracle, strict score and cutoff-tie accounting, exact versus ANN gates, selector parity with the installed Vectra implementation, external metadata materialization, complete filtered queries, ordered rollback/cancel, source-side signed-zero canonicalization versus migration preservation, native f64 round-trip, churn, separate-process reopen, supported interruption boundaries, resource ownership/deadline handling, failed preflights, and refusal to overwrite retained evidence. Required native tests do not silently skip.

## Freeze and execution

Create a configuration outside the source tree using absolute paths:

```json
{
  "plan": "/absolute/PLAN.md",
  "inputs": "/absolute/inputs.json",
  "warmPath": "/absolute/clean-integrated-warm-source",
  "warmSourceCommit": "FULL_COMMITTED_SHA",
  "nativeAddon": "/absolute/clean-integrated-warm-source/warm-sdk.darwin-arm64.node",
  "hybrid": { "uvPath": "/absolute/uv", "tokenizerPath": "/absolute/tokenizer.json" },
  "vectraPath": "/absolute/node_modules/vectra",
  "vectraLockfile": "/absolute/package-lock.json"
}
```

This combined freeze also binds hybrid source, the Qwen tokenizer, offline uv/Python and imported tokenizer runtime files, hybrid query IDs, and its fixed schedule. Unset `PYTHONPATH`, `PYTHONHOME` and `VIRTUAL_ENV`. The addon must be the file actually selected by `warmPath/index.js`. The repository loader does not honor `NAPI_RS_NATIVE_LIBRARY_PATH`. Freeze checks the public loader, source HEAD/clean tracked state, addon and Node hashes, JS/types/lockfiles, installed Vectra tree, dependency versions/integrities and installed package file hashes, all input hashes, protocol hash, harness files and thread configuration. Commit the harness first. `NODE_OPTIONS` must be unset. No package installation, network access, model generation, store creation or query occurs during freeze.

```sh
/absolute/node benchmarks/public/vectra_comparison/vector.mjs freeze /absolute/NEW-output-directory /absolute/config.json
```

The output directory must not already exist. The coordinator's separate grant for each phase must contain the exact `freeze-receipt.json` hash binding:

```json
{
  "freezeHash": "SHA256_OF_FREEZE_JSON",
  "phase": "preparation",
  "approved": true,
  "coordinator": "ROOT_COORDINATOR",
  "approvedAtUtc": "ISO_8601_TIMESTAMP"
}
```

After explicit approval, run preparation once. Measurement requires its own grant with `phase: "measurement"`, completed preparation and its correctness admission gate, all WARM builds/inference stopped, and both fixed external-load preflights passing. The controller watchdog observes the full phase, including gaps between workers; a violation during a copy is retained and blocks the next job, although that copy can finish after the deadline.

```sh
/absolute/node benchmarks/public/vectra_comparison/vector.mjs preparation /absolute/output /absolute/preparation-grant.json
/absolute/node benchmarks/public/vectra_comparison/vector.mjs measurement /absolute/output /absolute/measurement-grant.json
/absolute/node benchmarks/public/vectra_comparison/vector.mjs summarize /absolute/output
```

The shared controller runs vector and hybrid jobs under the same phase deadlines and measurement preflight. Each phase has one exclusive start marker and a two-hour deadline. There is no resume, overwrite, automatic retry, arm selection, slow-sample exclusion or threshold tuning. Summarize even an incomplete execution; its retained summary reports missing data and exits nonzero on an incomplete/failed global qualification. Summary output is also exclusive; reproducing a summary requires a separate materialized evidence directory with the original inputs and phase/result receipts, without an existing `vector-summary.json`.

## Measurement boundaries

- Each applicable arm/filter retains every query's IDs, unrounded scores, route, eligibility count, payload validation/hash, oracle audit, errors and latency. Full original vector values and full user metadata are materialized and copied inside both engines' timed API invocation; validation and JSON output occur afterward. The WARM filter includes its complete metadata scan and revision-checked eligibility collection. No precomputed eligible IDs replace adapter work.
- Exact score error and cutoff substitutions use the plan's 2e-6 bound. Strict ordered agreement is reported separately. Numerically accepted exact ties do not become ANN-recall failures. Actual full-graph routes have mean recall >=0.99 and worst-query recall >=0.90 against both WARM exact and the independent oracle; SciFact baseline relevance deltas must also remain within 0.01. Graph requests with filtered-exact routes remain labeled exact. Any failed quality/lifecycle gate prevents an advantage claim; all arms remain in the evidence.
- Three fresh-process repetitions use the frozen rotating arm order, first 20 unmeasured source-order warmups, full unfiltered query sets, and fixed filtered strides. Nearest-rank quantiles require the complete identical successful query set. Failed calls' elapsed times are retained separately. Each advantage must meet the fixed p50/p95/p99 criteria in all three repetitions; ratios to both exact baselines remain visible.
- Process-cold open includes process startup, imports, constructor and forced Vectra index load. Its first exact query includes actual lazy initialization: the pinned WARM engine may build a graph when materializing a missing snapshot even in exact mode. Per-worker maintenance and graph first-query-after-build are separate receipts. OS page-cache state is uncontrolled; this is not disk-cold latency.
- Prepared stores are copied into exclusive isolated directories. Node `COPYFILE_FICLONE` requests copy-on-write equally for both engines, with ordinary-copy fallback. Stale lock files are omitted, symlinks rejected, partial destinations retained. Logical capacity and allocated blocks are reported per store; shared clone blocks are not a summed physical disk footprint.
- Stage and query RSS plus one-second OS observations cover Node/native memory and recursively owned descendants, including the hybrid tokenizer child when it uses this monitor. Each process has the fixed 8 GiB/two-consecutive-sample ceiling. Per-process and aggregate tree peaks are retained; sub-second peaks can be missed. The same widened input fixtures, ID maps, oracle lookup and validation bookkeeping contribute to both workers' RSS; these are whole harness/process measurements, not native-only allocation estimates.
- On worker exit the controller cleans any residual owned process group and records the action. An unexpected surviving descendant makes the job non-qualifying even when the worker itself exited successfully.
- Two five-second preflights require observed external aggregate CPU <=20% of logical CPU capacity. Monitoring continues through the measurement phase's workers. Sibling jobs remain external. This is a shared-host observation, not host isolation; Linux aggregate `/proc/stat`, including steal, is observational. The coordinator must separately confirm no WARM build/inference jobs overlap. No unrelated process is stopped.

The declared vector matrix contains 62,000 static-quality queries, 186,000 churn/reopen quality queries, 63,600 timed calls and 4,560 warmups, plus oracle generation, cold calls and graph-first calls. These counts describe work, not a duration estimate. The coordinator must review feasibility against the fixed two-hour phase budgets before authorizing a run.

## Persistence and limitations

Single-write and 100-operation batch acknowledgements, explicit WARM flush, and acknowledgement-to-flush intervals are separate. Vectra `endUpdate` performs a full JSON write through `fs.writeFile` and has no equivalent explicit fsync barrier. Vectra JSON can change `-0` to `+0` on restart; this is reported separately from WARM's obligation to preserve values received from that source. WARM direct input must preserve original finite f64 bits.

The controller pauses a child only at `operation-return-before-controller-ack`, `ack-before-flush`, or `after-flush`, then interrupts its owned process group and opens the isolated store in a new process. Before explicit flush, whole old or new state is accepted; after completed WARM flush, new state is required. Partial state fails. Unsupported Vectra flush is retained explicitly. Reopen exceptions are preserved as unclassified operation errors for review; they cannot silently become a passing corruption result. These are process interruption checks, not hardware power-loss proof or an in-flight append hook. Existing Rust tests `append_failure_preserves_live_state_and_allows_retry` and `interrupted_append_and_publication_recover_whole_batches` in `src/core/engine/mutation.rs` exercise separate internal fault points; their existing receipts are separate evidence, not results produced by this harness.

Preparation produces `freeze*.json`, per-job inputs, worker output and stdout/stderr, phase receipts, oracle outputs, validated fixtures and resource observations. Measurement adds cold/timing/churn/crash outputs. Preserve every failed attempt and raw receipt. `vector-summary.json` collects quality gates, lifecycle gates, route counts, per-repetition/pooled quantiles and explicit claim eligibility. Raw large evidence may be losslessly archived later with original hashes; never discard failures or substitute a better run.

A source-derived follow-up hypothesis is that native metadata-only listing currently validates and clones envelope/base64 archive data before dropping vectors. This may matter for complete filters at larger widths. It is not an established timing cause, and the harness does not alter or bypass that work.
