// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadDataset } from '../../public/vectra_comparison/vector-worker.mjs'
import { metadata, scalarCosine } from '../../public/vectra_comparison/oracle-vector.mjs'
import { append, readJson } from '../../public/vectra_comparison/vector-receipts.mjs'

const require = createRequire(import.meta.url), job = await readJson(process.argv[2])
const { VectraMigrationIndex } = require(path.join(job.package, 'vectra.js'))
const native = require(path.join(job.package, 'index.js'))
const loaded = Object.values(require.cache).find(module => module.filename.endsWith('.node') && module.exports === native)
assert.ok(loaded); assert.equal(await fs.realpath(loaded.filename), await fs.realpath(job.addon))
const data = await loadDataset(job.dataset), index = await VectraMigrationIndex.open({ path: job.store })
await fs.writeFile(job.output, '', { flag: 'wx' })
const record = (ordinal, changed) => ({ id: data.ids[ordinal], vector: data.row(ordinal + (changed ? 1 : 0)), metadata: metadata(ordinal, changed ? 1 : 0) })
const stage = async (name, fn) => {
  process.send?.({ type: 'stage', name })
  const start = process.hrtime.bigint(), value = await fn(), ns = Number(process.hrtime.bigint() - start)
  await append(job.output, { type: 'stage', name, ns, value })
  return value
}
const checkRecords = async changed => {
  for (let i = 0; i < 100; i++) assert.deepEqual(await index.getItem(data.ids[i]), record(i, changed))
  return { records: 100, changed }
}
const checkHits = (result, query, changed) => {
  assert.equal(result.results.length, 10)
  const ids = new Set()
  for (const [i, hit] of result.results.entries()) {
    const ordinal = data.ordinal.get(hit.item.id)
    assert.ok(Number.isInteger(ordinal) && !ids.has(ordinal)); ids.add(ordinal)
    assert.deepEqual(hit.item, record(ordinal, changed && ordinal < 100))
    assert.ok(Number.isFinite(hit.score) && Math.abs(hit.score - scalarCosine(hit.item.vector, query)) <= 2e-6)
    if (i) assert.ok(result.results[i - 1].score >= hit.score)
  }
}
const probe = async (name, count, changed) => stage(name, async () => {
  const reports = []
  for (let i = 0; i < count; i++) {
    const query = data.query(i)
    let start = process.hrtime.bigint()
    const graph = await index.queryItems(query, { k: 10, mode: 'graph', ef: job.ef })
    const graphNs = Number(process.hrtime.bigint() - start)
    start = process.hrtime.bigint()
    const exact = await index.queryItems(query, { k: 10, mode: 'exact' })
    const exactNs = Number(process.hrtime.bigint() - start)
    checkHits(graph, query, changed); checkHits(exact, query, changed)
    assert.equal(graph.revision, exact.revision)
    if (name === 'first-graph-query-and-exact-control' || name === 'queries-after-maintenance' || name === 'queries-after-separate-process-reopen') assert.equal(graph.diagnostics?.route, 'fullGraph')
    if (graph.diagnostics?.route === 'fullGraph') {
      assert.equal(graph.diagnostics.graphDegree, job.degree)
      assert.equal(graph.diagnostics.graphBuildEf, job.buildEf)
    }
    const exactIds = new Set(exact.results.map(hit => hit.item.id))
    reports.push({ query: i, revision: graph.revision, graphNs, exactNs, graphDiagnostics: graph.diagnostics, exactDiagnostics: exact.diagnostics, graphIds: graph.results.map(hit => hit.item.id), exactIds: [...exactIds], matched: graph.results.filter(hit => exactIds.has(hit.item.id)).length })
  }
  return reports
})

try {
  if (job.action === 'update') {
    await stage('validate-before', () => checkRecords(false))
    await stage('initial-maintain-indices', () => index.maintainIndices())
    await probe('first-graph-query-and-exact-control', 1, false)
    await stage('batch-upsert-100', () => index.applyBatch(Array.from({ length: 100 }, (_, i) => ({ op: 'upsert', record: record(i, true) }))))
    await stage('validate-after', () => checkRecords(true))
    await probe('queries-before-maintenance', 3, true)
    await stage('maintain-indices', () => index.maintainIndices())
    await probe('queries-after-maintenance', 3, true)
    await stage('flush', async () => { await index.flush(); return { supported: true } })
  } else {
    assert.equal(job.action, 'reopen')
    await stage('validate-reopened', () => checkRecords(true))
    await stage('reopen-maintain-indices', () => index.maintainIndices())
    await probe('queries-after-separate-process-reopen', 3, true)
  }
  await append(job.output, { type: 'complete', action: job.action })
  process.disconnect?.()
} catch (error) {
  await append(job.output, { type: 'error', name: error.name, message: String(error.message).slice(0, 2000) })
  throw error
}
