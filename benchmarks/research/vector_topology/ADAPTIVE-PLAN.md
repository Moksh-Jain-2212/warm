<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Post-hoc selective fallback analysis

Use only the 1,000 already-exposed degree-64/ef-512 and default/ef-2048 trace
outputs, their post-hoc combined rankings and the original local f32 arrays.
No graph search, timing, paid API call, download, or frozen study phase occurs.

Score and order all 18 degree-64 candidates with the standalone trace's
normalization and f64 accumulation. Check that the first ten reproduce the
saved degree-64 ranking. Four candidate features are the first score, tenth
score, first-minus-tenth spread, and tenth-minus-eleventh gap. The last feature
uses an internal candidate not currently exposed by the k=10 public API. Test
both low and high tails for each feature in the fixed order listed, low first.

Queries 0–499 are a fitting partition; derive the threshold for each policy
from its 50th most extreme fitting value, including ties. Among the eight
policies choose the one that recovers the most fitting-partition oracle misses
when fallback returns the previously rescored union of the two saved top-ten
sets; break ties by fewer fallbacks, then the fixed policy order. Apply that
unchanged threshold to queries 500–999. Report fallback count and recall for
both partitions, for every policy as well as the selected policy; never select
a policy on the second partition. Record all per-query features, fallback
decisions and outcomes. Unconditionally retain the baseline, union and all
policies, including those that fail quality gates.

Both partitions were exposed during earlier development; the second is an
internal split, not held-out confirmation. Fallback requires a second graph and
its update, memory, search and merge cost is unmeasured. A favorable result is a
hypothesis for independent validation, not a production policy, reliability
guarantee, timing result or competitive claim. Fix all hashes and preserve the
analysis in a fresh exclusive directory.
