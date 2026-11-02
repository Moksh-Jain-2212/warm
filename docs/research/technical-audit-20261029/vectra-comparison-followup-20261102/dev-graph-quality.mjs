// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { append, cloneStore, manifest, readJson, sha256, writeOnce } from '../../../../benchmarks/public/vectra_comparison/vector-receipts.mjs'
import { atLeast, mean, metadata, recallAtK, scalarCosine } from '../../../../benchmarks/public/vectra_comparison/oracle-vector.mjs'

const require = createRequire(import.meta.url)
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..')
const old = '/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen'
const input = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/inputs.json'))
const stopped = await readJson(path.join(repo, 'docs/research/technical-audit-20261029/vectra-comparison-20261102/user-stop-receipt.json'))
const output = process.argv[2]
assert.ok(path.isAbsolute(output ?? ''), 'provide a fresh absolute output directory')
assert.equal(await sha256(path.join(input.glove.directory, 'train.f32')), input.glove.files['train.f32'].sha256)
assert.equal(await sha256(path.join(input.glove.directory, 'test.f32')), input.glove.files['test.f32'].sha256)
const { VectraMigrationIndex } = require(path.join(repo, 'vectra.js'))
const native = require(path.join(repo, 'index.js'))
const loaded = Object.values(require.cache).filter(item => item.filename.endsWith('.node') && item.exports === native)
assert.equal(loaded.length, 1)
const provenance = { node: process.version, addon: loaded[0].filename, addonSha256: await sha256(loaded[0].filename), scriptSha256: await sha256(new URL(import.meta.url).pathname), corpusSha256: input.glove.files['train.f32'].sha256, queriesSha256: input.glove.files['test.f32'].sha256, scope: 'Development recall diagnostic using previously exposed GloVe queries; no timings or competitive claims.' }
await fs.mkdir(output)
await writeOnce(path.join(output, 'started.json'), provenance)
const corpusBuffer = await fs.readFile(path.join(input.glove.directory, 'train.f32')), queriesBuffer = await fs.readFile(path.join(input.glove.directory, 'test.f32'))
const corpus = new Float32Array(corpusBuffer.buffer, corpusBuffer.byteOffset, corpusBuffer.length / 4), queries = new Float32Array(queriesBuffer.buffer, queriesBuffer.byteOffset, queriesBuffer.length / 4)
const results = []
for (const rows of [10000, 100000]) {
  const referenceFile = stopped.trees.results.files.find(entry => entry.path.endsWith(`glove-${rows}-oracle-oracle.ndjson`))
  assert.ok(referenceFile)
  const oracle = path.join(old, 'results', referenceFile.path)
  assert.equal(await sha256(oracle), referenceFile.sha256)
  const truth = new Map()
  for (const line of (await fs.readFile(oracle, 'utf8')).split('\n')) {
    if (!line) continue
    const row = JSON.parse(line)
    if (row.type !== 'oracle' || row.state !== 'baseline' || row.filter !== 'all') continue
    assert.equal(row.dataset, `glove-${rows}`); assert.equal(row.queryId, `query-${row.query}`)
    assert.ok(Number.isInteger(row.query) && row.query >= 0 && row.query < 1000 && !truth.has(row.query))
    truth.set(row.query, row.hits.map(hit => hit.ordinal))
  }
  assert.equal(truth.size, 1000)
  const source = path.join(old, 'fixtures', `glove-${rows}`, 'warm'), destination = path.join(output, `store-${rows}`)
  const sourceManifest = await manifest(source)
  await cloneStore(output, source, destination)
  const copiedManifest = await manifest(destination)
  const files = value => value.files.filter(file => path.basename(file.path) !== '.hms.lock').map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  assert.deepEqual(files(sourceManifest), files(copiedManifest), 'fixture copy differs')
  await writeOnce(path.join(output, `fixture-${rows}.json`), { source, destination, sourceFiles: files(sourceManifest), oracleSha256: referenceFile.sha256 })
  const index = await VectraMigrationIndex.open({ path: destination })
  await index.maintainIndices()
  for (const ef of [128, 256, 512]) {
    const file = path.join(output, `glove-${rows}-ef${ef}.ndjson`)
    await fs.writeFile(file, '', { flag: 'wx' })
    const recalls = []
    for (let query = 0; query < 1000; query++) {
      const q = Array.from(queries.subarray(query * 100, (query + 1) * 100))
      const found = await index.queryItems(q, { mode: 'graph', k: 10, ef })
      assert.equal(found.diagnostics.route, 'fullGraph'); assert.equal(found.results.length, 10)
      assert.ok(found.results.every((hit, i) => i === 0 || found.results[i - 1].score >= hit.score), 'graph results out of order')
      const ids = found.results.map(({ item, score }) => {
        assert.match(item.id, /^row-\d{8}$/)
        const ordinal = Number(item.id.slice(4))
        assert.ok(ordinal < rows)
        assert.deepEqual(item.metadata, metadata(ordinal))
        const vector = corpus.subarray(ordinal * 100, (ordinal + 1) * 100)
        assert.deepEqual(item.vector, Array.from(vector))
        assert.ok(Math.abs(score - scalarCosine(vector, q)) <= 2e-6)
        return ordinal
      })
      assert.equal(new Set(ids).size, ids.length)
      const recall = recallAtK(ids, truth.get(query)); recalls.push(recall)
      await append(file, { query, queryId: `query-${query}`, ids, recall, route: found.diagnostics.route, shortlist: found.diagnostics.shortlistLimit })
    }
    const average = mean(recalls), worst = Math.min(...recalls)
    const result = { rows, ef, meanRecall: average, worstRecall: worst, below90: recalls.filter(recall => !atLeast(recall, .9)).length, passes: atLeast(average, .99) && atLeast(worst, .9), path: file, sha256: await sha256(file) }
    results.push(result); await append(path.join(output, 'progress.ndjson'), result)
  }
}
await writeOnce(path.join(output, 'finished.json'), { ...provenance, results })
