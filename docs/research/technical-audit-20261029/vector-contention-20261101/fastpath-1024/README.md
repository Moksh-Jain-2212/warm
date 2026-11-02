# Fast-path-isolation comparison

The frozen baseline is `ba980ffc16e01981bf1d025debfb83d6e7334aac`; the changed
production candidate is `bf5f41f9f9114cf12fbd3fa9a0d60c8b6623b985`. The candidate's
eight vector tests, 15 snapshot tests and strict library/test Clippy gate passed
before source pinning. Timing additionally requires code-generation inspection,
a new coordinator quiet grant and the frozen host preflight.

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
