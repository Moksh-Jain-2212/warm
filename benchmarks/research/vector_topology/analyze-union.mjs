// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize } from '../../public/vectra_comparison/oracle-vector.mjs'
import { readJson, sha256, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const [traceRoot, output] = process.argv.slice(2)
assert.ok(path.isAbsolute(traceRoot ?? '') && path.isAbsolute(output ?? ''))
const finished = await readJson(path.join(traceRoot, 'finished.json'))
assert.equal(finished.complete, true)
assert.equal(await sha256(finished.corpus), finished.corpusSha256)
assert.equal(await sha256(finished.queries), finished.queriesSha256)
assert.equal(await sha256(finished.oracle), finished.oracleSha256)
const [corpus, queries] = await Promise.all([fs.readFile(finished.corpus), fs.readFile(finished.queries)])
assert.equal(corpus.length, 100000 * 100 * 4); assert.equal(queries.length, 1000 * 100 * 4)
const truth = (await fs.readFile(finished.oracle, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'oracle' && row.state === 'baseline' && row.filter === 'all')
assert.equal(truth.length, 1000); truth.forEach((row, i) => assert.equal(row.query, i))
const byMode = {}
for (const result of finished.results) {
  assert.equal(await sha256(result.output), result.sha256)
  byMode[result.mode] = (await fs.readFile(result.output, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'trace')
}
const rows = (bytes, index) => Array.from({ length: 100 }, (_, i) => bytes.readFloatLE((index * 100 + i) * 4))
const vectors = new Map()
const normalizedRow = id => {
  if (!vectors.has(id)) vectors.set(id, Float32Array.from(normalize(rows(corpus, id))))
  return vectors.get(id)
}
const ranked = (ids, query) => ids.map(id => {
  const vector = normalizedRow(id); let score = 0
  for (let i = 0; i < 100; i++) score += vector[i] * query[i]
  return { id, score: Math.max(-1, Math.min(1, score)) }
}).sort((a, b) => b.score - a.score || a.id - b.id).map(row => row.id)
await fs.mkdir(output)
const raw = path.join(output, 'queries.ndjson'), file = await fs.open(raw, 'wx')
const totals = { 'default512+degree64': { matched: 0, worst: 10, queriesWithMisses: 0 }, 'default2048+degree64': { matched: 0, worst: 10, queriesWithMisses: 0 } }
try {
  for (let query = 0; query < 1000; query++) {
    const find = (mode, ef) => { const row = byMode[mode].find(value => value.query === query && value.ef === ef); assert.ok(row); return row.coded.selected }
    const default512 = find('default', 512), default2048 = find('default', 2048), degree64 = find('degree64', 512), q = normalize(rows(queries, query))
    for (const ids of [default512, default2048, degree64]) assert.deepEqual(ranked(ids, q), ids, `rescoring does not reproduce selected order for query ${query}`)
    const cases = {}
    for (const [name, first] of [['default512+degree64', default512], ['default2048+degree64', default2048]]) {
      const union = [...new Set([...first, ...degree64])], selected = ranked(union, q).slice(0, 10)
      const matched = selected.filter(id => truth[query].hits.some(hit => hit.ordinal === id)).length
      totals[name].matched += matched; totals[name].worst = Math.min(totals[name].worst, matched)
      if (matched < 10) totals[name].queriesWithMisses++
      cases[name] = { candidateCount: union.length, selected, matched }
    }
    await file.writeFile(`${JSON.stringify({ query, cases })}\n`)
  }
} finally { await file.close() }
const results = Object.fromEntries(Object.entries(totals).map(([name, value]) => [name, { meanRecall: value.matched / 10000, worstRecall: value.worst / 10, queriesWithMisses: value.queriesWithMisses }]))
await writeOnce(path.join(output, 'summary.json'), { postHoc: true, scope: 'Offline recombination of already observed top-ten IDs with canonical-style f64 rescoring; no new graph search or latency measurement; queries are exposed.', traceSummarySha256: await sha256(path.join(traceRoot, 'finished.json')), sourceSha256: await sha256(fileURLToPath(import.meta.url)), rawSha256: await sha256(raw), results })
