// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { select } = require('./vectra-selector.js')

const PROFILE = 'vectra-migration.json'
const MAX_IDS = 1_048_576
const MAX_BYTES = 8 * 1024 * 1024
const MAX_VALUES = 1_048_576
const MAX_OPS = 4096
const ATTEMPTS = 3
const FILTER_CACHE_ENTRIES = 8
const FILTER_CACHE_BYTES = 2 * 1024 * 1024
const FILTER_CACHE_IDS = 100_000
const PRIVATE = Symbol('owned migration store')
const bytes = value => Buffer.byteLength(value, 'utf8')
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be an integer in ${min}..${max}`)
  return value
}
function id(value) {
  if (typeof value !== 'string' || !value || bytes(value) > 65523 || value.includes('\0') || /[\uD800-\uDFFF]/u.test(value) || /^hms:(chunk|meaning):/.test(value)) {
    throw new TypeError('id must contain 1..65523 valid UTF-8 bytes, no NUL or reserved prefix')
  }
  return value
}
function revision(value) {
  if (value !== undefined && (typeof value !== 'string' || !value || bytes(value) > 256)) throw new TypeError('ifRevision must be a nonempty opaque token of at most 256 bytes')
  return value
}
function json(value, name, limit = 64 * 1024) {
  let nodes = 0
  let size = 0
  const seen = new Set()
  function charge(length) {
    size += length
    if (size > limit) throw new RangeError(`${name} exceeds ${limit} bytes`)
  }
  function clone(current, depth) {
    if (++nodes > 16384 || depth > 32) throw new RangeError(`${name} exceeds JSON depth or node limits`)
    if (typeof current === 'string' && /[\uD800-\uDFFF]/u.test(current)) throw new TypeError(`${name} must contain valid Unicode strings`)
    if (typeof current === 'string' && bytes(current) > limit) throw new RangeError(`${name} exceeds ${limit} bytes`)
    if (current === null || typeof current === 'string' || typeof current === 'boolean' || (typeof current === 'number' && Number.isFinite(current))) {
      charge(bytes(JSON.stringify(current)))
      return current
    }
    if (typeof current !== 'object' || seen.has(current)) throw new TypeError(`${name} must be finite, acyclic JSON`)
    const prototype = Object.getPrototypeOf(current)
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) throw new TypeError(`${name} must be plain JSON`)
    seen.add(current)
    const result = Array.isArray(current) ? [] : Object.create(null)
    const entries = Object.keys(current)
    charge(2 + Math.max(0, entries.length - 1))
    for (const key of entries) {
      if (!Array.isArray(current)) {
        if (/[\uD800-\uDFFF]/u.test(key)) throw new TypeError(`${name} must contain valid Unicode keys`)
        if (bytes(key) > limit) throw new RangeError(`${name} exceeds ${limit} bytes`)
        charge(bytes(JSON.stringify(key)) + 1)
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (!descriptor || !own(descriptor, 'value')) throw new TypeError(`${name} must not contain accessors`)
      Object.defineProperty(result, key, { value: clone(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true })
    }
    if (Array.isArray(current)) for (let i = 0; i < current.length; i++) if (!own(current, i)) throw new TypeError(`${name} must not contain sparse arrays`)
    seen.delete(current)
    return result
  }
  const encoded = JSON.stringify(clone(value, 0))
  if (bytes(encoded) > limit) throw new RangeError(`${name} exceeds ${limit} bytes`)
  return JSON.parse(encoded)
}
function metadata(value = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('metadata must be a JSON object')
  return json(value, 'metadata')
}
function vector(value, dimensions) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw new TypeError('vector must be an array of finite numbers')
  if (value.length !== dimensions) throw new RangeError(`vector must have ${dimensions} dimensions`)
  const copy = Array.from(value)
  if (!copy.every(v => typeof v === 'number' && Number.isFinite(v)) || !copy.some(v => v !== 0)) {
    throw new TypeError('vector must contain finite numbers and have nonzero norm')
  }
  return copy
}
function keys(value = []) {
  if (!Array.isArray(value) || value.length > 4096 || value.some(key => typeof key !== 'string')) throw new TypeError('indexedMetadata must be an array of strings')
  return json(value, 'indexedMetadata', 8192)
}
function view(value, indexed) {
  if (!indexed.length) return value
  return Object.fromEntries(indexed.filter(key => own(value, key)).map(key => [key, value[key]]))
}
function wrap(value, indexedView) {
  const result = { warmVectraMigration: 1, metadata: value }
  if (!isDeepStrictEqual(value, indexedView)) result.indexedMetadata = indexedView
  return result
}
function unwrap(record, includeVector = true) {
  const envelope = record.metadata
  if (envelope?.warmVectraMigration !== 1 || !envelope.metadata || typeof envelope.metadata !== 'object' || Array.isArray(envelope.metadata)) {
    throw new Error('store contains a record outside the Vectra migration profile')
  }
  if (includeVector && !Array.isArray(record.vector)) throw new Error('native record omitted its original vector')
  return { id: record.id, ...(includeVector ? { vector: record.vector } : {}), metadata: envelope.metadata }
}
function cleanConflict(error) {
  return typeof error?.message === 'string' && /^vector record revision conflict\b/.test(error.message)
}
function nativeFilter(filter) {
  const scalar = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  const entries = Object.keys(filter)
  if (entries.length === 0 || entries.length > 64) return undefined
  const result = Object.create(null)
  for (const key in filter) {
    if (!own(filter, key) || key in Object.prototype || key === '$and' || key === '$or') return undefined
    const value = filter[key]
    if (scalar(value)) result[key] = value
    else {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !own(value, '$eq') || !scalar(value.$eq)) return undefined
      for (const operator in value) if (operator !== '$eq') return undefined
      result[key] = value.$eq
    }
  }
  return result
}
function addBudget(budget, operation) {
  const item = operation.record
  const next = {
    operations: budget.operations + 1,
    ids: budget.ids + bytes(item ? item.id : operation.id),
    values: budget.values + (item?.vector.length ?? 0),
    metadata: budget.metadata + (item ? bytes(JSON.stringify(item.metadata)) : 0),
  }
  if (next.operations > MAX_OPS || next.ids > MAX_BYTES || next.values > MAX_VALUES || next.metadata > MAX_BYTES) {
    throw new RangeError('transaction exceeds 4096 operations, 1048576 vector values or 8 MiB ID/metadata limits')
  }
  return next
}
const emptyBudget = () => ({ operations: 0, ids: 0, values: 0, metadata: 0 })

async function writeProfile(directory, profile) {
  const temporary = path.join(directory, `.${PROFILE}.${randomUUID()}`)
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(profile))
    await handle.sync()
  } finally { await handle.close() }
  try {
    await fs.rename(temporary, path.join(directory, PROFILE))
    if (process.platform !== 'win32') {
      const parent = await fs.open(directory, 'r')
      try { await parent.sync() } finally { await parent.close() }
    }
  }
  catch (error) { await fs.rm(temporary, { force: true }); throw error }
}
function configuration(options) {
  if (!options || typeof options.path !== 'string' || !options.path) throw new TypeError('path is required')
  const space = options.embeddingSpace
  if (!space || typeof space.model !== 'string' || !space.model || typeof space.revision !== 'string' || !space.revision) {
    throw new TypeError('embeddingSpace requires model, revision and dimensions')
  }
  integer(space.dimensions, 1, 65536, 'embedding dimensions')
  const profile = {
    version: 1, state: 'importing', source: 'vectra-0.15',
    embeddingSpace: { model: space.model, revision: space.revision, dimensions: space.dimensions },
    dimensions: integer(options.dimensions ?? 1024, 1, 1_048_576, 'memory dimensions'),
    indexedMetadata: keys(options.indexedMetadata),
  }
  if ((options.candidateDimensions === undefined) !== (options.rerankCandidates === undefined)) throw new TypeError('candidateDimensions and rerankCandidates must be supplied together')
  if (options.candidateDimensions !== undefined) {
    profile.candidateDimensions = integer(options.candidateDimensions, 1, space.dimensions, 'candidate dimensions')
    profile.rerankCandidates = integer(options.rerankCandidates, 1, 4096, 'rerank candidates')
  }
  if (options.highRecall !== undefined) {
    if (typeof options.highRecall !== 'boolean') throw new TypeError('highRecall must be boolean')
    profile.highRecall = options.highRecall
  }
  return json(profile, 'migration profile', 16384)
}
function nativeSystem(directory, profile, native) {
  const { WarmMemorySystem } = require('./index.js')
  for (const method of ['mutateVectorRecords', 'getVectorRecord', 'listVectorRecords', 'queryVectorRecords']) {
    if (typeof WarmMemorySystem.prototype[method] !== 'function') throw new Error('native vector-record API unavailable; build the updated warm-sdk')
  }
  const space = profile.embeddingSpace
  return new WarmMemorySystem(profile.dimensions, directory, {
    ...native, vectorRecords: true,
    embeddingModel: space.model, embeddingRevision: space.revision, embeddingDimensions: space.dimensions,
    vectorCandidateDimensions: profile.candidateDimensions, vectorRerankCandidates: profile.rerankCandidates,
    vectorHighRecall: profile.highRecall,
  })
}

class VectraMigrationIndex {
  #system
  #profile
  #path
  #pending = 0
  #tail = Promise.resolve()
  #readers = new Set()
  #filterCache = new Map()
  #filterCacheBytes = 0
  #filterCacheRevision
  #maxPending
  #transaction

  constructor(token, system, profile, directory, maxPending) {
    if (token !== PRIVATE) throw new TypeError('use VectraMigrationIndex.create or open')
    this.#system = system
    this.#profile = profile
    this.#path = directory
    this.#maxPending = integer(maxPending ?? 32, 1, 4096, 'maxPending')
  }
  static async #create(options, importing) {
    const profile = configuration(options)
    const directory = path.resolve(options.path)
    integer(options.maxPending ?? 32, 1, 4096, 'maxPending')
    await fs.mkdir(directory, { mode: 0o700 })
    await writeProfile(directory, profile)
    try {
      const system = nativeSystem(directory, profile, options.native)
      const index = new VectraMigrationIndex(PRIVATE, system, profile, directory, options.maxPending)
      if (!importing) {
        profile.state = 'ready'
        await system.flush()
        await writeProfile(directory, profile)
      }
      return index
    } catch (error) {
      profile.state = 'failed'
      await writeProfile(directory, profile)
      throw error
    }
  }
  static create(options) { return this.#create(options, false) }
  static async open(options) {
    if (!options || typeof options.path !== 'string' || !options.path) throw new TypeError('path is required')
    const directory = path.resolve(options.path)
    integer(options.maxPending ?? 32, 1, 4096, 'maxPending')
    const file = await fs.open(path.join(directory, PROFILE), 'r')
    let profile
    try {
      if ((await file.stat()).size > 16384) throw new RangeError('migration profile exceeds 16 KiB')
      profile = JSON.parse(await file.readFile('utf8'))
    } finally { await file.close() }
    if (!profile || profile.version !== 1 || profile.state !== 'ready' || profile.source !== 'vectra-0.15') throw new Error('migration store is incomplete or has an unsupported profile')
    const checked = configuration({ path: directory, ...profile })
    checked.state = 'ready'
    return new VectraMigrationIndex(PRIVATE, nativeSystem(directory, checked, options.native), checked, directory, options.maxPending)
  }
  static async importItems(items, options) {
    const index = await this.#create(options, true)
    let count = 0
    try {
      let operations = []
      let estimate = 0
      let values = 0
      const commit = async () => {
        if (operations.length) await index.#system.mutateVectorRecords(operations)
        count += operations.length
        operations = []; estimate = 0; values = 0
      }
      for await (const input of items) {
        const record = index.#record(input, true)
        // Bounds the encoded archive, indexed f32 values and metadata conservatively;
        // native validation still enforces its exact per-item and transaction limits.
        const size = bytes(JSON.stringify(record.metadata)) + bytes(record.id) + record.vector.length * 40 + 1024
        if (operations.length && (operations.length >= 128 || estimate + size > 4 * 1024 * 1024 || values + record.vector.length > MAX_VALUES)) await commit()
        operations.push({ op: 'insert', record }); estimate += size; values += record.vector.length
      }
      await commit()
      await index.#system.flush()
      index.#profile.state = 'ready'
      index.#profile.importedItems = count
      await writeProfile(index.#path, index.#profile)
      return { index, importedItems: count }
    } catch (error) {
      index.#profile.state = 'failed'
      index.#profile.importedItems = count
      await writeProfile(index.#path, index.#profile)
      throw error
    }
  }
  get path() { return this.#path }
  #enqueue(operation, read = false) {
    if (this.#pending >= this.#maxPending) return Promise.reject(new Error('migration queue is full; await pending operations'))
    this.#pending++
    const result = (read ? this.#tail : Promise.all([this.#tail, ...this.#readers])).then(operation)
    const settled = result.then(() => undefined, () => undefined)
    if (read) {
      this.#readers.add(settled)
      settled.then(() => this.#readers.delete(settled))
    } else {
      this.#readers.clear()
      this.#tail = settled
    }
    return result.finally(() => { this.#pending-- })
  }
  #committed() {
    if (this.#transaction) throw new Error('commit or cancel the staged transaction before reading or maintaining the index')
  }
  #clearFilterCache() {
    this.#filterCache.clear()
    this.#filterCacheBytes = 0
    this.#filterCacheRevision = undefined
  }
  #cachedFilter(key, ifRevision) {
    const cached = this.#filterCache.get(key)
    if (!cached || (ifRevision !== undefined && ifRevision !== cached.revision)) return undefined
    this.#filterCache.delete(key)
    this.#filterCache.set(key, cached)
    return cached
  }
  #rememberFilter(key, revision, ids, idBytes) {
    if (this.#filterCacheRevision !== revision) {
      this.#clearFilterCache()
      this.#filterCacheRevision = revision
    }
    const size = bytes(key) + idBytes
    if (ids.length > FILTER_CACHE_IDS || size > FILTER_CACHE_BYTES) return
    const existing = this.#filterCache.get(key)
    if (existing) {
      this.#filterCache.delete(key)
      this.#filterCacheBytes -= existing.size
    }
    while (this.#filterCache.size >= FILTER_CACHE_ENTRIES || this.#filterCacheBytes + size > FILTER_CACHE_BYTES) {
      const oldest = this.#filterCache.keys().next().value
      const entry = this.#filterCache.get(oldest)
      if (!entry) throw new Error('filter cache accounting invariant failed')
      this.#filterCache.delete(oldest)
      this.#filterCacheBytes -= entry.size
    }
    this.#filterCache.set(key, { revision, ids, size })
    this.#filterCacheBytes += size
  }
  #record(input, importing = false) {
    if (!input || typeof input !== 'object') throw new TypeError('item is required')
    if (input.metadataFile !== undefined) throw new TypeError('resolve external Vectra metadata before importing; use importVectraIndex')
    const original = metadata(input.metadata)
    const indexed = importing && input.indexedMetadata !== undefined ? metadata(input.indexedMetadata) : view(original, this.#profile.indexedMetadata)
    return { id: id(input.id), vector: vector(input.vector, this.#profile.embeddingSpace.dimensions), metadata: wrap(original, indexed) }
  }
  #operation(operation) {
    if (!operation || typeof operation !== 'object') throw new TypeError('operation is required')
    if (operation.op === 'delete') return { op: 'delete', id: id(operation.id) }
    if (operation.op === 'insert' || operation.op === 'upsert') return { op: operation.op, record: this.#record(operation.record) }
    throw new TypeError('operation must be insert, upsert or delete')
  }
  #write(operation) {
    return this.#enqueue(async () => {
      if (this.#transaction) {
        const budget = addBudget(this.#transaction.budget, operation)
        this.#transaction.operations.push(operation)
        this.#transaction.budget = budget
      } else await this.#system.mutateVectorRecords([operation])
    })
  }
  insertItem(item) { return this.#write({ op: 'insert', record: this.#record(item) }) }
  upsertItem(item) { return this.#write({ op: 'upsert', record: this.#record(item) }) }
  deleteItem(itemId) { return this.#write({ op: 'delete', id: id(itemId) }) }
  applyBatch(operations, options = {}) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > MAX_OPS) throw new RangeError('batch requires 1..4096 operations')
    const prepared = []
    let budget = emptyBudget()
    for (const operation of operations) {
      const item = this.#operation(operation)
      budget = addBudget(budget, item)
      prepared.push(item)
    }
    const ifRevision = revision(options.ifRevision)
    return this.#enqueue(() => {
      this.#committed()
      return this.#system.mutateVectorRecords(prepared, { ifRevision })
    })
  }
  beginUpdate() {
    return this.#enqueue(async () => {
      if (this.#transaction) throw new Error('update already in progress')
      const page = await this.#system.listVectorRecords({ limit: 1, includeVectors: false })
      this.#transaction = { revision: page.revision, operations: [], budget: emptyBudget() }
    })
  }
  endUpdate() {
    return this.#enqueue(async () => {
      if (!this.#transaction) throw new Error('no update in progress')
      const transaction = this.#transaction
      this.#transaction = undefined
      if (!transaction.operations.length) return { revision: transaction.revision, outcomes: [] }
      return this.#system.mutateVectorRecords(transaction.operations, { ifRevision: transaction.revision })
    })
  }
  cancelUpdate() { return this.#enqueue(() => { this.#transaction = undefined }) }
  getItem(itemId, options = {}) {
    id(itemId)
    const ifRevision = revision(options.ifRevision)
    return this.#enqueue(async () => {
      this.#committed()
      const result = await this.#system.getVectorRecord(itemId, { ifRevision })
      return result.record ? unwrap(result.record) : undefined
    }, true)
  }
  listItems(options = {}) {
    const limit = integer(options.limit ?? 100, 1, 1000, 'page limit')
    const includeVectors = options.includeVectors ?? true
    if (typeof includeVectors !== 'boolean') throw new TypeError('includeVectors must be boolean')
    const from = options.from === undefined ? undefined : id(options.from)
    const ifRevision = revision(options.ifRevision)
    return this.#enqueue(async () => {
      this.#committed()
      const page = await this.#system.listVectorRecords({ from, limit, includeVectors, ifRevision })
      return { revision: page.revision, items: page.records.map(record => unwrap(record, includeVectors)), nextFrom: page.nextFrom }
    }, true)
  }
  queryItems(query, options = {}) {
    const queryVector = vector(query, this.#profile.embeddingSpace.dimensions)
    const k = integer(options.k ?? 10, 1, 1000, 'k')
    const ef = integer(options.ef ?? 128, 1, 4096, 'ef')
    const mode = options.mode ?? 'exact'
    if (!['exact', 'auto', 'graph'].includes(mode)) throw new TypeError('mode must be exact, auto or graph')
    const minScore = options.minScore ?? -1
    if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1) throw new RangeError('minScore must be finite in [-1,1]')
    const filter = options.filter == null ? undefined : json(options.filter, 'filter')
    if (filter !== undefined && (typeof filter !== 'object' || Array.isArray(filter))) throw new TypeError('filter must be a JSON object')
    let explicit
    if (options.documentIds !== undefined) {
      if (!Array.isArray(options.documentIds) || options.documentIds.length > MAX_IDS) throw new TypeError('documentIds must be an array of at most 1048576 IDs')
      const unique = new Set()
      let totalBytes = 0
      for (const value of options.documentIds) {
        const item = id(value)
        if (!unique.has(item)) {
          totalBytes += bytes(item)
          if (totalBytes > MAX_BYTES) throw new RangeError('eligible IDs exceed resource limits')
          unique.add(item)
        }
      }
      explicit = [...unique]
    }
    const ifRevision = revision(options.ifRevision)
    return this.#enqueue(async () => {
      this.#committed()
      const nativeOptions = { k, mode, ef, minScore, documentIds: explicit, ifRevision }
      if (!filter || Object.keys(filter).length === 0 || explicit?.length === 0) return this.#query(queryVector, nativeOptions)
      const indexed = typeof this.#system.queryVectraRecords === 'function' && nativeFilter(filter)
      if (indexed) {
        try { return await this.#query(queryVector, nativeOptions, indexed) }
        catch (error) {
          if (error?.message !== 'native Vectra filter unavailable') throw error
        }
      }
      const allowed = explicit && new Set(explicit)
      const filterKey = explicit ? undefined : JSON.stringify(filter)
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        try {
          const cached = filterKey === undefined ? undefined : this.#cachedFilter(filterKey, ifRevision)
          if (cached) {
            return await this.#query(queryVector, { ...nativeOptions, documentIds: cached.ids, ifRevision: cached.revision })
          }
          let revision = ifRevision
          let from
          let totalBytes = 0
          const eligible = []
          do {
            const page = await this.#system.listVectorRecords({ from, limit: 1000, includeVectors: false, ifRevision: revision })
            if (typeof page.revision !== 'string' || !page.revision) throw new Error('native listing omitted its revision')
            if (revision !== undefined && page.revision !== revision) throw new Error('native listing returned an inconsistent revision')
            revision = page.revision
            for (const record of page.records) {
              const original = unwrap(record, false)
              if ((!allowed || allowed.has(record.id)) && select(record.metadata.indexedMetadata ?? original.metadata, filter)) {
                totalBytes += bytes(record.id)
                if (eligible.length === MAX_IDS || totalBytes > MAX_BYTES) throw new RangeError('eligible IDs exceed resource limits')
                eligible.push(record.id)
              }
            }
            if (page.nextFrom !== null && (typeof page.nextFrom !== 'string' || page.nextFrom === from)) throw new Error('native listing cursor did not advance')
            from = page.nextFrom
          } while (from !== null)
          if (filterKey !== undefined) this.#rememberFilter(filterKey, revision, eligible, totalBytes)
          return await this.#query(queryVector, { ...nativeOptions, documentIds: eligible, ifRevision: revision })
        } catch (error) {
          if (cleanConflict(error)) this.#clearFilterCache()
          if (ifRevision !== undefined || !cleanConflict(error) || attempt === ATTEMPTS - 1) throw error
        }
      }
      throw new Error('unreachable query retry state')
    }, true)
  }
  async #query(query, options, filter) {
    const { k, ...nativeOptions } = options
    const result = filter === undefined
      ? await this.#system.queryVectorRecords(query, k, nativeOptions)
      : await this.#system.queryVectraRecords(query, k, filter, nativeOptions)
    if (options.ifRevision !== undefined && result.revision !== options.ifRevision) throw new Error('native query returned an inconsistent revision')
    return { ...result, results: result.results.map(hit => ({ item: unwrap(hit.item), score: hit.score })) }
  }
  flush() { return this.#enqueue(() => { this.#committed(); return this.#system.flush() }) }
  maintainIndices() { return this.#enqueue(() => { this.#committed(); return this.#system.maintainIndices() }) }
}

const importVectraItems = (items, options) => VectraMigrationIndex.importItems(items, options)
function metadataFilename(file) {
  if (typeof file !== 'string' || !file || bytes(file) > 255 ||
      /[\\/:<>"|?*\u0000-\u001f]/.test(file) || /[\uD800-\uDFFF]/u.test(file) || /[. ]$/.test(file) ||
      /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])[ ]*(?:\.|$)/i.test(file)) {
    throw new TypeError('invalid external metadata filename')
  }
  return file
}
async function importVectraIndex(source, options) {
  if (!source || typeof source.listItems !== 'function' || typeof source.getIndexStats !== 'function') throw new TypeError('a Vectra 0.15 LocalIndex source is required')
  const stats = await source.getIndexStats()
  const items = await source.listItems()
  for (const item of items) if (item.metadataFile !== undefined) metadataFilename(item.metadataFile)
  async function* resolved() {
    for (const item of items) {
      let original = item.metadata
      if (item.metadataFile !== undefined) {
        const file = metadataFilename(item.metadataFile)
        const data = await source.storage.readFile(path.join(source.folderPath, file))
        if (data.byteLength > 64 * 1024) throw new RangeError('external metadata exceeds 64 KiB')
        original = source.codec.deserializeMetadata(data)
      }
      yield { id: item.id, vector: item.vector, metadata: original, indexedMetadata: item.metadata }
    }
  }
  return importVectraItems(resolved(), { ...options, indexedMetadata: stats.metadata_config?.indexed ?? [] })
}

module.exports = { VectraMigrationIndex, importVectraItems, importVectraIndex }
