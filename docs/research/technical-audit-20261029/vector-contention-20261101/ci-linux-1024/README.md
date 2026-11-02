# Fixed Linux vector qualification

**Qualification failed.** The single hosted [run 41383296700](https://github.com/writerslogic/warm/actions/runs/41383296700)
completed all ten processes in 594.311 seconds. All 92,880 coherent oracle checks
passed, and all 92,160 retained ordered answer lists matched across processes
and revisions. The writer-wait condition passed, but stale-idle 128-dimensional
p99 increased from 2,170,290 to 2,513,746 ns (+15.8254%), exceeding the fixed
15% ceiling. Its p50 increased 3.7512%. Every other idle p50/p99 condition passed;
the fresh 16-dimensional p99 increase was 4.3782%. No thresholds, samples or
processes were changed or excluded, and no retry occurred.

All 130 frozen host observations passed: external CPU capacity was 0.20–0.45%,
with four logical x86_64 CPUs and zero reported steal ticks throughout. Those
observations do not establish physical-host isolation or explain the failed
tail condition. The Linux result does not replace the earlier macOS failure
or blocked local attempts. The integrated source remains unqualified under
this experiment's complete acceptance rule.

The complete 41-file export is retained in `hosted-run-41383296700/`; run/job
metadata, the compressed original job log, transport verification and independent
checks are in `retrieval-41383296700/`. The 1,450,491-byte archive's SHA256 is
`e5a4e685096c04dfaa6842704d595d467078f933da5dff17f18a74881cc06991`.
Safe extraction accepted only bounded, unique, relative regular-file paths.
The frozen plan/scripts match workflow commit `050223a69cb5a907887de84e3e16a2ddf6c3bff4`;
source, reconstructed instrumentation, Cargo inputs, every report/log digest and
every cross-process answer were independently checked. The retained summary
reproduced byte-for-byte and correctly returned exit status 1. Executable hashes
were checked by the pinned runner driver before measurement; binaries are not
exported, so local verification does not claim to rehash their bytes.

`decode_joblog.py` reconstructs the archive from the retained compressed log with
length/SHA256 and safe-member checks. Running `summarize.py` inside the retained
hosted-run directory recomputes the summary without a benchmark and returns 1
for this failed qualification. `retrieval-41383296700/verification.json` records
the exact limits and per-process values for the failed condition.

This is one separately preregistered comparison on a free standard public
GitHub `ubuntu-24.04` runner. Baseline `ba980ffc16e01981bf1d025debfb83d6e7334aac`
and integrated candidate `d7f5982f4612a16b78071d013ee858c64447a133` are fixed.
Both are built serially from source on the same runner with Rust 1.99.0,
two build jobs, opt-level 3, debug 0 and identical instrumentation. The workflow
fetches dependencies once before both offline builds; the pinned manifests and
lockfiles are identical and their hashes are recorded in `plan.json`.

The Rust harness is byte-identical to the local 1,024-sample harness: 8,192 rows,
dimensions 16/128/768, k=10, eight warmups, 1,024 queries per phase, original
64 query vectors repeated 16 times, and the original writer-version progression.
Five alternating pairs, complete ordered-result oracles, <=15% idle p50/p99
regression, >=50% writer-wait reduction at 128/768 dimensions, and the 600-second
measurement budget remain fixed. There are no automatic retries or exclusions.

The runner must report Linux x86_64 and four logical CPUs. External aggregate
process CPU capacity must remain <=20%, with two preflights five seconds apart
and five-second observations during measurement. No concurrent WARM builds/tests
are allowed. Host or completeness violations make the attempt inconclusive;
all collected evidence is retained. This is a VM-specific result, not evidence
of macOS, production, general-hardware or physical-host isolation. The original
64-sample failure and both local preflight failures remain unchanged.

[GitHub's runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
describes the selected public standard runner's four CPUs, 16 GB memory and
14 GB SSD. This citation establishes platform eligibility, not performance.
Aggregate `/proc/stat` counters, including steal ticks when available, are
retained only as observations; they add no acceptance threshold. Their field
definitions come from the [Linux kernel documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

The manual job in the existing `bench-refresh.yml` performs the online Cargo
fetch, then runs `probe.py build baseline`, `build current`, `verify`, `run
--quiet-grant '<dedicated runner grant>'`, and `summarize.py` using
`uv run --no-project python`. Build logs are written inside this evidence
directory from the start, including incomplete or failed compilation output.

The final workflow step always invokes `probe.py emit-evidence`, using system
Python 3.12 if uv setup failed. It exports only regular files under this directory
to a deterministic gzip tar; symlinks and unsafe names are rejected, Python
bytecode caches are omitted, and input/archive bytes are each capped at 64 MiB
with at most 1,000 files. Only after the archive passes validation does it print
`WARM_VECTOR_EVIDENCE_BEGIN` metadata (byte count, SHA256), 16,384-character
`WARM_VECTOR_EVIDENCE_DATA` base64 chunks and a matching `WARM_VECTOR_EVIDENCE_END`.
Failure emits an error and no successful END. There are no artifact uploads,
cache saves, executable exports or paid services. The coordinator reconstructs
the archive from job logs, verifies its byte count/SHA256 and safe member paths,
and records the retrieved evidence separately from this frozen plan.
