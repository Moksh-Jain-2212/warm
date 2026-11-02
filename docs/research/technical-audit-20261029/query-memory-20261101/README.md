# Filtered query capture memory

The selected change is the sorted-owner candidate
`5b3b4c61d0adeb39f7373fa19c4da00cfc4a5108`, based on main
`ba980ffc16e01981bf1d025debfb83d6e7334aac`. It replaces a temporary owner hash set
with sorted exact owner addresses and drops the lexical slot mask before
constructing that membership table. With the tested Rust 1.99 build, collecting
the consumed document-reference vector into the address vector reuses its
allocation. The dense index still pins its owners; existing capture, replacement,
scrubbing, scoring, and tie-order contracts are unchanged.

The frozen [plan](plan.json) compares this candidate (`sorted`) with the existing
hash-set implementation (`baseline`) and a compact checked-offset hash set
(`current`). The latter name is an experiment label, not the selected production
implementation. Its source is
`64af5a4804717562c48922cee1776e1bb0d4cf5b`.

## Measured allocation and correctness results

All 15 serial processes completed in 99.23 seconds. All 7,680 exhaustive ordered
result comparisons and the full cross-revision payload comparisons matched,
including scores. The per-query requested-byte peaks below are medians of five
process-round medians, on the frozen 10,000-row synthetic workload:

| Query group | Baseline | Sorted owners | Change |
|---|---:|---:|---:|
| Initial rare | 127,509 B | 60,391 B | -52.64% |
| Updated rare | 127,445 B | 60,991 B | -52.14% |
| Initial hot | 44,255 B | 44,247 B | -0.02% |
| Updated hot | 44,191 B | 44,183 B | -0.02% |

The first initial rare query had a higher cold peak: 327,689 B for baseline and
260,562 B for sorted owners, identically across all five rounds. The compact
candidate reduced the rare median peaks by approximately 8.08%, less than sorted
owners. All candidate reports, including the unselected candidate, are retained.
The [allocation attribution](allocation-attribution.json) records the original
overlap of the document-reference vector, slot mask, and owner hash set.

These are process-local requested allocation bytes, not RSS, allocator overhead,
or a production memory bound. The complete [summary](summary.json) retains cold
queries, allocation counts, lifecycle measurements, and every latency group.

## Timing limits and candidate selection

The predeclared descriptive regression trigger did not fire for either
candidate: it required a median p50 or empirical p99 increase over 5%, with at
least four of five paired process rounds slower. Sorted owners therefore wins
the recorded selection rule through the larger rare-query allocation reduction.
This does not establish latency noninferiority or a speed improvement.

In particular, updated-rare empirical p99 increased from 1.368 ms to 1.510 ms
(+10.37% in the medians of round quantiles). Only two of five paired rounds were
slower, and paired changes ranged from -69.25% to +52.98%. The first-rare p99
paired changes also include a +231.83% observation. No observation was removed
or rerun to change this outcome.

The [pre-run host snapshot](host-observation.json), at
2026-11-02T01:54:16.141632Z, recorded another Python process at 66.2% CPU. Its
parent belonged to the separate `Documents/finetune` environment and a different
terminal Codex process from the benchmark driver. The snapshot establishes
concurrent host activity before measurements; it does not establish that task's
purpose, how long it continued, or which measurement it affected. The host also
ran ordinary desktop applications. WARM workers had coordinated a build/test
pause, but an isolated quiet host cannot be claimed. No other process was
stopped or inspected for credentials.

Timing remains a descriptive, confounded comparison. Exact-result and
process-local allocation evidence are reported separately. The observation does
not justify attributing unfavorable tails to a particular process, nor does it
invalidate the measured allocation accounting. No follow-up timing run was
performed.

## Reproduction and validation

`probe.py` pins source revisions, the plan, harness, compiler, executable hashes,
and raw reports. It refuses to overwrite an execution ledger or automatically
retry a measurement. The existing run can be independently summarized without
repeating timing:

```sh
uv run --no-project python docs/research/technical-audit-20261029/query-memory-20261101/summarize.py
uv run --no-project python -m unittest discover -s docs/research/technical-audit-20261029/query-memory-20261101 -p test_probe.py
```

The small [candidate source bundle](candidate-sources.bundle) preserves both
original signed candidate commits without relying on publication of experimental
branches. It requires the recorded baseline commit. `git bundle verify` checks
that prerequisite; `git bundle unbundle` imports the candidate objects without
changing the checkout or branches.

`probe.py --help` describes the original driver: actions `baseline`, `sorted`,
and `current` build the corresponding archived source, and `run` executes the
frozen comparison. Its build manifests include the exact commands, settings,
source, and executable hashes. A new run requires a separate worktree with a
separate evidence directory and an explicit coordinated window, preserving these
artifacts. No models, paid APIs, or cloud workloads were used.

[Focused validation](focused-validation.json) distinguishes the prior candidate
test results. [Final validation](final-validation.json) records selected-source
identity, artifact verification, and final selected-source checks. Integration
with the other recovery changes and the repository's final CI gate remain the
coordinator's responsibility.
