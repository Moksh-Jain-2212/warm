// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, sha256, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const [root, output] = process.argv.slice(2)
assert.ok(path.isAbsolute(root ?? '') && path.isAbsolute(output ?? ''))
const finished = await readJson(path.join(root, 'finished.json'))
assert.equal(finished.complete, true)
const results = []
for (const result of finished.results) {
  assert.equal(await sha256(result.output), result.sha256)
  const rows = (await fs.readFile(result.output, 'utf8')).trim().split('\n').map(JSON.parse).filter(row => row.type === 'trace')
  for (const cell of result.cells) {
    const traces = rows.filter(row => row.ef === cell.ef)
    assert.equal(traces.length, 1000)
    let missedByBoth = 0, missedByCodedOnly = 0, missedByExactOnly = 0, queriesDiffer = 0
    traces.forEach((row, i) => {
      assert.equal(row.query, i)
      const coded = new Set(row.coded.oracleCoverage[0]), exact = new Set(row.exactRouting.oracleCoverage[0])
      const codedOnly = [...exact].filter(id => !coded.has(id)).length
      const exactOnly = [...coded].filter(id => !exact.has(id)).length
      assert.ok(codedOnly <= row.coded.classes[0] && exactOnly <= row.exactRouting.classes[0])
      const shared = row.coded.classes[0] - codedOnly
      assert.equal(shared, row.exactRouting.classes[0] - exactOnly)
      missedByBoth += shared; missedByCodedOnly += codedOnly; missedByExactOnly += exactOnly
      if (codedOnly || exactOnly) queriesDiffer++
    })
    assert.equal(missedByBoth + missedByCodedOnly, cell.classes.coded[0])
    assert.equal(missedByBoth + missedByExactOnly, cell.classes.exactRouting[0])
    results.push({ mode: result.mode, ef: cell.ef, missedByBoth, missedByCodedOnly, missedByExactOnly, queriesDiffer })
  }
}
await writeOnce(output, { sourceSummary: path.join(root, 'finished.json'), sourceSummarySha256: await sha256(path.join(root, 'finished.json')), scriptSha256: await sha256(fileURLToPath(import.meta.url)), interpretation: 'Exact routing is a same-topology diagnostic counterfactual, not the production path or a held-out result.', results })
