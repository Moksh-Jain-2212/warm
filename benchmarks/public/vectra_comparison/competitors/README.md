<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Standalone Node ANN comparison

This is a separate, unfiltered index-only study, not a Vectra migration or WARM
public-API benchmark. It adds hnswlib-node 3.0.0 and USearch 2.26.5 to the existing
comparison without treating different interfaces as equivalent. These libraries
return IDs and distances; this study does not include filtering, metadata, original
f64 vector returns, transactions, durability, hybrid search or application packing.
Do not compare its timings directly with the migration adapter or claim an
end-to-end WARM advantage from this study. The GloVe queries have already informed
WARM development and are not held-out proof.

Use only the existing GloVe f32 arrays and the complete independent oracle saved
in the user-stopped attempt. Freeze verifies their SHA256 values against the input
manifest and the stop receipt. The schedule uses the first 10,000 and 100,000
training rows and the same 1,000 test queries, one query at a time. Both systems
use cosine and full-dimensional f32 vectors, connectivity 32, construction effort
200 and search effort 128, 256, 512 and 2048. hnswlib uses seed 100; USearch's Node API
does not expose a build seed. Each arm is built separately, saved, and queried for
quality. Each timing repetition opens the saved index in a fresh process, warms up
20 fixed queries and times all 1,000 in source order. Three repetitions rotate the
arm order. Load, build, save, file bytes and whole-process sampled RSS are recorded
separately. The timed region includes the Node index call and required argument and
result conversion; result validation and JSON output are outside it.

Every returned ID must be unique and in range, every score finite, cosine-correct
within 2e-6 and ordered. All 1,000 query IDs must occur once in order. Each arm and
timing repetition independently reports mean and worst recall against the frozen
oracle. Quality qualification requires mean >= 0.99 and worst >= 0.90; failures
remain visible, and a qualified point is not evidence of a speed advantage. Empty,
filtered and churn cases are unsupported rather than silently emulated. RSS uses
one-second process samples and can miss short peaks.

Means use compensated summation. Threshold comparisons allow four machine epsilons
solely for floating-point representation at equality; thresholds are not rounded.

The controller hashes its own and worker sources, their shared scoring and resource
helpers, package lock, runtime, loaded JavaScript/native dependencies, inputs and
oracle, then verifies them before each phase. It uses a fresh exclusive output,
one no-retry start per phase, two-hour preparation and measurement ceilings,
8 GiB per-process RSS ceiling and the existing two-interval host-load preflight.
Measurement aborts on load or resource violations and keeps partial receipts.
Do not run other benchmark work or builds during timing. Never relax a gate or
select a best retry after viewing results.

From the repository root, after installing the isolated locked dependencies and
building hnswlib-node for this host, run:

```sh
node benchmarks/public/vectra_comparison/competitors/run.mjs freeze /absolute/new/output
node benchmarks/public/vectra_comparison/competitors/run.mjs preparation /absolute/new/output
node benchmarks/public/vectra_comparison/competitors/run.mjs measurement /absolute/new/output
```

The freeze contains absolute paths and host-specific native hashes; copying it to a
new machine does not create a valid run. No model download or paid service is used.
