// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec, readJson, runMonitored, sha256, watchPhase, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../..')
const [root, binary] = process.argv.slice(2)
assert.ok(path.isAbsolute(root ?? '') && path.isAbsolute(binary ?? ''), 'new absolute output and binary required')
assert.equal(process.env.NODE_OPTIONS, undefined, 'unset NODE_OPTIONS')
assert.ok(!Object.keys(process.env).some(name => name.startsWith('WARM_QGRAPH_')), 'unset experimental graph environment knobs')
const priorRoot = '/Volumes/A/.hms-bench-cache/warm-graph-trace-20261102-v1'
const prior = await readJson(path.join(priorRoot, 'finished.json'))
assert.equal(prior.complete, true)
const priorResult = prior.results.find(result => result.mode === 'degree64')
assert.ok(priorResult); assert.equal(await sha256(priorResult.output), priorResult.sha256)
assert.equal(await sha256(prior.corpus), prior.corpusSha256); assert.equal(await sha256(prior.queries), prior.queriesSha256)
const reference = (await fs.readFile(priorResult.output, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'trace' && row.ef === 512)
assert.equal(reference.length, 1000); reference.forEach((row, i) => assert.equal(row.query, i))
await fs.mkdir(root)
const binaryCopy = path.join(root, 'diagnostic-binary')
await fs.copyFile(binary, binaryCopy, fs.constants.COPYFILE_EXCL); await fs.chmod(binaryCopy, 0o700)
const artifacts = ['ADJACENCY-PLAN.md', 'adjacency-run.mjs', 'adjacency-worker.mjs', 'src/bin/adjacency.rs', 'Cargo.toml', 'Cargo.lock']
const sourceHashes = {}
for (const name of artifacts) {
  const target = path.join(root, 'sources', name)
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(here, name), target, fs.constants.COPYFILE_EXCL)
  sourceHashes[name] = await sha256(target)
}
const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim()
const corePatch = (await exec('git', ['diff', '--binary', '--', 'Cargo.toml', 'Cargo.lock', 'src/core'], { cwd: repo, maxBuffer: 16 * 1024 ** 2 })).stdout
assert.equal((await exec('git', ['ls-files', '--others', '--exclude-standard', '--', 'src/core'], { cwd: repo })).stdout.trim(), '')
await fs.writeFile(path.join(root, 'core.patch'), corePatch, { flag: 'wx' })
const frozen = { sourceCommit, corePatchSha256: await sha256(path.join(root, 'core.patch')), rootLockSha256: await sha256(path.join(repo, 'Cargo.lock')), sources: sourceHashes, corpus: prior.corpus, corpusSha256: prior.corpusSha256, queries: prior.queries, queriesSha256: prior.queriesSha256, reference: priorResult.output, referenceSha256: priorResult.sha256, priorSummarySha256: await sha256(path.join(priorRoot, 'finished.json')), expectedGraphHash: priorResult.graphHash, binarySha256: await sha256(binaryCopy), node: process.version, rustVersion: (await exec('rustc', ['--version'])).stdout.trim(), deadlineMs: 7_200_000, scope: 'Paired same-graph shared-host development; exposed queries; not a frozen study or competitive claim.' }
await writeOnce(path.join(root, 'started.json'), frozen)
const deadline = Date.now() + frozen.deadlineMs, hostFile = path.join(root, 'host.ndjson'), watcher = watchPhase(hostFile, deadline, false)
let failure, result, receipt
const quantile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(fraction * values.length) - 1]
try {
  const output = path.join(root, 'results.ndjson'), saved = path.join(root, 'index3.bin')
  receipt = await runMonitored({ worker: path.join(here, 'adjacency-worker.mjs'), job: { development: true, binary: binaryCopy, corpus: prior.corpus, queries: prior.queries, reference: priorResult.output, output, saved }, jobFile: path.join(root, 'job.json'), receipt: path.join(root, 'receipt.json'), hostFile, deadline, signal: watcher.signal, environment: { RAYON_NUM_THREADS: '1', OMP_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } })
  assert.ok(receipt.complete, 'adjacency diagnostic worker incomplete')
  const lines = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse), start = lines[0]
  assert.equal(start.type, 'start'); assert.equal(start.graphHash, frozen.expectedGraphHash)
  assert.equal(start.index4Bytes - start.index3Bytes, 100000 * 64)
  assert.equal(start.index4Breakdown.adjacency_ids_bytes, 100000 * 64 * 4)
  assert.equal(start.index3Breakdown.adjacency_ids_bytes, 100000 * 64 * 3)
  const parity = lines.filter(row => row.type === 'parity'), timings = lines.filter(row => row.type === 'timing')
  assert.equal(parity.length, 1000); assert.equal(timings.length, 3000)
  parity.forEach((row, i) => {
    assert.equal(row.query, i); assert.deepEqual(row.candidates, reference[i].coded.shortlist)
    assert.deepEqual(row.selected, reference[i].coded.selected)
  })
  const repetitions = []
  for (let rep = 0; rep < 3; rep++) {
    const rows = timings.filter(row => row.repetition === rep); assert.equal(rows.length, 1000)
    rows.forEach((row, i) => { assert.equal(row.query, i); assert.equal(row.first4, (i + rep) % 2 === 0); assert.ok(Number.isSafeInteger(row.index4Ns) && row.index4Ns >= 0); assert.ok(Number.isSafeInteger(row.index3Ns) && row.index3Ns >= 0) })
    repetitions.push(Object.fromEntries(['index4Ns', 'index3Ns'].map(key => [key, { p50: quantile(rows.map(row => row[key]), .5), p95: quantile(rows.map(row => row[key]), .95), p99: quantile(rows.map(row => row[key]), .99) }])))
  }
  result = { ...start, parityQueries: parity.length, savedSha256: await sha256(saved), outputSha256: await sha256(output), repetitions, peakOwnedTreeRssBytes: receipt.peakOwnedTreeRssBytes }
} catch (error) { failure = { name: error.name, message: error.message } }
finally { await watcher.stop() }
const host = { samples: 0, maxExternalCpuFraction: 0, samplesAbove20Percent: 0 }
try {
  for await (const line of readline.createInterface({ input: createReadStream(hostFile) })) {
    const row = JSON.parse(line)
    if (row.type !== 'worker-resource' || row.workerPid !== receipt?.pid) continue
    assert.ok(Number.isFinite(row.externalCpuFraction) && row.externalCpuFraction >= 0)
    host.samples++; host.maxExternalCpuFraction = Math.max(host.maxExternalCpuFraction, row.externalCpuFraction)
    if (row.externalCpuFraction > .20) host.samplesAbove20Percent++
  }
  if (receipt?.complete) assert.ok(host.samples > 0, 'missing worker observations')
} catch (error) { failure ??= { name: error.name, message: error.message } }
await writeOnce(path.join(root, 'finished.json'), { ...frozen, complete: !failure && !watcher.failure, failure: failure ?? watcher.failure ?? null, result, receipt, host })
if (failure || watcher.failure) throw new Error(`adjacency diagnostic incomplete: ${JSON.stringify(failure ?? watcher.failure)}`)
