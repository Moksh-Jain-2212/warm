// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cloneStore, exec, manifest, readJson, runMonitored, sha256, watchPhase, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../..'), root = process.argv[2]
assert.ok(path.isAbsolute(root ?? ''), 'new absolute output directory required')
assert.equal(process.env.NODE_OPTIONS, undefined, 'unset NODE_OPTIONS')
assert.ok(!Object.keys(process.env).some(name => name.startsWith('WARM_QGRAPH_')), 'unset experimental graph environment knobs')
const fixture = '/Volumes/A/.hms-bench-cache/vectra-comparison-followup-20261102-v1/fixtures/glove-100000/warm'
const input = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/inputs.json'))
const stop = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/user-stop-receipt.json'))
const dataset = { name: 'glove-100000', rows: 100000, dimensions: 100, queryCount: 1000, corpus: path.join(input.glove.directory, 'train.f32'), queries: path.join(input.glove.directory, 'test.f32') }
assert.equal(await sha256(dataset.corpus), input.glove.files['train.f32'].sha256); assert.equal(await sha256(dataset.queries), input.glove.files['test.f32'].sha256)
const oracleRecord = stop.trees.results.files.find(file => file.path.endsWith('glove-100000-oracle-oracle.ndjson'))
assert.ok(oracleRecord)
const oracle = path.join('/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen/results', oracleRecord.path)
assert.equal(await sha256(oracle), oracleRecord.sha256)
const identity = tree => tree.files.filter(file => path.basename(file.path) !== '.hms.lock').map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
await fs.mkdir(root)
const packagePath = path.join(root, 'package'); await fs.mkdir(packagePath)
const packageHashes = {}
for (const name of ['index.js', 'vectra.js', 'vectra-selector.js', 'warm-sdk.node']) {
  const target = path.join(packagePath, name); await fs.copyFile(path.join(repo, name), target, fs.constants.COPYFILE_EXCL); packageHashes[name] = await sha256(target)
}
const artifacts = [['LIMIT-PLAN.md', 'LIMIT-PLAN.md'], ['limit-run.mjs', 'limit-run.mjs'], ['limit-worker.mjs', 'limit-worker.mjs'], ['../../public/vectra_comparison/vector-worker.mjs', 'harness/vector-worker.mjs'], ['../../public/vectra_comparison/oracle-vector.mjs', 'harness/oracle-vector.mjs'], ['../../public/vectra_comparison/vector-receipts.mjs', 'harness/vector-receipts.mjs']]
const sourceHashes = {}
for (const [source, name] of artifacts) { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(here, source), target, fs.constants.COPYFILE_EXCL); sourceHashes[name] = await sha256(target) }
const frozen = { sourceCommit: (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim(), packageHashes, sourceHashes, fixture, dataset, oracle, oracleSha256: oracleRecord.sha256, datasetHashes: { corpus: await sha256(dataset.corpus), queries: await sha256(dataset.queries) }, node: process.version, executable: process.execPath, nodeSha256: await sha256(process.execPath), counts: [99999, 100000, 100001], deadlineMs: 7_200_000, scope: 'Local ID-count boundary and exact-oracle correctness on a clone; no timing or frozen study.' }
await writeOnce(path.join(root, 'started.json'), frozen)
const deadline = Date.now() + frozen.deadlineMs, hostFile = path.join(root, 'host.ndjson'), watcher = watchPhase(hostFile, deadline, false)
let failure, result, sourceTree
try {
  sourceTree = identity(await manifest(fixture))
  const store = path.join(root, 'store'); await cloneStore(root, fixture, store)
  assert.deepEqual(identity(await manifest(store)), sourceTree, 'fixture copy changed')
  watcher.check()
  const output = path.join(root, 'results.ndjson')
  const receipt = await runMonitored({ worker: path.join(here, 'limit-worker.mjs'), job: { development: true, package: packagePath, addon: path.join(packagePath, 'warm-sdk.node'), store, dataset, oracle, output }, jobFile: path.join(root, 'job.json'), receipt: path.join(root, 'receipt.json'), hostFile, deadline, signal: watcher.signal, environment: { RAYON_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } })
  assert.ok(receipt.complete, 'boundary worker incomplete')
  const rows = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse), queries = rows.filter(row => row.type === 'query')
  assert.equal(queries.length, 6); assert.equal(rows.at(-1).type, 'complete'); assert.equal(rows.at(-1).calls, 404)
  queries.forEach((row, i) => { assert.equal(row.count, frozen.counts[Math.floor(i / 2)]); assert.equal(row.repetition, i % 2); assert.equal(row.pageCalls, i % 2 === 0 || row.count === 100001 ? 101 : 0); assert.equal(row.audit.pass, true) })
  for (let i = 0; i < 6; i += 2) assert.equal(queries[i].resultHash, queries[i + 1].resultHash)
  assert.deepEqual(identity(await manifest(fixture)), sourceTree, 'source fixture changed')
  result = { output, outputSha256: await sha256(output), receipt, queries }
} catch (error) { failure = { name: error.name, message: error.message } }
finally { await watcher.stop() }
await writeOnce(path.join(root, 'finished.json'), { ...frozen, complete: !failure && !watcher.failure, failure: failure ?? watcher.failure ?? null, sourceTree, result })
if (failure || watcher.failure) throw new Error(`filter ID boundary diagnostic incomplete: ${JSON.stringify(failure ?? watcher.failure)}`)
