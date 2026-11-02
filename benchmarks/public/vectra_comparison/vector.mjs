// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { FILTERS, latency, recallAtK } from './oracle-vector.mjs'
import { LIMITS, exec, sha256, hashValue, manifest, writeOnce, readJson, append, preflight, cloneStore, runMonitored } from './vector-receipts.mjs'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILES = ['vector.mjs', 'vector-worker.mjs', 'vector-receipts.mjs', 'oracle-vector.mjs', 'test_vector.mjs', 'README-vector.md']
const THREAD_ENVIRONMENT = ['RAYON_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'UV_THREADPOOL_SIZE', 'TOKENIZERS_PARALLELISM']
const threadEnvironment = () => Object.fromEntries(THREAD_ENVIRONMENT.map(name => [name, process.env[name] ?? null]))
export const ARMS = Object.freeze([{ name: 'vectra-exact', engine: 'vectra', mode: 'exact' }, { name: 'warm-exact', engine: 'warm', mode: 'exact' }, ...[128, 256, 512].map(ef => ({ name: `warm-graph-${ef}`, engine: 'warm', mode: 'graph', ef }))])
export function timingSchedule(datasets) {
  const jobs = []
  for (let repetition = 0; repetition < 3; repetition++) for (const dataset of datasets) {
    const arms = ARMS.filter(arm => arm.mode === 'exact' || dataset.rows >= 4096)
    const ordered = [...arms.slice(repetition % arms.length), ...arms.slice(0, repetition % arms.length)]
    for (const filter of FILTERS) for (const arm of ordered) jobs.push({ dataset: dataset.name, arm: arm.name, filter: filter.name, repetition, queryStride: filter.name === 'all' ? 1 : dataset.name === 'scifact' ? 3 : 10, warmupQueries: 20 })
  }
  return jobs
}
async function driverHashes() { return Object.fromEntries(await Promise.all(FILES.map(async name => [name, await sha256(path.join(HERE, name))]))) }
async function verifyInputs(inputs) {
  const files = []
  for (const group of [inputs.glove, inputs.scifact]) for (const [relative, expected] of Object.entries(group.files)) {
    const filename = path.join(group.directory, relative), stat = await fs.stat(filename)
    if (expected.bytes !== undefined) assert.equal(stat.size, expected.bytes, `input size: ${filename}`)
    assert.equal(await sha256(filename), expected.sha256, `input hash: ${filename}`)
    files.push({ path: filename, bytes: stat.size, sha256: expected.sha256 })
  }
  for (const [relative, expected] of Object.entries(inputs.scifact.sources)) {
    const filename = path.join(inputs.scifact.source_directory, relative)
    assert.equal((await fs.stat(filename)).size, expected.bytes); assert.equal(await sha256(filename), expected.sha256)
    files.push({ path: filename, ...expected })
  }
  return files
}
function datasets(inputs) {
  return [...inputs.glove.prefixes.map(prefix => ({ name: `glove-${prefix.rows}`, rows: prefix.rows, dimensions: 100, queryCount: 1000, corpus: path.join(inputs.glove.directory, 'train.f32'), queries: path.join(inputs.glove.directory, 'test.f32'), embeddingModel: 'glove-100-angular', embeddingRevision: inputs.glove.source_archive_sha256 })), { name: 'scifact', rows: 5183, dimensions: 1024, queryCount: 300, corpus: path.join(inputs.scifact.directory, 'generated/corpus.f32'), queries: path.join(inputs.scifact.directory, 'generated/queries.f32'), mapping: path.join(inputs.scifact.directory, 'input.json'), qrels: path.join(inputs.scifact.source_directory, 'qrels/test.tsv'), embeddingModel: inputs.scifact.embedding_model, embeddingRevision: inputs.scifact.effective_revision }]
}
async function dependencyInventory(lockfile) {
  const lock = await readJson(lockfile)
  assert.ok(lock.packages && lock.lockfileVersion >= 2, 'provide the actual npm package-lock with packages/integrities')
  const result = []
  for (const [relative, item] of Object.entries(lock.packages)) {
    if (!relative.includes('node_modules/')) continue
    const filename = path.join(path.dirname(lockfile), relative, 'package.json')
    try { const actual = await readJson(filename); assert.equal(actual.version, item.version, `installed dependency differs from lock: ${relative}`); result.push({ path: relative, name: actual.name, version: actual.version, integrity: item.integrity ?? null, packageJsonSha256: await sha256(filename) }) }
    catch (error) { if (error.code !== 'ENOENT') throw error; result.push({ path: relative, version: item.version, installed: false, optional: !!item.optional, dev: !!item.dev }) }
  }
  assert.ok(result.some(item => item.name === 'vectra' && item.version === '0.15.0'))
  return result
}
export async function freeze(configuration, output) {
  assert.ok(!process.env.NODE_OPTIONS, 'unset NODE_OPTIONS for the pinned default worker runtime')
  const config = await readJson(configuration)
  for (const key of ['plan', 'inputs', 'warmPath', 'nativeAddon', 'vectraPath', 'vectraLockfile', 'warmSourceCommit']) assert.equal(typeof config[key], 'string', `missing ${key}`)
  const source = (await exec('git', ['-C', config.warmPath, 'rev-parse', 'HEAD'])).stdout.trim()
  assert.equal(source, config.warmSourceCommit)
  assert.equal((await exec('git', ['-C', config.warmPath, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim(), '', 'freeze requires clean integrated source')
  assert.equal((await readJson(path.join(config.vectraPath, 'package.json'))).version, '0.15.0')
  const loaded = JSON.parse((await exec(process.execPath, ['-e', "const b=require(process.argv[1]); console.log(JSON.stringify(Object.values(require.cache).filter(m=>m.filename.endsWith('.node')&&m.exports===b).map(m=>m.filename)))", path.join(config.warmPath, 'index.js')])).stdout)
  assert.equal(loaded.length, 1, 'native loader provenance must be unambiguous')
  assert.equal(await fs.realpath(loaded[0]), await fs.realpath(config.nativeAddon), 'configured addon is not the one selected by the public loader')
  const inputs = await readJson(config.inputs), verifiedInputs = await verifyInputs(inputs)
  const mappingManifest = path.resolve(path.dirname(config.inputs), inputs.scifact.mapping_manifest)
  assert.equal(await sha256(mappingManifest), inputs.scifact.mapping_manifest_sha256)
  const warmFiles = Object.fromEntries(await Promise.all(['vectra.js', 'vectra-selector.js', 'vectra.d.ts', 'index.js', 'index.d.ts', 'package.json', 'package-lock.json', 'Cargo.lock'].map(async file => [file, await sha256(path.join(config.warmPath, file))])))
  const frozen = { version: 1, preparationOnlyUntilExplicitGrant: true, createdAtUtc: new Date().toISOString(), ...config, source, runtime: { executable: process.execPath, version: process.version, sha256: await sha256(process.execPath) }, sourceFiles: warmFiles, nativeSha256: await sha256(config.nativeAddon), vectra: await manifest(config.vectraPath), dependencyLockSha256: await sha256(config.vectraLockfile), dependencyInventory: await dependencyInventory(config.vectraLockfile), protocolSha256: await sha256(config.plan), inputManifestSha256: await sha256(config.inputs), inputIdentity: hashValue(verifiedInputs), verifiedInputs, driver: await driverHashes(), datasets: datasets(inputs), limits: LIMITS, queryOrder: 'source ordinal; no query randomization', seed: 20261102, nativeGraphSeed: 'pinned engine defaults; no seed tuning', arms: ARMS, filters: FILTERS, repetitions: 3, host: { platform: process.platform, release: os.release(), architecture: os.arch(), logicalCpus: os.cpus().length, cpuModels: [...new Set(os.cpus().map(cpu => cpu.model))], memoryBytes: os.totalmem() }, durationCeilingNote: 'No duration estimate from development timings; coordinator must reject any projected execution exceeding fixed phase budgets before granting execution.' }
  frozen.timingSchedule = timingSchedule(frozen.datasets)
  frozen.driverSource = (await exec('git', ['-C', HERE, 'rev-parse', 'HEAD'])).stdout.trim()
  assert.equal((await exec('git', ['-C', HERE, 'status', '--porcelain', '--', ...FILES])).stdout.trim(), '', 'commit the harness before freezing')
  frozen.threadEnvironment = threadEnvironment()
  frozen.storeCopy = 'Exclusive fresh directory; fs.cp COPYFILE_FICLONE requests copy-on-write, falls back to byte copy; lock files omitted. Per-file allocated blocks may be shared across clones and are not a summed physical footprint.'
  await fs.mkdir(output) // Deliberately no recursive/overwrite/resume semantics.
  await writeOnce(path.join(output, 'freeze.json'), frozen)
  await writeOnce(path.join(output, 'freeze-receipt.json'), { freezeHash: await sha256(path.join(output, 'freeze.json')), noMeasurementExecuted: true })
  return frozen
}
export async function verifyFreeze(root) {
  assert.ok(!process.env.NODE_OPTIONS, 'unset NODE_OPTIONS for the pinned default worker runtime')
  const file = path.join(root, 'freeze.json'), frozen = await readJson(file), receipt = await readJson(path.join(root, 'freeze-receipt.json'))
  assert.equal(await sha256(file), receipt.freezeHash)
  assert.deepEqual(await driverHashes(), frozen.driver, 'driver changed after freeze')
  assert.deepEqual(threadEnvironment(), frozen.threadEnvironment, 'thread configuration changed after freeze')
  assert.equal(process.execPath, frozen.runtime.executable); assert.equal(process.version, frozen.runtime.version); assert.equal(await sha256(process.execPath), frozen.runtime.sha256)
  assert.equal(await sha256(frozen.nativeAddon), frozen.nativeSha256)
  for (const [file, expected] of Object.entries(frozen.sourceFiles)) assert.equal(await sha256(path.join(frozen.warmPath, file)), expected)
  assert.equal((await exec('git', ['-C', frozen.warmPath, 'rev-parse', 'HEAD'])).stdout.trim(), frozen.source)
  assert.equal(await sha256(frozen.plan), frozen.protocolSha256); assert.equal(await sha256(frozen.inputs), frozen.inputManifestSha256)
  assert.equal(await sha256(frozen.vectraLockfile), frozen.dependencyLockSha256)
  assert.deepEqual(await dependencyInventory(frozen.vectraLockfile), frozen.dependencyInventory)
  assert.deepEqual(await manifest(frozen.vectraPath), frozen.vectra)
  return { frozen, freezeHash: receipt.freezeHash }
}
async function admission(root, phase, grantPath) {
  const { frozen, freezeHash } = await verifyFreeze(root), grant = await readJson(grantPath)
  assert.equal(grant.freezeHash, freezeHash); assert.equal(grant.phase, phase); assert.equal(grant.approved, true)
  assert.ok(typeof grant.coordinator === 'string' && grant.coordinator && !Number.isNaN(Date.parse(grant.approvedAtUtc)))
  await writeOnce(path.join(root, `${phase}-started.json`), { grant, startedAtUtc: new Date().toISOString(), noRetry: true })
  return { frozen, freezeHash }
}
export async function runPhase(root, phase, grantPath) {
  assert.ok(['preparation', 'measurement'].includes(phase))
  const { frozen } = await admission(root, phase, grantPath)
  const deadline = Date.now() + (phase === 'preparation' ? LIMITS.preparationMs : LIMITS.measurementMs)
  const hostFile = path.join(root, `${phase}-host.ndjson`)
  const receipts = [], config = path.join(root, 'freeze.json'), worker = path.join(HERE, 'vector-worker.mjs')
  let serial = 0
  const run = async (job, killBoundary = null) => {
    const id = `${phase}-${String(serial++).padStart(4, '0')}-${job.dataset.name}-${job.engine ?? 'oracle'}-${job.action}`
    const output = path.join(root, 'results', `${id}.ndjson`), jobFile = path.join(root, 'jobs', `${id}.json`), receipt = path.join(root, 'receipts', `${id}.json`)
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(path.dirname(receipt), { recursive: true })
    const result = await runMonitored({ worker, job: { ...job, config, output }, jobFile, receipt, hostFile, deadline, quiet: phase === 'measurement', killBoundary })
    receipts.push({ id, job: { ...job, config, output }, receipt, result })
    if (!result.resourceQualified) throw new Error(`phase incomplete: ${result.stop?.kind}`)
    return result
  }
  const fixture = (dataset, engine) => path.join(root, 'fixtures', dataset.name, engine)
  const copy = async (dataset, engine, name) => { const destination = path.join(root, 'stores', name); await fs.mkdir(path.dirname(destination), { recursive: true }); await cloneStore(root, fixture(dataset, engine), destination); return destination }
  try {
    for (const input of frozen.verifiedInputs) assert.equal(await sha256(input.path), input.sha256, `changed input: ${input.path}`)
    if (phase === 'preparation') {
      for (const dataset of frozen.datasets) {
        const oracleJob = { action: 'oracle', dataset }
        const oracle = await run(oracleJob); assert.ok(oracle.complete, 'oracle failed; no engine measurement')
        await writeOnce(path.join(root, 'oracles', `${dataset.name}.json`), { output: receipts.at(-1).job.output })
        for (const engine of ['vectra', 'warm']) {
          const store = fixture(dataset, engine); await fs.mkdir(path.dirname(store), { recursive: true })
          assert.ok((await run({ action: 'prepare', dataset, engine, store })).complete, 'failed import is not benchmarkable')
          assert.ok((await run({ action: 'validate', dataset, engine, store })).complete, 'reopen validation failed')
        }
        const oraclePath = (await readJson(path.join(root, 'oracles', `${dataset.name}.json`))).output
        for (const arm of ARMS) {
          const store = await copy(dataset, arm.engine, `quality-${dataset.name}-${arm.name}`)
          await run({ action: arm.mode === 'graph' && dataset.rows < 4096 ? 'unavailable' : 'quality', dataset, engine: arm.engine, arm, store, oracle: oraclePath })
        }
      }
    } else {
      const preparation = await readJson(path.join(root, 'preparation-finished.json')); assert.equal(preparation.complete, true, 'preparation incomplete')
      const quiet = await preflight(hostFile); await writeOnce(path.join(root, 'measurement-preflight.json'), quiet)
      if (!quiet.pass) throw new Error('preflight failed; no query timings collected')
      for (const dataset of frozen.datasets) for (let repetition = 0; repetition < 3; repetition++) for (const engine of ['vectra', 'warm']) {
        const store = await copy(dataset, engine, `cold-${dataset.name}-${engine}-${repetition}`), oracle = (await readJson(path.join(root, 'oracles', `${dataset.name}.json`))).output
        await run({ action: 'cold', dataset, engine, arm: ARMS.find(arm => arm.engine === engine && arm.mode === 'exact'), repetition, store, oracle })
      }
      for (const scheduled of frozen.timingSchedule) {
        const dataset = frozen.datasets.find(dataset => dataset.name === scheduled.dataset), arm = ARMS.find(arm => arm.name === scheduled.arm)
        const store = await copy(dataset, arm.engine, `timing-${dataset.name}-${arm.name}-${scheduled.filter}-${scheduled.repetition}`), oracle = (await readJson(path.join(root, 'oracles', `${dataset.name}.json`))).output
        await run({ action: 'timing', dataset, engine: arm.engine, arm, filter: scheduled.filter, repetition: scheduled.repetition, store, oracle })
      }
      for (const dataset of frozen.datasets) {
        const oracle = (await readJson(path.join(root, 'oracles', `${dataset.name}.json`))).output
        for (const engine of ['vectra', 'warm']) {
          const store = await copy(dataset, engine, `churn-single-${dataset.name}-${engine}`)
          await run({ action: 'churn', dataset, engine, arm: ARMS.find(arm => arm.engine === engine && arm.mode === 'exact'), writeStyle: 'single', store, oracle })
        }
        for (const arm of ARMS.filter(arm => arm.mode === 'exact' || dataset.rows >= 4096)) {
          const store = await copy(dataset, arm.engine, `churn-batch-${dataset.name}-${arm.name}`)
          await run({ action: 'churn', dataset, engine: arm.engine, arm, writeStyle: 'batch', store, oracle })
          await run({ action: 'reopen', dataset, engine: arm.engine, arm, state: 'churn', store, oracle })
        }
      }
      const dataset = frozen.datasets[0]
      for (const engine of ['vectra', 'warm']) for (const boundary of ['operation-return-before-controller-ack', 'ack-before-flush', 'after-flush']) {
        const store = await copy(dataset, engine, `crash-${engine}-${boundary}`)
        const stopped = await run({ action: 'crash-write', dataset, engine, store, boundary }, boundary)
        if (stopped.stop?.kind === 'planned-process-interruption') await run({ action: 'crash-reopen', dataset, engine, store, boundary })
        else assert.ok(engine === 'vectra' && boundary === 'after-flush' && stopped.events.some(event => event.boundary === 'after-flush-unsupported'), 'unexpected crash boundary outcome')
      }
    }
    const complete = receipts.every(item => item.result.complete || item.result.stop?.kind === 'planned-process-interruption')
    await writeOnce(path.join(root, `${phase}-finished.json`), { complete, receipts, noRetry: true })
    return { complete }
  } catch (error) {
    await writeOnce(path.join(root, `${phase}-finished.json`), { complete: false, error: { name: error.name, message: error.message }, receipts, noRetry: true })
    throw error
  }
}
async function records(file) { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
export function qualityGate(rows, exactRows, exact = false, expectedQueries = exactRows.map(row => row.query)) {
  const identities = items => {
    const ids = items.map(row => row.query), expected = new Set(expectedQueries)
    return expected.size === expectedQueries.length && ids.length === expected.size && new Set(ids).size === ids.length && ids.every(id => expected.has(id))
  }
  const identitiesPass = identities(rows) && identities(exactRows)
  const reference = new Map(exactRows.map(row => [row.query, row]))
  const recall = [], oracle = [], ndcg = [], qrel = []
  let missingReference = 0, missingMetrics = 0
  for (const row of rows) {
    const referenceRow = reference.get(row.query)
    if (!referenceRow || referenceRow.error || !referenceRow.correctness || row.error || row.eligibleCount !== referenceRow.eligibleCount) { missingReference++; continue }
    const value = recallAtK(row.hits.map(hit => hit.ordinal), referenceRow.hits.map(hit => hit.ordinal)); if (value !== null) recall.push(value)
    if (Number.isFinite(row.oracleRecall)) oracle.push(row.oracleRecall)
    else if (referenceRow.eligibleCount > 0) missingMetrics++
    if (referenceRow.qrel?.eligibleJudgments > 0 && (!Number.isFinite(row.qrel?.ndcg10) || !Number.isFinite(row.qrel?.recall10))) missingMetrics++
    if (row.qrel?.ndcg10 !== null && row.qrel?.ndcg10 !== undefined && referenceRow.qrel?.ndcg10 !== null && referenceRow.qrel?.ndcg10 !== undefined) { ndcg.push(row.qrel.ndcg10 - referenceRow.qrel.ndcg10); qrel.push(row.qrel.recall10 - referenceRow.qrel.recall10) }
  }
  const result = { queries: rows.length, emptyEligibleQueries: rows.filter(row => row.eligibleCount === 0).length, identitiesPass, missingReference, missingMetrics, meanRecallWarmExact: mean(recall), worstRecallWarmExact: recall.length ? Math.min(...recall) : null, meanRecallOracle: mean(oracle), worstRecallOracle: oracle.length ? Math.min(...oracle) : null, meanNdcgDelta: mean(ndcg), meanQrelRecallDelta: mean(qrel), queriesWithEligibleJudgments: ndcg.length, queriesWithoutEligibleJudgments: rows.filter(row => row.qrel?.eligibleJudgments === 0).length }
  result.basis = exact ? 'Exact per-query score and cutoff-boundary audit; recall differences within accepted ties are descriptive.' : 'ANN recall and relevance thresholds against full exact and independent oracle.'
  result.pass = rows.length > 0 && identitiesPass && !missingReference && !missingMetrics && rows.every(row => row.correctness) && (exact || ((!recall.length || (result.meanRecallWarmExact >= .99 && result.worstRecallWarmExact >= .90 && result.meanRecallOracle >= .99 && result.worstRecallOracle >= .90)) && (!ndcg.length || (result.meanNdcgDelta >= -.01 && result.meanQrelRecallDelta >= -.01))))
  return result
}
export async function summarize(root) {
  const frozen = await readJson(path.join(root, 'freeze.json')), phases = [], queries = [], other = []
  for (const phase of ['preparation', 'measurement']) {
    try {
      const receipt = await readJson(path.join(root, `${phase}-finished.json`)); phases.push({ phase, complete: receipt.complete, error: receipt.error })
      for (const entry of receipt.receipts) for (const row of await records(entry.job.output)) {
        const item = { dataset: entry.job.dataset.name, arm: entry.job.arm?.name, repetition: entry.job.repetition, action: entry.job.action, engine: entry.job.engine, ...row }
        if (row.type === 'query') queries.push(item); else if (['graph-unavailable', 'crash-recovery', 'worker-error', 'write', 'storage', 'stage'].includes(row.type)) other.push(item)
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; phases.push({ phase, complete: false, missing: true }) }
  }
  const quality = [], lifecycleQuality = [], timing = []
  for (const dataset of frozen.datasets) for (const filter of FILTERS) for (const arm of ARMS.filter(arm => arm.mode === 'exact' || dataset.rows >= 4096)) {
    const selected = queries.filter(row => row.dataset === dataset.name && row.filter === filter.name && row.arm === arm.name)
    const staticRows = selected.filter(row => row.action === 'quality')
    const exact = queries.filter(row => row.dataset === dataset.name && row.filter === filter.name && row.arm === 'warm-exact' && row.action === 'quality')
    const exactRoute = arm.mode === 'exact' || filter.name !== 'all'
    const allQueries = Array.from({ length: dataset.queryCount }, (_, i) => i)
    const gate = qualityGate(staticRows, exact, exactRoute, allQueries)
    quality.push({ dataset: dataset.name, filter: filter.name, arm: arm.name, ...gate, worstQueries: [...staticRows].sort((a, b) => (a.oracleRecall ?? 1) - (b.oracleRecall ?? 1)).slice(0, 20).map(row => ({ query: row.query, oracleRecall: row.oracleRecall, hits: row.hits, audit: row.audit, error: row.error })) })
    for (const phase of ['before-maintenance', 'after-maintenance', 'after-flush-separate-process-reopen-and-maintenance']) {
      const rows = selected.filter(row => row.phase === phase)
      const references = queries.filter(row => row.dataset === dataset.name && row.filter === filter.name && row.arm === 'warm-exact' && row.phase === phase)
      const lifecycle = qualityGate(rows, references, exactRoute || rows.every(row => row.route !== 'fullGraph'), allQueries)
      lifecycleQuality.push({ dataset: dataset.name, filter: filter.name, arm: arm.name, phase, ...lifecycle })
    }
    const samples = []
    for (let repetition = 0; repetition < 3; repetition++) {
      const rows = selected.filter(row => row.role === 'timing' && row.repetition === repetition), successful = rows.filter(row => !row.error && Number.isFinite(row.elapsedMs))
      const values = successful.map(row => row.elapsedMs); samples.push(...values)
      const stride = filter.name === 'all' ? 1 : dataset.name === 'scifact' ? 3 : 10
      const expectedQueries = Array.from({ length: Math.ceil(dataset.queryCount / stride) }, (_, i) => i * stride)
      const references = queries.filter(row => row.dataset === dataset.name && row.filter === filter.name && row.arm === 'warm-exact' && row.role === 'timing' && row.repetition === repetition)
      const quality = qualityGate(rows, references, exactRoute, expectedQueries)
      timing.push({ dataset: dataset.name, filter: filter.name, arm: arm.name, repetition, quality, ...latency(values), expectedQueries, queryIds: successful.map(row => row.query), errors: rows.filter(row => row.error).map(row => ({ query: row.query, elapsedMs: row.elapsedMs, error: row.error })), correctness: rows.every(row => row.correctness) && JSON.stringify(rows.map(row => row.query)) === JSON.stringify(expectedQueries), routeCounts: Object.fromEntries([...new Set(rows.map(row => row.route))].map(route => [route, rows.filter(row => row.route === route).length])) })
    }
    timing.push({ dataset: dataset.name, filter: filter.name, arm: arm.name, repetition: 'pooled', ...latency(samples) })
  }
  const advantage = []
  const globallyComplete = phases.length === 2 && phases.every(phase => phase.complete) && quality.every(row => row.pass) && lifecycleQuality.every(row => row.pass) && timing.filter(row => row.repetition !== 'pooled').every(row => row.correctness && row.quality.pass) && queries.every(row => row.correctness) && other.filter(row => ['graph-unavailable', 'crash-recovery'].includes(row.type)).every(row => row.pass) && !other.some(row => row.type === 'worker-error')
  for (const point of quality.filter(point => point.arm !== 'vectra-exact')) for (const baseline of ['vectra-exact', 'warm-exact'].filter(name => name !== point.arm)) {
    const comparisons = []
    for (let repetition = 0; repetition < 3; repetition++) {
      const match = item => item.dataset === point.dataset && item.filter === point.filter && item.repetition === repetition
      const arm = timing.find(item => match(item) && item.arm === point.arm), base = timing.find(item => match(item) && item.arm === baseline)
      const identicalSuccessfulQueries = JSON.stringify(arm.queryIds) === JSON.stringify(base.queryIds) && arm.count > 0
      comparisons.push({ repetition, identicalSuccessfulQueries, p50Ratio: arm.p50 / base.p50, p95Ratio: arm.p95 / base.p95, p99Ratio: arm.p99 / base.p99, pass: identicalSuccessfulQueries && !arm.errors.length && !base.errors.length && arm.correctness && base.correctness && arm.quality.pass && base.quality.pass && arm.p50 <= .9 * base.p50 && arm.p95 <= .9 * base.p95 && arm.p99 <= 1.05 * base.p99 })
    }
    advantage.push({ dataset: point.dataset, filter: point.filter, arm: point.arm, baseline, comparisons, qualified: globallyComplete && point.pass && comparisons.every(item => item.pass), interpretation: 'All three matched repetitions required; no best-run selection.' })
  }
  const result = { freezeHash: await sha256(path.join(root, 'freeze.json')), phases, globallyComplete, quality, lifecycleQuality, timing, advantage, queryRecords: queries.length, lifecycleAndResourceReceipts: other, unsupported: ['Native in-flight append interruption is not exposed through the Node harness; existing Rust mutation fault tests are separate evidence.', 'Vectra has no explicit fsync/flush barrier.', 'Page-cache state uncontrolled; process-cold is not disk-cold.'], performanceClaimPermitted: advantage.some(item => item.qualified) }
  await writeOnce(path.join(root, 'vector-summary.json'), result)
  return result
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, root, argument] = process.argv.slice(2)
  try {
    const result = action === 'freeze' ? await freeze(argument, root) : action === 'summarize' ? await summarize(root) : await runPhase(root, action, argument)
    console.log(JSON.stringify({ action, output: root, complete: result.complete ?? result.globallyComplete ?? true, preparationOnly: action === 'freeze' }))
    if (action === 'summarize' && !result.globallyComplete) process.exitCode = 1
  } catch (error) { console.error(error.stack); process.exitCode = 1 }
}
