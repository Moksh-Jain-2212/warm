// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMonitored, sha256, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const root = process.argv[2]
assert.ok(path.isAbsolute(root ?? ''), 'new absolute output directory required')
assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS must be unset')
await fs.mkdir(root)
const rows = 100_000, dimensions = 100, queryCount = 3
const corpus = path.join(root, 'synthetic-corpus.f32'), queries = path.join(root, 'synthetic-queries.f32')
const handle = await fs.open(corpus, 'wx')
try {
  for (let offset = 0; offset < rows; offset += 1000) {
    const buffer = Buffer.alloc(1000 * dimensions * 4)
    for (let i = 0; i < 1000; i++) for (let j = 0; j < dimensions; j++) buffer.writeFloatLE(Math.sin((offset + i + 1) * (j + 1)) * .5, (i * dimensions + j) * 4)
    await handle.writeFile(buffer)
  }
} finally { await handle.close() }
const queryBytes = Buffer.alloc(queryCount * dimensions * 4)
for (let i = 0; i < queryCount * dimensions; i++) queryBytes.writeFloatLE(Math.sin(i + 1) * .5, i * 4)
await fs.writeFile(queries, queryBytes, { flag: 'wx' })
const config = path.join(root, 'config.json')
await writeOnce(config, { vectraPath: '/Volumes/A/toip-warm-backend/toip-mcp-server/node_modules/vectra' })
const dataset = { name: 'synthetic-100000', rows, dimensions, queryCount, corpus, queries, embeddingModel: 'synthetic', embeddingRevision: 'local-development-only' }
const store = path.join(root, 'store'), worker = fileURLToPath(new URL('../../public/vectra_comparison/vector-worker.mjs', import.meta.url))
const results = []
for (const action of ['prepare', 'validate']) {
  const stem = path.join(root, action), output = `${stem}-output.ndjson`
  const job = { development: true, action, dataset, engine: 'vectra', store, config, output }
  const receipt = await runMonitored({ worker, job, jobFile: `${stem}-job.json`, receipt: `${stem}-receipt.json`, hostFile: `${stem}-host.ndjson`, deadline: Date.now() + 1_800_000 })
  assert.ok(receipt.complete, `${action} failed`)
  const lines = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse)
  const validation = lines.find(row => row.name === (action === 'prepare' ? 'validate-full-store' : 'separate-process-reopen-validation'))
  assert.equal(validation.value.records, rows); assert.equal(validation.value.pass, true)
  if (action === 'prepare') assert.equal(lines.find(row => row.name === 'ingest-acknowledgements').value.batchSize, rows)
  results.push({ action, receipt, outputSha256: await sha256(output), validation: validation.value })
}
await writeOnce(path.join(root, 'summary.json'), { synthetic: true, node: process.version, executable: process.execPath, scriptSha256: await sha256(fileURLToPath(import.meta.url)), workerSha256: await sha256(worker), corpusSha256: await sha256(corpus), querySha256: await sha256(queries), storeSha256: await sha256(path.join(store, 'index.json')), rows, dimensions, queryCount, results })
