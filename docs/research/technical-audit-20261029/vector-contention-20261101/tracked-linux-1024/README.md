# Changed-row ledger qualification

The frozen candidate is integrated root revision
`b4fc1ba634e1cca0ae8024f259fa6bcb8ef73954`, containing changed-row ledger commit
`8cd4cb9056b69ab6f6778cabd6a901c0735fe97c` and the graph-limitation docstring
clarification. No build or measurement has run for this study. The coordinator's
combined readiness gate and explicit workflow dispatch remain required. Baseline is
`ba980ffc16e01981bf1d025debfb83d6e7334aac`. No old emitted build manifest or
executable is reused.

`source-qualification/` preserves the initial scoped record and exact compressed
logs: 15 vector tests, 16 snapshot tests, strict library/test Clippy and no ignored
tests. Those source hashes precede docstring-only commit `d666cac1`; its patch and
the final integrated hashes are recorded separately. The three reviewed Rust files'
non-comment lines match. These scoped checks do not claim the pending combined
root gate has already completed.

This study retains the exact Rust query harness, 1,024 samples per phase,
five alternating pairs, complete ordered-result oracles, <=15% idle p50/p99
regression ceiling, >=50% writer-wait reduction at 128/768 dimensions and
<=20% observed external CPU capacity on a four-CPU public `ubuntu-24.04` runner.
The completion allowance is predeclared as **900 seconds** because the previous
complete workload used 594.311 seconds of its 600-second allowance. This provides
completion margin for VM runtime variation; it changes no quality threshold,
workload or process order. There are no automatic retries or sample exclusions.

The prior complete Linux study remains failed: stale-idle128D p99 increased
15.8254%, exceeding the 15% ceiling. Its exact export and readable summary remain
under `../ci-linux-1024/hosted-run-41383296700/`. The earlier macOS failure and both
blocked local confirmations also remain preserved. A result from this new source
would apply only to its fixed Linux VM workload; it cannot replace those findings
or establish production performance or physical-host isolation.

The existing optional workflow will select this directory as `EVIDENCE`. Its
commands remain `probe.py build baseline`, `build current`, `verify`,
`run --quiet-grant '<dedicated runner grant>'`, and `summarize.py`, using
`uv run --no-project python`. Online Cargo fetching occurs before the two fresh
offline serial builds. No models, paid cloud services or local timings are used.

The verified bounded log exporter is reused unchanged. The final always step
runs `probe.py emit-evidence`; it emits one SHA256/length-checked gzip/base64
archive in job logs, with no artifact uploads or cache saves. Retrieval reuses
`../ci-linux-1024/decode_joblog.py`. The complete exact compressed archive will
be canonical, alongside a small readable summary and verification metadata;
large raw JSON/logs are materialized on demand for byte-identical reproduction.
