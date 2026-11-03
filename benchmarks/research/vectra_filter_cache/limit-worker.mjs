// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { metadata, scalarCosine, auditExact } from '../../public/vectra_comparison/oracle-vector.mjs'
import { loadDataset } from '../../public/vectra_comparison/vector-worker.mjs'
import { append, hashValue, readJson } from '../../public/vectra_comparison/vector-receipts.mjs'

const require = createRequire(import.meta.url), job = await readJson(process.argv[2])
const native = require(path.join(job.package, 'index.js'))
const loaded = Object.values(require.cache).find(module => module.filename.endsWith('.node') && module.exports === native)
assert.ok(loaded); assert.equal(await fs.realpath(loaded.filename), await fs.realpath(job.addon))
const { VectraMigrationIndex } = require(path.join(job.package, 'vectra.js'))
const data = await loadDataset(job.dataset), query = data.query(0)
const truth = (await fs.readFile(job.oracle, 'utf8')).trim().split('\n').map(JSON.parse).find(row => row.type === 'oracle' && row.state === 'baseline' && row.filter === 'all' && row.query === 0)
assert.ok(truth); assert.equal(truth.queryId, data.queryIds[0]); assert.equal(truth.hits.length, 10)
assert.ok(truth.hits.every(hit => hit.ordinal < 99999))
assert.ok(scalarCosine(data.row(0), query) < truth.cutoff - 2e-6)
const index = await VectraMigrationIndex.open({ path: job.store }), extraId = 'row-00100000'
await index.insertItem({ id: extraId, vector: data.row(0), metadata: metadata(100000) })
assert.deepEqual(await index.getItem(extraId), { id: extraId, vector: data.row(0), metadata: metadata(100000) })
await fs.writeFile(job.output, '', { flag: 'wx' })
const list = native.WarmMemorySystem.prototype.listVectorRecords
let calls = 0
native.WarmMemorySystem.prototype.listVectorRecords = async function (...args) { calls++; return list.apply(this, args) }
try {
  for (const count of [99999, 100000, 100001]) {
    const eligible = new Set(Array.from({ length: count }, (_, i) => i)), expected = { ...truth, eligibleCount: count }
    for (let repetition = 0; repetition < 2; repetition++) {
      const before = calls
      process.send?.({ type: 'stage', name: `count-${count}-${repetition}` })
      const result = await index.queryItems(query, { k: 10, mode: 'exact', filter: { ordinal: { $lt: count } } })
      assert.equal(result.diagnostics?.route, 'filteredExact')
      const hits = result.results.map(hit => {
        const ordinal = hit.item.id === extraId ? 100000 : data.ordinal.get(hit.item.id)
        assert.ok(Number.isInteger(ordinal)); assert.deepEqual(hit.item.metadata, metadata(ordinal))
        assert.deepEqual(hit.item.vector, data.row(ordinal === 100000 ? 0 : ordinal))
        return { ordinal, score: hit.score }
      })
      const audit = auditExact(hits, expected, ordinal => scalarCosine(data.row(ordinal === 100000 ? 0 : ordinal), query), eligible)
      assert.equal(audit.pass, true, JSON.stringify(audit))
      const pages = calls - before
      assert.equal(pages, repetition === 0 || count === 100001 ? 101 : 0)
      await append(job.output, { type: 'query', count, repetition, pageCalls: pages, resultHash: hashValue(result.results), hits, audit })
    }
  }
  await append(job.output, { type: 'complete', calls })
  process.disconnect?.()
} catch (error) {
  await append(job.output, { type: 'error', name: error.name, message: String(error.message).slice(0, 2000) })
  throw error
} finally { native.WarmMemorySystem.prototype.listVectorRecords = list }
