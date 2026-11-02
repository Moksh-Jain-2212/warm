# Stale exact-vector query contention

This is a new local synthetic experiment, independent of the historical retrieval-tail
comparison. `plan.json` fixes the workload, acceptance conditions, process order and
instrumentation before production edits or timing. Source, compiler and executable hashes
are recorded in the build manifests; raw samples and complete ordered results are retained
in compressed JSON files.

The candidate is **not performance-qualified**: correctness and writer-wait conditions
passed, but the frozen idle-query latency condition failed. All ten planned processes ran
once, with no timing retries, threshold changes or post-measurement tuning.

The baseline is `ba980ffc16e01981bf1d025debfb83d6e7334aac`. Its stale exact path holds the
document read lock through the canonical base scan and the changed-document scoring pass.
The preimplementation diagnostic passed all 648 coherent brute-force oracle checks. Writer
lock-wait medians were 586, 880 and 3,766 microseconds at 16, 128 and 768 dimensions;
concurrent query medians were 590, 885 and 3,786 microseconds. These diagnostic samples are
excluded from the paired comparison.

The candidate captures live-row eligibility, bounded changed-document owners, and their
text segment under one document read guard. It releases the guard before any canonical
scoring. Base owners and embeddings are already pinned by the immutable vector snapshot;
changed owners are retained by `Arc`. Eligibility costs one bit per snapshot row, at most
512 KiB under the existing 4,194,304-row snapshot bound. Changed owners reuse the dense
index's limits of 128 documents and 1,024 matching embedded chunks. Crossing either limit
returns the existing complete generic-search fallback. The ranked-text read still holds
the document read guard and rejects scrubbed retained text. Fresh exact and graph scoring
retain their existing dispatch and ranking semantics.

The deterministic regression pauses canonical scoring and requires a writer to finish
replacement, deletion and insertion before scoring resumes. The complete ordered answer
must still equal the pre-write coherent oracle. Additional tests cover bitmap boundaries
63/64/65 and 127/128/129, delta limits 127/128/129 documents and 1,023/1,024/1,025 chunks,
canonical score/tie/minimum-score behavior, public overflow fallback, and scrubbing of both
captured base and delta text through durable replacement and compaction.

The benchmark uses 8,192 synthetic rows, dimensions 16/128/768, k=10, eight warmups and
64 recorded queries per phase. Phases are fresh idle, stale idle and stale with a writer.
The writer's replacement is prepared before the query; its signal arrives at canonical
scoring entry, without waiting in the query. This deliberately measures overlapping
scoring and updates. It does **not** measure writers arriving during capture, persistent
engine mutation cost, HTTP latency, or production concurrency. Capture still walks the
base eligibility and live-document metadata under a read lock. Each answer must equal the
complete pre-write oracle; paired processes also compare every complete ordered answer.

Query memory is peak net allocator-requested bytes on the query thread while ranking,
including retained ranked hits and temporary capture/scoring buffers. It excludes corpus
storage, existing owners retained longer by `Arc`, writer allocations, allocator metadata,
RSS and output serialization. The optimized test profile and identical probe instrumentation
are used for both revisions; these are not shipped release-binary timings. Processes run
serially only after an explicit quiet-window signal from the coordinating agent.

## Paired results

The five alternating pairs completed in 20.76 seconds. All 6,480 coherent brute-force
checks passed, and every recorded complete ordered result matched across revisions and
processes. Values below are medians of the five per-process statistics; times are
microseconds. `summary.json` and the ten `execution-*.json.gz` files retain the values and
every sample.

| Dimensions | Phase | Query p50 baseline → candidate | Query p99 baseline → candidate | p99 change |
|---|---|---:|---:|---:|
| 16 | Fresh idle | 27.92 → 27.92 | 35.875 → 44.708 | +24.62% |
| 16 | Stale idle | 590.21 → 591.21 | 629.541 → 660.250 | +4.88% |
| 16 | Stale with writer | 596.33 → 598.12 | 631.625 → 653.333 | +3.44% |
| 128 | Fresh idle | 285.38 → 284.96 | 309.709 → 319.208 | +3.07% |
| 128 | Stale idle | 888.83 → 875.25 | 1,003.791 → 1,067.750 | +6.37% |
| 128 | Stale with writer | 899.25 → 889.21 | 951.042 → 938.459 | −1.32% |
| 768 | Fresh idle | 2,995.25 → 2,986.33 | 3,382.750 → 3,241.667 | −4.17% |
| 768 | Stale idle | 3,807.29 → 3,577.08 | 4,094.417 → 3,895.375 | −4.86% |
| 768 | Stale with writer | 3,805.71 → 3,597.25 | 4,031.208 → 3,882.416 | −3.69% |

Writer lock-wait p50 changed from 591.500 to 0.041 microseconds at 16 dimensions,
894.500 to 0.042 at 128, and 3,787.250 to 0.042 at 768. The two required dimensions
exceed the predeclared 50% reduction. This measures lock acquisition after the scheduled
writer begins; signal delivery, scheduler delay and persistent mutation cost are excluded.

Stale idle query peak requested memory increased from 1,360 to 3,408 bytes and stale
writer query memory from 1,552 to 3,600 bytes, with allocator calls increasing from two to
four. The additional 2,048 bytes are the 8,192-bit eligibility map and reserved delta-owner
capacity in this fixture. Fresh queries remain at 720 bytes and two allocations. The
larger documented bounds are established by code and boundary tests, not by this workload.

The idle-query gate requires every dimension's median process p50 and p99 to increase by
no more than 15%. Fresh 16-dimensional p99 increased 24.62%, so the gate fails even though
its p50 was unchanged and all other idle groups passed. With 64 samples, the nearest-rank
empirical p99 is each process's maximum. The five paired changes for this group were
−43.93%, −13.15%, +211.83%, +24.62% and +29.53%; none was excluded. Code inspection finds
the fresh branch and canonical scorer unchanged apart from whitespace and the test-only
pause hook, which the benchmark replaces with identical instrumentation in both variants.
This does not rule out code-generation effects from the changed surrounding function.

The coordinator held this task's workers' builds and tests during measurement. The host
was **not isolated**: load averages began at 13.48/7.38/5.43 and ended at 10.14/7.09/5.38;
`mediaanalysisd` showed 116.8% CPU at the start and 105.7% at the end. The end snapshot also
shows an external Python process (PID 39270, parent 26751) at 54.7% CPU, but its overlap
with measured samples is unknown. `execution.json` and `execution-context.json` preserve
the endpoint observations. They cannot attribute the failed tail-latency condition to
either the patch or a particular background process. The measurements remain confounded
observations, and no production speedup or performance qualification is claimed.

`probe.py` builds pinned offline source archives, records a separate diagnostic, and runs
the five frozen alternating pairs without automatic retries. `summarize.py` uses the median
of each process's nearest-rank p50/p99, retaining all samples. The first baseline build
compiled successfully but the collector expected the wrong library target name; the
corrected collector recovered its unchanged cached executable before any measurements.
`build-baseline-collector-error.json` retains that metadata error.

To reproduce, create a separate worktree of the baseline revision and copy only
`plan.json`, `probe.py`, `contention_probe.rs` and `summarize.py` into this same evidence
directory there. Run `uv run --no-project python
docs/research/technical-audit-20261029/vector-contention-20261101/probe.py build baseline`,
then `build current`, then `run` during a quiet window, and run `summarize.py`. The current
source commit must also be available in that repository. Existing build and run records
intentionally prevent accidental overwrites; preserve the new worktree's independent outputs.
