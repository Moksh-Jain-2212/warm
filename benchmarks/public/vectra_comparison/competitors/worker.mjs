// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { append, readJson } from '../vector-receipts.mjs'
import { recallAtK, scalarCosine } from '../oracle-vector.mjs'

const require = createRequire(import.meta.url)

export function createIndex(engine, dimensions, ef, rows) {
  if (engine === 'hnswlib') {
    const { HierarchicalNSW } = require('hnswlib-node')
    const index = new HierarchicalNSW('cosine', dimensions)
    return {
      build() { index.initIndex(rows, 32, 200, 100) },
      add(ordinal, values) { index.addPoint(Array.from(values), ordinal) },
      save(file) { index.writeIndexSync(file) },
      load(file) { index.readIndexSync(file) },
      ready() { index.setEf(ef) },
      count() { return index.getCurrentCount() },
      search(values, k) { const result = index.searchKnn(Array.from(values), k); return result.neighbors.map((id, i) => ({ ordinal: id, score: 1 - result.distances[i] })) },
    }
  }
  assert.equal(engine, 'usearch')
  const { Index } = require('usearch')
  const index = new Index({ dimensions, metric: 'cos', quantization: 'f32', connectivity: 32, expansion_add: 200, expansion_search: ef })
  return {
    build() {},
    add(ordinal, values) { index.add(BigInt(ordinal), values, 1) },
    save(file) { index.save(file) },
    load(file) { index.load(file) },
    ready() {},
    count() { return index.size() },
    search(values, k) { const result = index.search(values, k, 1); return Array.from(result.keys, (id, i) => ({ ordinal: Number(id), score: 1 - result.distances[i] })) },
  }
}

export function validateHits(hits, values, query, dimensions, count) {
  assert.equal(hits.length, Math.min(10, count))
  assert.equal(new Set(hits.map(hit => hit.ordinal)).size, hits.length)
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    assert.ok(Number.isInteger(hit.ordinal) && hit.ordinal >= 0 && hit.ordinal < count)
    assert.ok(Number.isFinite(hit.score))
    const score = scalarCosine(values.subarray(hit.ordinal * dimensions, (hit.ordinal + 1) * dimensions), query)
    assert.ok(Math.abs(hit.score - score) <= 2e-6, 'score differs from cosine')
    if (i > 0) assert.ok(hits[i - 1].score >= hit.score, 'scores are out of order')
  }
}

export async function run(job) {
  assert.equal(os.endianness(), 'LE')
  assert.ok(['prepare', 'timing'].includes(job.action))
  await fs.writeFile(job.output, '', { flag: 'wx', mode: 0o600 })
  const corpus = await fs.readFile(job.corpus), queries = await fs.readFile(job.queries)
  assert.ok(corpus.length >= job.rows * job.dimensions * 4)
  assert.equal(queries.length, job.queryCount * job.dimensions * 4)
  const values = new Float32Array(corpus.buffer, corpus.byteOffset, job.rows * job.dimensions)
  const queryValues = new Float32Array(queries.buffer, queries.byteOffset, job.queryCount * job.dimensions)
  const truth = new Map()
  for (const line of (await fs.readFile(job.oracle, 'utf8')).split('\n')) {
    if (!line) continue
    const row = JSON.parse(line)
    if (row.type !== 'oracle' || row.state !== 'baseline' || row.filter !== 'all') continue
    assert.equal(row.dataset, `glove-${job.rows}`)
    assert.equal(row.queryId, `query-${row.query}`)
    assert.ok(Number.isInteger(row.query) && row.query >= 0 && row.query < job.queryCount && !truth.has(row.query))
    truth.set(row.query, row.hits.map(hit => hit.ordinal))
  }
  assert.equal(truth.size, job.queryCount)
  const index = createIndex(job.engine, job.dimensions, job.ef, job.rows)
  let started = performance.now()
  if (job.action === 'prepare') {
    index.build()
    for (let row = 0; row < job.rows; row++) index.add(row, values.subarray(row * job.dimensions, (row + 1) * job.dimensions))
    const buildMs = performance.now() - started
    const exclusive = await fs.open(job.index, 'wx', 0o600); await exclusive.close()
    started = performance.now(); index.save(job.index)
    await append(job.output, { type: 'build', rows: job.rows, buildMs, saveMs: performance.now() - started, storageBytes: (await fs.stat(job.index)).size })
  } else {
    index.load(job.index)
    await append(job.output, { type: 'open', loadMs: performance.now() - started })
  }
  assert.equal(index.count(), job.rows)
  index.ready()
  const query = i => queryValues.subarray(i * job.dimensions, (i + 1) * job.dimensions)
  if (job.action === 'timing') for (let i = 0; i < 20; i++) index.search(query(i), 10)
  for (let i = 0; i < job.queryCount; i++) {
    const vector = query(i)
    started = performance.now()
    const hits = index.search(vector, 10)
    const elapsedMs = job.action === 'timing' ? performance.now() - started : null
    let correctness = true, error = null
    try { validateHits(hits, values, vector, job.dimensions, job.rows) } catch (failure) { correctness = false; error = failure.message }
    await append(job.output, { type: 'query', query: i, queryId: `query-${i}`, hits, recall: recallAtK(hits.map(hit => hit.ordinal), truth.get(i)), correctness, error, elapsedMs })
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run(await readJson(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1 })
}
