// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { dirname, resolve, join, isAbsolute } from 'node:path'

const require = createRequire(import.meta.url)
export const POLICY = Object.freeze({ semanticK: 10, hybridK: 20, candidateLimit: 100, tokens: 4096, fusion: 'rrf' })
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const textFile = id => `${sha256(id)}.txt`

export function metadata(ordinal, id, text) {
  const bucket100 = ordinal % 100
  return { documentId: id, startPos: 0, endPos: text.length - 1, bucket100, eligible10: bucket100 < 10, eligible1: bucket100 === 0 }
}

export function filterFor(name) {
  if (name === 'all') return undefined
  if (name === 'ten-percent') return { eligible10: true }
  if (name === 'one-percent') return { eligible1: true }
  if (name === 'empty') return { bucket100: -1 }
  throw new Error('unknown eligibility policy')
}

export function eligibleDocuments(data, name) {
  const filter = filterFor(name)
  return data.documents.filter((doc, ordinal) => {
    const md = metadata(ordinal, doc.id, doc.text)
    return !filter || Object.entries(filter).every(([key, value]) => md[key] === value)
  })
}

export function validateData(data, synthetic = false) {
  assert(data && Array.isArray(data.documents) && Array.isArray(data.queries))
  const width = data.embeddingSpace?.dimensions
  assert(Number.isInteger(width) && width > 0 && width <= 4096, 'embedding width')
  assert(typeof data.embeddingSpace.model === 'string' && typeof data.embeddingSpace.revision === 'string')
  assert(data.documents.length > 0 && data.queries.length > 0)
  if (synthetic) assert(data.documents.length <= 32 && data.queries.length <= 8 && width <= 32, 'synthetic fixture bounds')
  for (const rows of [data.documents, data.queries]) {
    const ids = new Set()
    for (const row of rows) {
      assert(typeof row.id === 'string' && row.id.length > 0 && !ids.has(row.id), 'unique nonempty IDs')
      assert(!row.id.includes('\0') && Buffer.byteLength(row.id) <= 1024, 'bounded ID')
      ids.add(row.id)
      assert(typeof row.text === 'string' && row.text.length > 0 && Buffer.byteLength(row.text) <= 65536, 'bounded text')
      assert(!row.text.isWellFormed || row.text.isWellFormed(), 'valid Unicode')
      assert(Array.isArray(row.vector) && row.vector.length === width, 'embedding length')
      assert(row.vector.every(Number.isFinite) && row.vector.some(value => value !== 0), 'finite nonzero embedding')
    }
  }
  const docs = new Set(data.documents.map(row => row.id))
  const queries = new Set(data.queries.map(row => row.id))
  assert(data.qrels && typeof data.qrels === 'object')
  for (const [qid, judgments] of Object.entries(data.qrels)) {
    assert(queries.has(qid), 'unknown qrel query')
    for (const [id, grade] of Object.entries(judgments)) assert(docs.has(id) && Number.isInteger(grade) && grade > 0, 'invalid qrel')
  }
  return data
}

async function checkedFile(path, hash, bytes) {
  assert(isAbsolute(path) && /^[a-f0-9]{64}$/.test(hash), 'absolute input path and SHA256 required')
  const stat = await lstat(path)
  assert(stat.isFile() && !stat.isSymbolicLink(), 'regular input file required')
  if (bytes !== undefined) assert.equal(stat.size, bytes, 'input size')
  assert(stat.size <= 64 * 1024 * 1024, 'input exceeds harness allocation bound')
  const value = await readFile(path)
  assert.equal(sha256(value), hash, `input hash: ${path}`)
  return value
}

export async function loadSciFact(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const input = manifest.scifact
  const mappingBytes = await checkedFile(resolve(dirname(manifestPath), input.mapping_manifest), input.mapping_manifest_sha256)
  const mapping = JSON.parse(mappingBytes)
  const raw = await checkedFile(join(input.directory, 'input.json'), input.files['input.json'].sha256)
  const data = JSON.parse(raw)
  for (const [field, file, expectedRows] of [['documents', 'generated/corpus.f32', 5183], ['queries', 'generated/queries.f32', 300]]) {
    const spec = input.files[file]
    assert.deepEqual(spec.shape, [expectedRows, 1024])
    const vectors = await checkedFile(join(input.directory, file), spec.sha256, expectedRows * 1024 * 4)
    assert.equal(data[field].length, expectedRows)
    const ids = field === 'documents' ? mapping.document_ids : mapping.query_ids
    const hashes = field === 'documents' ? mapping.document_text_sha256 : mapping.query_text_sha256
    data[field].forEach((row, i) => {
      assert.equal(row.id, ids[i], 'source row identity')
      assert.equal(sha256(row.text), hashes[i], 'source text identity')
      row.vector = Array.from({ length: 1024 }, (_, d) => vectors.readFloatLE((i * 1024 + d) * 4))
    })
  }
  data.embeddingSpace = { model: input.embedding_model, revision: input.effective_revision, dimensions: 1024 }
  data.qrels = mapping.qrels
  assert.equal(Object.values(data.qrels).reduce((n, row) => n + Object.keys(row).length, 0), 339)
  return validateData(data)
}

export async function createTokenCounter(uvPath, tokenizerPath, expectedHash, expectedRuntime = null) {
  await checkedFile(tokenizerPath, expectedHash)
  const child = spawn(uvPath, ['run', '--offline', '--no-project', '--with', 'tokenizers==0.23.3',
    'python', new URL('./hybrid-tokenizer.py', import.meta.url).pathname, tokenizerPath, expectedHash],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HF_HUB_OFFLINE: '1', RAYON_NUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1' } })
  let readyResolve, readyReject, buffer = '', stderr = '', sequence = 0, closed = false, readyReceived = false
  const pending = new Map()
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const exited = new Promise(resolve => child.once('close', resolve))
  const fail = error => {
    readyReject(error)
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error) }
    pending.clear()
  }
  const countTokens = text => new Promise((resolve, reject) => {
    if (closed || pending.size >= 32 || Buffer.byteLength(text) > 1400000) { reject(new Error('tokenizer request bound or closed process')); return }
    const id = sequence++
    const payload = `${JSON.stringify({ id, text })}\n`
    if (Buffer.byteLength(payload) > 2 * 1024 * 1024) { reject(new Error('tokenizer serialized request bound')); return }
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('tokenizer request timed out')); child.kill('SIGKILL') }, 30000)
    pending.set(id, { resolve, reject, timer })
    child.stdin.write(payload, error => { if (error) fail(error) })
  })
  countTokens.peakRssBytes = 0
  child.stdout.on('data', bytes => {
    buffer += bytes.toString('utf8')
    if (buffer.length > 65536) { fail(new Error('tokenizer output bound')); child.kill('SIGKILL'); return }
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      try {
        const result = JSON.parse(line)
        if (result.ready) {
          assert(!readyReceived, 'duplicate tokenizer readiness')
          readyReceived = true
          assert.equal(result.sha256, expectedHash)
          assert.equal(result.tokenizers, '0.23.3')
          if (expectedRuntime) { assert.equal(result.executable, expectedRuntime.executable); assert.equal(result.tokenizersRoot, expectedRuntime.tokenizersRoot); assert.equal(result.python, expectedRuntime.python); assert.deepEqual(result.virtualFiles, expectedRuntime.virtualFiles) }
          countTokens.receipt = result
          readyResolve()
        } else {
          assert(Number.isSafeInteger(result.count) && result.count >= 0 && Number.isFinite(result.peakRssBytes))
          const request = pending.get(result.id); assert(request, 'unexpected tokenizer response')
          pending.delete(result.id); clearTimeout(request.timer)
          countTokens.peakRssBytes = Math.max(countTokens.peakRssBytes, result.peakRssBytes)
          request.resolve(result.count)
        }
      } catch (error) { fail(error); child.kill('SIGKILL') }
    }
  })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-8192) })
  child.stdin.on('error', fail)
  child.once('error', fail)
  child.once('close', code => {
    closed = true
    if (code !== 0 || pending.size || !readyReceived) fail(new Error(`tokenizer exited (${code}): ${stderr}`))
  })
  countTokens.close = async () => {
    if (closed) return
    child.stdin.end('{"op":"close"}\n')
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    try { await exited } finally { clearTimeout(timer) }
  }
  const timer = setTimeout(() => { fail(new Error('tokenizer startup timed out')); child.kill('SIGKILL') }, 30000)
  try { await ready; return countTokens } catch (error) { await countTokens.close(); throw error }
  finally { clearTimeout(timer) }
}

export async function packContext(results, textById, countTokens, { maxDocuments = POLICY.hybridK, maxTokens = POLICY.tokens } = {}) {
  assert(Number.isInteger(maxDocuments) && maxDocuments > 0 && maxDocuments <= 20)
  assert(Number.isInteger(maxTokens) && maxTokens >= 0 && maxTokens <= 4096)
  const ids = [], seen = new Set()
  let text = '', tokens = 0, stoppedAt = null
  for (const result of results) {
    const id = result.documentId
    if (seen.has(id)) continue
    seen.add(id)
    assert(textById.has(id), 'ranking referenced an unknown document')
    if (ids.length === maxDocuments) break
    const next = text ? `${text}\n\n${textById.get(id)}` : textById.get(id)
    const count = await countTokens(next)
    assert(Number.isInteger(count) && count >= 0, 'invalid token count')
    if (count > maxTokens) { stoppedAt = id; break }
    ids.push(id); text = next; tokens = count
  }
  return { ids, tokens, unusedTokens: maxTokens - tokens, stoppedAt, textSha256: sha256(text) }
}

export function qrelMetrics(ids, judgments, eligibleIds, k = 10) {
  const positive = Object.entries(judgments ?? {}).filter(([id]) => eligibleIds.has(id))
  if (positive.length === 0) return { eligiblePositiveCount: 0, recall: null, ndcg: null }
  const grades = new Map(positive)
  const top = ids.slice(0, k)
  assert.equal(new Set(ids).size, ids.length, 'duplicate ranked documents')
  const dcg = top.reduce((sum, id, rank) => sum + ((2 ** (grades.get(id) ?? 0) - 1) / Math.log2(rank + 2)), 0)
  const ideal = positive.map(([, grade]) => grade).sort((a, b) => b - a).slice(0, k)
    .reduce((sum, grade, rank) => sum + ((2 ** grade - 1) / Math.log2(rank + 2)), 0)
  return { eligiblePositiveCount: positive.length, recall: top.filter(id => grades.has(id)).length / positive.length, ndcg: dcg / ideal }
}

export async function openVectra(modulePath, store, readerPath) {
  const { LocalIndex } = require(modulePath)
  const localRequire = createRequire(require.resolve(modulePath))
  const bm25 = localRequire('wink-bm25-text-search')
  const state = { reads: 0, bytes: 0, added: 0, errors: [] }
  const index = new LocalIndex(store, undefined, undefined, undefined, {
    docReader: async id => {
      state.reads++
      try {
        const bytes = await readFile(join(readerPath, textFile(id)))
        state.bytes += bytes.length
        return bytes.toString('utf8')
      } catch (error) { state.errors.push({ stage: 'read', id, code: error.code ?? error.name }); throw error }
    },
    bm25Factory: () => {
      const engine = bm25()
      const addDoc = engine.addDoc
      engine.addDoc = function (...args) {
        try { const result = addDoc.apply(this, args); state.added++; return result }
        catch (error) { state.errors.push({ stage: 'addDoc', code: error.name }); throw error }
      }
      return engine
    },
  })
  return { index, state }
}

export function loadedNativeAddon(modulePath) {
  const { WarmMemorySystem } = require(modulePath)
  const matches = Object.values(require.cache).filter(entry => entry.filename.endsWith('.node') && entry.exports.WarmMemorySystem === WarmMemorySystem)
  assert.equal(matches.length, 1, 'exactly one loaded WARM native addon must be identifiable')
  return matches[0].filename
}

export async function prepareEngine(engine, modulePath, store, data) {
  validateData(data)
  await mkdir(store) // An existing destination is always rejected.
  if (engine === 'vectra') {
    const readerPath = join(store, 'text')
    await mkdir(readerPath)
    for (const doc of data.documents) await writeFile(join(readerPath, textFile(doc.id)), doc.text, { flag: 'wx' })
    const { index } = await openVectra(modulePath, join(store, 'index'), readerPath)
    await index.createIndex()
    await index.beginUpdate()
    for (const [ordinal, doc] of data.documents.entries()) {
      await index.insertItem({ id: doc.id, vector: doc.vector, metadata: metadata(ordinal, doc.id, doc.text) })
    }
    await index.endUpdate()
    return { acknowledged: true, explicitFlush: 'not exposed by Vectra', textReader: 'uncached filesystem per request' }
  }
  assert.equal(engine, 'warm')
  const { WarmMemorySystem } = require(modulePath)
  const space = data.embeddingSpace
  const index = new WarmMemorySystem(1024, join(store, 'index'), {
    embeddingModel: space.model, embeddingRevision: space.revision, embeddingDimensions: space.dimensions,
  })
  for (let offset = 0; offset < data.documents.length; offset += 100) {
    const docs = data.documents.slice(offset, offset + 100).map((doc, i) => ({
      id: doc.id, text: doc.text, version: 'fixture-v1', metadata: metadata(offset + i, doc.id, doc.text),
      chunkWords: 4096, overlapWords: 0, storeText: true, embeddings: [doc.vector],
    }))
    const counts = await index.memorizeDocuments(docs)
    assert(counts.every(count => count === 1), 'one chunk per original document required')
  }
  await index.flush()
  return { acknowledged: true, explicitFlush: 'completed', textReader: 'native retained-text cache' }
}

export async function openEngine(engine, modulePath, store, data) {
  if (engine === 'vectra') {
    const context = await openVectra(modulePath, join(store, 'index'), join(store, 'text'))
    await context.index.getIndexStats()
    return { ...context, engine }
  }
  assert.equal(engine, 'warm')
  const { WarmMemorySystem } = require(modulePath)
  const space = data.embeddingSpace
  return { engine, index: new WarmMemorySystem(1024, join(store, 'index'), {
    embeddingModel: space.model, embeddingRevision: space.revision, embeddingDimensions: space.dimensions,
  }) }
}

export async function queryEngine(context, query, eligibility) {
  const filter = filterFor(eligibility)
  if (context.engine === 'warm') {
    const rows = await context.index.searchDocuments(query.text, {
      k: POLICY.hybridK, candidateLimit: POLICY.candidateLimit, embedding: query.vector,
      lexicalWeight: 1, semanticWeight: 1, fusion: POLICY.fusion, filter,
    })
    return rows
  }
  const state = context.state
  state.reads = 0; state.bytes = 0; state.added = 0; state.errors.length = 0
  const rows = await context.index.queryItems(query.vector, query.text, POLICY.semanticK, filter, true)
  return rows
}

export function normalizeResults(rows, engine) {
  if (engine === 'warm') return rows.map(row => ({ documentId: row.documentId, score: row.score,
    lexicalScore: row.lexicalScore, semanticScore: row.semanticScore, text: row.text,
    startByte: row.startByte, endByte: row.endByte }))
  assert.equal(engine, 'vectra')
  return rows.map(row => ({ documentId: row.item.metadata.documentId, score: row.score,
    isBm25: row.item.metadata.isBm25 === true, itemId: row.item.id }))
}

export function validateResults(rows, context, data, eligibility) {
  const eligible = new Set(eligibleDocuments(data, eligibility).map(doc => doc.id))
  const sources = new Map(data.documents.map(doc => [doc.id, doc.text]))
  assert(rows.length <= 20 && rows.length <= eligible.size, 'ranking output bound')
  assert.equal(new Set(rows.map(row => row.documentId)).size, rows.length, 'duplicate returned document')
  for (const row of rows) {
    assert(eligible.has(row.documentId) && Number.isFinite(row.score), 'invalid ranking or post-top-k filter')
    if (context.engine === 'warm') {
      assert(row.text === sources.get(row.documentId), 'retained original text mismatch')
      assert.equal(row.startByte, 0)
      assert.equal(row.endByte, Buffer.byteLength(row.text))
    }
  }
  if (context.engine === 'vectra') {
    assert.deepEqual(context.state.errors, [], 'Vectra swallowed a document preparation failure')
    assert.equal(context.state.reads, context.state.added, 'every text read must reach BM25')
    const semantic = rows.filter(row => !row.isBm25)
    assert.equal(semantic.length, Math.min(10, eligible.size), 'complete semantic shortlist')
    assert(rows.slice(0, semantic.length).every(row => !row.isBm25), 'actual append order changed')
    assert.equal(context.state.reads, Math.max(0, eligible.size - semantic.length), 'complete BM25 eligibility')
  }
  return eligible
}
