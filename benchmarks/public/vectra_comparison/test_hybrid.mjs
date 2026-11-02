// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { runWorker } from './hybrid-worker.mjs'
import { compareHybridPair, runHybridJob } from './hybrid-run.mjs'
import { createTokenCounter, eligibleDocuments, metadata, normalizeResults, openEngine,
  packContext, prepareEngine, qrelMetrics, queryEngine, sha256, textFile, validateData,
  validateResults } from './hybrid.mjs'

const vectraModule = process.env.VECTRA_MODULE
const warmModule = process.env.WARM_MODULE
const uvPath = process.env.UV_PATH ?? 'uv'
assert(vectraModule && warmModule, 'explicit local VECTRA_MODULE and WARM_MODULE are required; no downloads or skips')
const worker = new URL('./hybrid-worker.mjs', import.meta.url)
const data = validateData({
  embeddingSpace: { model: 'synthetic-hybrid-fixture', revision: '1', dimensions: 3 },
  documents: Array.from({ length: 24 }, (_, i) => ({ id: `d${i}`,
    text: `${i < 10 ? 'unrelated' : 'cellular'} document ${i}\nα café 🧬${i < 10 ? ' other' : ' cellular evidence treatment'}`,
    vector: i < 10 ? [1, (i + 1) / 100, 0] : [0, 1, (i + 1) / 100] })),
  queries: [{ id: 'q0', text: 'cellular treatment', vector: [1, 0, 0] }],
  qrels: { q0: { d12: 1, d20: 1 } },
}, true)

async function temporary(fn) {
  const root = await mkdtemp(join(tmpdir(), 'warm-hybrid-test-'))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true }) }
}

async function tokenFixture(root) {
  const path = join(root, 'tokenizer.json')
  const tokenizer = { version: '1.0', truncation: null, padding: null, added_tokens: [],
    normalizer: null, pre_tokenizer: { type: 'Whitespace' }, post_processor: null, decoder: null,
    model: { type: 'WordLevel', vocab: { '[UNK]': 0, a: 1, b: 2 }, unk_token: '[UNK]' } }
  const bytes = JSON.stringify(tokenizer)
  await writeFile(path, bytes)
  return { tokenizerPath: path, tokenizerSha256: sha256(bytes), uvPath }
}

async function child(root, name, config) {
  const configPath = join(root, `${name}.config.json`), output = join(root, `${name}.output.json`)
  await writeFile(configPath, JSON.stringify(config))
  const proc = spawn(process.execPath, [worker.pathname, configPath, output], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  proc.stdout.on('data', value => { stdout += value; if (stdout.length > 65536) proc.kill('SIGKILL') })
  proc.stderr.on('data', value => { stderr += value; if (stderr.length > 65536) proc.kill('SIGKILL') })
  const timer = setTimeout(() => proc.kill('SIGKILL'), 90000)
  try {
    const status = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', (code, signal) => resolve({ code, signal })) })
    assert.equal(status.signal, null, `${name} killed: ${stderr}`)
    assert.equal(status.code, 0, `${name}: ${stderr}`)
    assert.equal(stdout, '', 'worker stdout is not a result channel')
    const receipt = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(receipt.complete, true, JSON.stringify(receipt))
    return receipt
  } finally { clearTimeout(timer); if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL') }
}

test('context packing uses the actual concatenation and 4095/4096/4097 token boundary', async () => temporary(async root => {
  const spec = await tokenFixture(root)
  const count = await createTokenCounter(spec.uvPath, spec.tokenizerPath, spec.tokenizerSha256)
  try {
  for (const n of [4095, 4096, 4097]) {
    const texts = new Map([['x', Array(n).fill('a').join(' ')]])
    const packed = await packContext([{ documentId: 'x' }], texts, count)
    assert.equal(packed.ids.length, n <= 4096 ? 1 : 0)
    assert.equal(packed.tokens, n <= 4096 ? n : 0)
  }
  const packed = await packContext([{ documentId: 'x' }, { documentId: 'x' }, { documentId: 'y' }, { documentId: 'z' }],
    new Map([['x', 'a'], ['y', 'a b'], ['z', 'b']]), count, { maxTokens: 2 })
  assert.deepEqual(packed.ids, ['x'])
  assert.equal(packed.stoppedAt, 'y') // Stop at the first overflow; do not skip to a shorter document.
  assert.equal(packed.tokens, 1)
  } finally { await count.close() }
}))

test('pinned Qwen tokenizer handles synthetic Unicode and long input without truncation', async () => {
  const count = await createTokenCounter(uvPath, '/Volumes/A/hms-models/Qwen3-Embedding-0.6B/tokenizer.json',
    'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a')
  try {
    const texts = ['α café 🧬\n\ncellular treatment', '  spaces\tand\nnewlines', 'a'.repeat(4097), 'title\npassage.\n\ntitle two\npassage two.']
    const counts = []
    for (const text of texts) counts.push(await count(text))
    assert.deepEqual(counts, [9, 6, 513, 12])
    assert.equal(count.receipt.tokenizers, '0.23.3')
    assert(count.peakRssBytes > 0)
  } finally { await count.close() }
})

test('document cap boundaries and invalid ranking references fail explicitly', async () => {
  const count = async text => text.length
  for (const n of [19, 20, 21]) {
    const texts = new Map(Array.from({ length: n }, (_, i) => [`d${i}`, 'a']))
    const packed = await packContext([...texts.keys()].map(documentId => ({ documentId })), texts, count)
    assert.equal(packed.ids.length, Math.min(20, n))
  }
  await assert.rejects(packContext([{ documentId: 'missing' }], new Map(), count), /unknown document/)
})

test('qrel scores use eligible positives and distinct packed evidence', () => {
  const scores = qrelMetrics(['b', 'a'], { a: 2, b: 1, outside: 1 }, new Set(['a', 'b']))
  assert.equal(scores.recall, 1)
  assert(Math.abs(scores.ndcg - (1 + 3 / Math.log2(3)) / (3 + 1 / Math.log2(3))) < 1e-12)
  assert.equal(qrelMetrics([], { outside: 1 }, new Set(['a'])).recall, null)
  assert.throws(() => qrelMetrics(['a', 'a'], { a: 1 }, new Set(['a'])), /duplicate/)
})

test('synthetic data bounds and complete source-derived filters are enforced', () => {
  assert.equal(eligibleDocuments(data, 'ten-percent').length, 10)
  assert.equal(eligibleDocuments(data, 'one-percent').length, 1)
  assert.equal(eligibleDocuments(data, 'empty').length, 0)
  const broken = structuredClone(data); broken.documents[0].vector = [NaN, 0, 0]
  assert.throws(() => validateData(broken, true), /finite/)
  const md = metadata(1, 'unicode', 'a🧬')
  assert.equal(md.endPos, 2, 'Vectra inclusive UTF-16 offset, independent of WARM byte spans')
})

test('actual Vectra preserves semantic-then-keyword order and surfaces swallowed text failures', async () => temporary(async root => {
  const store = join(root, 'vectra')
  await prepareEngine('vectra', vectraModule, store, data)
  const context = await openEngine('vectra', vectraModule, store, data)
  const rows = normalizeResults(await queryEngine(context, data.queries[0], 'all'), 'vectra')
  validateResults(rows, context, data, 'all')
  assert(rows.length > 10, 'keyword evidence must survive beyond semantic K')
  assert(rows.slice(0, 10).every(row => !row.isBm25))
  assert(rows.slice(10).every(row => row.isBm25))
  assert.equal(context.state.reads, 14)
  await unlink(join(store, 'text', textFile('d12')))
  const damaged = normalizeResults(await queryEngine(context, data.queries[0], 'all'), 'vectra')
  assert.throws(() => validateResults(damaged, context, data, 'all'), /swallowed/)
}))

test('real engine preparation and quality use distinct processes with original Unicode text', async () => temporary(async root => {
  const fixturePath = join(root, 'fixture.json'), bytes = JSON.stringify(data)
  await writeFile(fixturePath, bytes)
  const token = await tokenFixture(root)
  for (const [engine, modulePath] of [['vectra', vectraModule], ['warm', warmModule]]) {
    const base = { purpose: 'synthetic-development', engine, modulePath, store: join(root, engine),
      fixturePath, fixtureSha256: sha256(bytes), ...token }
    const prepared = await child(root, `${engine}-prepare`, { ...base, phase: 'prepare' })
    const result = await child(root, `${engine}-quality`, { ...base, phase: 'quality' })
    assert.notEqual(prepared.pid, result.pid)
    assert.equal(result.timingsCollected, false)
    const all = result.observations.find(row => row.eligibility === 'all')
    assert(!all.engineError, JSON.stringify(all))
    assert(all.ranking.length > 10)
    assert(all.packed.tokens <= 4096 && all.packed.ids.length <= 20)
    const empty = result.observations.find(row => row.eligibility === 'empty')
    if (engine === 'vectra') {
      assert.match(empty.engineError.message, /too small for consolidation/)
      assert(result.failedQueries > 0, 'third-party limitation must remain a failed case')
      assert.equal(result.querySetComplete, false)
    } else {
      assert.deepEqual(empty.ranking, [])
      assert.equal(result.failedQueries, 0)
    }
  }
}))


test('measurement requires frozen source, coordinator admission and the monitored IPC parent', async () => {
  await assert.rejects(runWorker({ engine: 'warm', phase: 'timing', purpose: 'synthetic-development',
    modulePath: warmModule, store: '/unused-hybrid-fixture' }), /frozen monitored study controller/)
})

test('fast engine errors cannot enter successful quantiles or qualify a speed comparison', () => {
  const row = (queryId, ms) => ({ queryId, eligibility: 'all', ranked: { ndcg: 1, recall: 1 }, packed: { recall: 1 },
    rankingMs: ms, packingMs: 1, rankingAndPackingMs: ms + 1 })
  const base = { phase: 'timing', freezeSha256: 'same', timingsCollected: true }
  const vectra = { ...base, engine: 'vectra', observations: [row('q1', 10), row('q2', 20)] }
  const warm = { ...base, engine: 'warm', observations: [row('q1', 5), { queryId: 'q2', eligibility: 'all',
    engineError: { message: 'fast failure' }, errorElapsedMs: .01 }] }
  const result = compareHybridPair(vectra, warm, 'all')
  assert.equal(result.repetitionPass, false)
  assert.equal(result.sameSuccessfulSet, false)
  assert.equal(result.warmFailures, 1)
  assert.equal(result.latency.rankingMs.warm.p50, 5)
  assert.deepEqual(result.errorWallTimes.warm, [.01])
  assert.throws(() => compareHybridPair(vectra, { ...warm, observations: warm.observations.slice(0, 1) }, 'all'), /different declared/)
})


test('shared monitor runs a quality worker with IPC, descendant accounting and no development timings', async () => temporary(async root => {
  const fixturePath = join(root, 'fixture.json'), bytes = JSON.stringify(data)
  await writeFile(fixturePath, bytes)
  const token = await tokenFixture(root)
  const base = { purpose: 'synthetic-development', development: true, engine: 'vectra', modulePath: vectraModule,
    store: join(root, 'vectra'), fixturePath, fixtureSha256: sha256(bytes), ...token }
  await child(root, 'prepare', { ...base, phase: 'prepare' })
  const output = join(root, 'quality.json')
  const receipt = await runHybridJob({ job: { ...base, phase: 'quality', output },
    jobFile: join(root, 'quality-job.json'), receipt: join(root, 'monitor.json'),
    hostFile: join(root, 'host.jsonl'), deadline: Date.now() + 30000, quiet: false })
  assert.equal(receipt.complete, true)
  assert.equal(receipt.processColdOpenMs, null)
  assert.equal(receipt.elapsedMs, null)
  assert(receipt.events.some(event => event.type === 'opened'))
  const result = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(result.timingsCollected, false)
  assert(result.tokenizer.pid > 0 && result.tokenizer.peakRssBytes > 0)
  assert.equal(result.completedObservations, 4)
  assert.equal(result.querySetComplete, false)
}))


test('study data is never loaded when the frozen worker source hash changed', async () => temporary(async root => {
  const inputManifest = join(root, 'input.json')
  await writeFile(inputManifest, '{}')
  const frozen = { authorized: true, allowedPhases: ['quality'], inputManifestSha256: sha256('{}'), workerSha256: '0'.repeat(64) }
  const freezePath = join(root, 'freeze.json'), bytes = JSON.stringify(frozen)
  await writeFile(freezePath, bytes)
  await assert.rejects(runWorker({ purpose: 'frozen-study', phase: 'quality', engine: 'vectra', modulePath: vectraModule,
    store: join(root, 'not-created'), freezePath, freezeSha256: sha256(bytes), inputManifest }),
    error => error.code === 'ERR_ASSERTION' && error.actual === '0'.repeat(64))
}))
