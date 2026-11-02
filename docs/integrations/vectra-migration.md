# Migrate Vectra vectors to WARM

`warm-sdk/vectra` imports existing vectors into a new, owned WARM store. It retains stable IDs, original finite JavaScript doubles, and original JSON metadata. Records remain explicitly vector-only: the adapter does not invent text, run an embedding model, or add document history.

This is a migration profile, not a drop-in `LocalIndex` implementation. The selector compatibility target is Vectra 0.15.0 at [`dec2dadc`](https://github.com/Stevenic/vectra/tree/dec2dadc3bb158b06ac72fa9097bee729429a271). WARM searches normalized f32 embeddings and returns the preserved original f64 vector with each hit. Scores and tied-result order need not be bit-identical to Vectra. Hybrid/BM25 ranking, Vectra codecs and filesystem layouts as a destination, browser storage, automatic IDs, and uncommitted reads are outside this profile.

## Import an existing LocalIndex

Keep the source index read-only for the entire import. Supply the actual model identity and dimensions used to create its vectors; no model is downloaded or inferred from metadata.

```js
const { LocalIndex } = require('vectra') // the source application uses Vectra 0.15.0
const { importVectraIndex } = require('warm-sdk/vectra')

async function migrate() {
  const source = new LocalIndex('./vectra-source')
  const { index, importedItems } = await importVectraIndex(source, {
    path: './warm-destination', // must not exist; its parent directory must exist
    embeddingSpace: {
      model: 'your-existing-embedding-model',
      revision: 'your-existing-model-revision',
      dimensions: 384,
    },
  })
  await index.flush()
  console.log({ importedItems })
}
migrate().catch(error => { console.error(error); process.exitCode = 1 })
```

The importer reads full external metadata through the source's public storage and codec APIs. It retains the indexed metadata returned by `listItems()` separately as the filter view. A field stored only in a metadata sidecar remains available in returned items but does not suddenly become filterable. This matches the pinned [`LocalIndex`](https://github.com/Stevenic/vectra/blob/dec2dadc3bb158b06ac72fa9097bee729429a271/src/LocalIndex.ts) behavior. `importVectraItems(iterable, options)` also accepts a synchronous or asynchronous stream of `{ id, vector, metadata, indexedMetadata? }` records when the caller has already resolved sidecars.

External metadata names must be single portable filenames: separators, alternate-stream/drive colons, invalid Unicode/control characters, Windows device names and trailing dots/spaces are rejected before storage reads. Ordinary Vectra UUID filenames remain supported.

Imports use bounded atomic batches. A later failure can leave earlier batches in the new destination; its profile is marked incomplete/failed and the adapter refuses to open it. The source is untouched. Inspect or remove that failed destination after its owning process exits, then import into a new directory. An import is not an atomic replacement of an existing store and does not resume a partial destination.

## Create, query, transact, reopen

This complete example uses synthetic vectors and no model:

```js
const { VectraMigrationIndex } = require('warm-sdk/vectra')

async function example() {
  const index = await VectraMigrationIndex.create({
    path: './new-vector-store',
    embeddingSpace: { model: 'example-vectors', revision: '1', dimensions: 3 },
    indexedMetadata: ['group'],
  })
  await index.beginUpdate()
  await index.insertItem({ id: 'a', vector: [1, -0, 0], metadata: { group: 'public', note: 'preserved' } })
  await index.insertItem({ id: 'b', vector: [0, 1, 0], metadata: { group: 'private' } })
  await index.endUpdate()

  const result = await index.queryItems([1, 0, 0], {
    k: 1, filter: { group: 'public' }, mode: 'exact',
  })
  console.log(result.results[0].item) // original vector and complete metadata
  console.log(result.diagnostics) // actual route, including exact fallbacks
  await index.flush()
}
example().catch(error => { console.error(error); process.exitCode = 1 })
```

In a **later process**, reopen with `await VectraMigrationIndex.open({ path: './new-vector-store' })`. The persisted profile restores the embedding identity, indexed metadata keys and optional candidate configuration. Reapply any runtime/security options under `native` on every open; credentials are never written to the profile. The adapter owns its native system privately. The native process lease prevents simultaneous independent writers; this API does not expose a close/dispose operation, so release ownership by ending the owning process.

`beginUpdate()` captures a revision. Writes stage cloned inputs in call order, including repeated IDs. `endUpdate()` submits one native atomic transaction and consumes the buffer even if the commit fails; `cancelUpdate()` discards it. Reads, queries, maintenance and a separate `applyBatch()` reject while an update is staged. `applyBatch([{op:'insert',record}, {op:'upsert',record}, {op:'delete',id}], {ifRevision})` is the direct atomic alternative. An insertion conflict aborts the whole batch, including preceding deletes. Writes never retry automatically, particularly after an uncertain commit acknowledgement.

`listItems({limit, from, ifRevision, includeVectors})` returns a page `{revision, items, nextFrom}` rather than Vectra's unbounded array. Pass `nextFrom` unchanged as the next inclusive cursor and the first page's revision on subsequent calls. `getItem(id)` returns the original item or `undefined`. Tokens apply only to the current store instance and revision; they intentionally expire after a write or process restart.

## Filters and ranking

Filtered queries first scan **all** metadata pages at one revision, then pass the complete eligible ID set to native ranking at that same revision. They do not filter a previously truncated shortlist. `documentIds` intersects that set; `[]` always returns no matches. The adapter retries a clean revision conflict at most twice after the first attempt, restarting the whole scan. An explicit `ifRevision` disables these retries. Other failures propagate immediately. Exceeding an eligibility bound fails; it never truncates the set or substitutes an unfiltered search.

Selectors follow the pinned [`ItemSelector`](https://github.com/Stevenic/vectra/blob/dec2dadc3bb158b06ac72fa9097bee729429a271/src/ItemSelector.ts), including its unusual behavior:

| Selector | Pinned behavior retained |
| --- | --- |
| `$and`, `$or` | Recursive conjunction/disjunction; empty `$and` matches, empty `$or` does not. |
| Scalars, `$eq`, `$ne` | Strict equality/inequality; missing or null fields do not match operator objects, including `$ne`. A scalar null filter does not match. |
| `$gt`, `$gte`, `$lt`, `$lte` | Stored value must be numeric; the source's JavaScript operand coercion is retained. |
| `$in`, `$nin` | Booleans never match either. Numeric array membership is **not** ordinary set membership: `{n:5}` fails `$in:[5]` but matches `$in:['15']`; `$nin` has the corresponding substring behavior. |
| Unknown operator | Returns strict equality against its operand immediately; later operators in that object are not evaluated. |
| Empty field object | Matches any present non-null value. |

Accepted metadata and filters are bounded, finite, acyclic plain JSON with valid Unicode strings. Object-reference equality, functions, accessors, `undefined`, sparse arrays, NaN and infinity are not a supported migration contract. Empty or omitted `indexedMetadata` means all metadata is indexed; a nonempty list projects only existing named keys. Imported explicit filter views are retained; later upserts derive their view from the persisted key list.

Native exact search is the default. For ANN comparisons, call `await index.maintainIndices()` outside measured queries (the current graph preparation threshold is 4096 vector rows). A cold exact query can build an exact snapshot and defer its graph; a later unfiltered graph or auto query completes that deferred build on demand. Otherwise an explicit graph request reports an unavailable graph if none exists. Set `ef` from 1 to 4096 to trade search effort against approximate recall; validate quality on your own workload. Filtered/ownership-restricted routes use full exact search; inspect returned diagnostics and do not label that work a graph speedup. Experimental `candidateDimensions` and `rerankCandidates` must be configured together when creating the store; full-width candidates are allowed as a control. Neither projection nor a different model is enabled automatically.

For an opt-in denser graph, create the migration index with `highRecall: true`.
This selects degree 64 and construction effort 500 instead of degree 32 and effort
128, and persists the choice in the migration profile. It increases graph build
work and memory, supports at most 2,097,152 embedded rows, and does not guarantee
any recall or latency target. Full-graph query diagnostics report the actual
`graphDegree` and `graphBuildEf`. Native `WarmMemorySystem` callers can set
`vectorHighRecall: true` and should reapply their runtime configuration on reopen.

## Storage and bounds

The adapter creates explicit vector-capable **schema 7** stores. Ordinary WARM stores retain their existing default schema. The adapter refuses existing destination directories, including older WARM stores; it does not perform an in-place schema upgrade. General native store upgrade requires the separate offline copy/verify workflow, and an upgraded native store is not automatically an adapter-owned migration profile.

Original f64 values live in the native versioned envelope, separate from normalized search embeddings; they are not duplicated in adapter metadata. That envelope, original metadata and any distinct indexed view share the native **64 KiB per-record** metadata allowance. Large dimensions can therefore hit the encoded-byte limit before the configured dimension limit. Text or other user metadata counts toward the same allowance. The adapter adds a small versioned metadata wrapper and duplicates only a distinct indexed view.

| Resource | Limit |
| --- | --- |
| Query `k`; list page | 1–1000 |
| Query `ef` | 1–4096 |
| `minScore` | Finite, inclusive −1 to 1; default −1 |
| Ordered transaction | 1–4096 operations; repeated IDs retain order |
| Transaction vector values | 1,048,576 total |
| Transaction IDs; encoded native envelopes | 8 MiB each; native journal additionally bounded at 32 MiB |
| Eligibility | 1,048,576 IDs and 8 MiB summed UTF-8 ID bytes |
| ID | 1–65,523 UTF-8 bytes; no NUL or reserved `hms:chunk:`/`hms:meaning:` prefixes |
| JSON input | Depth 32, 16,384 nodes, 64 KiB before native envelope overhead |
| Queued calls | Default 32; configurable 1–4096 |

Vectors must match the configured dimension and be finite and nonzero. The native boundary also validates the exact encoded sizes. These bounds are errors, not truncation policies. No throughput, latency or quality advantage is claimed by this migration contract; comparison requires a separately qualified workload and the actual recorded search route.
