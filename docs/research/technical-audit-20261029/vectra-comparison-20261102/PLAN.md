# Vectra comparison protocol — preparation only

This plan separates vector migration compatibility, numeric scale, and real-text
retrieval. No benchmark, model generation or pruning run has started. Finish the
native vector-record/adapter source, type and correctness gates first. Before
execution, commit the final driver, dependency lock, source/native-addon hashes,
input manifest, reference tests, process schedule and resource ceiling, then obtain
the coordinator's execution and quiet-window grant. This is a bounded proposal
for that freeze, not a result or a claim of superior performance.

## Implementations and scope

Use the public Node APIs in one pinned Node runtime for both engines. The locally
installed runtime is Node 26.8.1; it satisfies Vectra's >=22 requirement, while WARM
CI uses Node 22. Record the chosen executable/hash at freeze and do not mix runtimes.
Vectra is 0.15.0, retained at
`/Volumes/A/toip-warm-backend/toip-mcp-server/node_modules/vectra`; its inspected
source matches commit `dec2dadc3bb158b06ac72fa9097bee729429a271` after line-ending
normalization. Hash the actual imported package and lock all dependencies. The
[source](https://github.com/Stevenic/vectra/tree/dec2dadc3bb158b06ac72fa9097bee729429a271)
and local `src/LocalIndex.ts`, `src/ItemSelector.ts`, `src/storage/LocalFileStorage.ts`
are the contract, including selector quirks and the existing bounded top-k heap.

The WARM migration arm uses `warm-sdk/vectra` and `VectraMigrationIndex`, backed by
schema 7 native records. Prepared adapter commit is `f1af798c`; the final integrated
native source and built addon remain to be frozen. Read `vectra.d.ts` and
`docs/integrations/vectra-migration.md` at that source. This profile preserves IDs,
original finite f64 vectors and JSON metadata; it does not reproduce Vectra's
filesystem, automatic IDs, browser storage, uncommitted reads or hybrid API.
Do not fabricate text for numeric records or describe this as drop-in equivalence.

Use full stored dimensions throughout. The previously tested 256/100 and 512/50
prefix settings failed their quality gates; they are excluded from these arms
and from recommendations. No new model calls, downloads, paid APIs, cloud jobs,
LLM judges, ToIP changes or publication are part of this protocol.

## Frozen local inputs

All arrays are existing little-endian f32 rows, widened identically to JavaScript
numbers at input. No corpus texts or large arrays enter Git. `inputs.json` records
paths, shapes and SHA256 values. Revalidate once before preparing stores; missing
or changed cache files fail closed, without invoking a downloader.

| Workload | Corpus | Queries | Mapping and relevance |
| --- | ---: | ---: | --- |
| GloVe tiny | first 128 rows | first 1,000 test rows | numeric source ordinals only |
| GloVe 1K | first 1,000 rows | same 1,000 | numeric source ordinals only |
| GloVe 10K | first 10,000 rows | same 1,000 | numeric source ordinals only |
| GloVe 100K | first 100,000 rows | same 1,000 | numeric source ordinals only |
| SciFact | all 5,183 documents | all 300 official test queries | 339 positive qrels; exact original IDs/text |

GloVe is the existing first-row subset of the public ANN-Benchmarks
[`glove-100-angular.hdf5`](https://ann-benchmarks.com/glove-100-angular.hdf5), originally
1,183,514 training and 10,000 test rows. Its vectors have no retained document-text
mapping and cannot establish RAG or hybrid relevance. Prefixes are unique original
source rows, never replicated data. Recompute deterministic cosine truth for each
eligible subset; the existing `neighbors.i32` and its older argpartition tie policy
are not the new oracle.

SciFact reuses the fresh native Qwen3-Embedding-0.6B arrays and source mapping from
[the completed study](../matryoshka-native-20261102/README.md), not the older MiniLM
or development LME arrays. The pinned Qwen revision is
`97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3`; full width is 1024. Its generic Documents
query instruction, effective embedding identity, one-time Metal/batch-1 generation,
2048-token cap and input/token receipts remain unchanged. Every passage is the
original title + newline + body; no auto-chunking, whitespace replacement or new
embedding pass. This is a public benchmark test split already used during WARM
development, not held-out production proof; 100K numeric results do not imply
100K text-quality results or answer accuracy.

## Compatibility gate before measurement

Reuse the native and adapter regression suites rather than duplicate their unit
coverage. Add a small independent real-Vectra round-trip fixture covering original
vector bits (including signed zero), full metadata versus indexed filter view,
external metadata loading, mixed/repeated-ID atomic batches, insert conflict,
cancel, delete-missing, paging/revision consistency and restart. Compare the pinned
ItemSelector outputs, including numeric/string `$in`/`$nin`, null/missing, nested
logical operators and empty eligibility. Verify zero/nonfinite/wrong-width vectors
are rejected according to the documented WARM contract; unsupported Vectra inputs
are compatibility limits, not silently coerced or dropped records.

Import from a read-only source into a fresh owned destination. Validate every ID,
vector bit and metadata value after paging and after a separate-process reopen.
Report partial-import quarantine and no-resume semantics. Test limits using the
existing boundary fixtures; do not benchmark a failed or truncated import.

## Search arms and reference

1. **Exact vector:** Vectra `LocalIndex.queryItems(vector, '', 10, filter, false)`
   versus WARM `queryItems(vector, {k:10, mode:'exact', filter})`. Use the same
   original vectors, complete eligible set and returned item fields. Include the
   public JavaScript wrapper/selector and returned-vector materialization cost.
2. **Full-width ANN:** WARM `{mode:'graph', ef:128}`, `ef:256`, `ef:512`, all at
   k=10 and without candidate-prefix configuration. Prepare with `maintainIndices()`
   outside query timing. All points are reported, not just the best. Tiny/1K are
   below the current 4096-row preparation threshold: report explicit graph
   unavailability; do not relabel an exact fallback as ANN. Run graph arms on
   10K/100K GloVe and the full SciFact corpus.
3. **Real-text hybrid:** use separate document stores. Vectra `LocalIndex` receives
   the original vector and an explicit text reader backed by the original source;
   validate every documentId/startPos/endPos mapping. Freeze the reader/cache policy,
   include its I/O and memory cost, and do not preload only one engine. WARM receives the same text
   and vector as one chunk (`chunk_words=4096`, overlap 0; maximum source 1541 words).
   This measures each engine's document policy, not vector-record migration.

Compute an independent normalized f64 cosine oracle, ordered by score descending
then stable source ordinal. Validate it against a second scalar implementation on
small independent boundary fixtures before dataset scoring. Record strict top-10
agreement, maximum score error, tie-boundary substitutions and missed IDs separately:
WARM normalizes/stores f32 while Vectra scores the preserved JavaScript doubles.
A missing result is numerically explainable only when both its oracle score and the
returned substitute lie within 2e-6 of the oracle cutoff; any larger exact-score or
non-boundary membership error fails correctness. Never round scores before ranking.

ANN quality is measured both against WARM full exact and the independent oracle:
mean recall@10 >=0.99 and worst-query recall@10 >=0.90 are required to call a setting
quality-qualified. SciFact also requires nDCG@10 and qrel recall@10 no more than
0.01 absolute below full exact. Report every query/worst miss and every failed gate;
no post-result ef tuning. The eligible truth is recomputed for each filter/churn
state. Insufficient eligible rows use min(k, eligible count); empty sets require
empty results and are excluded only from recall denominators, with counts shown.

## Hybrid budgets and filters

Vectra's BM25 option rebuilds a keyword engine per call and appends up to semanticK
keyword hits after its semantic hits. Use semanticK=10, so its total is at most 20;
retain the actual append order. WARM uses hybrid k=20, candidate_limit=100, equal
lexical/vector weights and its existing RRF fusion (k=60). These are distinct native
policies, not equivalent scoring implementations. Preserve returned IDs/scores/
route/order before context packing; validate Vectra text reads so swallowed file
errors cannot look like legitimate empty lexical results.

Apply the same context packer to both: at most 20 unique documents and 4096 tokens,
using the already pinned Qwen tokenizer without inference. Pack full original document texts joined with two newlines, counting the actual
concatenated payload, in rank order; stop at the first document that exceeds remaining tokens, and report
unused budget. Do not silently increase semanticK, append extra WARM results or
truncate only one engine to ten. Report pre-packing nDCG@10/recall@10 and packed
qrel evidence coverage, actual document/token counts; these are retrieval metrics,
not answer accuracy. Timings include ranking and identical context packing, with
raw ranking time also recorded separately.

Derive identical indexed booleans from source-ordinal `bucket100 = ordinal % 100`:
`eligible10 = bucket100 < 10`, `eligible1 = bucket100 == 0`. Use unfiltered, 10%
(`eligible10: true`), 1% (`eligible1: true`) and an empty selector (`bucket100: -1`).
Equality filters work in both document APIs; synthetic eligibility is workload
metadata, not a relevance judgment. Both engines select the complete set before top-k. Measure the adapter's complete metadata scan and native filtered-exact
fallback rather than passing precomputed IDs only to WARM. Record actual eligibility
count and route on every call. Filtered graph requests must be labeled exact when
that is the route; no filtered ANN speedup attribution. For filtered qrel metrics,
report queries with positive eligible judgments separately from those with none.

## Process schedule, latency and resources

Preparation, import acknowledgement, explicit flush and graph build are separate
stages with separate durations. Build one fixture per engine/dataset; validate and
flush it before cloning into isolated per-process stores. No store is concurrently
opened by independent processes. Never use Vectra's loaded in-memory state as a cold
start or WARM's prepared snapshot as its build time.

Quality visits every query once per applicable arm/filter. Timing uses three fresh
process repetitions, rotating fixed engine/arm order each repetition; perform 20
unmeasured warmup queries (first 20 source-order queries) and then the fixed schedule.
Unfiltered numeric trials use all 1,000 queries; SciFact semantic/hybrid uses all 300.
Filtered timings use every tenth numeric query (100) or every third SciFact query
(100), fixed before results. No concurrency within an engine. Record each call's
elapsed wall time from invocation through Promise settlement and required context
packing; exclude JSON output/reference validation. Record route and validation
outside the measured region. Use nearest-rank p50/p95/p99 per process and pooled,
plus all raw samples; 100/300-query filtered/text tails have limited p99 precision.

Measure process-cold open (spawn, import, constructor plus forced Vectra index load),
first-query latency, and already-open query latency separately. Page-cache state is
uncontrolled, so do not call this disk-cold. Sample baseline, open, serving, build
peak and teardown RSS using OS units consistently; include Node, native allocations,
original f64 envelopes, normalized f32 rows, graph/owner buffers, transient snapshot
overlap and query scratch. Report logical file bytes and allocated filesystem bytes
with sparse journal capacity, profile/metadata, full vectors and graph buffers
separated. Code-only graph byte counts are not total RSS or storage savings.

Before timed queries all our builds and inference must stop. Require two 5-second
preflights with external aggregate CPU <=20% of observed host capacity, then monitor
throughout. Record host/OS/CPU/memory/runtime/thread settings and process observations;
never stop unrelated work. A failed preflight collects no query timings. No retry,
exclusion of slow queries, threshold relaxation or later "best" run. Explicit ceiling:
2 hours for preparation/reference/quality, 2 hours for the complete timing/churn
phase, and 8 GiB RSS per owned process; timeout or two consecutive 1-second samples
above the memory ceiling stop that phase and preserve partial artifacts as incomplete.
A projected duration beyond these limits requires a revised plan before any run.

A latency advantage requires quality qualification plus >=10% lower median and p95
than the matched exact vector baseline in all three repetitions, with p99 no more
than 5% worse. Hybrid claims additionally require qrel nDCG/recall within 0.01 absolute
of Vectra at the identical context budget. Otherwise report the measured tradeoff or
Vectra win. No aggregate claim may hide small-store, filter, update or memory losses.

## Churn, persistence and failure accounting

On separate copies after static quality, upsert the first min(100,floor(N/10)) IDs with the
next source row's vector and metadata epoch 1; delete the next disjoint same-sized
ID set. Query all original queries before maintenance, after maintenance and after
a separate-process flush/reopen; rebuild eligible oracle against the resulting live
state. Missing/deleted IDs, outdated metadata/vectors and incorrect stale-route
reports fail correctness. For SciFact, this is lifecycle consistency only: swapped
vectors no longer support original qrel relevance claims.

Measure acknowledged single writes and a fixed 100-operation batch separately
(using a smaller final batch for tiny). Report WARM explicit flush duration and
ack-to-flush interval. Vectra `endUpdate()` serializes the index through `fs.writeFile`
and exposes no equivalent explicit fsync barrier; label that acknowledgement, not
an equally durable commit. Include full-file rewrite/serialization costs and file
sizes rather than timing only in-memory mutation.

Reuse existing crash harness/fault points where available. In isolated fixture
stores, test interrupted writes before acknowledgement, after acknowledgement but
before explicit WARM flush, and after flush; reopen in a distinct process and
validate all-or-none batch/old-or-new state or explicit corruption refusal. Preserve
all failures, exact process stop points and logs. Do not claim deterministic timing
of an uncontrolled kill or silently retry corruption; a process interruption test
is not hardware power-loss proof. Complete the deterministic fault harness and its
acceptance cases before freezing, rather than adding hooks during measurement.

## Deliverable and remaining preparation

Archive compact per-query IDs/scores/routes/eligibility, metrics, worst misses,
resource traces, process exit status, failed gates, hashes and exact reproduction
commands. Keep corpus text/large arrays local. Freeze the integrated addon and
adapter only after all correctness gates pass; validate harness references/bounds,
matched hybrid text/context mapping and interrupted-write hooks; then review the
fixed schedule/resource budget with the coordinator. No performance recommendation
or memory-pruning experiment follows automatically from this planning document.
