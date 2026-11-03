// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { FILTERS, atLeast, latency, mean, recallAtK } from './oracle-vector.mjs'
import { hybridTimingSchedule, runHybridJob, compareHybridPair } from './hybrid-run.mjs'
import { LIMITS, exec, sha256, hashValue, manifest, packageFiles, storageReceipt, writeOnce, readJson, preflight, cloneStore, runMonitored, watchPhase } from './vector-receipts.mjs'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FILES = ['vector.mjs', 'vector-worker.mjs', 'vector-receipts.mjs', 'oracle-vector.mjs', 'test_vector.mjs', 'README-vector.md', 'hybrid-run.mjs', 'hybrid-worker.mjs', 'hybrid.mjs', 'hybrid-tokenizer.py', 'test_hybrid.mjs', 'README-hybrid.md', '../../../docs/research/technical-audit-20261029/vectra-comparison-20261102/PLAN.md', '../../../docs/research/technical-audit-20261029/vectra-comparison-followup-20261102/PLAN.md', '../../../docs/research/technical-audit-20261029/vectra-comparison-followup-20261102/IMPORT-AND-QUIET-HOST.md']
const THREAD_ENVIRONMENT = ['RAYON_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'UV_THREADPOOL_SIZE', 'TOKENIZERS_PARALLELISM']
const threadEnvironment = () => Object.fromEntries(THREAD_ENVIRONMENT.map(name => [name, process.env[name] ?? null]))
export function hostInfo() { return { platform: process.platform, release: os.release(), architecture: os.arch(), logicalCpus: os.cpus().length, cpuModels: [...new Set(os.cpus().map(cpu => cpu.model))], memoryBytes: os.totalmem() } }
export function verifyHost(expected, actual = hostInfo()) { assert.deepEqual(actual, expected, 'host changed after freeze') }
export function verifyGraphEnvironment(environment = process.env) {
  assert.ok(!Object.keys(environment).some(name => name.startsWith('WARM_QGRAPH_')), 'unset experimental graph environment knobs')
}
export const ARMS = Object.freeze([{ name: 'vectra-exact', engine: 'vectra', mode: 'exact' }, { name: 'warm-exact', engine: 'warm', mode: 'exact' }, ...[128, 256, 512, 2048].map(ef => ({ name: `warm-graph-${ef}`, engine: 'warm', mode: 'graph', ef })), { name: 'warm-graph-high-recall-512', engine: 'warm', mode: 'graph', ef: 512, highRecall: true }])
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
export async function dependencyInventory(lockfile) {
  const lock = await readJson(lockfile)
  assert.ok(lock.packages && lock.lockfileVersion >= 2, 'provide the actual npm package-lock with packages/integrities')
  const result = []
  for (const [relative, item] of Object.entries(lock.packages)) {
    if (!relative.includes('node_modules/')) continue
    const filename = path.join(path.dirname(lockfile), relative, 'package.json')
    let actual
    try { actual = await readJson(filename) }
    catch (error) { if (error.code !== 'ENOENT') throw error; assert.ok(item.optional || item.dev, `required dependency missing: ${relative}`); result.push({ path: relative, version: item.version, installed: false, optional: !!item.optional, dev: !!item.dev }); continue }
    assert.ok(!(await fs.lstat(path.dirname(filename))).isSymbolicLink(), `dependency symlink refused: ${relative}`)
    assert.equal(actual.version, item.version, `installed dependency differs from lock: ${relative}`)
    result.push({ path: relative, name: actual.name, version: actual.version, integrity: item.integrity ?? null, packageJsonSha256: await sha256(filename), files: await packageFiles(path.dirname(filename)) })
  }
  assert.ok(result.some(item => item.name === 'vectra' && item.version === '0.15.0'))
  return result
}
export async function pythonRuntime(uvPath, tokenizerPath) {
  assert.ok(path.isAbsolute(uvPath) && path.isAbsolute(tokenizerPath), 'absolute uv and tokenizer paths required')
  for (const name of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) assert.ok(!process.env[name], `unset ${name} for the frozen tokenizer runtime`)
  const code = `import json, os, platform, sys, hashlib, pathlib, resource, tokenizers
from tokenizers import Tokenizer
Tokenizer.from_file(sys.argv[1]).encode('synthetic freeze fixture')
files = sorted({os.path.realpath(m.__file__) for m in list(sys.modules.values()) if getattr(m, '__file__', None) and os.path.isfile(m.__file__)})
prefix = os.path.realpath(sys.prefix)
virtual = {os.path.relpath(f, prefix): hashlib.sha256(open(f, 'rb').read()).hexdigest() for f in files if os.path.commonpath([prefix, f]) == prefix}
files = [f for f in files if os.path.commonpath([prefix, f]) != prefix]
print(json.dumps({'executable': os.path.realpath(sys.executable), 'python': platform.python_version(), 'tokenizers': tokenizers.__version__, 'tokenizersRoot': os.path.realpath(os.path.dirname(tokenizers.__file__)), 'files': files, 'virtualFiles': virtual}))`
  const env = { ...process.env, HF_HUB_OFFLINE: '1', RAYON_NUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1' }
  const runtime = JSON.parse((await exec(uvPath, ['run', '--offline', '--no-project', '--with', 'tokenizers==0.23.3', 'python', '-c', code, tokenizerPath], { env, maxBuffer: 8 * 1024 ** 2 })).stdout)
  assert.equal(runtime.tokenizers, '0.23.3')
  const packageEntries = await packageFiles(runtime.tokenizersRoot)
  const paths = new Set([await fs.realpath(uvPath), runtime.executable, ...runtime.files, ...packageEntries.map(item => path.join(runtime.tokenizersRoot, item.path))])
  const artifacts = []
  for (const file of [...paths].sort()) artifacts.push({ path: file, sha256: await sha256(file) })
  return { executable: runtime.executable, python: runtime.python, tokenizers: runtime.tokenizers, tokenizersRoot: runtime.tokenizersRoot, virtualFiles: runtime.virtualFiles, artifacts }
}

export async function freeze(configuration, output) {
  verifyGraphEnvironment()
  assert.ok(!process.env.NODE_OPTIONS, 'unset NODE_OPTIONS for the pinned default worker runtime')
  assert.ok(path.isAbsolute(configuration) && path.isAbsolute(output), 'absolute freeze paths required')
  const config = await readJson(configuration)
  assert.ok(config.hybrid && typeof config.hybrid === 'object', 'combined hybrid configuration required')
  for (const key of ['plan', 'inputs', 'warmPath', 'nativeAddon', 'vectraPath', 'vectraLockfile', 'warmSourceCommit']) assert.equal(typeof config[key], 'string', `missing ${key}`)
  for (const key of ['plan', 'inputs', 'warmPath', 'nativeAddon', 'vectraPath', 'vectraLockfile']) assert.ok(path.isAbsolute(config[key]), `absolute ${key} required`)
  const source = (await exec('git', ['-C', config.warmPath, 'rev-parse', 'HEAD'])).stdout.trim()
  assert.equal(source, config.warmSourceCommit)
  assert.equal((await exec('git', ['-C', config.warmPath, 'status', '--porcelain', '--untracked-files=no'])).stdout.trim(), '', 'freeze requires clean integrated source')
  assert.equal((await readJson(path.join(config.vectraPath, 'package.json'))).version, '0.15.0')
  const loaded = JSON.parse((await exec(process.execPath, ['-e', "const b=require(process.argv[1]); console.log(JSON.stringify(Object.values(require.cache).filter(m=>m.filename.endsWith('.node')&&m.exports===b).map(m=>m.filename)))", path.join(config.warmPath, 'index.js')])).stdout)
  assert.equal(loaded.length, 1, 'native loader provenance must be unambiguous')
  assert.equal(await fs.realpath(loaded[0]), await fs.realpath(config.nativeAddon), 'configured addon is not the one selected by the public loader')
  const inputs = await readJson(config.inputs), verifiedInputs = await verifyInputs(inputs)
  assert.ok(path.isAbsolute(config.hybrid.uvPath ?? '') && path.isAbsolute(config.hybrid.tokenizerPath ?? ''), 'absolute hybrid runtime paths required')
  const uvPath = await fs.realpath(config.hybrid.uvPath), tokenizerPath = await fs.realpath(config.hybrid.tokenizerPath)
  const tokenizerSha256 = await sha256(tokenizerPath)
  assert.equal(tokenizerSha256, 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a', 'protocol tokenizer changed')
  const python = await pythonRuntime(uvPath, tokenizerPath)
  const scifactInput = await readJson(path.join(inputs.scifact.directory, 'input.json'))
  const hybridQueryIds = scifactInput.queries.map(query => query.id)
  assert.equal(hybridQueryIds.length, 300); assert.equal(new Set(hybridQueryIds).size, 300)
  const mappingManifest = path.resolve(path.dirname(config.inputs), inputs.scifact.mapping_manifest)
  assert.equal(await sha256(mappingManifest), inputs.scifact.mapping_manifest_sha256)
  const warmFiles = Object.fromEntries(await Promise.all(['vectra.js', 'vectra-selector.js', 'vectra.d.ts', 'index.js', 'index.d.ts', 'package.json', 'package-lock.json', 'Cargo.lock'].map(async file => [file, await sha256(path.join(config.warmPath, file))])))
  const frozen = { version: 1, preparationOnlyUntilExplicitGrant: true, createdAtUtc: new Date().toISOString(), ...config, source, runtime: { executable: process.execPath, version: process.version, sha256: await sha256(process.execPath) }, sourceFiles: warmFiles, nativeSha256: await sha256(config.nativeAddon), vectra: await manifest(config.vectraPath), dependencyLockSha256: await sha256(config.vectraLockfile), dependencyInventory: await dependencyInventory(config.vectraLockfile), protocolSha256: await sha256(config.plan), inputManifestSha256: await sha256(config.inputs), inputIdentity: hashValue(verifiedInputs), verifiedInputs, driver: await driverHashes(), datasets: datasets(inputs), limits: LIMITS, queryOrder: 'source ordinal; no query randomization', seed: 20261102, nativeGraphSeed: 'pinned engine defaults; no seed tuning', arms: ARMS, filters: FILTERS, repetitions: 3, host: hostInfo(), durationCeilingNote: 'No duration estimate from development timings; coordinator must reject any projected execution exceeding fixed phase budgets before granting execution.' }
  frozen.timingSchedule = timingSchedule(frozen.datasets)
  frozen.driverSource = (await exec('git', ['-C', HERE, 'rev-parse', 'HEAD'])).stdout.trim()
  assert.equal((await exec('git', ['-C', HERE, 'status', '--porcelain', '--', ...FILES])).stdout.trim(), '', 'commit the harness before freezing')
  frozen.threadEnvironment = threadEnvironment()
  frozen.storeCopy = 'Exclusive fresh directory; fs.cp COPYFILE_FICLONE requests copy-on-write, falls back to byte copy; lock files omitted. Per-file allocated blocks may be shared across clones and are not a summed physical footprint.'
  const hybridFreeze = { authorized: true, allowedPhases: ['prepare', 'quality', 'timing'], inputManifestSha256: await sha256(config.inputs), workerSha256: await sha256(path.join(HERE, 'hybrid-worker.mjs')), helperSha256: await sha256(path.join(HERE, 'hybrid.mjs')), tokenizerBridgeSha256: await sha256(path.join(HERE, 'hybrid-tokenizer.py')), nodeVersion: process.version, modulePaths: { warm: config.warmPath, vectra: config.vectraPath }, nativeAddonPath: config.nativeAddon, nativeAddonSha256: frozen.nativeSha256, uvPath, tokenizerPath, tokenizerSha256, pythonRuntime: { executable: python.executable, python: python.python, tokenizersRoot: python.tokenizersRoot, virtualFiles: python.virtualFiles }, artifacts: python.artifacts }
  frozen.hybrid = { uvPath, tokenizerPath, tokenizerSha256, queryIds: hybridQueryIds, timingSchedule: hybridTimingSchedule() }
  await fs.mkdir(output) // Deliberately no recursive/overwrite/resume semantics.
  await writeOnce(path.join(output, 'hybrid-freeze.json'), hybridFreeze)
  frozen.hybridFreezeHash = await sha256(path.join(output, 'hybrid-freeze.json'))
  await writeOnce(path.join(output, 'freeze.json'), frozen)
  await writeOnce(path.join(output, 'freeze-receipt.json'), { freezeHash: await sha256(path.join(output, 'freeze.json')), noMeasurementExecuted: true })
  return frozen
}
export async function verifyFreeze(root) {
  verifyGraphEnvironment()
  for (const name of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV']) assert.ok(!process.env[name], `unset ${name} for the frozen tokenizer runtime`)
  assert.ok(!process.env.NODE_OPTIONS, 'unset NODE_OPTIONS for the pinned default worker runtime')
  const file = path.join(root, 'freeze.json'), frozen = await readJson(file), receipt = await readJson(path.join(root, 'freeze-receipt.json'))
  assert.equal(await sha256(file), receipt.freezeHash)
  assert.equal(await sha256(path.join(root, 'hybrid-freeze.json')), frozen.hybridFreezeHash)
  assert.equal(await sha256(frozen.hybrid.tokenizerPath), frozen.hybrid.tokenizerSha256)
  for (const artifact of (await readJson(path.join(root, 'hybrid-freeze.json'))).artifacts) assert.equal(await sha256(artifact.path), artifact.sha256)
  assert.deepEqual(await driverHashes(), frozen.driver, 'driver changed after freeze')
  assert.deepEqual(threadEnvironment(), frozen.threadEnvironment, 'thread configuration changed after freeze')
  verifyHost(frozen.host)
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
  const receipt = await readJson(path.join(root, 'freeze-receipt.json')), grant = await readJson(grantPath)
  assert.equal(grant.freezeHash, receipt.freezeHash); assert.equal(grant.phase, phase); assert.equal(grant.approved, true)
  assert.ok(typeof grant.coordinator === 'string' && grant.coordinator && !Number.isNaN(Date.parse(grant.approvedAtUtc)))
  await writeOnce(path.join(root, `${phase}-started.json`), { grant, startedAtUtc: new Date().toISOString(), noRetry: true })
  return { grant, freezeHash: receipt.freezeHash }
}
export async function runPhase(root, phase, grantPath) {
  assert.ok(['preparation', 'measurement'].includes(phase))
  const deadline = Date.now() + (phase === 'preparation' ? LIMITS.preparationMs : LIMITS.measurementMs)
  const { grant } = await admission(root, phase, grantPath)
  const hostFile = path.join(root, `${phase}-host.ndjson`)
  const receipts = [], hybridReceipts = [], config = path.join(root, 'freeze.json'), worker = path.join(HERE, 'vector-worker.mjs')
  let serial = 0, frozen = null, watcher = watchPhase(hostFile, deadline, false)
  const run = async (job, killBoundary = null) => {
    watcher?.check()
    const id = `${phase}-${String(serial++).padStart(4, '0')}-${job.dataset.name}-${job.engine ?? 'oracle'}-${job.action}`
    const output = path.join(root, 'results', `${id}.ndjson`), jobFile = path.join(root, 'jobs', `${id}.json`), receipt = path.join(root, 'receipts', `${id}.json`)
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(path.dirname(receipt), { recursive: true })
    const result = await runMonitored({ worker, job: { ...job, config, output }, jobFile, receipt, hostFile, deadline, quiet: phase === 'measurement', killBoundary, signal: watcher?.signal })
    receipts.push({ id, job: { ...job, config, output }, receipt, result })
    watcher?.check()
    if (!result.resourceQualified) throw new Error(`phase incomplete: ${result.stop?.kind}`)
    return result
  }
  const runHybrid = async (job) => {
    watcher?.check()
    const id = `${phase}-hybrid-${String(serial++).padStart(4, '0')}-${job.engine}-${job.phase}`
    const output = path.join(root, 'results', `${id}.json`), jobFile = path.join(root, 'jobs', `${id}.json`), receipt = path.join(root, 'receipts', `${id}.json`)
    await fs.mkdir(path.dirname(output), { recursive: true }); await fs.mkdir(path.dirname(receipt), { recursive: true })
    const payload = { ...job, purpose: 'frozen-study', development: false, output, inputManifest: frozen.inputs, freezePath: path.join(root, 'hybrid-freeze.json'), freezeSha256: frozen.hybridFreezeHash, modulePath: job.engine === 'warm' ? frozen.warmPath : frozen.vectraPath, uvPath: frozen.hybrid.uvPath, tokenizerPath: frozen.hybrid.tokenizerPath, tokenizerSha256: frozen.hybrid.tokenizerSha256 }
    if (job.phase === 'timing') Object.assign(payload, { admissionPath: path.join(root, 'hybrid-measurement-grant.json'), admissionSha256: await sha256(path.join(root, 'hybrid-measurement-grant.json')), preflightPath: path.join(root, 'hybrid-measurement-preflight.json'), preflightSha256: await sha256(path.join(root, 'hybrid-measurement-preflight.json')) })
    const result = await runHybridJob({ job: payload, jobFile, receipt, hostFile, deadline, quiet: phase === 'measurement', signal: watcher?.signal })
    const entry = { id, job: payload, receipt, result }
    hybridReceipts.push(entry)
    watcher?.check()
    assert.ok(result.complete && result.resourceQualified, `hybrid job incomplete: ${id}`)
    entry.storage = await storageReceipt(job.store)
    watcher?.check()
    return result
  }
  const hybridFixture = engine => path.join(root, 'hybrid-fixtures', engine)
  const hybridCopy = async (engine, name) => { watcher?.check(); const destination = path.join(root, 'hybrid-stores', name); await fs.mkdir(path.dirname(destination), { recursive: true }); await cloneStore(root, hybridFixture(engine), destination); watcher?.check(); return destination }
  const fixture = (dataset, engine, highRecall = false) => path.join(root, 'fixtures', dataset.name, highRecall ? `${engine}-high-recall` : engine)
  const copy = async (dataset, engine, name, highRecall = false) => { watcher?.check(); const destination = path.join(root, 'stores', name); await fs.mkdir(path.dirname(destination), { recursive: true }); await cloneStore(root, fixture(dataset, engine, highRecall), destination); watcher?.check(); return destination }
  try {
    frozen = (await verifyFreeze(root)).frozen
    watcher.check()
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
        if (dataset.rows >= 4096) {
          const store = fixture(dataset, 'warm', true)
          assert.ok((await run({ action: 'prepare', dataset, engine: 'warm', highRecall: true, store })).complete, 'high-recall import failed')
          assert.ok((await run({ action: 'validate', dataset, engine: 'warm', store })).complete, 'high-recall reopen validation failed')
        }
        const oraclePath = (await readJson(path.join(root, 'oracles', `${dataset.name}.json`))).output
        for (const arm of ARMS) {
          const store = await copy(dataset, arm.engine, `quality-${dataset.name}-${arm.name}`, !!arm.highRecall && dataset.rows >= 4096)
          await run({ action: arm.mode === 'graph' && dataset.rows < 4096 ? 'unavailable' : 'quality', dataset, engine: arm.engine, arm, store, oracle: oraclePath })
        }
      }
      for (const engine of ['vectra', 'warm']) {
        const store = hybridFixture(engine); await fs.mkdir(path.dirname(store), { recursive: true })
        await runHybrid({ phase: 'prepare', engine, store })
        await runHybrid({ phase: 'quality', engine, store: await hybridCopy(engine, `quality-${engine}`) })
      }
    } else {
      const preparation = await readJson(path.join(root, 'preparation-finished.json')); assert.equal(preparation.complete, true, 'preparation incomplete')
      const qualification = await preparationGate(frozen, preparation.receipts)
      const hybridQualification = await hybridPreparationGate(frozen, preparation.hybridReceipts ?? [])
      await writeOnce(path.join(root, 'measurement-preparation-gate.json'), { ...qualification, hybrid: hybridQualification })
      assert.ok(qualification.pass && hybridQualification.pass, 'preparation correctness incomplete; no query timings collected')
      const quiet = await preflight(hostFile); await writeOnce(path.join(root, 'measurement-preflight.json'), quiet)
      if (!quiet.pass) throw new Error('preflight failed; no query timings collected')
      watcher.check()
      watcher.setQuiet(true)
      await writeOnce(path.join(root, 'hybrid-measurement-grant.json'), { freezeHash: frozen.hybridFreezeHash, phase: 'measurement', approved: true, coordinator: grant.coordinator, approvedAtUtc: grant.approvedAtUtc })
      await writeOnce(path.join(root, 'hybrid-measurement-preflight.json'), { ...quiet, freezeHash: frozen.hybridFreezeHash })
      for (const dataset of frozen.datasets) for (let repetition = 0; repetition < 3; repetition++) for (const engine of ['vectra', 'warm']) {
        const store = await copy(dataset, engine, `cold-${dataset.name}-${engine}-${repetition}`), oracle = (await readJson(path.join(root, 'oracles', `${dataset.name}.json`))).output
        await run({ action: 'cold', dataset, engine, arm: ARMS.find(arm => arm.engine === engine && arm.mode === 'exact'), repetition, store, oracle })
      }
      for (const scheduled of frozen.timingSchedule) {
        const dataset = frozen.datasets.find(dataset => dataset.name === scheduled.dataset), arm = ARMS.find(arm => arm.name === scheduled.arm)
        const store = await copy(dataset, arm.engine, `timing-${dataset.name}-${arm.name}-${scheduled.filter}-${scheduled.repetition}`, !!arm.highRecall), oracle = (await readJson(path.join(root, 'oracles', `${dataset.name}.json`))).output
        await run({ action: 'timing', dataset, engine: arm.engine, arm, filter: scheduled.filter, repetition: scheduled.repetition, store, oracle })
      }
      for (const scheduled of frozen.hybrid.timingSchedule) {
        const store = await hybridCopy(scheduled.engine, `timing-${scheduled.engine}-${scheduled.repetition}`)
        await runHybrid({ phase: 'timing', engine: scheduled.engine, repetition: scheduled.repetition, store })
      }
      for (const dataset of frozen.datasets) {
        const oracle = (await readJson(path.join(root, 'oracles', `${dataset.name}.json`))).output
        for (const engine of ['vectra', 'warm']) {
          const store = await copy(dataset, engine, `churn-single-${dataset.name}-${engine}`)
          await run({ action: 'churn', dataset, engine, arm: ARMS.find(arm => arm.engine === engine && arm.mode === 'exact'), writeStyle: 'single', store, oracle })
        }
        for (const arm of ARMS.filter(arm => arm.mode === 'exact' || dataset.rows >= 4096)) {
          const store = await copy(dataset, arm.engine, `churn-batch-${dataset.name}-${arm.name}`, !!arm.highRecall)
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
    watcher?.check()
    await watcher?.stop()
    watcher?.check()
    const complete = receipts.every(item => item.result.complete || item.result.stop?.kind === 'planned-process-interruption') && hybridReceipts.every(item => item.result.complete)
    await writeOnce(path.join(root, `${phase}-finished.json`), { complete, receipts, hybridReceipts, noRetry: true })
    return { complete }
  } catch (error) {
    await watcher?.stop()
    await writeOnce(path.join(root, `${phase}-finished.json`), { complete: false, error: { name: error.name, message: error.message }, receipts, hybridReceipts, noRetry: true })
    throw error
  }
}
async function records(file) { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
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
  result.pass = rows.length > 0 && identitiesPass && !missingReference && !missingMetrics && rows.every(row => row.correctness) && (exact || ((!recall.length || (atLeast(result.meanRecallWarmExact, .99) && atLeast(result.worstRecallWarmExact, .90) && atLeast(result.meanRecallOracle, .99) && atLeast(result.worstRecallOracle, .90))) && (!ndcg.length || (atLeast(result.meanNdcgDelta, -.01) && atLeast(result.meanQrelRecallDelta, -.01)))))
  return result
}
export async function preparationGate(frozen, entries) {
  const queries = [], errors = [], unavailable = []
  for (const entry of entries) {
    if (!entry.result?.complete) errors.push({ job: entry.id, kind: 'incomplete-job' })
    for (const row of await records(entry.job.output)) {
      const item = { dataset: entry.job.dataset.name, arm: entry.job.arm?.name, action: entry.job.action, ...row }
      if (row.type === 'query' && entry.job.action === 'quality') queries.push(item)
      if (row.type === 'worker-error') errors.push({ job: entry.id, kind: 'worker-error' })
      if (row.type === 'graph-unavailable') unavailable.push(item)
    }
  }
  const gates = []
  for (const dataset of frozen.datasets) {
    for (const arm of ARMS.filter(arm => arm.mode === 'graph' && dataset.rows < 4096)) {
      const rows = unavailable.filter(row => row.dataset === dataset.name && row.arm === arm.name)
      if (rows.length !== 1 || !rows[0].pass) errors.push({ dataset: dataset.name, arm: arm.name, kind: 'unavailable-graph' })
    }
    const expected = Array.from({ length: dataset.queryCount }, (_, i) => i)
    for (const filter of FILTERS) for (const arm of ARMS.filter(arm => arm.mode === 'exact' || dataset.rows >= 4096)) {
      const rows = queries.filter(row => row.dataset === dataset.name && row.filter === filter.name && row.arm === arm.name)
      const exact = queries.filter(row => row.dataset === dataset.name && row.filter === filter.name && row.arm === 'warm-exact')
      gates.push({ dataset: dataset.name, filter: filter.name, arm: arm.name, ...qualityGate(rows, exact, true, expected) })
    }
  }
  return { pass: !errors.length && gates.length > 0 && gates.every(gate => gate.pass), errors, gates, note: 'Admission checks completeness, routes, payloads and exact audits. ANN recall and relevance thresholds remain reported by the final quality gates.' }
}

export async function hybridPreparationGate(frozen, entries) {
  const errors = [], engineErrors = []
  for (const engine of ['vectra', 'warm']) for (const phase of ['prepare', 'quality']) {
    const selected = entries.filter(entry => entry.job.engine === engine && entry.job.phase === phase)
    if (selected.length !== 1) { errors.push({ engine, phase, kind: 'missing-or-duplicate-job' }); continue }
    const entry = selected[0]
    try {
      assert.equal(entry.result.complete, true)
      const result = await readJson(entry.job.output)
      assert.equal(result.complete, true); assert.equal(result.engine, engine); assert.equal(result.phase, phase)
      if (phase === 'quality') {
        assert.equal(result.freezeSha256, frozen.hybridFreezeHash)
        for (const filter of ['all', 'ten-percent', 'one-percent', 'empty']) {
          const rows = result.observations.filter(row => !row.warmup && row.eligibility === filter)
          assert.deepEqual(rows.map(row => row.queryId), frozen.hybrid.queryIds, 'incomplete hybrid quality identities')
          engineErrors.push(...rows.filter(row => row.engineError).map(row => ({ engine, filter, queryId: row.queryId, error: row.engineError })))
        }
      }
    } catch (error) { errors.push({ engine, phase, kind: 'incomplete-job', message: error.message }) }
  }
  return { pass: errors.length === 0, errors, engineErrors, note: 'Every expected quality query must be recorded; recorded engine errors remain failures in hybrid qualification.' }
}

export async function hybridSummary(frozen, entries) {
  const eligibility = ['all', 'ten-percent', 'one-percent', 'empty'], jobs = [], errors = []
  for (const entry of entries) {
    try {
      assert.equal(entry.result.complete, true)
      assert.ok(entry.storage && Array.isArray(entry.storage.files) && Number.isFinite(entry.storage.logicalBytes) && Number.isFinite(entry.storage.allocatedBytes), 'missing hybrid storage accounting')
      const result = await readJson(entry.job.output)
      assert.equal(result.complete, true); assert.equal(result.engine, entry.job.engine); assert.equal(result.phase, entry.job.phase)
      if (entry.job.phase === 'timing') assert.equal(result.repetition, entry.job.repetition)
      if (entry.job.phase !== 'prepare') assert.equal(result.freezeSha256, frozen.hybridFreezeHash)
      jobs.push(result)
    } catch (error) { errors.push({ job: entry.id, message: error.message }) }
  }
  const find = (phase, engine, repetition) => jobs.filter(job => job.phase === phase && job.engine === engine && (phase !== 'timing' || job.repetition === repetition))
  const paired = (phase, filter, repetition) => {
    const vectra = find(phase, 'vectra', repetition), warm = find(phase, 'warm', repetition)
    if (vectra.length !== 1 || warm.length !== 1) return { complete: false, error: 'missing or duplicate hybrid jobs', repetitionPass: false }
    const expected = phase === 'timing' && filter !== 'all' ? frozen.hybrid.queryIds.filter((_, i) => i % 3 === 0) : frozen.hybrid.queryIds
    try { return compareHybridPair(vectra[0], warm[0], filter, expected) }
    catch (error) { return { complete: false, error: error.message, repetitionPass: false } }
  }
  const quality = eligibility.map(filter => ({ filter, ...paired('quality', filter) }))
  const timing = eligibility.flatMap(filter => [0, 1, 2].map(repetition => ({ filter, repetition, ...paired('timing', filter, repetition) })))
  const advantage = eligibility.map(filter => {
    const reference = quality.find(row => row.filter === filter), repetitions = timing.filter(row => row.filter === filter)
    return { filter, qualified: reference.complete && Object.values(reference.quality).every(metric => metric.pass) && repetitions.length === 3 && repetitions.every(row => row.repetitionPass) }
  })
  return { complete: !errors.length && ['vectra', 'warm'].every(engine => find('prepare', engine).length === 1) && quality.every(row => row.complete) && timing.every(row => row.complete), errors, quality, timing, advantage, storage: entries.map(entry => ({ id: entry.id, engine: entry.job.engine, phase: entry.job.phase, repetition: entry.job.repetition, storage: entry.storage ?? null })) }
}

export async function summarize(root) {
  const frozen = await readJson(path.join(root, 'freeze.json')), phases = [], queries = [], other = [], hybridEntries = []
  for (const phase of ['preparation', 'measurement']) {
    try {
      const receipt = await readJson(path.join(root, `${phase}-finished.json`)); phases.push({ phase, complete: receipt.complete, error: receipt.error })
      hybridEntries.push(...(receipt.hybridReceipts ?? []))
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
  const hybrid = frozen.hybrid ? await hybridSummary(frozen, hybridEntries) : null
  const advantage = []
  const globallyComplete = (!hybrid || hybrid.complete) && phases.length === 2 && phases.every(phase => phase.complete) && quality.every(row => row.pass) && lifecycleQuality.every(row => row.pass) && timing.filter(row => row.repetition !== 'pooled').every(row => row.correctness && row.quality.pass) && queries.every(row => row.correctness) && other.filter(row => ['graph-unavailable', 'crash-recovery'].includes(row.type)).every(row => row.pass) && !other.some(row => row.type === 'worker-error')
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
  const result = { freezeHash: await sha256(path.join(root, 'freeze.json')), phases, globallyComplete, quality, lifecycleQuality, timing, advantage, hybrid, queryRecords: queries.length, lifecycleAndResourceReceipts: other, unsupported: ['Native in-flight append interruption is not exposed through the Node harness; existing Rust mutation fault tests are separate evidence.', 'Vectra has no explicit fsync/flush barrier.', 'Page-cache state uncontrolled; process-cold is not disk-cold.'], performanceClaimPermitted: advantage.some(item => item.qualified) || (globallyComplete && !!hybrid && hybrid.advantage.some(item => item.qualified)) }
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
