// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'

export const EPSILON = 2e-6
export const FILTERS = Object.freeze([
  { name: 'all', filter: undefined },
  { name: '10pct', filter: { eligible10: true } },
  { name: '1pct', filter: { eligible1: true } },
  { name: 'empty', filter: { bucket100: -1 } },
])
export function metadata(ordinal, epoch = 0) {
  return { ordinal, bucket100: ordinal % 100, eligible10: ordinal % 100 < 10, eligible1: ordinal % 100 === 0, epoch }
}
export function eligible(ordinal, name) {
  if (name === 'all') return true
  if (name === '10pct') return ordinal % 100 < 10
  if (name === '1pct') return ordinal % 100 === 0
  if (name === 'empty') return false
  throw new Error(`unknown filter ${name}`)
}
export function normalize(vector) {
  assert.ok(vector.length > 0 && Array.from(vector).every(Number.isFinite), 'nonfinite/empty oracle vector')
  let scale = 0
  for (const value of vector) scale = Math.max(scale, Math.abs(value))
  assert.ok(scale > 0, 'zero oracle vector')
  let norm = 0
  for (const value of vector) norm += (value / scale) ** 2
  norm = Math.sqrt(norm)
  return Float64Array.from(vector, value => (value / scale) / norm)
}
export function normalizeRows(values, dimensions) {
  assert.ok(Number.isSafeInteger(dimensions) && dimensions > 0 && values.length % dimensions === 0)
  const out = new Float64Array(values.length)
  for (let offset = 0; offset < values.length; offset += dimensions) out.set(normalize(values.subarray(offset, offset + dimensions)), offset)
  return out
}
export function scoreCosine(normalizedRows, dimensions, row, normalizedQuery) {
  let dot = 0
  for (let column = 0; column < dimensions; column++) dot += normalizedRows[row * dimensions + column] * normalizedQuery[column]
  return dot
}
// Independent scalar reference uses scaled numerator and norms, without storing normalized rows.
export function scalarCosine(left, right) {
  assert.equal(left.length, right.length)
  const a = Math.max(...Array.from(left, Math.abs)), b = Math.max(...Array.from(right, Math.abs))
  assert.ok(a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b))
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < left.length; i++) { const x = left[i] / a, y = right[i] / b; dot += x * y; aa += x * x; bb += y * y }
  return dot / Math.sqrt(aa * bb)
}
export function liveState(count, churn = false) {
  const changed = Math.min(100, Math.floor(count / 10))
  return Array.from({ length: count }, (_, ordinal) => ({ ordinal, row: churn && ordinal < changed ? ordinal + 1 : ordinal, deleted: churn && ordinal >= changed && ordinal < 2 * changed, epoch: churn && ordinal < changed ? 1 : 0 }))
}
export function oracleTopK(rows, dimensions, query, state, filter = 'all', k = 10) {
  const normalizedQuery = normalize(query), best = []
  let eligibleCount = 0
  for (const item of state) {
    if (item.deleted || !eligible(item.ordinal, filter)) continue
    eligibleCount++
    const hit = { ordinal: item.ordinal, score: scoreCosine(rows, dimensions, item.row, normalizedQuery) }
    let index = best.length
    while (index > 0 && (hit.score > best[index - 1].score || (hit.score === best[index - 1].score && hit.ordinal < best[index - 1].ordinal))) index--
    if (index < k) { best.splice(index, 0, hit); if (best.length > k) best.pop() }
  }
  return { hits: best, eligibleCount, cutoff: best.at(-1)?.score ?? null }
}
export function auditExact(actual, truth, scoreForOrdinal, eligibleOrdinals, epsilon = EPSILON) {
  const failures = [], expected = truth.hits.map(hit => hit.ordinal), returned = actual.map(hit => hit.ordinal)
  if (actual.length !== Math.min(10, truth.eligibleCount)) failures.push('result-count')
  if (new Set(returned).size !== returned.length) failures.push('duplicate-id')
  let maxScoreError = 0
  for (let i = 0; i < actual.length; i++) {
    const hit = actual[i]
    if (!eligibleOrdinals.has(hit.ordinal)) { failures.push(`ineligible:${hit.ordinal}`); continue }
    const error = Math.abs(hit.score - scoreForOrdinal(hit.ordinal))
    if (!Number.isFinite(hit.score) || !Number.isFinite(error)) failures.push(`nonfinite:${hit.ordinal}`)
    else { maxScoreError = Math.max(maxScoreError, error); if (error > epsilon) failures.push(`score:${hit.ordinal}`) }
    if (i && actual[i - 1].score < hit.score) failures.push(`score-order:${i}`)
    if (i && scoreForOrdinal(actual[i - 1].ordinal) + epsilon < scoreForOrdinal(hit.ordinal)) failures.push(`oracle-order:${i}`)
  }
  const missed = expected.filter(id => !returned.includes(id)), substitutes = returned.filter(id => !expected.includes(id))
  const boundary = missed.length === substitutes.length && [...missed, ...substitutes].every(id => Math.abs(scoreForOrdinal(id) - truth.cutoff) <= epsilon)
  if (missed.length && !boundary) failures.push('non-boundary-membership')
  return { pass: failures.length === 0, strictAgreement: JSON.stringify(expected) === JSON.stringify(returned), maxScoreError, missed, substitutes, tieBoundarySubstitutions: boundary ? substitutes.length : 0, failures }
}
export function recallAtK(actual, expected) {
  if (!expected.length) return null
  const ids = new Set(actual)
  return expected.filter(id => ids.has(id)).length / expected.length
}
export function qrelMetrics(ids, qrels, eligibleIds) {
  const relevant = [...qrels].filter(([id, relevance]) => relevance > 0 && eligibleIds.has(id))
  if (!relevant.length) return { ndcg10: null, recall10: null, eligibleJudgments: 0 }
  const gain = relevance => 2 ** relevance - 1
  const ideal = relevant.map(([, relevance]) => relevance).sort((a, b) => b - a).slice(0, 10).reduce((sum, relevance, rank) => sum + gain(relevance) / Math.log2(rank + 2), 0)
  const top = ids.slice(0, 10)
  const dcg = top.reduce((sum, id, rank) => sum + gain(qrels.get(id) ?? 0) / Math.log2(rank + 2), 0)
  return { ndcg10: dcg / ideal, recall10: top.filter(id => (qrels.get(id) ?? 0) > 0).length / relevant.length, eligibleJudgments: relevant.length }
}
export function nearestRank(values, probability) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)]
}
export function mean(values) {
  if (!values.length) return null
  let sum = 0, correction = 0
  for (const value of values) {
    const adjusted = value - correction, next = sum + adjusted
    correction = (next - sum) - adjusted
    sum = next
  }
  return sum / values.length
}
export function atLeast(value, threshold) {
  return Number.isFinite(value) && Number.isFinite(threshold) && (value >= threshold || threshold - value <= 4 * Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(threshold)))
}
export function latency(values) {
  return { count: values.length, p50: nearestRank(values, .5), p95: nearestRank(values, .95), p99: nearestRank(values, .99) }
}
