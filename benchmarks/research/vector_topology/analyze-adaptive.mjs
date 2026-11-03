// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize } from '../../public/vectra_comparison/oracle-vector.mjs'
import { readJson, sha256, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const [traceRoot, unionRoot, output] = process.argv.slice(2)
assert.ok([traceRoot, unionRoot, output].every(value => path.isAbsolute(value ?? '')))
const trace = await readJson(path.join(traceRoot, 'finished.json')), union = await readJson(path.join(unionRoot, 'summary.json'))
assert.equal(trace.complete, true); assert.equal(union.postHoc, true)
assert.equal(await sha256(path.join(traceRoot, 'finished.json')), union.traceSummarySha256)
assert.equal(await sha256(trace.corpus), trace.corpusSha256); assert.equal(await sha256(trace.queries), trace.queriesSha256); assert.equal(await sha256(trace.oracle), trace.oracleSha256)
const record = trace.results.find(row => row.mode === 'degree64')
assert.ok(record); assert.equal(await sha256(record.output), record.sha256)
const rawUnion = path.join(unionRoot, 'queries.ndjson'); assert.equal(await sha256(rawUnion), union.rawSha256)
const [corpus, queries, traceText, unionText, oracleText] = await Promise.all([fs.readFile(trace.corpus), fs.readFile(trace.queries), fs.readFile(record.output, 'utf8'), fs.readFile(rawUnion, 'utf8'), fs.readFile(trace.oracle, 'utf8')])
assert.equal(corpus.length, 100000 * 100 * 4); assert.equal(queries.length, 1000 * 100 * 4)
const traces = traceText.trim().split('\n').map(JSON.parse).filter(row => row.type === 'trace' && row.ef === 512)
const unions = unionText.trim().split('\n').map(JSON.parse)
const truth = oracleText.trim().split('\n').map(JSON.parse).filter(row => row.type === 'oracle' && row.state === 'baseline' && row.filter === 'all')
assert.equal(traces.length, 1000); assert.equal(unions.length, 1000); assert.equal(truth.length, 1000)
const row = (buffer, id) => Array.from({ length: 100 }, (_, i) => buffer.readFloatLE((id * 100 + i) * 4))
const normalized = new Map()
const score = (id, query) => {
  if (!normalized.has(id)) normalized.set(id, Float32Array.from(normalize(row(corpus, id))))
  const vector = normalized.get(id); let result = 0
  for (let i = 0; i < 100; i++) result += vector[i] * query[i]
  return Math.max(-1, Math.min(1, result))
}
const data = traces.map((traceRow, query) => {
  assert.equal(traceRow.query, query); assert.equal(unions[query].query, query); assert.equal(truth[query].query, query)
  const q = normalize(row(queries, query)), candidates = traceRow.coded.shortlist
  assert.equal(candidates.length, 18); assert.equal(new Set(candidates).size, 18)
  const ranked = candidates.map(id => ({ id, score: score(id, q) })).sort((a, b) => b.score - a.score || a.id - b.id)
  assert.deepEqual(ranked.slice(0, 10).map(x => x.id), traceRow.coded.selected)
  const oracle = new Set(truth[query].hits.map(hit => hit.ordinal)), base = traceRow.coded.selected.filter(id => oracle.has(id)).length
  const merged = unions[query].cases['default2048+degree64']
  assert.equal(merged.matched, merged.selected.filter(id => oracle.has(id)).length); assert.ok(merged.matched >= base)
  return { query, baseMatched: base, unionMatched: merged.matched, features: { top1: ranked[0].score, top10: ranked[9].score, spread: ranked[0].score - ranked[9].score, cutoffGap: ranked[9].score - ranked[10].score } }
})
const policies = []
for (const feature of ['top1', 'top10', 'spread', 'cutoffGap']) for (const tail of ['low', 'high']) {
  const fit = data.slice(0, 500).map(item => item.features[feature]).sort((a, b) => tail === 'low' ? a - b : b - a)
  const threshold = fit[49], useFallback = item => tail === 'low' ? item.features[feature] <= threshold : item.features[feature] >= threshold
  const summarize = rows => {
    let fallbacks = 0, recovered = 0, total = 0, worst = 10
    for (const item of rows) { const fallback = useFallback(item); if (fallback) { fallbacks++; recovered += item.unionMatched - item.baseMatched }; const matched = fallback ? item.unionMatched : item.baseMatched; total += matched; worst = Math.min(worst, matched) }
    return { queries: rows.length, fallbacks, recovered, meanRecall: total / (rows.length * 10), worstRecall: worst / 10 }
  }
  policies.push({ feature, tail, threshold, fit: summarize(data.slice(0, 500)), evaluation: summarize(data.slice(500)) })
}
const ordered = policies.map((policy, order) => ({ policy, order })).sort((a, b) => b.policy.fit.recovered - a.policy.fit.recovered || a.policy.fit.fallbacks - b.policy.fit.fallbacks || a.order - b.order)
const selected = ordered[0].policy
const baseline = rows => ({ meanRecall: rows.reduce((sum, item) => sum + item.baseMatched, 0) / (rows.length * 10), worstRecall: Math.min(...rows.map(item => item.baseMatched)) / 10, missingNeighbors: rows.reduce((sum, item) => sum + 10 - item.baseMatched, 0) })
await fs.mkdir(output)
const sources = {}
for (const filename of ['ADAPTIVE-PLAN.md', 'analyze-adaptive.mjs']) {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), filename), target = path.join(output, filename)
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL); sources[filename] = await sha256(target)
}
const perQuery = data.map(item => ({ ...item, decisions: policies.map(policy => ({ feature: policy.feature, tail: policy.tail, fallback: policy.tail === 'low' ? item.features[policy.feature] <= policy.threshold : item.features[policy.feature] >= policy.threshold })) }))
const raw = path.join(output, 'queries.ndjson'); await fs.writeFile(raw, perQuery.map(item => JSON.stringify(item)).join('\n') + '\n', { flag: 'wx' })
await writeOnce(path.join(output, 'summary.json'), { scope: 'Post-hoc analysis on previously exposed queries; deterministic internal split is not held-out proof; no timings or new graph searches.', sources, traceSummarySha256: await sha256(path.join(traceRoot, 'finished.json')), unionSummarySha256: await sha256(path.join(unionRoot, 'summary.json')), querySha256: await sha256(raw), baseline: { fit: baseline(data.slice(0, 500)), evaluation: baseline(data.slice(500)) }, selected, policies })
