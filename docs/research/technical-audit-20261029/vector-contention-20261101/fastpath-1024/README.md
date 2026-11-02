# Fast-path-isolation comparison

**Blocked before measurement.** Both fixed preflights failed: external CPU capacity
was 46.63% and 47.45%, exceeding the 20% budget. No timing process or sample ran,
and no retry occurred. `preflight-failure.json` records the outcome and
`host-availability.json` retains complete observations. This integrated candidate
is not performance-qualified by this experiment.

The frozen baseline is `ba980ffc16e01981bf1d025debfb83d6e7334aac`; the changed
production candidate is integrated revision `d7f5982f4612a16b78071d013ee858c64447a133`.
Its vector source is byte-identical to isolation commit
`bf5f41f9f9114cf12fbd3fa9a0d60c8b6623b985`, whose eight vector tests, 15 snapshot
tests and strict library/test Clippy gate passed before pinning. Timing additionally
requires integrated readiness checks, code-generation inspection, a new coordinator
quiet grant and the frozen host preflight.

This separate experiment evaluates an actual source change that isolates stale
exact work from fresh dispatch. Read-only inspection of the original binaries
found a 464-byte baseline dispatch frame and 512-byte candidate frame. That
48-byte difference motivates a bounded implementation experiment; it does not
establish the cause of the original tail-latency failure.

The original 64-sample study's failed fresh-16D p99 gate remains unchanged.
The unchanged-candidate 1,024-sample confirmation was blocked before timing:
its two preflights exceeded the fixed 20% external CPU capacity budget. Neither
study is superseded, discarded or retried here. No performance qualification is
claimed before this changed candidate meets its own complete frozen criteria.

`premeasurement-scope-revision.json` preserves the initial plan that pinned the
isolated source alone. The coordinator repinned to integrated source before its
build or any timing, retaining every threshold, workload setting and baseline.
The already compiled baseline is reused after verification of its engine,
instrumented vector source, Rust harness, settings and executable hashes. Its
original build manifest remains in `build-baseline-before-scope.json`; separate
execution-wrapper and plan fields identify the updated protocol without claiming
a new compiler invocation. An earlier wrapper EOF-whitespace correction is
retained in `premeasurement-format-correction.json` and `preformat-probe.py.gz`.

Code-generation evidence is independent of timing. `codegen-inspection.json`
records exact commands, binary hashes, instruction counts and prologues from
the existing optimized, instrumented test binaries. The integrated dispatcher
uses 416 stack bytes and 824 instructions, versus 464/1,092 for the baseline
and 512/1,300 for the original candidate. Its fresh canonical scorer remains
176 bytes and 264 instructions. The shared finalizer is now an outlined call
on the fresh route, with its own 112-byte frame and 244 instructions; the smaller
dispatcher alone does not establish lower total stack use or faster execution.

The scorer's strict normalized hashes differ because of static-data addresses,
an unwind-stub address and a compiler-selected collector specialization name.
The separately inspected collectors all have 89 instructions and 64-byte frames;
their instructions match after paired ADRP/ADD data-page offsets are normalized.
`otool -Iv` resolves each unwind stub to `__Unwind_Resume`. After those verified
layout/alias adjustments, all 264 fresh-scorer instructions match. The stricter
normalization, full disassemblies and explicit rules remain available; this
comparison makes no latency claim. These are binaries of the recorded complete
revisions; source identity with the isolated vector-file commit does not imply
that its entire standalone binary was measured or inspected here.

The Rust benchmark harness is byte-identical to `../confirmation-1024/contention_probe.rs`:
8,192 rows; dimensions 16/128/768; k=10; eight warmups; 1,024 recorded queries per
phase. Original query vectors 8..71 repeat 16 times while writer versions continue
the original index+2 progression. Every full ordered result must match its
coherent pre-write oracle and every corresponding cross-process/revision result.

Five alternating baseline/candidate pairs retain the original <=15% idle p50/p99
regression ceiling and >=50% writer-wait median reduction at 128/768 dimensions.
The total execution budget remains 600 s. There are no automatic retries, tuning
runs, changed thresholds or selective sample exclusions.

The host condition remains <=20% aggregate external CPU capacity across ten
logical CPUs, plus no WARM worker builds/tests. Two preflight observations five
seconds apart must pass. Process/load observations repeat every five seconds
and after each process; an in-run violation makes the attempt inconclusive and
stops after its active process, preserving all collected samples. Only the
harness, its descendants and exact ancestor PIDs are excluded; unrelated
children of ancestors remain external. Observed external builds also disqualify
the attempt. This is a sampled shared-host budget, not isolation or a guarantee
against interference between observations. Unrelated jobs are never stopped.

Use `uv run --no-project python` with `probe.py build baseline`, then
`build current`, after both commits are pinned. `probe.py verify` checks artifact
hashes. A separately granted `probe.py run --quiet-grant '<message and timestamp>'`
can start once. `summarize.py` accepts only a complete, host-qualified ledger.

`candidate-sources.bundle` preserves only the original vector candidate and its
isolation follow-up (the `perf/vector-fastpath-isolation` ref), with `ba980ffc`
as a prerequisite; it excludes unrelated evidence branches. Run `git bundle
verify <path>/candidate-sources.bundle` and `git bundle unbundle
<path>/candidate-sources.bundle` in a clone containing that baseline to restore
the original objects for historical reproduction. The integrated candidate
`d7f5982f` is available on `origin/fix/recovery-query-improvements`. The bundle
verification and source/check-log hashes are recorded in `final-validation.json`.
