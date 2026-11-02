// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

export async function runHybridJob({ job, ...monitorOptions }) {
  const { runMonitored } = await import('./vector-receipts.mjs')
  assert(job && ['prepare', 'quality', 'timing'].includes(job.phase))
  assert.equal(job.development, job.purpose === 'synthetic-development')
  if (job.phase === 'timing') assert.equal(monitorOptions.quiet, true, 'timing must retain continuous host monitoring')
  return runMonitored({ ...monitorOptions, worker: fileURLToPath(new URL('./hybrid-worker.mjs', import.meta.url)),
    job: { ...job, monitorPid: process.pid } })
}

function average(values) {
  const finite = values.filter(value => value !== null)
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null
}

function percentiles(values) {
  assert(values.every(value => Number.isFinite(value) && value >= 0))
  const sorted = [...values].sort((a, b) => a - b)
  return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, sorted[Math.ceil(p / 100 * sorted.length) - 1] ?? null]))
}

export function compareHybridPair(vectra, warm, eligibility) {
  assert.equal(vectra.engine, 'vectra'); assert.equal(warm.engine, 'warm')
  assert.equal(vectra.phase, warm.phase)
  assert.equal(vectra.freezeSha256, warm.freezeSha256)
  const select = receipt => receipt.observations.filter(row => !row.warmup && row.eligibility === eligibility)
  const v = select(vectra), w = select(warm)
  for (const rows of [v, w]) assert.equal(new Set(rows.map(row => row.queryId)).size, rows.length)
  const declaredV = v.map(row => row.queryId).sort(), declaredW = w.map(row => row.queryId).sort()
  assert.deepEqual(declaredV, declaredW, 'different declared query populations')
  const successful = rows => rows.filter(row => !row.engineError)
  const vs = successful(v), ws = successful(w)
  const sameSuccessfulSet = JSON.stringify(vs.map(row => row.queryId).sort()) === JSON.stringify(ws.map(row => row.queryId).sort())
  const complete = v.length > 0 && vs.length === v.length && ws.length === w.length
  const metric = (rows, field) => average(rows.map(row => field(row)))
  const quality = Object.fromEntries([['ndcg10', row => row.ranked.ndcg], ['recall10', row => row.ranked.recall],
    ['packedRecall', row => row.packed.recall]].map(([name, get]) => {
    const a = metric(vs, get), b = metric(ws, get)
    return [name, { vectra: a, warm: b, pass: a !== null && b !== null && b >= a - .01 }]
  }))
  const timing = vectra.timingsCollected && warm.timingsCollected
  const latency = timing ? Object.fromEntries(['rankingMs', 'packingMs', 'rankingAndPackingMs'].map(field => {
    const a = percentiles(vs.map(row => row[field])), b = percentiles(ws.map(row => row[field]))
    return [field, { vectra: a, warm: b,
      ratios: Object.fromEntries(Object.keys(a).map(key => [key, a[key] > 0 && b[key] !== null ? b[key] / a[key] : null])) }]
  })) : null
  const ratios = latency?.rankingAndPackingMs.ratios
  return { eligibility, declaredQueries: v.length, vectraFailures: v.length - vs.length, warmFailures: w.length - ws.length,
    sameSuccessfulSet, complete, quality, latency,
    errorWallTimes: timing ? { vectra: v.filter(row => row.engineError).map(row => row.errorElapsedMs), warm: w.filter(row => row.engineError).map(row => row.errorElapsedMs) } : null,
    repetitionPass: Boolean(complete && sameSuccessfulSet && Object.values(quality).every(metric => metric.pass)
      && ratios && ratios.p50 !== null && ratios.p50 <= .90 && ratios.p95 <= .90 && ratios.p99 <= 1.05),
    note: 'A recommendation requires all three distinct frozen repetitions plus the complete quality gate; errors never enter successful latency quantiles.' }
}
