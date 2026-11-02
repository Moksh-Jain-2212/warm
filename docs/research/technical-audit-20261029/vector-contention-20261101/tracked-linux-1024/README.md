# Changed-row ledger qualification

**Qualification passed for this fixed Linux VM workload.** The single
[run 41387201348](https://github.com/writerslogic/warm/actions/runs/41387201348)
completed all ten processes in 537.555 seconds, within the predeclared 900-second
allowance. All 92,880 coherent oracle checks passed, and all 92,160 retained full
ordered answers and canonical score bits matched across processes/revisions.
Every idle-query p50/p99 condition and the required writer-wait condition passed.
No sample, process, threshold or workload changed; no retry occurred.

Values below are medians of the five per-process p99 statistics, in milliseconds.

| Dimensions | Stale-idle baseline p99 | Candidate p99 | Change |
|---|---:|---:|---:|
| 16 | 1.182816 | 0.173795 | −85.31% |
| 128 | 1.978206 | 0.947464 | −52.10% |
| 768 | 7.437951 | 6.118674 | −17.74% |

All fresh-query p50/p99 changes were non-positive in this comparison. Required
writer lock-wait medians fell more than 99.99%; this measures acquisition after
the scheduled scoring-entry signal, not persistent mutation cost or arbitrary
writer arrivals. The benchmark covers the exact-vector route; graph delta
discovery retains its separately documented live-store scan.

All 119 host observations passed: four logical x86_64 CPUs, external process CPU
capacity 0.15–0.40%, and zero reported steal ticks throughout. These observations
do not establish physical-host isolation or imply production/macOS performance.
Earlier failed and blocked experiments remain preserved with their original
outcomes; this qualification applies to the new integrated source and workload.

`hosted-run-41387201348/evidence.tar.gz` is the exact 47-file export, retained
without modification (1,409,904 bytes; SHA256
`0d1a9ef796b6eeb4f250037d23935153134ac9a7b3fc35d6bed5ba1d349108ed`).
The readable summary and storage metadata are alongside it. Run/job metadata,
the compressed original job log, member hashes and independent verification
are in `retrieval-41387201348/`. Frozen files match workflow commit
`2ccdfa1cf64cfbd59c0751c7fa1bd9d680667c47`; all pinned source, reconstructed
instrumentation, Cargo/build-manifest and raw report/log hashes were checked.
The original summary reproduced byte-for-byte with exit status 0. Executables
were hashed by the pinned runner driver before measurement; their bytes are
intentionally not exported, so local verification does not rehash binaries.

The frozen candidate is integrated root revision
`b4fc1ba634e1cca0ae8024f259fa6bcb8ef73954`, containing changed-row ledger commit
`8cd4cb9056b69ab6f6778cabd6a901c0735fe97c` and the graph-limitation docstring
clarification. The coordinator completed its combined readiness gate before the
single explicit workflow dispatch. Baseline is
`ba980ffc16e01981bf1d025debfb83d6e7334aac`. No old emitted build manifest or
executable is reused.

`source-qualification/` preserves the initial scoped record and exact compressed
logs: 15 vector tests, 16 snapshot tests, strict library/test Clippy and no ignored
tests. Those source hashes precede docstring-only commit `d666cac1`; its patch and
the final integrated hashes are recorded separately. The three reviewed Rust files'
non-comment lines match. This initial scoped record remains separate from the
coordinator's combined readiness gate and the hosted qualification result.

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
`../ci-linux-1024/decode_joblog.py`. The complete exact compressed archive is
canonical, alongside a small readable summary and verification metadata;
large raw JSON/logs are materialized on demand for byte-identical reproduction.

From the repository root, using a new output directory (summary only; no benchmark):

```sh
vector_evidence=docs/research/technical-audit-20261029/vector-contention-20261101/tracked-linux-1024
uv run --no-project python "$vector_evidence/../ci-linux-1024/decode_joblog.py" \
  "$vector_evidence/hosted-run-41387201348/evidence.tar.gz" \
  target/vector-evidence-reproduced-41387201348 target/vector-evidence-reproduced-41387201348-transport.json \
  --archive-metadata "$vector_evidence/retrieval-41387201348/transport.json"
uv run --no-project python target/vector-evidence-reproduced-41387201348/summarize.py \
  > target/vector-evidence-reproduced-41387201348/reproduced-summary.stdout
cmp target/vector-evidence-reproduced-41387201348/summary.json \
  "$vector_evidence/hosted-run-41387201348/summary.json"
```
