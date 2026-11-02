# Fresh native Matryoshka evaluation

Status: protocol scope approved; no real embedding generation or query measurements have run.
The source revisions, harness, prepared input manifest and executable hash must be
frozen before generation. Query timings additionally require the coordinator's
quiet-window grant after all participating builds finish.

## Question and scope

Does WARM's opt-in prefix graph, followed by canonical full-vector reranking,
preserve useful retrieval quality and improve serving latency on the complete
public SciFact test split? This is one 5,183-document benchmark, not held-out
production validation, answer accuracy, a 100K scale result, or permission to
discard full vectors or factual records. Earlier cached LongMemEval development
results remain historical and do not determine this study's configuration.

## Inputs and model

- Source directory: `/Volumes/A/.hms-bench-cache/downloads/scifact`.
- BEIR source archive URL:
  <https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip>.
  The unpacked source hashes below, rather than an unverified archive claim,
  identify this run's actual inputs.
- `corpus.jsonl`: 5,183 rows, 8,106,566 bytes;
  SHA256 `dec31c8182f3d744c7d2c09423756fd1d17cbef75808db13ba01cc0aab4d1ac6`.
- `queries.jsonl`: 209,731 bytes;
  SHA256 `8ff84a7c903f722981cd8d595c022660140c51867b27608a6d4910db86080313`.
- `qrels/test.tsv`: 339 rows covering 300 test queries, 5,389 bytes;
  SHA256 `0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c`.
- Preserve corpus file order and source IDs. Each document is exactly
  `title + "\n" + text`; the longest has 1,541 whitespace words. Preserve query
  file order restricted to IDs in test qrels; every judged document must exist.
  Preserve all test qrels and explicitly validate uniqueness and coverage.
- Local model: `/Volumes/A/hms-models/Qwen3-Embedding-0.6B`, revision
  `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`.
- Actual `config.json` SHA256:
  `b5bf1f51fc45be473a54718cef92448d90a1be001bf9b9a44b8c7f10a19feaa9`.
- Actual `tokenizer.json` SHA256:
  `def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a`.
- Actual `model.safetensors` SHA256:
  `0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd`.
  The config's HF metadata records Git blob SHA1
  `cef2749ee93607b8f9a58ec72f4f6bfaf874e71d`; it matches the actual file.
- Generate every required vector afresh with the current Rust Candle
  `core::models::Embedder`, the generic document-retrieval task, and exact query
  instruction `Given a web search query, retrieve relevant passages that answer
  the query`. Documents are unprefixed. Record the exact formatted query prefix,
  native effective embedding-space identity, device and scalar type.
- Full output is 1,024-dimensional L2-normalized f32; last-token pooling and the
  native 2,048-token input cap apply. Report truncated document/query IDs and
  untruncated token counts. No old vectors, downloads, external inference, paid
  service, Modal or LLM judging.

## Generation and resource bounds

One Metal model process, explicitly checked rather than silently falling back,
with native batch size 1. Process source rows once, in order, and write bounded
outer batches to a new partial file with durable progress receipts. Atomically
rename completed vector outputs. An interrupted run is reported and preserved;
there are no automatic retries or device/batch changes. The process ceiling is
two hours. Generation and model loading are separate from search processes and
query timings. The two complete arrays contain 22,458,368 f32 bytes in total.

Host: Apple M4, 10 CPUs, 32 GiB RAM; `/Volumes/A` has approximately 3.9 TiB free
at preparation. Rust 1.99.0, `CARGO_BUILD_JOBS=2`, separate worktree target;
offline Cargo only. Python 3.13.9 and NumPy 2.5.4 from the existing competitive
stdlib environment, invoked with uv 0.12.10 in offline mode. No package install.

## Native comparison

Five arms share the same fresh vectors, original texts, metadata and full
embedding-space identity:

| Arm | Candidate dimensions | Rerank shortlist | Query route |
| --- | ---: | ---: | --- |
| exact | 1,024 | none | full exact |
| full100 | 1,024 | 100 | full graph |
| full50 | 1,024 | 50 | full graph |
| prefix256 | 256 | 100 | projected graph |
| prefix512 | 512 | 50 | projected graph |

Use `WarmCore`, the public document API and
`search_vectors_with_report`; all queries pass the complete 1,024-dimensional
vector. One retained-text chunk per document (`chunk_words=4096`, overlap 0),
ingest batches of 128, default store configuration apart from full embedding
space and candidate settings. Disable no existing durability behavior.
Distinguish ingest acknowledgement time from explicit flush time. Build the
derived graph with `rebuild_vector_index(1)`; the exact arm builds an exact
snapshot with a graph threshold greater than the corpus size. Graph defaults
include construction ef 128 and fixed seed 0x5EED; query ef is 128; final k is 10.
Native prefix normalization, graph candidate selection and canonical reranking
are part of the measured implementation. Typed actual routes and index status
are saved; fallbacks cannot be counted as projected speedups.

Three query conditions cover all 300 queries each: unfiltered; corpus row modulo
10 equals query row modulo 10; corpus row modulo 100 equals query row modulo
100. These are deterministic artificial selectivity cases, not natural SciFact
metadata. Filters precede ranking and use the full filtered exact route. The
oracle uses the same eligibility. Report filtered timing independently.

Before timing, each arm's exact mode must reproduce oracle IDs and canonical
score bits, and filtered results must match the filtered oracle exactly. Save
compact per-query hit IDs, score bits, actual routes and missing oracle IDs.
No final qrel metrics are computed on lifecycle-modified documents.

## Quality and lifecycle gates

Report recall@10 against the full native exact top 10, per-query worst recall,
missed IDs, ordered ranking agreement, qrel nDCG@10 and qrel recall@10. nDCG uses
gain `2^relevance-1`, discount `log2(rank+1)` and each query's ideal relevance
ordering; recall uses positive qrels. Filtered qrel summaries explicitly state
the number of queries with eligible positives and exclude zero-positive queries
only from that qrel denominator. All 300 queries stay in oracle agreement.

Qualification requires zero eligibility/current-read/delete/reopen violations;
unfiltered projected mean oracle recall >=0.99 and per-query worst >=0.8; and
compared with the matched full-graph shortlist, mean recall loss <=0.005,
qrel nDCG@10 loss <=0.005 and qrel recall@10 loss <=0.005. These are research
acceptance criteria, not unconditional recall guarantees or production defaults.

Lifecycle checks replace IDs at corpus rows 0,250,...,5000 (21 rows), using the
next original row's already freshly generated text/vector and retaining the
replaced ID's bucket metadata. Delete rows 125,375,...,5125 (21 disjoint rows).
These 42 mutations remain below the 64-mutation rebuild recommendation. Compare
all 300 queries and three conditions to the authoritative exact state before
rebuild, after explicit flush/reopen, and after explicit rebuild. Check stale
exact diagnostics before rebuild and validate returned content versions,
eligibility and deleted-ID absence throughout. Fresh graph results after rebuild
remain approximate; only exact and filtered routes require exact oracle equality.

## Timing and accounting

After correctness checks and all builds finish, obtain a coordinator quiet-window
grant. All our builds and inference must have stopped. Two five-second preflight
observations must each show external CPU usage <=20% of aggregate observed
capacity on the ten-CPU host (<=200% when 100% denotes one CPU). Monitor throughout.
If the preflight is unavailable or fails, collect no query timings and report the
condition; no exclusions or retry-to-pass. Capture start/end host load and process
metadata; holding our workers does not establish exclusive host isolation.
Five serial process repetitions per arm
use a fixed five-by-five cyclic Latin arm order. Each process loads existing
vectors, opens its prepared store and rebuilds its derived index outside query
timing. One complete warmup and then one measured 300-query pass per condition;
condition order is unfiltered, modulo 10, modulo 100. Each native call is timed
with a monotonic clock; serialization and RSS sampling are outside that interval.
Keep individual latencies and nearest-rank p50/p95/p99 per process and condition.

For unfiltered projected arms only, performance qualification additionally
requires a >=10% improvement in median
per-process p50 versus the matched full graph, while median per-process p95 and
p99 are each no more than 10% worse. No retries, alternate thresholds, or tuning
for favorable results. A noisy window is reported and any later study receives
a distinct protocol/run identity. Filtered exact timings are reported without
projected-speedup attribution. Three hundred samples per process and five process
replicates leave p99 estimates imprecise; report that sampling limit.

Record process peak RSS and serving RSS, separate open/build times, store-file
sizes by name, and logical retained graph-buffer bytes if available. Graph
residual bytes are a subset of graph index bytes, not an additive category.
Full stored embeddings remain 5,183*1,024*4 bytes logically; reduced prefix width
does not reduce retained full-vector storage or ordinary full-model inference.
RSS includes allocator/runtime/store overhead and is not a graph-size estimate.
Derived graph buffers are rebuilt on reopen rather than serialized as an
independent persistent ANN file. Estimated quiet window is 5–15 minutes, not a
measured promise.

## Validation, evidence and limits

Validate generation/token-cap boundaries before real embedding generation and
native retrieval with synthetic independent cosine/ranking, filter and lifecycle
fixtures before real retrieval evaluation; validate qrel/percentile calculations
independently before aggregation. Source
counts/hashes, IDs, token lengths, vector dimensions/finiteness/norms and all
result counts must be checked. Preserve protocol, source/build manifest,
reproduction commands, raw compact results and a readable aggregate; commit no
corpus texts, weights or large embedding arrays. Commit the reviewed frozen plan
before generation and signed/DCO results afterward. No unconditional adoption,
answer accuracy, native parity extrapolation, or general scaling claim.

Model background: [pinned Qwen model card](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/blob/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/README.md)
and [Matryoshka embedding explanation](https://sbert.net/examples/sentence_transformer/training/matryoshka/README.html).
Exact prefix scoring followed by a reduced shortlist remains approximate relative
to full-space cosine; this experiment additionally uses an approximate graph.
