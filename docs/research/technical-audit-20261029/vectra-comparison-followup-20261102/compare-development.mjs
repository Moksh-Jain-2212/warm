// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
const stopPath = path.resolve('docs/research/technical-audit-20261029/vectra-comparison-20261102/user-stop-receipt.json')
const stop = JSON.parse(await fs.readFile(stopPath, 'utf8'))
const oldRoot = '/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen/results'
const development = process.argv[2]
assert.ok(path.isAbsolute(development ?? ''), 'absolute development output required')
const finished = JSON.parse(await fs.readFile(path.join(development, 'finished.json'), 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = async (file, expected) => { const bytes = await fs.readFile(file); assert.equal(sha(bytes), expected); return bytes.toString('utf8').trim().split('\n').map(JSON.parse) }
const specs = [[10000, 128, '0027'], [10000, 256, '0028'], [10000, 512, '0029'], [100000, 128, '0037'], [100000, 256, '0038']]
const comparisons = []
for (const [rows, ef, id] of specs) {
  const name = `preparation-${id}-glove-${rows}-warm-quality.ndjson`
  const old = stop.trees.results.files.find(file => file.path === name)
  const latest = finished.results.find(result => result.rows === rows && result.ef === ef)
  assert.ok(old && latest)
  const before = (await read(path.join(oldRoot, name), old.sha256)).filter(row => row.type === 'query' && row.filter === 'all')
  const after = await read(latest.path, latest.sha256)
  assert.equal(before.length, 1000); assert.equal(after.length, 1000)
  let changedRankings = 0, improved = 0, degraded = 0
  for (let i = 0; i < 1000; i++) {
    assert.equal(before[i].query, i); assert.equal(after[i].query, i)
    const first = before[i].hits.map(hit => hit.ordinal)
    if (JSON.stringify(first) !== JSON.stringify(after[i].ids)) changedRankings++
    if (after[i].recall > before[i].oracleRecall) improved++
    if (after[i].recall < before[i].oracleRecall) degraded++
  }
  comparisons.push({ rows, ef, queries: 1000, changedRankings, improved, degraded, previousSha256: old.sha256, developmentSha256: latest.sha256 })
}
console.log(JSON.stringify({ scope: 'Offline comparison of previously saved, hash-verified query results; no new retrieval or timings.', priorStopReceiptSha256: sha(await fs.readFile(stopPath)), developmentReceiptSha256: sha(await fs.readFile(path.join(development, 'finished.json'))), comparisons }, null, 2))
