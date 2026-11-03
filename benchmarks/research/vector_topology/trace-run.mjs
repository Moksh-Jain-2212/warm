// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { append, exec, readJson, runMonitored, sha256, watchPhase, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../..')
const [output, binary] = process.argv.slice(2)
assert.ok(path.isAbsolute(output ?? '') && path.isAbsolute(binary ?? ''), 'provide fresh absolute output and binary paths')
assert.ok(!Object.keys(process.env).some(name => name.startsWith('WARM_QGRAPH_')), 'unset experimental graph environment knobs')
assert.equal(process.env.NODE_OPTIONS, undefined, 'unset NODE_OPTIONS')
const input = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/inputs.json'))
const stop = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/user-stop-receipt.json'))
const oldRoot = '/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen/results'
const topologyRoot = '/Volumes/A/.hms-bench-cache/warm-vector-topology-development-20261102-v1'
const highRoot = '/Volumes/A/.hms-bench-cache/warm-graph-high-ef-20261102-v1'
const previous = await readJson(path.join(topologyRoot, 'finished.json')), high = await readJson(path.join(highRoot, 'finished.json'))
assert.equal(previous.complete, true)
const corpus = path.join(input.glove.directory, 'train.f32'), queries = path.join(input.glove.directory, 'test.f32')
assert.equal(await sha256(corpus), input.glove.files['train.f32'].sha256)
assert.equal(await sha256(queries), input.glove.files['test.f32'].sha256)
const oracleRecord = stop.trees.results.files.find(file => file.path.endsWith('glove-100000-oracle-oracle.ndjson'))
assert.ok(oracleRecord)
const oracle = path.join(oldRoot, oracleRecord.path)
assert.equal(await sha256(oracle), oracleRecord.sha256)
const oracleRows = (await fs.readFile(oracle, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'oracle' && row.state === 'baseline' && row.filter === 'all')
assert.equal(oracleRows.length, 1000)
oracleRows.forEach((row, i) => { assert.equal(row.query, i); assert.equal(row.queryId, `query-${i}`); assert.equal(new Set(row.hits.map(hit => hit.ordinal)).size, 10) })
const references = {}, referenceFiles = []
for (const mode of ['default', 'degree64']) {
  const record = previous.results.find(row => row.mode === mode)
  assert.ok(record); assert.equal(await sha256(record.output), record.sha256)
  const rows = (await fs.readFile(record.output, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'query' && row.ef === 512)
  assert.equal(rows.length, 1000); rows.forEach((row, i) => assert.equal(row.query, i))
  references[`${mode}/512`] = rows.map(row => row.ids)
  referenceFiles.push({ path: record.output, sha256: record.sha256, graphHash: record.graphHash })
}
const highRecord = high.results.find(row => row.rows === 100000 && row.ef === 2048)
assert.ok(highRecord); assert.equal(await sha256(highRecord.path), highRecord.sha256)
const highRows = (await fs.readFile(highRecord.path, 'utf8')).trim().split('\n').map(JSON.parse)
assert.equal(highRows.length, 1000); highRows.forEach((row, i) => assert.equal(row.query, i))
references['default/2048'] = highRows.map(row => row.ids)
referenceFiles.push({ path: highRecord.path, sha256: highRecord.sha256 })

await fs.mkdir(output)
const binaryCopy = path.join(output, 'diagnostic-binary')
await fs.copyFile(binary, binaryCopy, fs.constants.COPYFILE_EXCL); await fs.chmod(binaryCopy, 0o700)
const artifacts = ['TRACE-PLAN.md', 'trace-run.mjs', 'trace-worker.mjs', 'src/bin/trace.rs', 'Cargo.toml', 'Cargo.lock']
const sourceHashes = {}
for (const name of artifacts) {
  const target = path.join(output, 'sources', name)
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(here, name), target, fs.constants.COPYFILE_EXCL)
  sourceHashes[name] = await sha256(target)
}
const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
const sourcePatch = (await exec('git', ['diff', '--binary', '--', 'Cargo.toml', 'Cargo.lock', 'src/core'], { cwd: repo, maxBuffer: 16 * 1024 ** 2 })).stdout
assert.equal((await exec('git', ['ls-files', '--others', '--exclude-standard', '--', 'src/core'], { cwd: repo })).stdout.trim(), '', 'untracked core source is not bound')
await fs.writeFile(path.join(output, 'core.patch'), sourcePatch, { flag: 'wx' })
const frozen = { sourceCommit, corePatchSha256: await sha256(path.join(output, 'core.patch')), rootLockSha256: await sha256(path.join(repo, 'Cargo.lock')), sources: sourceHashes, corpus, corpusSha256: await sha256(corpus), queries, queriesSha256: await sha256(queries), oracle, oracleSha256: await sha256(oracle), referenceFiles, binarySha256: await sha256(binaryCopy), node: process.version, rustVersion: (await exec('rustc', ['--version'])).stdout.trim(), modes: ['default', 'degree64'], efs: { default: [512, 2048], degree64: [512] }, repetitions: 3, deadlineMs: 7_200_000, scope: 'Previously exposed data; shared-host standalone development diagnostic; not a frozen study or competitive claim.' }
await writeOnce(path.join(output, 'started.json'), frozen)
const deadline = Date.now() + frozen.deadlineMs, hostFile = path.join(output, 'host.ndjson'), watcher = watchPhase(hostFile, deadline, false)
const results = []
let failure
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1]
try {
  for (const mode of frozen.modes) {
    watcher.check()
    const resultFile = path.join(output, `${mode}.ndjson`), receiptFile = path.join(output, `${mode}-receipt.json`)
    const receipt = await runMonitored({ worker: path.join(here, 'trace-worker.mjs'), job: { development: true, binary: binaryCopy, corpus, queries, oracle, mode, output: resultFile }, jobFile: path.join(output, `${mode}-job.json`), receipt: receiptFile, hostFile, deadline, signal: watcher.signal, environment: { RAYON_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } })
    assert.ok(receipt.complete, `incomplete trace: ${mode}`)
    const lines = (await fs.readFile(resultFile, 'utf8')).trim().split('\n').map(JSON.parse), start = lines[0], cells = []
    assert.equal(start.type, 'start'); assert.equal(start.mode, mode)
    assert.equal(start.graphHash, referenceFiles.find(row => row.graphHash && row.path.endsWith(`${mode}.ndjson`)).graphHash, 'graph structure changed')
    for (const ef of frozen.efs[mode]) {
      const traces = lines.filter(row => row.type === 'trace' && row.ef === ef), timings = lines.filter(row => row.type === 'timing' && row.ef === ef)
      assert.equal(traces.length, 1000); assert.equal(timings.length, 3000)
      const classes = { coded: Array(6).fill(0), exactRouting: Array(6).fill(0) }, counts = { coded: 0, exactRouting: 0 }
      traces.forEach((row, i) => {
        assert.equal(row.query, i); assert.deepEqual(row.coded.selected, references[`${mode}/${ef}`][i], `saved ranking mismatch ${mode}/${ef}/${i}`)
        const oracleIds = oracleRows[i].hits.map(hit => hit.ordinal)
        for (const name of Object.keys(classes)) {
          const trace = row[name]; assert.equal(trace.classes.length, 6); assert.equal(trace.classes.reduce((a, b) => a + b, 0), 10)
          assert.equal(trace.oracleCoverage.length, 5)
          for (let stage = 0; stage < 5; stage++) {
            const expected = oracleIds.filter(id => stage === 0 ? trace.oracleCoverage[0].includes(id) : trace.oracleCoverage[stage].includes(id))
            assert.deepEqual(trace.oracleCoverage[stage], expected)
            assert.equal(trace.oracleCoverage[stage].length, trace.classes.slice(stage + 1).reduce((a, b) => a + b, 0))
          }
          assert.equal(trace.classes[5], trace.selected.filter(id => oracleIds.includes(id)).length)
          trace.classes.forEach((n, j) => { classes[name][j] += n }); counts[name] += trace.evaluatedCount
        }
      })
      const repetitions = []
      for (let rep = 0; rep < 3; rep++) {
        const rows = timings.filter(row => row.repetition === rep); assert.equal(rows.length, 1000)
        rows.forEach((row, i) => { assert.equal(row.query, i); assert.deepEqual(row.selected, traces[i].coded.selected); assert.ok(Number.isSafeInteger(row.ns) && row.ns >= 0) })
        const ns = rows.map(row => row.ns)
        repetitions.push({ p50Ns: quantile(ns, .50), p95Ns: quantile(ns, .95), p99Ns: quantile(ns, .99) })
      }
      const recalls = traces.map((row, i) => row.coded.selected.filter(id => oracleRows[i].hits.some(hit => hit.ordinal === id)).length)
      const meanRecall = recalls.reduce((a, b) => a + b, 0) / 10000, worstRecall = Math.min(...recalls) / 10
      cells.push({ ef, meanRecall, worstRecall, below90: recalls.filter(n => n < 9).length, qualityPass: meanRecall >= .99 && worstRecall >= .9, classes, meanEvaluated: { coded: counts.coded / 1000, exactRouting: counts.exactRouting / 1000 }, repetitions })
    }
    const result = { mode, graphHash: start.graphHash, buildNs: start.buildNs, encodeNs: start.encodeNs, indexBytes: start.indexBytes, indexBreakdown: start.indexBreakdown, peakOwnedTreeRssBytes: receipt.peakOwnedTreeRssBytes, workerPid: receipt.pid, output: resultFile, sha256: await sha256(resultFile), cells }
    results.push(result); await append(path.join(output, 'progress.ndjson'), result)
  }
} catch (error) { failure = { name: error.name, message: error.message } }
finally { await watcher.stop() }
const host = Object.fromEntries(results.map(row => [row.workerPid, { samples: 0, maxExternalCpuFraction: 0, samplesAbove20Percent: 0 }]))
try {
  for await (const line of readline.createInterface({ input: createReadStream(hostFile) })) {
    const row = JSON.parse(line), summary = host[row.workerPid]
    if (row.type !== 'worker-resource' || !summary) continue
    assert.ok(Number.isFinite(row.externalCpuFraction) && row.externalCpuFraction >= 0)
    summary.samples++; summary.maxExternalCpuFraction = Math.max(summary.maxExternalCpuFraction, row.externalCpuFraction)
    if (row.externalCpuFraction > .20) summary.samplesAbove20Percent++
  }
  for (const row of Object.values(host)) assert.ok(row.samples > 0, 'missing host observations')
} catch (error) { failure ??= { name: error.name, message: error.message } }
await writeOnce(path.join(output, 'finished.json'), { ...frozen, complete: !failure && !watcher.failure, failure: failure ?? watcher.failure ?? null, results, host })
if (failure || watcher.failure) throw new Error(`development incomplete: ${JSON.stringify(failure ?? watcher.failure)}`)
