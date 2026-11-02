# Fixed Linux vector qualification

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
