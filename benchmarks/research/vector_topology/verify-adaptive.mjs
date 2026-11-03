// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, sha256, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const root = process.argv[2]
assert.ok(path.isAbsolute(root ?? ''))
const summaryPath = path.join(root, 'summary.json'), summary = await readJson(summaryPath), raw = path.join(root, 'queries.ndjson')
assert.equal(await sha256(raw), summary.querySha256)
const rows = (await fs.readFile(raw, 'utf8')).trim().split('\n').map(JSON.parse)
assert.equal(rows.length, 1000)
rows.forEach((row, i) => { assert.equal(row.query, i); assert.ok(Number.isInteger(row.baseMatched) && row.baseMatched >= 0 && row.baseMatched <= 10); assert.ok(Number.isInteger(row.unionMatched) && row.unionMatched >= row.baseMatched && row.unionMatched <= 10) })
const policyOrder = ['top1', 'top10', 'spread', 'cutoffGap'].flatMap(feature => ['low', 'high'].map(tail => ({ feature, tail })))
assert.equal(summary.policies.length, policyOrder.length)
for (const [index, policy] of summary.policies.entries()) {
  const { feature, tail } = policyOrder[index]
  assert.equal(policy.feature, feature); assert.equal(policy.tail, tail)
  const fitting = rows.slice(0, 500).map(row => row.features[feature]).sort((a, b) => tail === 'low' ? a - b : b - a)
  assert.equal(policy.threshold, fitting[49])
  for (const [name, partition] of [['fit', rows.slice(0, 500)], ['evaluation', rows.slice(500)]]) {
    const chosen = partition.filter(row => tail === 'low' ? row.features[feature] <= policy.threshold : row.features[feature] >= policy.threshold)
    const chosenIds = new Set(chosen.map(row => row.query))
    const matched = partition.map(row => chosenIds.has(row.query) ? row.unionMatched : row.baseMatched)
    const expected = { queries: 500, fallbacks: chosen.length, recovered: chosen.reduce((sum, row) => sum + row.unionMatched - row.baseMatched, 0), meanRecall: matched.reduce((sum, value) => sum + value, 0) / 5000, worstRecall: Math.min(...matched) / 10 }
    assert.deepEqual(policy[name], expected)
    for (const row of partition) assert.equal(row.decisions[index].fallback, chosenIds.has(row.query))
  }
}
const selected = summary.policies.map((policy, order) => ({ policy, order })).sort((a, b) => b.policy.fit.recovered - a.policy.fit.recovered || a.policy.fit.fallbacks - b.policy.fit.fallbacks || a.order - b.order)[0].policy
assert.deepEqual(summary.selected, selected)
await writeOnce(path.join(root, 'verification.json'), { verifiedQueries: rows.length, verifiedPolicies: policyOrder.length, selected: { feature: selected.feature, tail: selected.tail, threshold: selected.threshold }, summarySha256: await sha256(summaryPath), scriptSha256: await sha256(fileURLToPath(import.meta.url)) })
