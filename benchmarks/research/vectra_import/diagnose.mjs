// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { metadata } from '../../public/vectra_comparison/oracle-vector.mjs'
import { runMonitored, sha256, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const self = fileURLToPath(import.meta.url)
const dimensions = 100
const vectraPath = '/Volumes/A/toip-warm-backend/toip-mcp-server/node_modules/vectra'
const require = createRequire(import.meta.url)
const vector = row => Array.from({ length: dimensions }, (_, col) => Math.fround(Math.sin((row + 1) * (col + 1)) * 0.5))
const id = row => `row-${String(row).padStart(8, '0')}`
const memory = () => { const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage(); return { rss, heapUsed, external, arrayBuffers } }

async function worker(job) {
  const { rows } = job
  const { LocalIndex } = require(path.join(vectraPath, 'lib/index.js'))
  const index = new LocalIndex(job.store)
  await index.createIndex({ version: 1 })
  let calls = 0, serializedBytes = 0
  const snapshots = []
  const serialize = index.codec.serializeIndex.bind(index.codec)
  index.codec.serializeIndex = data => {
    const before = memory(), buffer = serialize(data), after = memory()
    calls++; serializedBytes += buffer.length
    snapshots.push({ items: data.items.length, bytes: buffer.length, before, after })
    return buffer
  }
  for (let offset = 0; offset < rows; offset += job.batch) {
    await index.beginUpdate()
    for (let i = offset; i < Math.min(rows, offset + job.batch); i++) await index.insertItem({ id: id(i), vector: vector(i), metadata: metadata(i) })
    await index.endUpdate()
  }
  const reopened = new LocalIndex(job.store)
  const actual = await reopened.listItems()
  assert.equal(actual.length, rows)
  for (let i = 0; i < rows; i++) {
    assert.equal(actual[i].id, id(i)); assert.deepEqual(actual[i].vector, vector(i)); assert.deepEqual(actual[i].metadata, metadata(i))
  }
  await writeOnce(job.output, { rows, dimensions, batch: job.batch, calls, serializedBytes, snapshots, finalMemory: memory(), fileSha256: await sha256(path.join(job.store, 'index.json')), validation: 'reopened all IDs, vectors and metadata' })
  process.disconnect?.()
}

async function main(root, scale) {
  assert.ok(path.isAbsolute(root), 'new absolute output directory required')
  assert.ok(['small', 'large'].includes(scale), 'scale must be small or large')
  assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS must be unset')
  assert.equal(require(path.join(vectraPath, 'package.json')).version, '0.15.0')
  await fs.mkdir(root)
  const results = []
  const rows = scale === 'small' ? 10_000 : 100_000
  for (const batch of scale === 'small' ? [100, rows] : [rows]) {
    const stem = path.join(root, `batch-${batch}`)
    const job = { development: true, rows, batch, store: `${stem}-store`, output: `${stem}-result.json` }
    const receipt = await runMonitored({ worker: self, job, jobFile: `${stem}-job.json`, receipt: `${stem}-receipt.json`, hostFile: `${stem}-host.ndjson`, deadline: Date.now() + 900_000 })
    assert.ok(receipt.complete, `diagnostic worker failed for batch ${batch}`)
    results.push(JSON.parse(await fs.readFile(job.output, 'utf8')))
  }
  if (results.length === 2) assert.equal(results[0].fileSha256, results[1].fileSha256, 'different index contents')
  await writeOnce(path.join(root, 'summary.json'), { node: process.version, executable: process.execPath, scriptSha256: await sha256(self), vectraPackageSha256: await sha256(path.join(vectraPath, 'package.json')), localIndexSha256: await sha256(path.join(vectraPath, 'lib/LocalIndex.js')), codecSha256: await sha256(path.join(vectraPath, 'lib/codecs/JsonCodec.js')), synthetic: true, results })
}

const arg = process.argv[2]
if (process.send) await worker(JSON.parse(await fs.readFile(arg, 'utf8')))
else await main(arg, process.argv[3])
