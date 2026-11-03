<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Graph quality development diagnostic

`dev-graph-quality.mjs` is a local diagnostic for the modified public migration
API on the previously examined 10,000- and 100,000-row GloVe fixtures. It uses the
same 1,000 already-exposed queries, full dimensions, k=10 and ef 128/256/512. It
verifies the existing input and oracle hashes, clones the old WARM fixture into a
new owned directory and checks the copied file hashes before opening it. It builds
the current graph, validates every returned ID, original vector, metadata, score,
route and per-query recall, and records the current addon and script hashes. It
records no query timing. Its results can inform development and identify a recall
regression; they are not held-out evidence or a competitor speed comparison.

Run once into a fresh absolute directory after rebuilding the actual local addon:

```sh
node docs/research/technical-audit-20261029/vectra-comparison-followup-20261102/dev-graph-quality.mjs /absolute/new/output
```

A failure leaves its partial raw output and must be reported. This diagnostic is
separate from the newly frozen comparison protocol and never writes the old
fixtures or changes its stopped attempt. It uses no model downloads or paid calls.

The first diagnostic used a wider final shortlist. After it failed to change any
of the 5,000 comparable ordered rankings, that policy was reverted. The next
separate development attempt tests the existing qgraph independent result
reservoir with capacity equal to `ef`, retaining the original final shortlist.
Traversal remains unchanged by the reservoir. Compare all six cells and per-query
changes against both the original saved outputs and the wide-shortlist receipt;
record regressions as well as improvements. The same exposed queries are used for
this development decision, so a later comparison on them is not held-out proof.

`high-ef-development.mjs` declares a separate, untimed 100,000-row diagnostic at
ef 1024, 2048 and 4096 on the same previously exposed queries. Its quality results
can identify settings that meet the fixed mean and worst thresholds; they cannot
establish latency, an optimal default or held-out generalization. The wider
shortlist and reservoir implementations were both reverted before this diagnostic.
