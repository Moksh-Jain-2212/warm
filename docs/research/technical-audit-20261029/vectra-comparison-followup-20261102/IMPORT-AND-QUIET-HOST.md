<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Import investigation and proposed next attempt

This is a proposal and local development evidence, not authorization or a study
result. Keep the repaired Vectra attempt and companion competitor attempt, their
failed admissions and all receipts unchanged. Existing query sets have been
exposed and no WARM advantage has been established.

## Vectra memory investigation

The failed Vectra worker loaded an 80,000,000-byte widened corpus and reached a
sampled 8,701,362,176-byte process-tree RSS. The final `index.json` is
117,964,800 bytes and ends in the middle of a value. A streaming scan found 55,257
`"id":` occurrences, including any incomplete final record; this does not prove
how many records were acknowledged, and the truncated file is not a reusable
fixture. The kill can interrupt the full-file overwrite. The worker had not
finished its initial import stage.

Pinned Vectra 0.15.0 shallow-copies the array of item references in
`beginUpdate`; it does not duplicate every vector there. Each `endUpdate`
serializes the complete growing index as `Buffer.from(JSON.stringify(data))`
and overwrites the file. The original schedule did this for every 100 records.
V8 heap accounting, external buffers, allocator retention and the input fixture
are different parts of the process footprint; RSS is not their simple sum.

Local synthetic experiments used the same Node 26.8.1 and Vectra package, 100
dimensions, deterministic f32 values widened to JS numbers, and matching metadata.
All final indexes were reopened and every ID, vector and metadata value checked.
They made no query timings, used no benchmark corpus, and are not the study:

* At 10,000 rows, 100-record transactions serialized 1,087,941,713 cumulative
  bytes in 100 calls; one transaction serialized 21,543,746 bytes once. Both
  produced the same final file hash. During the final serialization, observed
  RSS was 1,204,666,368 versus 289,390,592 bytes. These in-process snapshots
  capture points a one-second process monitor can miss.
* A separate 10,000-row controlled ablation retained 100 transactions and the
  real Vectra array-copy and insertion path, but replaced the first 99
  serializations and writes with `{}` and serialized the complete index only
  at the end. This deliberately has different intermediate durability and is
  not a benchmark candidate. Final file hashes and contents matched. The final
  serialization's after-call RSS was 1,209,860,096 bytes normally and
  286,638,080 bytes in the ablation. This implicates repeated serialization and
  its associated writes, not array copying alone; it does not isolate the
  allocator, string encoding and I/O individually.
* Capping V8 old space at 256 MiB was a diagnostic only. Its corresponding
  after-call RSS was 1,212,170,240 bytes, and it did not alleviate the observed
  footprint. The normal run's after-call V8 `heapTotal` was 110,051,328 bytes
  and `external` 55,423,048 bytes while RSS was 1,209,860,096 bytes. The
  accounting fields overlap and do not explain all RSS.
* A separate instrumented 10,000-row run captured macOS `vmmap` immediately
  after the 100th update. It reported a 1.1 GiB physical footprint and 884.4 MiB
  resident in `Malloc Large (empty)` regions. This directly supports retained
  allocator pages as a substantial contributor in that synthetic process; it
  does not identify every allocation or prove the failed real worker's exact
  breakdown. No allocator or runtime tuning is proposed from this observation.
* A 100,000-row one-transaction synthetic `LocalIndex` run serialized
  215,535,925 bytes once, validated all records after reopen and had a sampled
  process-tree RSS peak of 1,178,484,736 bytes. It did not load the full study
  fixture or execute the study's other phases. The revised actual harness also
  imported a synthetic 100,000-row fixture, with 80,000,000 bytes of widened
  corpus and three synthetic queries, checked all records, and reopened them in
  a separate process. One-second sampled RSS peaked at 1,083,883,520 bytes for
  preparation and 910,426,112 bytes for reopen; stage snapshots and shorter
  transient peaks can differ. The real study has 1,000 queries and other phases.
  None of these measurements establishes the real input's peak or duration.

Raw diagnostics, code snapshots, results and resource observations are retained
under `/Volumes/A/.hms-bench-cache/vectra-import-diagnostic-20261102-v1`,
`/Volumes/A/.hms-bench-cache/vectra-import-diagnostic-20261102-v2`,
`/Volumes/A/.hms-bench-cache/vectra-import-profile-20261102-v1`,
`/Volumes/A/.hms-bench-cache/vectra-import-vmmap-20261102-v1`, and
`/Volumes/A/.hms-bench-cache/vectra-import-worker-validation-20261102-v1`.
The first attempted external `vmmap` snapshot missed the exited process; its
error is retained in the profile directory. The successful snapshot is
`vmmap-vmmap.txt` in the subsequent directory.

Reproduce using new, nonexistent output directories and the pinned local package;
no downloads are needed. The scripts record hashes and per-worker receipts.

```sh
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vectra_import/diagnose.mjs /absolute/new-small-output small
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vectra_import/diagnose.mjs /absolute/new-large-output large
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vectra_import/profile.mjs /absolute/new-profile-output comparison
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vectra_import/profile.mjs /absolute/new-vmmap-output vmmap
env -u NODE_OPTIONS /opt/homebrew/Cellar/node/26.8.1/bin/node benchmarks/research/vectra_import/validate-worker.mjs /absolute/new-worker-output
```

## Proposed revision

For a separately authorized, freshly frozen combined attempt, create each initial
Vectra vector fixture in one public `beginUpdate`/`endUpdate` transaction, feeding
records one at a time. WARM fixture creation stays in 100-record transactions.
The two initial import stages therefore have different transaction and
acknowledgement semantics: retain their receipts but do not claim an import-speed
comparison between them. A failed or interrupted write remains quarantined and
is never resumed. Full-record and separate-process reopen validation remain
mandatory. Actual Vectra single-write and 100-operation timed workloads,
durability labels, query arms, hybrid fixture schedule, correctness and quality
criteria, phases and fixed two-hour deadlines are unchanged.

The standalone competitor study retains its own frozen index-only schedule and
must not be compared directly with the migration API. Both studies still require
fresh exclusive output directories and one start per phase. Freeze the revised
committed source, protocol, inputs, dependencies, addon and actual host; if the
host changes, rebuild and verify the appropriate local native dependencies and
freeze them on that host. Set the combined freeze configuration's `plan` to this
document. Both controllers also hash this document and the original and follow-up
plans as frozen artifacts. Existing grant and verification requirements apply.
No phase starts without explicit user authorization. Preserve failure, timeout,
and incomplete outputs; do not restart a phase or select a favorable attempt.
The two-hour combined schedule remains a material completion risk.

## Quiet-host preparation before the single preflight

The failed companion preflights included WebKit processes using approximately
one logical CPU each, along with Terminal, window-management and other activity.
On this macOS host, `man ps` describes `%cpu` as a decaying average over up to a
minute, not an instantaneous five-second utilization measurement. The existing
gate still uses its recorded values without reinterpretation or threshold change.

Use a reserved host or an agreed idle window on this host, with power and sleep
settings arranged in advance. The host owner should close or defer their own
browser, interactive apps, builds, inference, sync and scheduled heavy work;
do not terminate unrelated processes. Reserve enough uninterrupted time for the
entire phase. Finish builds and any intended preparation before timing; never
overlap the two studies' timing. At the scheduled time, take one process inventory
to verify that known competing workloads are absent and record host/setup details.
If that setup cannot be arranged, do not start a measurement phase. After the
last planned workload ends, allow a fixed two-minute settling interval without
CPU-threshold probing, then start the measurement phase once. This interval lets
the documented `ps` average decay but cannot guarantee a quiet host or protect
against a later daemon or interactive spike.

The controller then performs its existing single admission consisting of two
five-second intervals, each with every one-second observed external CPU fraction
at most 0.20, and continues monitoring throughout measurement. It retains the
8 GiB per-process/two-consecutive-sample RSS limit, all correctness, mean >=0.99
and worst-query >=0.90 quality gates, and no-retry rules. An admission or later
load violation ends the phase with no retry; do not repeatedly observe threshold
windows and pick a favorable start. The receipt and all failed attempts remain
part of the result.
