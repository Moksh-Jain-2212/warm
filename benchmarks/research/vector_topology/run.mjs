// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { append, exec, readJson, runMonitored, sha256, watchPhase, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../../..')
const old = '/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen/results'
const priorDev = '/Volumes/A/.hms-bench-cache/warm-graph-development-20261102-v2'
const input = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/inputs.json'))
const stop = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/user-stop-receipt.json'))
const previous = await readJson(path.join(priorDev, 'finished.json'))
const [output, binary] = process.argv.slice(2)
assert.ok(path.isAbsolute(output ?? '') && path.isAbsolute(binary ?? ''), 'provide fresh absolute output and binary paths')
assert.ok(!Object.keys(process.env).some(name => name.startsWith('WARM_QGRAPH_')), 'unset experimental graph environment knobs')
const corpus = path.join(input.glove.directory, 'train.f32'), queries = path.join(input.glove.directory, 'test.f32')
assert.equal(await sha256(corpus), input.glove.files['train.f32'].sha256)
assert.equal(await sha256(queries), input.glove.files['test.f32'].sha256)
const oracleRecord = stop.trees.results.files.find(file => file.path.endsWith('glove-100000-oracle-oracle.ndjson'))
assert.ok(oracleRecord)
const oracle = path.join(old, oracleRecord.path)
assert.equal(await sha256(oracle), oracleRecord.sha256)
const oracleRows = (await fs.readFile(oracle, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'oracle' && row.state === 'baseline' && row.filter === 'all')
assert.equal(oracleRows.length, 1000)
oracleRows.forEach((row, i) => { assert.equal(row.query, i); assert.equal(row.queryId, `query-${i}`); assert.equal(new Set(row.hits.map(hit => hit.ordinal)).size, 10) })
const source = path.join(here, 'src/main.rs'), lock = path.join(here, 'Cargo.lock'), worker = path.join(here, 'worker.mjs')
const expected = {}
for (const [ef, serial] of [[128, '0037'], [256, '0038']]) {
  const name = `preparation-${serial}-glove-100000-warm-quality.ndjson`, record = stop.trees.results.files.find(file => file.path === name)
  assert.ok(record); const file = path.join(old, name); assert.equal(await sha256(file), record.sha256)
  expected[ef] = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'query' && row.filter === 'all').map(row => ({ query: row.query, ids: row.hits.map(hit => hit.ordinal) }))
}
const reference512 = previous.results.find(row => row.rows === 100000 && row.ef === 512)
assert.ok(reference512); assert.equal(await sha256(reference512.path), reference512.sha256)
expected[512] = (await fs.readFile(reference512.path, 'utf8')).trim().split('\n').map(JSON.parse)
for (const ef of [128, 256, 512]) { assert.equal(expected[ef].length, 1000); expected[ef].forEach((row, i) => assert.equal(row.query, i)) }
await fs.mkdir(output)
const binaryCopy = path.join(output, 'diagnostic-binary')
await fs.copyFile(binary, binaryCopy, fs.constants.COPYFILE_EXCL)
await fs.chmod(binaryCopy, 0o700)
const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
const sourcePatch = (await exec('git', ['diff', '--binary', '--', 'Cargo.toml', 'Cargo.lock', 'src/core'], { cwd: repo, maxBuffer: 16 * 1024 ** 2 })).stdout
await fs.writeFile(path.join(output, 'source.patch'), sourcePatch, { flag: 'wx', mode: 0o600 })
const frozen = { corpus, corpusSha256: await sha256(corpus), queries, queriesSha256: await sha256(queries), oracle, oracleSha256: oracleRecord.sha256, binary: binaryCopy, binarySha256: await sha256(binaryCopy), sourceCommit, sourcePatchSha256: await sha256(path.join(output, 'source.patch')), sourceSha256: await sha256(source), lockSha256: await sha256(lock), rootLockSha256: await sha256(path.join(repo, 'Cargo.lock')), rustVersion: (await exec('rustc', ['--version'])).stdout.trim(), controllerSha256: await sha256(fileURLToPath(import.meta.url)), workerSha256: await sha256(worker), modes: ['default', 'degree48', 'degree64'], efs: [128, 256, 512], deadlineMs: 7_200_000, scope: '100,000-row GloVe development; no timing or competitive claims. Default must reproduce all 3,000 saved WARM rankings before topology variants run.' }
await writeOnce(path.join(output, 'started.json'), frozen)
const deadline = Date.now() + frozen.deadlineMs, hostFile = path.join(output, 'host.ndjson'), watcher = watchPhase(hostFile, deadline, false)
const results = []
let failure
try {
  for (const mode of frozen.modes) {
    watcher.check()
    const resultFile = path.join(output, `${mode}.ndjson`), jobFile = path.join(output, `${mode}-job.json`), receiptFile = path.join(output, `${mode}-receipt.json`)
    const receipt = await runMonitored({ worker, job: { binary: binaryCopy, corpus, queries, oracle, mode, output: resultFile }, jobFile, receipt: receiptFile, hostFile, deadline, signal: watcher.signal, environment: { RAYON_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } })
    assert.ok(receipt.complete, `incomplete topology diagnostic: ${mode}`)
    const lines = (await fs.readFile(resultFile, 'utf8')).trim().split('\n').map(JSON.parse), cells = []
    for (const ef of frozen.efs) {
      const queries = lines.filter(row => row.type === 'query' && row.ef === ef), summary = lines.find(row => row.type === 'summary' && row.ef === ef)
      assert.equal(queries.length, 1000); assert.ok(summary)
      let changed = 0
      queries.forEach((row, i) => {
        assert.equal(row.query, i); assert.equal(row.ids.length, 10); assert.equal(new Set(row.ids).size, 10)
        assert.ok(row.ids.every(id => Number.isInteger(id) && id >= 0 && id < 100000))
        assert.equal(row.matched, row.ids.filter(id => oracleRows[i].hits.some(hit => hit.ordinal === id)).length)
        if (JSON.stringify(row.ids) !== JSON.stringify(expected[ef][i].ids)) changed++
      })
      assert.equal(summary.meanRecall, queries.reduce((sum, row) => sum + row.matched, 0) / 10000)
      assert.equal(summary.worstRecall, Math.min(...queries.map(row => row.matched)) / 10)
      assert.equal(summary.below90, queries.filter(row => row.matched < 9).length)
      cells.push({ ef, ...summary, changedAgainstSaved: changed })
      if (mode === 'default') assert.equal(changed, 0, `default diagnostic does not reproduce WARM ef=${ef}`)
    }
    results.push({ mode, output: resultFile, sha256: await sha256(resultFile), graphHash: lines[0].graphHash, cells })
    await append(path.join(output, 'progress.ndjson'), results.at(-1))
  }
} catch (error) { failure = { name: error.name, message: error.message } }
finally { await watcher.stop() }
await writeOnce(path.join(output, 'finished.json'), { ...frozen, complete: !failure && !watcher.failure, failure: failure ?? watcher.failure ?? null, results })
if (failure || watcher.failure) throw new Error(`development incomplete: ${JSON.stringify(failure ?? watcher.failure)}`)
