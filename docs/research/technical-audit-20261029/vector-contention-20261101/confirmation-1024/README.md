# Separately preregistered 1,024-sample confirmation

**Blocked before measurement.** The single attempt's two host preflights observed
20.62% and 20.34% external CPU capacity, exceeding the frozen 20% budget.
No benchmark process or timing sample ran; no retry occurred. `preflight-failure.json`
and `host-availability.json` retain the outcome and complete observations. The
candidate remains unqualified; this attempt contributes no new timing or oracle
results. The coordinating agent released the workers after the failed preflight.

The original 64-sample study and failed fresh-16D latency gate at commit
`efb53a541767d6da8893d0a86850bd28839cd096` remain unchanged. This confirmation
increases empirical tail-sample precision: nearest-rank p99 is the maximum with
64 samples and the eleventh-largest value with 1,024. It is one fixed additional
study, with no automatic retries, tuning, or selective sample exclusions.

The engine revisions are unchanged: baseline `ba980ffc16e01981bf1d025debfb83d6e7334aac`
and candidate `0e49e592f8d7d3fddd68a842748a4c462408c4ed`. Existing binaries hardcode
64 samples, so both are rebuilt with the same engine source and scoring hook.
Only the standalone Rust harness's sample count and query schedule change.
Build manifests retain original and new binary hashes, source/harness hashes,
compiler identity and settings. The existing dedicated vector build cache is
reused; copied confirmation executables and source archives have separate paths.

`plan.json` fixes 8,192 rows, dimensions 16/128/768, k=10, eight warmups and
1,024 measured queries per phase. The original measured query vectors (indices
8 through 71) repeat 16 times; writer replacement versions continue the original
index+2 progression. All complete ordered results must match their coherent
pre-write oracle and match across processes/revisions. Five alternating pairs,
the original <=15% idle p50/p99 regression ceiling and >=50% writer-wait median
reduction at 128/768 dimensions remain fixed. Total measurement budget is 600 s.

This is a shared-host study, not an isolated-host claim. Before measurement,
the coordinator must explicitly pause WARM worker builds/tests. Two observations
five seconds apart must show external aggregate CPU use <=20% of the host's ten
logical CPUs; observations repeat every five seconds and after each process.
The sum of non-excluded `ps` CPU percentages is divided by ten. Only the harness
process, its descendants, and exact ancestor PIDs are excluded; unrelated
children of ancestors remain external. Observed external compiler/build
executables also fail the host condition. Raw executable names, CPU/load and
PID relationships are retained without command arguments or environments.

Host activity above the frozen budget, an observation error, incomplete process,
missing quiet grant or expired budget makes the study inconclusive. Failed
preflight starts no measurements. An in-run violation stops after the active
process; all collected samples remain retained and no automatic retry occurs.
Sampled process activity cannot rule out unsampled interference or explain a
specific latency change. Any later passing result qualifies only this fixed
workload under its observed shared-host conditions and does not erase the
original failure.

`design-revision.json` retains an earlier draft's 25% per-process CPU rule and
the coordinator's correction to an aggregate capacity budget before any builds
or timings. No performance result informed that revision.

Both rebuilt binaries compiled successfully and `build-verification.json` confirms
that their instrumented vector source files are byte-identical to the original
study. The candidate's unused test pause-hook warning arises because the benchmark
replaces that hook with its own identical instrumentation in both revisions.
Five harness integrity tests passed; their exact output is in `harness-tests.log.gz`.

`codegen-inspection.json` and `original-*-rank-disassembly.log.gz` retain a read-only
inspection of the original binaries, including exact commands and executable hashes.
The original baseline dispatch reserves 464 stack bytes (`sub sp, sp, #0x1d0`);
the original candidate reserves 512 bytes (112-byte pre-indexed save plus
`sub sp, sp, #0x190`). This 48-byte increase is a concrete code-generation difference.
It does not establish the cause of the original tail-latency failure. Extracting
the complete stale exact route into a non-inlined helper is a bounded follow-up
implementation experiment; a changed candidate needs its own frozen comparison.

Use `uv run --no-project python` with `probe.py build baseline`, then
`build current`. `probe.py verify` checks pinned artifacts. `probe.py preflight`
records host availability without running the probe. After an explicit grant,
`probe.py run --quiet-grant '<coordinator message and timestamp>'` runs once;
`summarize.py` accepts only a complete, host-qualified ledger. Harness integrity
checks use `python -m unittest discover -s <this-directory> -p test_probe.py`.
