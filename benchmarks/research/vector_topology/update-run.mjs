// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { append, cloneStore, exec, manifest, readJson, runMonitored, sha256, watchPhase, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../..')
const root = process.argv[2]
assert.ok(path.isAbsolute(root ?? ''), 'new absolute output directory required')
assert.equal(process.env.NODE_OPTIONS, undefined, 'unset NODE_OPTIONS')
assert.ok(!Object.keys(process.env).some(name => name.startsWith('WARM_QGRAPH_')), 'unset graph environment knobs')
const prior = '/Volumes/A/.hms-bench-cache/vectra-comparison-followup-20261102-v1'
const input = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/inputs.json'))
const dataset = { name: 'glove-100000', rows: 100000, dimensions: 100, queryCount: 1000, corpus: path.join(input.glove.directory, 'train.f32'), queries: path.join(input.glove.directory, 'test.f32') }
assert.equal(await sha256(dataset.corpus), input.glove.files['train.f32'].sha256)
assert.equal(await sha256(dataset.queries), input.glove.files['test.f32'].sha256)
const modes = [{ name: 'default', source: path.join(prior, 'fixtures/glove-100000/warm'), ef: 2048, degree: 32, buildEf: 128 }, { name: 'degree64', source: path.join(prior, 'fixtures/glove-100000/warm-high-recall'), ef: 512, degree: 64, buildEf: 500 }]
const identity = tree => tree.files.filter(file => path.basename(file.path) !== '.hms.lock').map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
await fs.mkdir(root)
const packagePath = path.join(root, 'package'); await fs.mkdir(packagePath)
for (const name of ['index.js', 'vectra.js', 'vectra-selector.js', 'warm-sdk.node']) await fs.copyFile(path.join(repo, name), path.join(packagePath, name), fs.constants.COPYFILE_EXCL)
const addon = path.join(packagePath, 'warm-sdk.node'), packageHashes = {}
for (const name of ['index.js', 'vectra.js', 'vectra-selector.js', 'warm-sdk.node']) packageHashes[name] = await sha256(path.join(packagePath, name))
const artifacts = [['UPDATE-PLAN.md', 'UPDATE-PLAN.md'], ['update-run.mjs', 'update-run.mjs'], ['update-worker.mjs', 'update-worker.mjs'], ['update-test.mjs', 'update-test.mjs'], ['../../public/vectra_comparison/vector-worker.mjs', 'harness/vector-worker.mjs'], ['../../public/vectra_comparison/oracle-vector.mjs', 'harness/oracle-vector.mjs'], ['../../public/vectra_comparison/vector-receipts.mjs', 'harness/vector-receipts.mjs']]
const sourceHashes = {}
for (const [source, name] of artifacts) { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(here, source), target, fs.constants.COPYFILE_EXCL); sourceHashes[name] = await sha256(target) }
const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
const datasetHashes = { corpus: await sha256(dataset.corpus), queries: await sha256(dataset.queries) }
const frozen = { sourceCommit, packageHashes, sources: sourceHashes, dataset, datasetHashes, node: process.version, executable: process.execPath, nodeSha256: await sha256(process.execPath), modes, deadlineMs: 7_200_000, scope: 'Separate shared-host development; 100 upserts on cloned previously exposed fixtures; no frozen-phase or competitive timing claim.' }
await writeOnce(path.join(root, 'started.json'), frozen)
const deadline = Date.now() + frozen.deadlineMs, hostFile = path.join(root, 'host.ndjson'), watcher = watchPhase(hostFile, deadline, false)
const results = [], sourceTrees = {}
let failure
try {
  for (const mode of modes) {
    watcher.check()
    const profile = await readJson(path.join(mode.source, 'vectra-migration.json'))
    assert.ok(profile.highRecall === undefined || typeof profile.highRecall === 'boolean')
    assert.equal(profile.highRecall ?? false, mode.name === 'degree64')
    sourceTrees[mode.name] = identity(await manifest(mode.source))
    const store = path.join(root, `store-${mode.name}`)
    await cloneStore(root, mode.source, store)
    assert.deepEqual(identity(await manifest(store)), sourceTrees[mode.name], 'fixture copy changed')
    const jobs = []
    for (const action of ['update', 'reopen']) {
      watcher.check()
      const stem = path.join(root, `${mode.name}-${action}`), output = `${stem}.ndjson`
      const job = { development: true, action, package: packagePath, addon, store, dataset, ...mode, output }
      const receipt = await runMonitored({ worker: path.join(here, 'update-worker.mjs'), job, jobFile: `${stem}-job.json`, receipt: `${stem}-receipt.json`, hostFile, deadline, signal: watcher.signal, environment: { RAYON_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } })
      assert.ok(receipt.complete, `incomplete ${mode.name}/${action}`)
      const rows = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse)
      assert.deepEqual(rows.at(-1), { type: 'complete', action })
      const names = action === 'update' ? ['validate-before', 'initial-maintain-indices', 'first-graph-query-and-exact-control', 'batch-upsert-100', 'validate-after', 'queries-before-maintenance', 'maintain-indices', 'queries-after-maintenance', 'flush'] : ['validate-reopened', 'reopen-maintain-indices', 'queries-after-separate-process-reopen']
      assert.deepEqual(rows.filter(row => row.type === 'stage').map(row => row.name), names)
      jobs.push({ action, output, sha256: await sha256(output), receipt, stages: rows.filter(row => row.type === 'stage') })
    }
    assert.deepEqual(identity(await manifest(mode.source)), sourceTrees[mode.name], 'source fixture changed')
    const result = { mode: mode.name, jobs }
    results.push(result); await append(path.join(root, 'progress.ndjson'), result)
  }
} catch (error) { failure = { name: error.name, message: error.message } }
finally { await watcher.stop() }
await writeOnce(path.join(root, 'finished.json'), { ...frozen, complete: !failure && !watcher.failure, failure: failure ?? watcher.failure ?? null, sourceTrees, results })
if (failure || watcher.failure) throw new Error(`update diagnostic incomplete: ${JSON.stringify(failure ?? watcher.failure)}`)
