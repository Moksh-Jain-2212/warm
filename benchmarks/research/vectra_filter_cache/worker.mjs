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
const data = await loadDataset(job.dataset), query = data.query(0), scores = new Map(), truth = new Map()
for (const bucket of [0, 1]) {
  const eligible = new Set(), hits = []
  for (let ordinal = bucket; ordinal < job.dataset.rows; ordinal += 100) {
    const score = scalarCosine(data.row(ordinal), query)
    eligible.add(ordinal); scores.set(ordinal, score); hits.push({ ordinal, score })
  }
  hits.sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
  truth.set(bucket, { eligible, hits: hits.slice(0, 10), eligibleCount: eligible.size, cutoff: hits[9].score })
}
const index = await VectraMigrationIndex.open({ path: job.store })
await fs.writeFile(job.output, '', { flag: 'wx' })
const list = native.WarmMemorySystem.prototype.listVectorRecords
let calls = 0
native.WarmMemorySystem.prototype.listVectorRecords = async function (...args) { calls++; return list.apply(this, args) }
try {
  for (let ordinal = 0; ordinal < 10; ordinal++) {
    const bucket = ordinal % 2, previous = calls
    process.send?.({ type: 'stage', name: `query-${ordinal}` })
    const start = process.hrtime.bigint()
    const result = await index.queryItems(query, { k: 10, mode: 'exact', filter: { bucket100: bucket } })
    const elapsedNs = Number(process.hrtime.bigint() - start)
    assert.equal(result.diagnostics?.route, 'filteredExact')
    const hits = result.results.map(hit => {
      const row = data.ordinal.get(hit.item.id)
      assert.ok(Number.isInteger(row)); assert.deepEqual(hit.item.metadata, metadata(row)); assert.deepEqual(hit.item.vector, data.row(row))
      return { ordinal: row, score: hit.score }
    })
    const expected = truth.get(bucket), audit = auditExact(hits, expected, id => scores.get(id), expected.eligible)
    assert.equal(audit.pass, true, JSON.stringify(audit))
    await append(job.output, { type: 'query', ordinal, bucket, elapsedNs, pageCalls: calls - previous, resultHash: hashValue(result.results), hits, audit })
  }
  await append(job.output, { type: 'complete', calls })
  process.disconnect?.()
} catch (error) {
  await append(job.output, { type: 'error', name: error.name, message: String(error.message).slice(0, 2000) })
  throw error
} finally { native.WarmMemorySystem.prototype.listVectorRecords = list }
