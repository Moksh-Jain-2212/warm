<!-- Copyright 2024-2026 WritersLogic Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Graph construction development diagnostic

This offline diagnostic uses the already exposed GloVe 100,000-row corpus and
1,000 queries, the saved independent exact oracle, full 100-dimensional vectors,
k=10 and ef 128/256/512. It reconstructs WARM's normalization, default graph
builder, 8-bit traversal/residual encoding, candidate retrieval and canonical
full-vector rescore. It first requires all 3,000 default ordered rankings to match
previously saved public WARM output. If they do not, it stops before comparing any
other configuration; agreement is evidence about these results, not proof that
every internal graph detail is identical.

After that control, it builds degree 48 / construction ef 400 and degree 64 /
construction ef 500, retaining all other shipping defaults. These fixed points
are motivated by earlier standalone experiments but those experiments do not
establish performance on this corpus or through WARM's API. For each point, save
every query's IDs and oracle hits, the graph structure hash, mean and worst recall
and the count below 90%. Do not select a product default from mean recall alone or
claim a speedup: building, memory, mutation, tail latency and held-out workloads
are not measured here. No query timing, model download or paid service is used.

Compile with the pinned local lockfile and run into a fresh absolute directory:

```sh
cargo build --release --offline --locked --manifest-path benchmarks/research/vector_topology/Cargo.toml
node benchmarks/research/vector_topology/run.mjs /absolute/new/output /absolute/path/to/warm-vector-topology-development
```

The controller verifies input and oracle hashes, copies and hashes the executable,
preserves every raw result, validates each query independently against the oracle,
and monitors the owned process tree with an 8 GiB per-process limit and a shared
2-hour deadline. A failure is retained as incomplete, with no automatic retry.
