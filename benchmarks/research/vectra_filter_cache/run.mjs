// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloneStore, exec, manifest, readJson, runMonitored, sha256, watchPhase, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../..'), root = process.argv[2]
assert.ok(process.argv[3] === undefined || process.argv[3] === '--native-filter', 'unknown diagnostic mode')
const nativeFilter = process.argv[3] === '--native-filter'
assert.ok(path.isAbsolute(root ?? ''), 'new absolute output directory required')
assert.equal(process.env.NODE_OPTIONS, undefined, 'unset NODE_OPTIONS')
assert.ok(!Object.keys(process.env).some(name => name.startsWith('WARM_QGRAPH_')), 'unset experimental graph environment knobs')
const fixture = '/Volumes/A/.hms-bench-cache/vectra-comparison-followup-20261102-v1/fixtures/glove-100000/warm'
const input = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/inputs.json'))
const dataset = { name: 'glove-100000', rows: 100000, dimensions: 100, queryCount: 1000, corpus: path.join(input.glove.directory, 'train.f32'), queries: path.join(input.glove.directory, 'test.f32') }
assert.equal(await sha256(dataset.corpus), input.glove.files['train.f32'].sha256)
assert.equal(await sha256(dataset.queries), input.glove.files['test.f32'].sha256)
const identity = tree => tree.files.filter(file => path.basename(file.path) !== '.hms.lock').map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
await fs.mkdir(root)
const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
const baselineSource = nativeFilter ? '/Volumes/A/.hms-bench-cache/warm-filter-cache-compare-20261102-v1/package-candidate/vectra.js' : `${sourceCommit}:vectra.js`
if (nativeFilter) assert.equal(await sha256(baselineSource), '8e4e2b7bc76cf63d98ec1d9e6f3770b9d0e072473202e43e336ce7185b759846')
const baseline = nativeFilter ? await fs.readFile(baselineSource, 'utf8') : (await exec('git', ['show', baselineSource], { cwd: repo })).stdout
const artifacts = [[nativeFilter ? 'NATIVE-PLAN.md' : 'PLAN.md', 'PLAN.md'], ['run.mjs', 'run.mjs'], ['worker.mjs', 'worker.mjs'], ['../../public/vectra_comparison/vector-worker.mjs', 'harness/vector-worker.mjs'], ['../../public/vectra_comparison/oracle-vector.mjs', 'harness/oracle-vector.mjs'], ['../../public/vectra_comparison/vector-receipts.mjs', 'harness/vector-receipts.mjs']]
if (nativeFilter) for (const source of ['src/core/vector_records.rs', 'src/core/vector_records/vectra_filter.rs', 'src/core/engine/vector_records.rs', 'src/core/documents/index.rs', 'src/bindings/node/api.rs', 'Cargo.toml', 'Cargo.lock']) artifacts.push([`../../../${source}`, `sources/${source}`])
const sourceHashes = {}
for (const [source, name] of artifacts) { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(here, source), target, fs.constants.COPYFILE_EXCL); sourceHashes[name] = await sha256(target) }
for (const mode of ['baseline', 'candidate']) {
  const packagePath = path.join(root, `package-${mode}`); await fs.mkdir(packagePath)
  for (const name of ['index.js', 'vectra-selector.js', 'warm-sdk.node']) await fs.copyFile(path.join(repo, name), path.join(packagePath, name), fs.constants.COPYFILE_EXCL)
  if (mode === 'baseline') await fs.writeFile(path.join(packagePath, 'vectra.js'), baseline, { flag: 'wx' })
  else await fs.copyFile(path.join(repo, 'vectra.js'), path.join(packagePath, 'vectra.js'), fs.constants.COPYFILE_EXCL)
}
const packageHashes = {}
for (const mode of ['baseline', 'candidate']) {
  packageHashes[mode] = {}
  for (const name of ['index.js', 'vectra-selector.js', 'warm-sdk.node', 'vectra.js']) packageHashes[mode][name] = await sha256(path.join(root, `package-${mode}`, name))
}
assert.notEqual(packageHashes.baseline['vectra.js'], packageHashes.candidate['vectra.js'])
for (const name of ['index.js', 'vectra-selector.js', 'warm-sdk.node']) assert.equal(packageHashes.baseline[name], packageHashes.candidate[name])
const frozen = { sourceCommit, baselineSource, nativeFilter, sourceHashes, packageHashes, fixture, dataset, datasetHashes: { corpus: await sha256(dataset.corpus), queries: await sha256(dataset.queries) }, node: process.version, executable: process.execPath, nodeSha256: await sha256(process.execPath), modes: ['baseline', 'candidate'], schedule: Array.from({ length: 10 }, (_, i) => i % 2), deadlineMs: 7_200_000, scope: 'Alternating filters on exposed data; shared-host development, not a frozen study or performance-advantage claim.' }
await writeOnce(path.join(root, 'started.json'), frozen)
const deadline = Date.now() + frozen.deadlineMs, hostFile = path.join(root, 'host.ndjson'), watcher = watchPhase(hostFile, deadline, false)
const results = []
let failure, sourceTree
try {
  sourceTree = identity(await manifest(fixture))
  for (const mode of frozen.modes) {
    watcher.check()
    const store = path.join(root, `store-${mode}`), packagePath = path.join(root, `package-${mode}`)
    await cloneStore(root, fixture, store)
    assert.deepEqual(identity(await manifest(store)), sourceTree, 'fixture copy changed')
    const stem = path.join(root, mode), output = `${stem}.ndjson`
    const job = { development: true, package: packagePath, addon: path.join(packagePath, 'warm-sdk.node'), store, dataset, output }
    const receipt = await runMonitored({ worker: path.join(here, 'worker.mjs'), job, jobFile: `${stem}-job.json`, receipt: `${stem}-receipt.json`, hostFile, deadline, signal: watcher.signal, environment: { RAYON_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } })
    assert.ok(receipt.complete, `incomplete ${mode} worker`)
    const rows = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse), queries = rows.filter(row => row.type === 'query')
    assert.equal(queries.length, 10); assert.equal(rows.at(-1).type, 'complete')
    queries.forEach((row, i) => { assert.equal(row.ordinal, i); assert.equal(row.bucket, i % 2); assert.equal(row.audit.pass, true); assert.ok(Number.isSafeInteger(row.elapsedNs) && row.elapsedNs >= 0); assert.equal(row.pageCalls, nativeFilter ? (mode === 'baseline' && i < 2 ? 100 : 0) : (mode === 'baseline' || i < 2 ? 100 : 0)) })
    assert.equal(rows.at(-1).calls, nativeFilter ? (mode === 'baseline' ? 200 : 0) : (mode === 'baseline' ? 1000 : 200))
    results.push({ mode, output, outputSha256: await sha256(output), receipt, queries })
  }
  assert.deepEqual(results[0].queries.map(row => row.resultHash), results[1].queries.map(row => row.resultHash), 'result payloads differ')
  assert.deepEqual(identity(await manifest(fixture)), sourceTree, 'source fixture changed')
} catch (error) { failure = { name: error.name, message: error.message } }
finally { await watcher.stop() }
const host = Object.fromEntries(results.map(row => [row.receipt.pid, { mode: row.mode, samples: 0, maxExternalCpuFraction: 0, samplesAbove20Percent: 0 }]))
try {
  for await (const line of readline.createInterface({ input: createReadStream(hostFile) })) {
    const row = JSON.parse(line), summary = host[row.workerPid]
    if (row.type !== 'worker-resource' || !summary) continue
    assert.ok(Number.isFinite(row.externalCpuFraction) && row.externalCpuFraction >= 0)
    summary.samples++; summary.maxExternalCpuFraction = Math.max(summary.maxExternalCpuFraction, row.externalCpuFraction)
    if (row.externalCpuFraction > .20) summary.samplesAbove20Percent++
  }
  for (const item of Object.values(host)) assert.ok(item.samples > 0, 'missing host observation')
} catch (error) { failure ??= { name: error.name, message: error.message } }
await writeOnce(path.join(root, 'finished.json'), { ...frozen, complete: !failure && !watcher.failure, failure: failure ?? watcher.failure ?? null, sourceTree, results, host })
if (failure || watcher.failure) throw new Error(`filter cache diagnostic incomplete: ${JSON.stringify(failure ?? watcher.failure)}`)
