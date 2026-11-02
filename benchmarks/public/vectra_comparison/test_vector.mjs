// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { normalize, normalizeRows, scalarCosine, oracleTopK, liveState, auditExact, qrelMetrics, latency, FILTERS, metadata } from './oracle-vector.mjs'
import { ARMS, timingSchedule, qualityGate, summarize } from './vector.mjs'
import { parseProcesses, descendants, preflight, writeOnce, readJson, manifest, cloneStore, assertOwnedPath, runMonitored, sha256, exec } from './vector-receipts.mjs'
import { provider, routeCheck } from './vector-worker.mjs'
const require = createRequire(import.meta.url), HERE = path.dirname(fileURLToPath(import.meta.url))
const sources = { vectraPath: process.env.VECTRA_TEST_PACKAGE, warmPath: process.env.WARM_TEST_PACKAGE, nativeAddon: process.env.WARM_TEST_ADDON }
for (const [name, value] of Object.entries(sources)) assert.ok(value, `${name} test path is required; actual API checks must not silently skip`)
async function temporary(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'warm-vector-harness-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory }
async function lines(file) { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }

test('normalized oracle agrees with independent scalar sorting, including extremes and cutoff ties', () => {
  const vectors = [[1, -0, 0], [1, 0, 0], [1, 1e-4, 0], [1, .001, 0], [1, .01, 0], [0, 1, 0], [-1, 0, 0], [1e30, 1e-30, 0], [1e-30, 1e-30, 0], [2, 1, 0], [3, 1, 0], [4, 1, 0], [-1, -1, 0]]
  const rows = normalizeRows(Float64Array.from(vectors.flat()), 3)
  for (const query of [[1, 0, -0], [1, 1, 1], [-1, 0, 0]]) for (const filter of FILTERS) {
    const truth = oracleTopK(rows, 3, query, liveState(vectors.length), filter.name)
    const expected = vectors.map((vector, ordinal) => ({ ordinal, score: scalarCosine(vector, query) })).filter(hit => filter.name === 'all' || (filter.name === '10pct' && hit.ordinal < 10) || (filter.name === '1pct' && hit.ordinal === 0)).sort((a, b) => b.score - a.score || a.ordinal - b.ordinal).slice(0, 10)
    assert.deepEqual(truth.hits.map(hit => hit.ordinal), expected.map(hit => hit.ordinal))
    truth.hits.forEach((hit, i) => assert.ok(Math.abs(hit.score - expected[i].score) < 1e-14))
  }
  assert.throws(() => normalize([0, -0])); assert.throws(() => normalize([NaN, 1])); assert.throws(() => normalize([Infinity, 1]))
  const scores = Array.from({ length: 12 }, (_, i) => i < 9 ? 1 - i / 100 : .5 - (i - 9) * 1e-6)
  const truth = { hits: scores.slice(0, 10).map((score, ordinal) => ({ score, ordinal })), eligibleCount: 12, cutoff: .5 }
  const eligible = new Set(scores.map((_, i) => i)), score = i => scores[i]
  const substitute = [...truth.hits.slice(0, 9), { ordinal: 10, score: scores[10] }]
  assert.equal(auditExact(substitute, truth, score, eligible).tieBoundarySubstitutions, 1)
  assert.equal(auditExact(substitute, truth, score, eligible).pass, true)
  scores[10] = .5 - 2.001e-6; substitute[9].score = scores[10]
  assert.equal(auditExact(substitute, truth, score, eligible).pass, false)
  const badScore = truth.hits.map(hit => ({ ...hit })); badScore[0].score += 2.001e-6
  assert.equal(auditExact(badScore, truth, score, eligible).pass, false)
  assert.equal(auditExact([...truth.hits.slice(0, 9), truth.hits[0]], truth, score, eligible).pass, false)
  assert.equal(auditExact([], { hits: [], cutoff: null, eligibleCount: 0 }, score, new Set()).pass, true)
})

test('quality gates distinguish exact numerical ties from ANN misses and fail missing references', () => {
  const reference = [{ query: 0, hits: [{ ordinal: 1 }], correctness: true, eligibleCount: 1, oracleRecall: 1, qrel: null }]
  const tie = [{ ...reference[0], hits: [{ ordinal: 2 }], oracleRecall: 0 }]
  assert.equal(qualityGate(tie, reference, true).pass, true)
  assert.equal(qualityGate(tie, reference).pass, false)
  assert.equal(qualityGate(reference, [{ query: 0, error: { message: 'failed' } }], true).pass, false)
  assert.equal(qualityGate([], [], true).pass, false)
  assert.deepEqual(latency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { count: 10, p50: 5, p95: 10, p99: 10 })
  assert.deepEqual(qrelMetrics(['a'], new Map([['a', 1]]), new Set()), { ndcg10: null, recall10: null, eligibleJudgments: 0 })
  const schedule = timingSchedule([{ name: 'glove-128', rows: 128 }, { name: 'scifact', rows: 5183 }])
  assert.equal(schedule.length, 3 * 4 * (2 + 5)); assert.equal(schedule.filter(job => job.dataset === 'scifact' && job.queryStride === 3).length, 3 * 3 * 5)
  for (const repetition of [0, 1, 2]) assert.equal(schedule.filter(job => job.repetition === repetition && job.filter === 'all' && job.dataset === 'scifact')[0].arm, ARMS[repetition].name)
  assert.equal(routeCheck('warm', { mode: 'graph' }, 'all', 'filteredExact', 'prepared'), false)
  assert.equal(routeCheck('warm', { mode: 'graph' }, '10pct', 'filteredExact', 'prepared'), true)
})

test('resource ownership includes descendants while siblings remain external; admission and copies fail closed', async t => {
  const root = await temporary(t), file = path.join(root, 'preflight.ndjson')
  const ps = parseProcesses('10 1 20.0 1024 node\n11 10 30.0 2048 python\n12 1 70.0 512 compiler')
  assert.equal(ps[1].rssBytes, 2048 * 1024); assert.deepEqual([...descendants(ps, [10])], [10, 11])
  let count = 0
  const failed = await preflight(file, async () => ({ externalCpuFraction: ++count === 3 ? .20001 : .1 }), async () => {})
  assert.equal(failed.pass, false); assert.equal(count, 5); assert.equal((await lines(file)).length, 5)
  count = 0; const passed = await preflight(path.join(root, 'pass.ndjson'), async () => { count++; return { externalCpuFraction: .2 } }, async () => {})
  assert.equal(passed.pass, true); assert.equal(count, 10)
  await writeOnce(path.join(root, 'receipt.json'), { retained: true }); await assert.rejects(writeOnce(path.join(root, 'receipt.json'), {}), { code: 'EEXIST' })
  assert.throws(() => assertOwnedPath(root, root)); assert.throws(() => assertOwnedPath(root, path.join(root, '..', 'escape')))
  const source = path.join(root, 'source'), copy = path.join(root, 'copy'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'data'), 'exact'); await fs.writeFile(path.join(source, '.hms.lock'), 'stale')
  await cloneStore(root, source, copy); assert.equal(await fs.readFile(path.join(copy, 'data'), 'utf8'), 'exact'); await assert.rejects(fs.stat(path.join(copy, '.hms.lock')), { code: 'ENOENT' })
  await assert.rejects(cloneStore(root, source, copy), { code: 'EEXIST' })
  await fs.symlink('data', path.join(copy, 'link')); await assert.rejects(manifest(copy), /symlink/)
})

test('actual pinned selector and external metadata materialization match the harness provider', async t => {
  const root = await temporary(t), { LocalIndex } = require(path.join(sources.vectraPath, 'lib/index.js'))
  assert.equal(require(path.join(sources.vectraPath, 'package.json')).version, '0.15.0')
  const { ItemSelector } = require(path.join(sources.vectraPath, 'lib/ItemSelector.js')), { select } = require(path.join(sources.warmPath, 'vectra-selector.js'))
  const filters = [{ n: { $in: [5] } }, { n: { $nin: [5] } }, { n: { $in: ['15'] } }, { missing: { $ne: 1 } }, { n: null }, { $and: [{ n: { $gte: 4 } }, { $or: [{ n: 5 }, { s: 'a' }] }] }]
  for (const item of [{ n: 5, s: 'a' }, { n: null }, {}]) for (const filter of filters) assert.equal(select(item, filter), ItemSelector.select(item, filter))
  const directory = path.join(root, 'external'), index = new LocalIndex(directory)
  await index.createIndex({ version: 1, metadata_config: { indexed: ['eligible10'] } })
  await index.insertItem({ id: 'external', vector: [1, -0, 0], metadata: { eligible10: true, full: { text: 'retained sidecar' } } })
  const api = await provider('vectra', sources, directory)
  const stored = await api.all(), found = await api.query([1, 0, 0], { mode: 'exact' }, { eligible10: true })
  assert.deepEqual(found.hits[0].item.metadata, stored[0].metadata); assert.equal(stored[0].metadata.full.text, 'retained sidecar')
  assert.equal(Object.is(stored[0].vector[1], 0), true)
  const { importVectraIndex } = require(path.join(sources.warmPath, 'vectra.js'))
  // Import is exercised in the isolated package below; the public function must be present here.
  assert.equal(typeof importVectraIndex, 'function')
})

test('monitor observes owned child RSS and stops a process at its fixed deadline', { timeout: 10000 }, async t => {
  const root = await temporary(t), worker = path.join(root, 'owned-worker.mjs')
  await fs.writeFile(worker, "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.send({type:'stage',name:'descendant',childPid:child.pid}); setTimeout(()=>{child.kill('SIGTERM');process.disconnect();},1400); child.on('exit',()=>{});\n")
  const monitored = await runMonitored({ worker, job: { output: path.join(root, 'unused'), development: true }, jobFile: path.join(root, 'job.json'), receipt: path.join(root, 'receipt.json'), hostFile: path.join(root, 'host.ndjson'), deadline: Date.now() + 5000 })
  assert.equal(monitored.complete, true)
  const descendant = monitored.events.find(event => event.childPid).childPid
  assert.ok(monitored.peakRssByPid[descendant] > 0)
  assert.ok((await lines(path.join(root, 'host.ndjson'))).some(sample => sample.ownedPids.includes(descendant)))
  await fs.writeFile(worker, "setInterval(()=>{},1000)\n")
  const stopped = await runMonitored({ worker, job: { output: path.join(root, 'unused2'), development: true }, jobFile: path.join(root, 'job2.json'), receipt: path.join(root, 'receipt2.json'), hostFile: path.join(root, 'host2.ndjson'), deadline: Date.now() + 100 })
  assert.equal(stopped.complete, false); assert.equal(stopped.resourceQualified, false); assert.equal(stopped.stop.kind, 'phase-timeout'); assert.equal(stopped.exit.signal, 'SIGKILL')
})

test('spontaneous worker exit cleans its residual process group and cannot qualify', { timeout: 10000 }, async t => {
  const root = await temporary(t), worker = path.join(root, 'orphan-worker.mjs')
  await fs.writeFile(worker, "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.unref(); process.send({type:'stage',name:'leave-owned-child',childPid:child.pid},()=>process.exit(0));\n")
  const result = await runMonitored({ worker, job: { output: path.join(root, 'unused'), development: true }, jobFile: path.join(root, 'job.json'), receipt: path.join(root, 'receipt.json'), hostFile: path.join(root, 'host.ndjson'), deadline: Date.now() + 5000 })
  assert.equal(result.exit.code, 0); assert.equal(result.complete, false); assert.equal(result.resourceQualified, false)
  assert.equal(result.stop.kind, 'unexpected-owned-descendants')
  assert.equal(result.descendantCleanup.processGroup, result.pid); assert.equal(result.descendantCleanup.residualGroupFound, true); assert.equal(result.descendantCleanup.signal, 'SIGKILL')
  const childPid = result.events.find(event => event.childPid).childPid
  let status
  try { status = (await exec('/bin/ps', ['-p', String(childPid), '-o', 'stat='])).stdout.trim() }
  catch (error) { assert.equal(error.code, 1); status = error.stdout.trim() }
  assert.ok(!status || status.startsWith('Z'), `owned descendant remains active: ${status}`)
})

test('actual engines pass tiny oracle, filter, churn, separate-process reopen and controlled interruption checks', { timeout: 120000 }, async t => {
  const root = await temporary(t), packagePath = path.join(root, 'warm-package'); await fs.mkdir(packagePath)
  for (const file of ['index.js', 'vectra.js', 'vectra-selector.js']) await fs.copyFile(path.join(sources.warmPath, file), path.join(packagePath, file))
  const nativeAddon = path.join(packagePath, 'warm-sdk.node'); await fs.copyFile(sources.nativeAddon, nativeAddon)
  const config = path.join(root, 'config.json'); await writeOnce(config, { ...sources, warmPath: packagePath, nativeAddon, inputIdentity: 'synthetic-development-only' })
  const count = 24, dimensions = 3, queryCount = 3
  const vectors = Array.from({ length: count }, (_, i) => [i % 2 ? -1 : 1, i === 0 ? -0 : i / 10, .5]), queries = [[1, 0, .1], [-1, 0, .1], [.1, 1, .1]]
  for (const [name, values] of [['corpus', vectors.flat()], ['queries', queries.flat()]]) { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, i) => bytes.writeFloatLE(value, i * 4)); await fs.writeFile(path.join(root, `${name}.f32`), bytes) }
  const dataset = { name: 'synthetic-only', rows: count, dimensions, queryCount, corpus: path.join(root, 'corpus.f32'), queries: path.join(root, 'queries.f32'), embeddingModel: 'synthetic', embeddingRevision: 'test-v1' }
  let serial = 0
  const run = async (job, killBoundary = null) => {
    const id = `${serial++}-${job.engine ?? 'oracle'}-${job.action}`, output = path.join(root, `${id}.ndjson`)
    const result = await runMonitored({ worker: path.join(HERE, 'vector-worker.mjs'), job: { ...job, dataset, config, output, development: true }, jobFile: path.join(root, `${id}.json`), receipt: path.join(root, `${id}-receipt.json`), hostFile: path.join(root, 'host.ndjson'), deadline: Date.now() + 30000, killBoundary })
    const rows = await lines(output)
    assert.ok(result.complete || result.stop?.kind === 'planned-process-interruption', JSON.stringify(rows.filter(row => row.type === 'worker-error')))
    for (const row of rows) { if (row.type === 'query') { assert.equal(row.correctness, true, JSON.stringify(row)); assert.equal(row.elapsedMs, null) }; if (row.type === 'graph-unavailable' || row.type === 'crash-recovery') assert.equal(row.pass, true, JSON.stringify(row)) }
    return { result, rows, output }
  }
  const oracle = (await run({ action: 'oracle' })).output
  for (const engine of ['vectra', 'warm']) {
    const store = path.join(root, engine), arm = ARMS.find(arm => arm.engine === engine && arm.mode === 'exact')
    const prepared = await run({ action: 'prepare', engine, store })
    const validation = prepared.rows.find(row => row.name === 'validate-full-store').value
    assert.equal(validation.sourceZeroCanonicalizations, 0)
    const reopened = await run({ action: 'validate', engine, store })
    assert.equal(reopened.rows.find(row => row.name === 'separate-process-reopen-validation').value.sourceZeroCanonicalizations, engine === 'vectra' ? 1 : 0)
    const quality = await run({ action: 'quality', engine, arm, store, oracle }); assert.equal(quality.rows.filter(row => row.type === 'query').length, queryCount * 4)
    if (engine === 'warm') await run({ action: 'unavailable', engine, arm: ARMS[2], store, oracle })
    const churnStore = path.join(root, `${engine}-churn`); await cloneStore(root, store, churnStore)
    await run({ action: 'churn', engine, arm, store: churnStore, oracle, writeStyle: 'batch' }); await run({ action: 'reopen', engine, arm, store: churnStore, oracle, state: 'churn' })
    for (const boundary of ['operation-return-before-controller-ack', 'ack-before-flush', 'after-flush']) {
      const crashStore = path.join(root, `${engine}-${boundary}`); await cloneStore(root, store, crashStore)
      const stopped = await run({ action: 'crash-write', engine, store: crashStore }, boundary)
      if (engine === 'vectra' && boundary === 'after-flush') assert.ok(stopped.result.events.some(event => event.boundary === 'after-flush-unsupported'))
      else { assert.equal(stopped.result.stop.boundary, boundary); const recovered = await run({ action: 'crash-reopen', engine, store: crashStore, boundary }); assert.equal(recovered.rows.find(row => row.type === 'crash-recovery').state, 'new') }
    }
  }
  const { LocalIndex } = require(path.join(sources.vectraPath, 'lib/index.js')), source = new LocalIndex(path.join(root, 'vectra'))
  await source.getIndexStats()
  const { importVectraIndex } = require(path.join(packagePath, 'vectra.js'))
  const { index: imported } = await importVectraIndex(source, { path: path.join(root, 'migration'), dimensions: 1024, embeddingSpace: { model: 'synthetic', revision: 'test-v1', dimensions } })
  const received = (await source.listItems())[0], retrieved = await imported.getItem(received.id)
  assert.ok(received.vector.every((value, i) => Object.is(value, retrieved.vector[i])))
  await imported.beginUpdate(); await imported.upsertItem({ id: received.id, vector: [1, 2, 3], metadata: {} }); await imported.cancelUpdate()
  assert.deepEqual(await imported.getItem(received.id), retrieved)
  await assert.rejects(imported.applyBatch([{ op: 'delete', id: received.id }, { op: 'insert', record: received }, { op: 'insert', record: received }]))
  assert.deepEqual(await imported.getItem(received.id), retrieved)
  assert.equal(await sha256(nativeAddon), await sha256(sources.nativeAddon))
})

test('partial summary retains errors and cannot claim an advantage', async t => {
  const root = await temporary(t)
  await writeOnce(path.join(root, 'freeze.json'), { datasets: [{ name: 'tiny', rows: 24, queryCount: 3 }] })
  const result = await summarize(root)
  assert.equal(result.globallyComplete, false); assert.equal(result.performanceClaimPermitted, false)
  assert.ok(result.quality.every(point => !point.pass)); assert.ok(result.lifecycleQuality.every(point => !point.pass))
  await assert.rejects(summarize(root), { code: 'EEXIST' })
})
