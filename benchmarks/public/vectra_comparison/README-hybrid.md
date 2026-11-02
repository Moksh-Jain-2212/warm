# Hybrid document comparison harness

This harness exercises the real Vectra 0.15 `LocalIndex` hybrid API and WARM
`searchDocuments` with identical supplied vectors and original document text.
The [protocol](../../../docs/research/technical-audit-20261029/vectra-comparison-20261102/PLAN.md)
and [input manifest](../../../docs/research/technical-audit-20261029/vectra-comparison-20261102/inputs.json)
remain preparation artifacts. No SciFact query evaluation or benchmark timing has
run. The vector-only migration, ANN, mutation and interruption harness is separate.

## Local development check

The coordinated vector harness must supply `vector-receipts.mjs` beside these files.
Use already installed modules and native artifacts; these commands do not install
Node packages, build Rust, download weights or call an embedding model:

```sh
VECTRA_MODULE=/Volumes/A/toip-warm-backend/toip-mcp-server/node_modules/vectra \
WARM_MODULE=/Volumes/A/warm-vectra-node-qualification \
node --test benchmarks/public/vectra_comparison/test_hybrid.mjs
```

`UV_PATH` optionally selects the existing uv executable. The tokenizer bridge uses
`uv run --offline --no-project --with tokenizers==0.23.3`; absent cached wheels are
an error. Tests require the already cached Qwen tokenizer at
`/Volumes/A/hms-models/Qwen3-Embedding-0.6B/tokenizer.json`, hash
`def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a`.
Only synthetic strings are tokenized. A tiny WordLevel fixture independently tests
4095/4096/4097-token and 19/20/21-document boundaries. The cached older Node tokenizer
binding cannot parse the Qwen JSON, so the bridge reads the unchanged file with the
pinned Python runtime instead of rewriting it.

The real-engine fixture contains 24 synthetic documents, one query and three-dimensional
vectors. It tests appended keyword evidence beyond semantic K, complete eligibility,
Unicode/byte/UTF-16 offsets, original retained text, separate-process reopen, hidden
reader errors, qrel arithmetic and failure-safe comparison. Synthetic worker receipts
suppress timing values. Tests require their dependencies and never silently skip.

## API and text-reader contract

`hybrid.mjs` loads hash-bound source rows and vectors, creates one original document
per chunk, invokes the actual APIs, checks results and packs context. No automatic
embedding API is called. Vectra uses its real BM25 factory; the wrapper only records
`addDoc` failures that Vectra otherwise catches. Its reader performs an uncached
filesystem read per request, with safe hash-derived filenames and original text.
Vectra metadata uses inclusive JavaScript UTF-16 `endPos`; WARM's result spans are
UTF-8 bytes. These are checked independently, not equated.

Both workers retain the same canonical text map for validation/context packing; it
is included in baseline RSS and is unavailable to the Vectra ranking reader. WARM
uses its native retained-text cache. The common packer preserves ranking order,
deduplicates IDs, concatenates full original text with two newlines and counts the
actual concatenated tokens. It stops at the first overflow, at 20 documents or 4096
tokens. It does not drop a large result and continue with shorter lower-ranked ones.

Raw Vectra results remain semantic top 10 followed by up to 10 BM25 results. WARM
uses k=20, candidateLimit=100, equal weights and its existing RRF policy. Scores/order
are never re-fused in the harness. `actualRoute: null` states that these document
APIs expose no typed route report; this harness makes no ANN attribution.

Pinned Vectra throws `document collection is too small for consolidation` when
too few records remain after semantic selection, including empty eligibility. The
worker records the error and continues other declared cases without fallback.
`querySetComplete` becomes false; errors count against qualification. Read/addDoc
failures swallowed by the API are integrity failures and stop the worker. Completed
observations remain in the exclusive `.queries.jsonl` progress file if later work
fails. No raw source text is written to results.

## Worker configuration and lifecycle

`node hybrid-worker.mjs CONFIG.json [OUTPUT.json]` supports `prepare`, `quality` and
`timing`. The output argument can instead be `config.output`. Output/progress paths
must be fresh; existing stores are rejected by preparation. Each store owner is a
separate process because the native API has no public close operation. Preparation
must exit before a quality/timing worker opens that store.

Development uses `purpose: "synthetic-development"`, `engine`, absolute `modulePath`,
absolute `store`, `fixturePath` and `fixtureSha256`. Fixtures are bounded to 32
documents, eight queries and width 32. Quality also needs `tokenizerPath`,
`tokenizerSha256` and optionally `uvPath`. Its fixture format is:

```json
{
  "embeddingSpace": {"model":"fixture", "revision":"1", "dimensions":2},
  "documents": [{"id":"a", "text":"original text", "vector":[1,0]}],
  "queries": [{"id":"q", "text":"question", "vector":[1,0]}],
  "qrels": {"q":{"a":1}}
}
```

Study jobs use `purpose: "frozen-study"`, `inputManifest`, `freezePath` and
`freezeSha256`. The source freeze must explicitly authorize each allowed phase and
bind `inputManifestSha256`, `workerSha256`, `helperSha256`,
`tokenizerBridgeSha256`, `nodeVersion`, `modulePaths` for both engines and an
`nativeAddonPath`/`nativeAddonSha256`, and an `artifacts` list of absolute `{path,sha256}` entries covering the loaded packages,
lock, tokenizer runtime and native addon. The loaded native module is identified from the actual require cache; an environment
override that the loader ignores cannot substitute another addon. These hashes are rechecked before work;
the final list is reviewed by the coordinator before execution.

Timing additionally requires repetition 0/1/2, a matching hash-bound coordinator
admission (`phase: "measurement"`, `approved: true`, `freezeHash`, `coordinator`),
and a matching hash-bound passing preflight result. The worker requires an IPC
monitor parent and checks its PID. It cannot start timing from the development mode.
All four eligibility cases are fixed; all 300 queries run unfiltered and every third
query (100) runs filtered, after 20 warmups. No adaptive query selection occurs.

`runHybridJob()` in `hybrid-run.mjs` reuses the vector harness's
`runMonitored({worker,job,jobFile,receipt,hostFile,deadline,quiet,...})` implementation.
It requires continuous quiet monitoring for timing. The coordinator uses the shared
`preflight`, `cloneStore`, `storageReceipt` and exclusive phase markers for the one
frozen three-repetition schedule; it must not run an independent retry window for
hybrid after a failed preflight. No source changes are needed to admit an approved
run; authorization resides in the frozen receipt, not a changed boolean in code.

## Measurement and qualification boundaries

Raw ranking time ends immediately when the public API Promise settles. Normalizing
result records and checking text/scores/eligibility happen after that clock stops.
Common context packing has its own clock, including offline tokenizer IPC and
encoding; `rankingAndPackingMs` adds those two intervals without validation/output.
The first open query is a separately labeled warmup observation. `openMs` isolates
package import plus engine open; the monitor's process-cold total additionally
includes verified input loading and tokenizer startup, which are disclosed separately.
No disk-cold claim is made.

The tokenizer child is closed in `finally`; its PID/runtime/hash and peak RSS are
recorded. The shared monitor includes descendants in aggregate RSS and owned CPU,
so tokenization is neither omitted from memory cost nor misclassified as external
host load. Node and Python peak values are retained separately; summing nonconcurrent
peaks is not an aggregate-peak measurement.

`compareHybridPair()` reports nearest-rank p50/p95/p99 for successful queries only,
with error wall-times separate. Different declared query sets are rejected; any
failure or different successful sets blocks qualification. Qrel nDCG@10, recall@10
and packed evidence recall must stay within 0.01 absolute of Vectra. Queries with no
eligible positive judgment have null quality metrics, not invented zero or perfect
scores. A latency claim requires the complete quality gate and the protocol's
median/p95/p99 ratios in all three distinct repetitions; one passing pair is only
one observation. All failures, Vectra wins, memory costs and unsupported cases must
remain in the final report.
