// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import v8 from 'node:v8'
import { PerformanceObserver } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { metadata } from '../../public/vectra_comparison/oracle-vector.mjs'
import { provider } from '../../public/vectra_comparison/vector-worker.mjs'
import { runMonitored, sha256, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const self = fileURLToPath(import.meta.url), require = createRequire(import.meta.url)
const vectraPath = '/Volumes/A/toip-warm-backend/toip-mcp-server/node_modules/vectra'
const rows = 10_000, dimensions = 100, batch = 100
const id = i => `row-${String(i).padStart(8, '0')}`
const memory = () => ({ ...process.memoryUsage(), v8: v8.getHeapStatistics() })

async function worker(job) {
  const values = new Float64Array(rows * dimensions)
  for (let i = 0; i < values.length; i++) values[i] = Math.fround(Math.sin((Math.floor(i / dimensions) + 1) * (i % dimensions + 1)) * 0.5)
  const vector = i => Array.from(values.subarray(i * dimensions, (i + 1) * dimensions))
  const gc = {}, observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { const kind = String(entry.detail.kind); gc[kind] = (gc[kind] ?? 0) + 1 } })
  observer.observe({ entryTypes: ['gc'] })
  const index = await provider('vectra', { vectraPath }, job.store, true), codec = index.raw.codec
  const serialize = codec.serializeIndex.bind(codec), snapshots = []
  let serializedBytes = 0, calls = 0
  codec.serializeIndex = data => {
    const before = memory(), skipped = job.mode === 'ablate' && data.items.length < rows
    const buffer = skipped ? Buffer.from('{}') : serialize(data)
    calls++; serializedBytes += buffer.length
    snapshots.push({ items: data.items.length, skipped, bytes: buffer.length, before, after: memory() })
    return buffer
  }
  for (let offset = 0; offset < rows; offset += batch) {
    const operations = Array.from({ length: batch }, (_, j) => { const i = offset + j; return { op: 'insert', record: { id: id(i), vector: vector(i), metadata: metadata(i) } } })
    await index.batch(operations)
  }
  if (job.mode === 'vmmap') {
    try {
      const result = await promisify(execFile)('/usr/bin/vmmap', ['-summary', String(process.pid)], { timeout: 10000, maxBuffer: 4 * 1024 ** 2 })
      await fs.writeFile(job.vmmap, result.stdout, { flag: 'wx' })
    } catch (error) { await writeOnce(job.vmmap, { failed: true, message: error.message }) }
  }
  const reopened = await provider('vectra', { vectraPath }, job.store)
  const items = await reopened.all()
  assert.equal(items.length, rows)
  for (let i = 0; i < rows; i++) { assert.equal(items[i].id, id(i)); assert.deepEqual(items[i].vector, vector(i)); assert.deepEqual(items[i].metadata, metadata(i)) }
  await new Promise(resolve => setImmediate(resolve))
  observer.disconnect()
  await writeOnce(job.output, { mode: job.mode, rows, dimensions, batch, calls, serializedBytes, gc, snapshots, final: memory(), fileSha256: await sha256(path.join(job.store, 'index.json')), validation: 'reopened all IDs, vectors and metadata' })
  process.disconnect?.()
}

async function main(root, selection) {
  assert.ok(path.isAbsolute(root), 'new absolute output directory required')
  assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS must be unset in controller')
  assert.equal(require(path.join(vectraPath, 'package.json')).version, '0.15.0')
  await fs.mkdir(root)
  const results = []
  assert.ok(['comparison', 'vmmap'].includes(selection), 'selection must be comparison or vmmap')
  for (const mode of selection === 'comparison' ? ['default', 'heap256', 'ablate'] : ['vmmap']) {
    const stem = path.join(root, mode), job = { development: true, mode, store: `${stem}-store`, output: `${stem}-result.json`, vmmap: `${stem}-vmmap.txt` }
    const environment = mode === 'heap256' ? { NODE_OPTIONS: '--max-old-space-size=256' } : {}
    const receipt = await runMonitored({ worker: self, job, jobFile: `${stem}-job.json`, receipt: `${stem}-receipt.json`, hostFile: `${stem}-host.ndjson`, deadline: Date.now() + 900_000, environment })
    assert.ok(receipt.complete, `diagnostic worker failed for ${mode}`)
    results.push(JSON.parse(await fs.readFile(job.output, 'utf8')))
  }
  assert.equal(new Set(results.map(result => result.fileSha256)).size, 1, 'different final index contents')
  await writeOnce(path.join(root, 'summary.json'), { node: process.version, executable: process.execPath, scriptSha256: await sha256(self), workerSha256: await sha256(fileURLToPath(new URL('../../public/vectra_comparison/vector-worker.mjs', import.meta.url))), localIndexSha256: await sha256(path.join(vectraPath, 'lib/LocalIndex.js')), codecSha256: await sha256(path.join(vectraPath, 'lib/codecs/JsonCodec.js')), synthetic: true, results })
}

const arg = process.argv[2]
if (process.send) await worker(JSON.parse(await fs.readFile(arg, 'utf8')))
else await main(arg, process.argv[3])
