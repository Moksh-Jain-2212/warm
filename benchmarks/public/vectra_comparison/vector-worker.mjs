// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { FILTERS, metadata, eligible, normalizeRows, oracleTopK, scalarCosine, liveState, auditExact, recallAtK, qrelMetrics } from './oracle-vector.mjs'
import { append, readJson, writeOnce, hashValue, storageReceipt } from './vector-receipts.mjs'
const require = createRequire(import.meta.url)
const now = () => performance.now()
const rss = () => process.memoryUsage().rss
const send = message => process.send?.(message)

export function scoreOrderPass(hits, score, epsilon = 2e-6) {
  return hits.every((hit, i) => i === 0 || (hits[i - 1].score >= hit.score && score(hits[i - 1].ordinal) + epsilon >= score(hit.ordinal)))
}

export async function loadDataset(spec) {
  const [corpus, queryBytes] = await Promise.all([fs.readFile(spec.corpus), fs.readFile(spec.queries)])
  assert.equal(corpus.length >= spec.rows * spec.dimensions * 4, true)
  assert.equal(queryBytes.length, spec.queryCount * spec.dimensions * 4)
  const values = new Float64Array(spec.rows * spec.dimensions), queries = new Float64Array(spec.queryCount * spec.dimensions)
  for (let i = 0; i < values.length; i++) values[i] = corpus.readFloatLE(i * 4)
  for (let i = 0; i < queries.length; i++) queries[i] = queryBytes.readFloatLE(i * 4)
  const mapping = spec.mapping ? await readJson(spec.mapping) : null
  const ids = mapping ? mapping.documents.map(item => item.id) : Array.from({ length: spec.rows }, (_, i) => `row-${String(i).padStart(8, '0')}`)
  const queryIds = mapping ? mapping.queries.map(item => item.id) : Array.from({ length: spec.queryCount }, (_, i) => `query-${i}`)
  assert.equal(ids.length, spec.rows); assert.equal(queryIds.length, spec.queryCount)
  assert.equal(new Set(ids).size, ids.length)
  const qrels = new Map()
  if (spec.qrels) {
    const lines = (await fs.readFile(spec.qrels, 'utf8')).trim().split(/\r?\n/).slice(1)
    for (const line of lines) { const [qid, id, score] = line.split('\t'); assert.ok(queryIds.includes(qid)); assert.ok(ids.includes(id)); if (!qrels.has(qid)) qrels.set(qid, new Map()); qrels.get(qid).set(id, +score) }
  }
  const row = index => Array.from(values.subarray(index * spec.dimensions, (index + 1) * spec.dimensions))
  const query = index => Array.from(queries.subarray(index * spec.dimensions, (index + 1) * spec.dimensions))
  return { values, queries, ids, queryIds, qrels, row, query, ordinal: new Map(ids.map((id, ordinal) => [id, ordinal])) }
}
export async function provider(engine, config, directory, create = false, dimensions = 3) {
  if (engine === 'vectra') {
    const { LocalIndex } = require(path.join(config.vectraPath, 'lib/index.js'))
    const index = new LocalIndex(directory)
    if (create) await index.createIndex({ version: 1 })
    else await index.getIndexStats()
    return {
      raw: index,
      async batch(operations) {
        await index.beginUpdate()
        try { for (const operation of operations) { if (operation.op === 'delete') await index.deleteItem(operation.id); else await index[operation.op === 'insert' ? 'insertItem' : 'upsertItem'](operation.record) }; await index.endUpdate() }
        catch (error) { index.cancelUpdate(); throw error }
      },
      async query(vector, arm, filter) {
        assert.equal(arm.mode, 'exact')
        const hits = await index.queryItems(vector, '', 10, filter, false)
        return { hits: hits.map(({ item, score }) => ({ item: { id: item.id, vector: Array.from(item.vector), metadata: structuredClone(item.metadata) }, score })), route: 'vectraExact', routeEvidence: 'Pinned public queryItems(vector, empty string, 10, filter, false); no native route diagnostic exposed.' }
      },
      async all() {
        const result = []
        for (const item of await index.listItems()) {
          const full = item.metadataFile ? index.codec.deserializeMetadata(await index.storage.readFile(path.join(index.folderPath, item.metadataFile))) : item.metadata
          result.push({ id: item.id, vector: item.vector, metadata: full })
        }
        return result
      },
      async flush() { return { supported: false, durability: 'endUpdate acknowledgement uses fs.writeFile; no explicit fsync API' } },
      async maintain() { return { supported: false, reason: 'Vectra exact scan has no ANN build' } },
    }
  }
  assert.equal(engine, 'warm')
  const native = require(path.join(config.warmPath, 'index.js'))
  const loaded = Object.values(require.cache).find(module => module.filename.endsWith('.node') && module.exports === native)
  assert.ok(loaded, 'native binding provenance unavailable')
  assert.equal(await fs.realpath(loaded.filename), await fs.realpath(config.nativeAddon), 'public loader selected a different native addon')
  const { VectraMigrationIndex } = require(path.join(config.warmPath, 'vectra.js'))
  const index = create ? await VectraMigrationIndex.create({ path: directory, dimensions: 1024, embeddingSpace: { model: config.embeddingModel ?? 'vectra-comparison-existing-vectors', revision: config.embeddingRevision ?? config.inputIdentity, dimensions } }) : await VectraMigrationIndex.open({ path: directory })
  return {
    raw: index,
    batch: operations => index.applyBatch(operations),
    async query(vector, arm, filter) {
      const found = await index.queryItems(vector, { k: 10, mode: arm.mode, ef: arm.ef, filter })
      return { hits: found.results.map(({ item, score }) => ({ item: { id: item.id, vector: Array.from(item.vector), metadata: structuredClone(item.metadata) }, score })), route: found.diagnostics?.route, diagnostics: found.diagnostics, revision: found.revision, routeEvidence: 'Native query diagnostics' }
    },
    async all() {
      const items = []; let from, revision
      do { const page = await index.listItems({ from, limit: 1000, includeVectors: true, ifRevision: revision }); revision ??= page.revision; assert.equal(page.revision, revision); items.push(...page.items); from = page.nextFrom ?? undefined } while (from !== undefined)
      return items
    },
    async flush() { await index.flush(); return { supported: true, durability: 'WARM explicit flush completed; not a hardware power-loss assertion' } },
    maintain: () => index.maintainIndices(),
  }
}
export function operations(data, state) {
  return state.filter(item => item.epoch || item.deleted).map(item => item.deleted ? { op: 'delete', id: data.ids[item.ordinal] } : { op: 'upsert', record: { id: data.ids[item.ordinal], vector: data.row(item.row), metadata: metadata(item.ordinal, item.epoch) } })
}
export function validateItems(items, data, state, engine) {
  const actual = new Map(items.map(item => [item.id, item]))
  assert.equal(actual.size, items.length, 'duplicate stored IDs')
  assert.equal(items.length, state.filter(item => !item.deleted).length)
  let sourceZeroCanonicalizations = 0
  for (const expected of state.filter(item => !item.deleted)) {
    const item = actual.get(data.ids[expected.ordinal]); assert.ok(item, 'missing stored ID')
    assert.deepEqual(item.metadata, metadata(expected.ordinal, expected.epoch))
    const values = data.row(expected.row); assert.equal(item.vector.length, values.length)
    values.forEach((value, i) => { if (!Object.is(value, item.vector[i])) { assert.ok(engine === 'vectra' && value === 0 && item.vector[i] === 0, 'stored f64 value differs'); sourceZeroCanonicalizations++ } })
  }
  return { records: actual.size, sourceZeroCanonicalizations, pass: true }
}
export function routeCheck(engine, arm, filter, route, phase) {
  if (engine === 'vectra') return route === 'vectraExact'
  if (filter !== 'all') return route === 'filteredExact'
  if (arm.mode === 'exact') return ['fullExact', 'staleExact', 'fallbackExact'].includes(route)
  if (phase === 'before-maintenance') return ['fullGraph', 'staleExact', 'fallbackExact'].includes(route)
  return route === 'fullGraph'
}
async function stage(job, name, callback) {
  send({ type: 'stage', name, rssBytes: rss() }); const start = now()
  const value = await callback()
  await append(job.output, { type: 'stage', name, elapsedMs: job.development ? null : now() - start, rssBytes: rss(), value: value?.raw ? { engine: job.engine, opened: true } : value })
  return value
}
function safeError(error) { return { name: error.name, message: String(error.message).slice(0, 4096) } }
async function loadTruth(file) {
  const result = new Map()
  for (const line of (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean)) { const item = JSON.parse(line); if (item.type === 'oracle') result.set(`${item.state}/${item.filter}/${item.query}`, item) }
  return result
}
export async function runWorker(job) {
  await fs.writeFile(job.output, '', { flag: 'wx' })
  await append(job.output, { type: 'worker-start', pid: process.pid, rssBytes: rss(), job: { action: job.action, dataset: job.dataset.name, engine: job.engine, arm: job.arm, repetition: job.repetition, development: !!job.development } })
  const config = { ...await readJson(job.config), embeddingModel: job.dataset.embeddingModel, embeddingRevision: job.dataset.embeddingRevision }
  if (job.action === 'oracle') {
    const data = await loadDataset(job.dataset), rows = normalizeRows(data.values, job.dataset.dimensions)
    for (const stateName of ['baseline', 'churn']) {
      const state = liveState(job.dataset.rows, stateName === 'churn')
      for (const filter of FILTERS) for (let query = 0; query < job.dataset.queryCount; query++) {
        const truth = oracleTopK(rows, job.dataset.dimensions, data.query(query), state, filter.name)
        await append(job.output, { type: 'oracle', dataset: job.dataset.name, state: stateName, filter: filter.name, query, queryId: data.queryIds[query], ...truth })
      }
    }
    return { complete: true }
  }
  // Cold open precedes dataset loading; spawn/import/forced index-load is reported by the controller.
  let index
  if (job.action === 'cold') { index = await stage(job, 'process-cold-open', () => provider(job.engine, config, job.store, false, job.dataset.dimensions)); send({ type: 'opened', rssBytes: rss() }) }
  const data = await loadDataset(job.dataset)
  await append(job.output, { type: 'fixture-loaded', rssBytes: rss(), corpusBytes: data.values.byteLength, queryBytes: data.queries.byteLength, note: 'Identical widened input fixture overhead retained in both workers; whole-process RSS includes it.' })
  if (!index) index = await stage(job, job.action === 'prepare' ? 'create' : 'open', () => provider(job.engine, config, job.store, job.action === 'prepare', job.dataset.dimensions))
  const baseline = liveState(job.dataset.rows), changed = liveState(job.dataset.rows, true)
  if (job.action === 'prepare') {
    await stage(job, 'ingest-acknowledgements', async () => {
      for (let offset = 0; offset < baseline.length; offset += 100) {
        await index.batch(baseline.slice(offset, offset + 100).map(item => ({ op: 'insert', record: { id: data.ids[item.ordinal], vector: data.row(item.row), metadata: metadata(item.ordinal) } })))
      }
      return { count: baseline.length, batchSize: 100, acknowledgment: job.engine === 'warm' ? 'native ordered transaction' : 'endUpdate fs.writeFile; no explicit fsync guarantee' }
    })
    await stage(job, 'explicit-flush', () => index.flush())
    await stage(job, 'validate-full-store', async () => validateItems(await index.all(), data, baseline, job.engine))
    await stage(job, 'initial-maintainIndices', () => index.maintain())
    await append(job.output, { type: 'storage', ...(await storageReceipt(job.store)) })
    return { complete: true }
  }
  if (job.action === 'validate') {
    await stage(job, 'separate-process-reopen-validation', async () => validateItems(await index.all(), data, job.state === 'churn' ? changed : baseline, job.engine))
    return { complete: true }
  }
  if (job.action === 'crash-write') {
    const ops = operations(data, changed).slice(0, Math.min(100, operations(data, changed).length))
    await index.batch(ops)
    send({ type: 'boundary', boundary: 'operation-return-before-controller-ack', count: ops.length })
    await new Promise(resolve => process.once('message', resolve))
    send({ type: 'boundary', boundary: 'ack-before-flush' })
    await new Promise(resolve => process.once('message', resolve))
    const barrier = await index.flush()
    if (!barrier.supported) { send({ type: 'boundary', boundary: 'after-flush-unsupported', barrier }); return { complete: true, unsupported: true } }
    send({ type: 'boundary', boundary: 'after-flush', barrier })
    await new Promise(() => {})
  }
  if (job.action === 'crash-reopen') {
    const actual = await index.all(), expectedNew = baseline.map(item => ({ ...item }))
    const applied = operations(data, changed).slice(0, Math.min(100, operations(data, changed).length))
    for (const operation of applied) { const ordinal = data.ordinal.get(operation.id ?? operation.record.id); expectedNew[ordinal] = changed[ordinal] }
    const accepts = state => { try { return validateItems(actual, data, state, job.engine) } catch { return null } }
    const oldState = accepts(baseline), newState = accepts(expectedNew)
    const pass = job.boundary === 'after-flush' ? !!newState : !!(oldState || newState)
    await append(job.output, { type: 'crash-recovery', oldState, newState, pass, state: newState ? 'new' : oldState ? 'old' : 'partial-or-invalid', boundary: job.boundary, evidenceScope: 'Process interruption at a supported acknowledgement boundary; after completed WARM flush the new state is required. No native in-flight append or hardware power-loss claim.' })
    return { complete: true, correctness: pass }
  }
  const truth = await loadTruth(job.oracle)
  const recordQuery = async (query, filter, stateName, phase, role = 'quality') => {
    let found, error, elapsedMs = null
    const vector = data.query(query), start = now()
    try { found = await index.query(vector, job.arm, filter.filter) } catch (failure) { error = safeError(failure) }
    if (role !== 'warmup' && !job.development) elapsedMs = now() - start
    const expected = truth.get(`${stateName}/${filter.name}/${query}`); assert.ok(expected, 'missing frozen truth')
    const state = stateName === 'churn' ? changed : baseline
    if (error) { await append(job.output, { type: 'query', role, phase, query, state: stateName, filter: filter.name, error, elapsedMs, correctness: false }); return }
    const ids = new Set(state.filter(item => !item.deleted && eligible(item.ordinal, filter.name)).map(item => data.ids[item.ordinal]))
    let payload = { pass: true }, hits = found.hits.map(hit => ({ ordinal: data.ordinal.get(hit.item.id), id: hit.item.id, score: hit.score }))
    try {
      for (const hit of found.hits) {
        const ordinal = data.ordinal.get(hit.item.id); assert.ok(ids.has(hit.item.id), 'ineligible payload ID')
        assert.ok(Number.isFinite(hit.score), 'nonfinite returned score')
        assert.ok(Math.abs(hit.score - scalarCosine(data.row(state[ordinal].row), vector)) <= 2e-6, 'returned score differs from original-vector cosine')
        assert.deepEqual(hit.item.metadata, metadata(ordinal, state[ordinal].epoch))
        const storedVector = data.row(state[ordinal].row); assert.equal(hit.item.vector.length, storedVector.length)
        storedVector.forEach((value, i) => assert.ok(Object.is(value, hit.item.vector[i]) || (job.engine === 'vectra' && value === 0 && hit.item.vector[i] === 0), 'returned vector differs'))
      }
    } catch (failure) { payload = { pass: false, error: safeError(failure) } }
    const score = ordinal => ordinal === undefined || !state[ordinal] ? NaN : scalarCosine(data.row(state[ordinal].row), vector)
    const orderPass = scoreOrderPass(hits, score)
    const exact = job.arm.mode === 'exact' || found.route !== 'fullGraph'
    const audit = exact ? auditExact(hits, expected, score, new Set([...ids].map(id => data.ordinal.get(id)))) : null
    const routePass = routeCheck(job.engine, job.arm, filter.name, found.route, phase)
    const metrics = stateName === 'baseline' && data.qrels.has(data.queryIds[query]) ? qrelMetrics(hits.map(hit => hit.id), data.qrels.get(data.queryIds[query]), ids) : null
    await append(job.output, { type: 'query', role, phase, query, queryId: data.queryIds[query], state: stateName, filter: filter.name, eligibleCount: expected.eligibleCount, elapsedMs, hits, route: found.route, routeEvidence: found.routeEvidence, diagnostics: found.diagnostics, routePass, orderPass, payload, payloadHash: hashValue(found.hits), audit, oracleRecall: recallAtK(hits.map(hit => hit.ordinal), expected.hits.map(hit => hit.ordinal)), qrel: metrics, correctness: payload.pass && routePass && orderPass && (audit?.pass ?? (hits.length === Math.min(10, expected.eligibleCount) && new Set(hits.map(hit => hit.id)).size === hits.length)), rssBytes: rss() })
  }
  if (job.action === 'cold') {
    await recordQuery(0, FILTERS[0], 'baseline', 'cold-first-exact-including-actual-lazy-initialization', 'cold')
    return { complete: true, note: 'Page cache uncontrolled. Missing native exact snapshot may build a graph; this initialization remains included.' }
  }
  if (job.action === 'unavailable') {
    try { await index.query(data.query(0), job.arm, undefined); await append(job.output, { type: 'graph-unavailable', pass: false, unexpectedSuccess: true }) }
    catch (error) { const pass = /graph.*not.*available|graph.*unavailable|graph index.*not|no graph/i.test(error.message); await append(job.output, { type: 'graph-unavailable', pass, error: safeError(error), rows: job.dataset.rows }); return { complete: true, correctness: pass, notApplicable: true } }
    return { complete: true, correctness: false }
  }
  await stage(job, 'per-process-maintainIndices-outside-query-timing', () => index.maintain())
  if (job.action === 'churn') {
    const ops = operations(data, changed)
    const size = job.writeStyle === 'single' ? 1 : 100
    for (let offset = 0; offset < ops.length; offset += size) {
      const batch = ops.slice(offset, offset + size), start = now()
      await index.batch(batch); const acknowledgedAt = now()
      const flushStart = now(), flush = await index.flush(), flushEnd = now()
      await append(job.output, { type: 'write', offset, count: batch.length, kinds: batch.map(op => op.op), writeStyle: job.writeStyle, acknowledgedMs: job.development ? null : acknowledgedAt - start, flushMs: job.development || !flush.supported ? null : flushEnd - flushStart, ackToFlushMs: job.development || !flush.supported ? null : flushEnd - acknowledgedAt, flush, rssBytes: rss() })
    }
    await stage(job, 'validate-churn-store', async () => validateItems(await index.all(), data, changed, job.engine))
    if (job.writeStyle === 'single') return { complete: true }
    for (const phase of ['before-maintenance', 'after-maintenance']) {
      if (phase === 'after-maintenance') await stage(job, 'churn-maintainIndices', () => index.maintain())
      for (const filter of FILTERS) for (let query = 0; query < job.dataset.queryCount; query++) await recordQuery(query, filter, 'churn', phase)
    }
    await stage(job, 'churn-final-flush', () => index.flush())
    return { complete: true }
  }
  const stateName = job.state ?? 'baseline', phase = job.action === 'reopen' ? 'after-flush-separate-process-reopen-and-maintenance' : 'prepared'
  if (job.action === 'timing') {
    const filter = FILTERS.find(filter => filter.name === job.filter); assert.ok(filter)
    if (job.arm.mode === 'graph') await recordQuery(0, filter, stateName, phase, 'first-after-build')
    for (let query = 0; query < Math.min(20, job.dataset.queryCount); query++) await recordQuery(query, filter, stateName, phase, 'warmup')
    const stride = job.filter === 'all' ? 1 : job.dataset.name === 'scifact' ? 3 : 10
    for (let query = 0; query < job.dataset.queryCount; query += stride) await recordQuery(query, filter, stateName, phase, 'timing')
  } else {
    for (const filter of FILTERS) for (let query = 0; query < job.dataset.queryCount; query++) await recordQuery(query, filter, stateName, phase)
  }
  await append(job.output, { type: 'storage', ...(await storageReceipt(job.store)) })
  return { complete: true }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const job = await readJson(process.argv[2])
  try { const result = await runWorker(job); await append(job.output, { type: 'worker-end', ...result, rssBytes: rss() }); send({ type: 'complete', result }); process.disconnect?.() }
  catch (error) { await append(job.output, { type: 'worker-error', error: safeError(error), rssBytes: rss(), crashReopenFailure: job.action === 'crash-reopen', classification: 'Unclassified failure; inspect retained operation/error before attributing corruption.' }); send({ type: 'failure', error: safeError(error) }); process.exitCode = 1; process.disconnect?.() }
}
