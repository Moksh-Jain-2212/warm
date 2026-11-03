// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, sha256, writeOnce } from '../../public/vectra_comparison/vector-receipts.mjs'

const [root, output] = process.argv.slice(2)
assert.ok(path.isAbsolute(root ?? '') && path.isAbsolute(output ?? ''))
const finished = await readJson(path.join(root, 'finished.json'))
assert.equal(finished.complete, true); assert.equal(finished.results.length, 2)
const pids = {}, results = []
for (const result of finished.results) {
  assert.deepEqual(result.jobs.map(job => job.action), ['update', 'reopen'])
  const stages = {}, probes = {}, memory = {}
  for (const job of result.jobs) {
    assert.equal(await sha256(job.output), job.sha256)
    assert.equal(job.receipt.complete, true)
    pids[job.receipt.pid] = { mode: result.mode, action: job.action, samples: 0, maxExternalCpuFraction: 0, samplesAbove20Percent: 0 }
    memory[job.action] = job.receipt.peakOwnedTreeRssBytes
    for (const stage of job.stages) {
      assert.ok(Number.isSafeInteger(stage.ns) && stage.ns >= 0)
      stages[stage.name] = stage.ns
      if (stage.name === 'batch-upsert-100') {
        assert.equal(stage.value.outcomes.length, 100)
        stage.value.outcomes.forEach((outcome, i) => { assert.equal(outcome.op, 'upsert'); assert.equal(outcome.id, `row-${String(i).padStart(8, '0')}`); assert.equal(outcome.created, false) })
      }
      if (['validate-before', 'validate-after', 'validate-reopened'].includes(stage.name)) assert.equal(stage.value.records, 100)
      if (Array.isArray(stage.value)) probes[stage.name] = stage.value.map(row => ({ query: row.query, graphNs: row.graphNs, exactNs: row.exactNs, route: row.graphDiagnostics.route, matched: row.matched }))
    }
  }
  results.push({ mode: result.mode, stagesNs: stages, sampledPeakOwnedTreeRssBytes: memory, probes })
}
for await (const line of readline.createInterface({ input: createReadStream(path.join(root, 'host.ndjson')) })) {
  const row = JSON.parse(line), summary = pids[row.workerPid]
  if (row.type !== 'worker-resource' || !summary) continue
  assert.ok(Number.isFinite(row.externalCpuFraction) && row.externalCpuFraction >= 0)
  summary.samples++; summary.maxExternalCpuFraction = Math.max(summary.maxExternalCpuFraction, row.externalCpuFraction)
  if (row.externalCpuFraction > .20) summary.samplesAbove20Percent++
}
for (const item of Object.values(pids)) assert.ok(item.samples > 0, 'missing host observation')
await writeOnce(output, { sourceSummary: path.join(root, 'finished.json'), sourceSummarySha256: await sha256(path.join(root, 'finished.json')), scriptSha256: await sha256(fileURLToPath(import.meta.url)), interpretation: 'Shared-host development, one batch per arm and three previously exposed correctness probes; not qualified benchmark results.', results, host: pids })
