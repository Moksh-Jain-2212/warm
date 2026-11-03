// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { LIMITS, append, sha256, readJson, writeOnce, preflight, runMonitored, watchPhase } from '../vector-receipts.mjs'
import { atLeast, latency, mean } from '../oracle-vector.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const worker = path.join(here, 'worker.mjs')
const inputFile = path.resolve(here, '../../../../docs/research/technical-audit-20261029/vectra-comparison-20261102/inputs.json')
const stopFile = path.resolve(here, '../../../../docs/research/technical-audit-20261029/vectra-comparison-20261102/user-stop-receipt.json')
const stopped = '/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen'
const require = createRequire(import.meta.url)
export const arms = Object.freeze(['hnswlib', 'usearch'].flatMap(engine => [128, 256, 512, 2048].map(ef => Object.freeze({ engine, ef }))))

async function artifacts() {
  require('hnswlib-node'); require('usearch')
  const native = Object.values(require.cache).filter(entry => entry.filename.endsWith('.node')).map(entry => entry.filename)
  assert.equal(native.length, 2, 'expected exactly the two competitor native addons')
  const files = [...new Set([worker, fileURLToPath(import.meta.url), path.join(here, 'test.mjs'), path.join(here, 'README.md'), path.join(here, 'package.json'), path.join(here, 'package-lock.json'), path.resolve(here, '../vector-receipts.mjs'), path.resolve(here, '../oracle-vector.mjs'), path.resolve(here, '../../../../docs/research/technical-audit-20261029/vectra-comparison-20261102/PLAN.md'), path.resolve(here, '../../../../docs/research/technical-audit-20261029/vectra-comparison-followup-20261102/PLAN.md'), path.resolve(here, '../../../../docs/research/technical-audit-20261029/vectra-comparison-followup-20261102/IMPORT-AND-QUIET-HOST.md'), ...Object.keys(require.cache), process.execPath])].sort()
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await sha256(file)])))
}

async function freeze(root) {
  assert.ok(path.isAbsolute(root))
  const inputs = await readJson(inputFile), stop = await readJson(stopFile), files = inputs.glove.files
  const corpus = path.join(inputs.glove.directory, 'train.f32'), queries = path.join(inputs.glove.directory, 'test.f32')
  assert.equal(await sha256(corpus), files['train.f32'].sha256)
  assert.equal(await sha256(queries), files['test.f32'].sha256)
  const datasets = []
  for (const rows of [10000, 100000]) {
    const recorded = stop.trees.results.files.find(file => file.path.endsWith(`glove-${rows}-oracle-oracle.ndjson`))
    assert.ok(recorded, 'stopped attempt lacks a complete recorded oracle')
    const oracle = path.join(stopped, 'results', recorded.path)
    assert.equal(await sha256(oracle), recorded.sha256)
    datasets.push({ rows, dimensions: 100, queryCount: 1000, corpus, queries, oracle, oracleSha256: recorded.sha256 })
  }
  const frozen = { version: 1, createdAtUtc: new Date().toISOString(), nodeVersion: process.version, nodePath: process.execPath, platform: process.platform, architecture: process.arch, host: { cpus: os.cpus().length, model: os.cpus()[0].model, memory: os.totalmem() }, corpusSha256: files['train.f32'].sha256, queriesSha256: files['test.f32'].sha256, inputManifestSha256: await sha256(inputFile), priorStopReceiptSha256: await sha256(stopFile), artifacts: await artifacts(), datasets, arms, threads: 1, repetitions: 3, search: 'unfiltered top-10 cosine over original f32 inputs; no metadata or vector payload return', quality: { meanRecallAt10: 0.99, worstRecallAt10: 0.90 }, build: { connectivity: 32, constructionEf: 200, hnswSeed: 100, usearchQuantization: 'f32' }, limits: LIMITS, interpretation: 'Standalone Node ANN index API; no filtered, hybrid, persistence durability, returned-vector or direct WARM/Vectra latency comparison. Existing GloVe test queries informed development.' }
  await fs.mkdir(root)
  await writeOnce(path.join(root, 'freeze.json'), frozen)
  await writeOnce(path.join(root, 'freeze-receipt.json'), { sha256: await sha256(path.join(root, 'freeze.json')), preparationOnly: true })
  return frozen
}

async function verify(root) {
  const file = path.join(root, 'freeze.json'), receipt = await readJson(path.join(root, 'freeze-receipt.json'))
  assert.equal(await sha256(file), receipt.sha256)
  const frozen = await readJson(file)
  assert.equal(process.version, frozen.nodeVersion); assert.equal(process.execPath, frozen.nodePath)
  assert.equal(process.platform, frozen.platform); assert.equal(process.arch, frozen.architecture)
  assert.equal(os.cpus().length, frozen.host.cpus); assert.equal(os.cpus()[0].model, frozen.host.model); assert.equal(os.totalmem(), frozen.host.memory)
  assert.deepEqual(await artifacts(), frozen.artifacts)
  assert.equal(await sha256(inputFile), frozen.inputManifestSha256)
  assert.equal(await sha256(stopFile), frozen.priorStopReceiptSha256)
  assert.equal(await sha256(frozen.datasets[0].corpus), frozen.corpusSha256)
  assert.equal(await sha256(frozen.datasets[0].queries), frozen.queriesSha256)
  for (const dataset of frozen.datasets) assert.equal(await sha256(dataset.oracle), dataset.oracleSha256)
  return frozen
}

export async function summarize(file, dataset, timing) {
  const rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'query')
  assert.equal(rows.length, dataset.queryCount)
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].query, i); assert.equal(rows[i].queryId, `query-${i}`)
    assert.equal(typeof rows[i].recall, 'number'); assert.ok(rows[i].recall >= 0 && rows[i].recall <= 1)
    if (timing) assert.ok(Number.isFinite(rows[i].elapsedMs) && rows[i].elapsedMs >= 0, 'invalid timing')
  }
  const average = mean(rows.map(row => row.recall))
  const worst = Math.min(...rows.map(row => row.recall))
  const correctness = rows.every(row => row.correctness)
  return { queries: rows.length, meanRecall: average, worstRecall: worst, below90: rows.filter(row => !atLeast(row.recall, .9)).length, correctness, qualityQualified: correctness && atLeast(average, .99) && atLeast(worst, .90), ...(timing ? { latency: latency(rows.map(row => row.elapsedMs)) } : {}) }
}

async function phase(root, name) {
  assert.ok(['preparation', 'measurement'].includes(name))
  const frozen = await verify(root)
  await writeOnce(path.join(root, `${name}-started.json`), { startedAtUtc: new Date().toISOString(), noRetry: true, authorizedBy: 'user request for additional competitors and restarted tests' })
  const deadline = Date.now() + (name === 'preparation' ? LIMITS.preparationMs : LIMITS.measurementMs)
  const hostFile = path.join(root, `${name}-host.ndjson`), results = [], indexes = {}, watcher = watchPhase(hostFile, deadline, false)
  let failure = null
  try {
    if (name === 'measurement') {
      const preparation = await readJson(path.join(root, 'preparation-finished.json'))
      assert.ok(preparation.complete, 'preparation is incomplete')
      assert.equal(preparation.results.length, frozen.datasets.length * arms.length)
      assert.equal(new Set(preparation.results.map(row => `${row.dataset}/${row.engine}/${row.ef}`)).size, preparation.results.length)
      for (const row of preparation.results) assert.equal(await sha256(row.output), row.outputSha256)
      for (const [file, hash] of Object.entries(preparation.indexes)) assert.equal(await sha256(file), hash)
      const quiet = await preflight(hostFile)
      assert.ok(quiet.pass, 'quiet-window preflight failed; no timings collected')
      watcher.setQuiet(true)
    }
    let serial = 0
    const schedule = []
    for (let repetition = 0; repetition < (name === 'measurement' ? frozen.repetitions : 1); repetition++) {
      for (const dataset of frozen.datasets) {
        const ordered = [...arms.slice(repetition % arms.length), ...arms.slice(0, repetition % arms.length)]
        for (const arm of ordered) schedule.push({ repetition, dataset, arm })
      }
    }
    for (const { repetition, dataset, arm } of schedule) {
      watcher.check()
      const stem = `${name}-${String(serial++).padStart(3, '0')}-${dataset.rows}-${arm.engine}-${arm.ef}-r${repetition}`
      const output = path.join(root, 'results', `${stem}.ndjson`), index = path.join(root, 'indexes', `${dataset.rows}-${arm.engine}-${arm.ef}.index`)
      await fs.mkdir(path.dirname(index), { recursive: true })
      await fs.mkdir(path.dirname(output), { recursive: true })
      await fs.mkdir(path.join(root, 'receipts'), { recursive: true })
      const job = { action: name === 'preparation' ? 'prepare' : 'timing', ...dataset, ...arm, index, output, repetition }
      const receipt = await runMonitored({ worker, job, jobFile: path.join(root, 'jobs', `${stem}.json`), receipt: path.join(root, 'receipts', `${stem}.json`), hostFile, deadline, quiet: name === 'measurement', signal: watcher.signal, environment: { RAYON_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } })
      assert.ok(receipt.complete, `worker incomplete: ${stem}`)
      const metrics = await summarize(output, dataset, name === 'measurement')
      results.push({ dataset: dataset.rows, ...arm, repetition, output, outputSha256: await sha256(output), ...metrics })
      if (name === 'preparation') indexes[index] = await sha256(index)
    }
  } catch (error) { failure = { name: error.name, message: error.message } }
  finally { await watcher.stop() }
  const result = { complete: !failure && !watcher.failure, failure: failure ?? watcher.failure, results, indexes, finishedAtUtc: new Date().toISOString(), noRetry: true }
  await writeOnce(path.join(root, `${name}-finished.json`), result)
  if (!result.complete) throw new Error(`phase incomplete: ${JSON.stringify(result.failure)}`)
  return result
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [action, root] = process.argv.slice(2)
  assert.ok(path.isAbsolute(root ?? ''), 'absolute new output directory required')
  if (action === 'freeze') await freeze(root)
  else if (action === 'preparation' || action === 'measurement') await phase(root, action)
  else throw new Error('usage: node run.mjs freeze|preparation|measurement ABSOLUTE_OUTPUT')
}
