const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
;(async () => {
  const cjs = require('warm-sdk')
  const esm = await import('warm-sdk')
  assert.equal(cjs.WarmMemorySystem, esm.WarmMemorySystem)
  const { Memory } = require('warm-sdk/memory')
  assert.equal(Memory, (await import('warm-sdk/memory')).Memory)
  const { DocumentMemory } = await import('warm-sdk/semantic')
  const root = path.dirname(require.resolve('warm-sdk'))
  assert.ok(!fs.readdirSync(root).some(name => name.endsWith('.node')), 'root must be JavaScript-only')
  assert.ok(require.resolve('warm-sdk-darwin-arm64').endsWith('warm-sdk.darwin-arm64.node'))
  assert.deepEqual(fs.readdirSync('node_modules').filter(name => name.startsWith('warm-sdk-')), ['warm-sdk-darwin-arm64'])
  const warm = new cjs.WarmMemorySystem(1024, './store', {
    embeddingModel: 'package-synthetic', embeddingRevision: 'v1', embeddingDimensions: 4,
    vectorCandidateDimensions: 2, vectorRerankCandidates: 10,
  })
  const documents = new DocumentMemory(warm)
  await documents.memorize({ id: 'manual', text: 'Backups protect stored documents.', sourceUri: 'manual.md', embeddings: [[1, 0, 0, 0]] })
  assert.equal((await documents.search('backups'))[0].sourceUri, 'manual.md')
  const vector = (await warm.searchVectors([1, 0, 0, 0], 1, { mode: 'exact' }))[0]
  assert.equal(vector.documentId, 'manual')
  assert.equal(vector.score, 1)
  const memory = new Memory(warm, { supersession: 'latest-by-subject' })
  await memory.remember('Alice lives in Paris', { id: 'old', subject: 'alice/city', validFrom: new Date('2020-01-01T00:00:00Z') })
  await memory.remember('Alice lives in Berlin', { id: 'new', subject: 'alice/city', validFrom: new Date('2025-01-01T00:00:00Z') })
  assert.deepEqual((await memory.recall('Alice lives')).map(fact => fact.id), ['new'])
  assert.deepEqual((await memory.recall('Alice lives', { asOf: new Date('2021-01-01T00:00:00Z') })).map(fact => fact.id), ['old'])
  assert.deepEqual((await memory.forget({ ids: ['new'] }, { includeChain: true, purge: true, dryRun: false })).forgotten, ['new', 'old'])
  assert.equal(await memory.get('old'), null)
  assert.equal(await memory.get('new'), null)
  await warm.flush()

  const { VectraMigrationIndex } = require('warm-sdk/vectra')
  assert.equal(VectraMigrationIndex, (await import('warm-sdk/vectra')).VectraMigrationIndex)
  const records = await VectraMigrationIndex.create({
    path: './vector-records', embeddingSpace: { model: 'platform-fixture', revision: '1', dimensions: 3 },
    indexedMetadata: ['group'],
  })
  await records.applyBatch([
    { op: 'insert', record: { id: 'a', vector: [1 + 2 ** -40, -0, Number.MIN_VALUE], metadata: { group: 'public', extra: 'kept' } } },
    { op: 'insert', record: { id: 'b', vector: [-1, 0, 0], metadata: { group: 'private' } } },
  ])
  const hit = (await records.queryItems([1, 0, 0], { filter: { group: 'public' }, k: 1 })).results[0]
  assert.equal(hit.item.id, 'a')
  assert.equal(hit.item.vector[0], 1 + 2 ** -40)
  assert.ok(Object.is(hit.item.vector[1], -0))
  assert.equal(hit.item.vector[2], Number.MIN_VALUE)
  assert.equal(hit.item.metadata.extra, 'kept')
  assert.deepEqual((await records.queryItems([1, 0, 0], { filter: { extra: 'kept' } })).results, [])
  assert.deepEqual((await records.queryItems([1, 0, 0], { documentIds: [] })).results, [])
  await records.flush()
  console.log('Platform Vectra adapter: CJS/ESM, atomic batch, pre-top-k filter, exact original f64 and empty eligibility passed')

  console.log('Offline JavaScript-only warm-sdk + darwin-arm64 package: CJS/ESM, semantic query, full vector query, temporal recall and chain purge passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
