// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIndex, run, validateHits } from './worker.mjs'
import { scalarCosine } from '../oracle-vector.mjs'
import { runMonitored } from '../vector-receipts.mjs'
import { arms, summarize } from './run.mjs'

for (const engine of ['hnswlib', 'usearch']) test(`${engine} preserves cosine results across save and reopen`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'warm-ann-competitor-'))
  try {
    const file = path.join(directory, 'index'), vectors = new Float32Array([1, 0, 0, 0, 1, 0, -1, 0, 0])
    const first = createIndex(engine, 3, 32, 3)
    first.build()
    for (let i = 0; i < 3; i++) first.add(i, vectors.subarray(i * 3, i * 3 + 3))
    first.ready()
    first.save(file)
    const reopened = createIndex(engine, 3, 32, 3)
    reopened.load(file)
    reopened.ready()
    assert.equal(Number(reopened.count()), 3)
    const query = new Float32Array([1, 0, 0]), hits = reopened.search(query, 3)
    validateHits(hits, vectors, query, 3, 3)
    assert.deepEqual(hits.map(hit => hit.ordinal), [0, 1, 2])
    assert.throws(() => validateHits([hits[0], hits[0], hits[2]], vectors, query, 3, 3))
    assert.throws(() => validateHits([hits[0], hits[1], { ordinal: 3, score: 0 }], vectors, query, 3, 3))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('quality gate requires the complete ordered query population', async () => {
  assert.deepEqual(arms.map(arm => `${arm.engine}-${arm.ef}`), ['hnswlib-128', 'hnswlib-256', 'hnswlib-512', 'hnswlib-2048', 'usearch-128', 'usearch-256', 'usearch-512', 'usearch-2048'])
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'warm-ann-summary-'))
  try {
    const file = path.join(directory, 'rows')
    const rows = Array.from({ length: 3 }, (_, query) => ({ type: 'query', query, queryId: `query-${query}`, recall: 1, correctness: true }))
    await fs.writeFile(file, rows.map(JSON.stringify).join('\n'))
    assert.equal((await summarize(file, { queryCount: 3 }, false)).qualityQualified, true)
    rows[2] = { ...rows[1] }
    await fs.writeFile(file, rows.map(JSON.stringify).join('\n'))
    await assert.rejects(summarize(file, { queryCount: 3 }, false))
    rows[2] = { type: 'query', query: 2, queryId: 'query-2', recall: 0.8, correctness: true }
    await fs.writeFile(file, rows.map(JSON.stringify).join('\n'))
    assert.equal((await summarize(file, { queryCount: 3 }, false)).qualityQualified, false)
    for (const belowPerfect of [99, 100, 101]) {
      const boundary = Array.from({ length: 1000 }, (_, query) => ({ type: 'query', query, queryId: `query-${query}`, recall: query >= 1000 - belowPerfect ? 0.9 : 1, correctness: true }))
      await fs.writeFile(file, boundary.map(JSON.stringify).join('\n'))
      assert.equal((await summarize(file, { queryCount: 1000 }, false)).qualityQualified, belowPerfect <= 100)
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('quality and timing workers preserve every query identity and reject duplicate oracle rows', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'warm-ann-worker-'))
  try {
    const rows = 12, queryCount = 20, dimensions = 3
    const corpus = new Float32Array(rows * dimensions)
    for (let i = 0; i < rows; i++) corpus.set([1, i / 10, 0.25], i * dimensions)
    const queries = new Float32Array(queryCount * dimensions)
    for (let i = 0; i < queryCount; i++) queries.set([1, i / 20, 0.25], i * dimensions)
    const corpusFile = path.join(directory, 'corpus'), queryFile = path.join(directory, 'queries'), oracle = path.join(directory, 'oracle')
    await fs.writeFile(corpusFile, Buffer.from(corpus.buffer))
    await fs.writeFile(queryFile, Buffer.from(queries.buffer))
    const references = []
    for (let i = 0; i < queryCount; i++) {
      const query = queries.subarray(i * dimensions, (i + 1) * dimensions)
      const hits = Array.from({ length: rows }, (_, ordinal) => ({ ordinal, score: scalarCosine(corpus.subarray(ordinal * dimensions, (ordinal + 1) * dimensions), query) }))
      hits.sort((a, b) => b.score - a.score || a.ordinal - b.ordinal)
      references.push(JSON.stringify({ type: 'oracle', dataset: `glove-${rows}`, state: 'baseline', filter: 'all', query: i, queryId: `query-${i}`, hits: hits.slice(0, 10) }))
    }
    await fs.writeFile(oracle, references.join('\n') + '\n')
    for (const engine of ['hnswlib', 'usearch']) {
      const base = { rows, queryCount, dimensions, engine, ef: 32, corpus: corpusFile, queries: queryFile, oracle, index: path.join(directory, `${engine}.index`) }
      for (const action of ['prepare', 'timing']) {
        const output = path.join(directory, `${engine}-${action}.ndjson`)
        await run({ ...base, action, output })
        const actual = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'query')
        assert.deepEqual(actual.map(row => row.query), Array.from({ length: queryCount }, (_, i) => i))
        assert.ok(actual.every(row => row.correctness && row.recall === 1))
      }
    }
    const output = path.join(directory, 'monitored.ndjson')
    const receipt = await runMonitored({
      worker: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
      job: { rows, queryCount, dimensions, engine: 'hnswlib', ef: 32, corpus: corpusFile, queries: queryFile, oracle, action: 'prepare', index: path.join(directory, 'monitored.index'), output },
      jobFile: path.join(directory, 'job.json'), receipt: path.join(directory, 'receipt.json'),
      hostFile: path.join(directory, 'host.ndjson'), deadline: Date.now() + 30_000,
    })
    assert.ok(receipt.complete, JSON.stringify(receipt))
    assert.equal((await summarize(output, { queryCount }, false)).queries, queryCount)
    await fs.appendFile(oracle, references[0] + '\n')
    await assert.rejects(run({ rows, queryCount, dimensions, engine: 'hnswlib', ef: 32, corpus: corpusFile, queries: queryFile, oracle, action: 'prepare', index: path.join(directory, 'bad.index'), output: path.join(directory, 'bad.ndjson') }))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
