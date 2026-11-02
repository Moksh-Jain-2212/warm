# Local graph recall investigation, 2026-11-02

These are development diagnostics over the same 100,000-row GloVe input and
1,000 baseline unfiltered queries used in the interrupted frozen comparison.
They are not an independent evaluation: the results have been used to guide
changes. They exercise `Graph`/`VGraph` directly, not the complete Node API,
and do not establish application latency or a speed comparison. Elapsed times
in the logs include uncontrolled concurrent work and must not be compared.
The benchmark's planned ef=512 study arm was interrupted and remains incomplete.

The default-build diagnostic reproduced both completed study arms exactly:
ef=128 retrieved 9,235/10,000 oracle neighbors, with a worst query of 1/10;
ef=256 retrieved 9,634/10,000, with a worst query of 5/10. On this local
full-query diagnostic, ef=512 retrieved 9,859/10,000 (worst 6/10), and
ef=4096 retrieved 10,000/10,000. These are observations about this input,
not a guarantee of recall for other inputs or a replacement study result.

At ef=128, 256, and 512, increasing the returned shortlist from 18 to the
beam size did not change recall. Additional diagnostic runs explore graph
construction degree and retention independently; consult the logs for the
parameters and outcomes. The default baseline used shortlist pairs
(128,18/128), (256,18/256), (512,18/512), (1024,1024), (2048,2048), and
(4096,4096); the saved `recall_diagnostic.rs` uses shortlist 18 for each ef
and allows construction parameters to be selected through environment variables.
With degree 2,048 and build ef 500, the diagnostic retrieved all 10,000
neighbors at each of ef=128, 256 and 512. A 100,000-row fixed-slot adjacency
alone reserves approximately 819 MB during construction at that degree,
versus 12.8 MB at degree 32; neither quantity is total process memory. This
setting has not been selected as a product default or independently evaluated.

All diagnostic builds used commit `1ff8ecebea26ef47334c657f3e337e00ff22d3ec`;
qgraph `mod.rs` SHA-256 `2c40d9d6eacb922cb360d3464ad3a6a525a631124a122a4d3ad2e475d751f6fe`
and `vertex.rs` SHA-256 `bbfecd6d8d7b2dd6eeffeb3fa9ba399ebc3b5573e05da4b6f0a0f2914f4f629b`.
Inputs and SHA-256:

- `/Volumes/A/.hms-bench-cache/competitive/data/glove-100-angular-n100000-q1000/train.f32`: `119360a40fed67fd92d9a16ff15b21e5566ecaef1865f93ff07efc53e2bca8e7`
- `/Volumes/A/.hms-bench-cache/competitive/data/glove-100-angular-n100000-q1000/test.f32`: `d834585869aac11aba8de8dffe22ec50006b22d223ed1cce1ad357611091d613`
- `/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen/results/preparation-0030-glove-100000-oracle-oracle.ndjson`: `d3d9b337c191f8c2ff628a2af63d206367dcfcb05e016017797b62576bfc8ae8`

The diagnostics load the first 100,000 100-dimensional float32 rows, reproduce
the Rust store's f64 normalization and f32 representation, build the graph,
and compare canonical re-scoring of returned candidates with the frozen f64
oracle. To rerun, copy either Rust source into `examples/` in a clean checkout
of the cited commit and run `cargo run --release --offline --locked --example
recall_diagnostic`. Set `RECALL_DEGREE`, `RECALL_BUILD_EF`, and `RECALL_ALPHA`
as needed. The reservoir diagnostic uses the same variables. Its `rerank`
width is the larger of ef and reservoir; it changes candidate retention, not
traversal. The baseline and each modified setting must be distinguished from
any later frozen end-to-end evaluation.

The ensemble diagnostic builds up to eight independent graphs with consecutive
seeds and merges each graph's 18 candidates before canonical scoring. Eight
graphs at ef=128 retrieved 9,742/10,000 oracle neighbors, with a worst query
of 7/10; eight at ef=512 retrieved 9,984/10,000, with a worst query of 8/10.
This does not justify deploying the ensemble. See `ensemble.log` and
`recall_ensemble.rs`; run the latter as an example in the same way as above.
