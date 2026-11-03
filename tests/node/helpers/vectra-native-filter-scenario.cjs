// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { VectraMigrationIndex, importVectraItems } = require('../../../vectra.js')
const { WarmMemorySystem } = require('../../../index.js')
const { ItemSelector } = require('../../fixtures/vectra-0.15/ItemSelector.js')
const [phase, root] = process.argv.slice(2)
const directory = path.join(root, 'index')
const options = { path: directory, embeddingSpace: { model: 'synthetic-native-filter', revision: '1', dimensions: 3 } }
const query = [1, 0.125, 0]
const record = (id, metadata = {}, vector = [1, 0, 0]) => ({ id, metadata, vector })
const ids = result => result.results.map(hit => hit.item.id)

function monitor() {
  const list = WarmMemorySystem.prototype.listVectorRecords
  const native = WarmMemorySystem.prototype.queryVectraRecords
  assert.equal(typeof native, 'function', 'build the native filtered-query API before running these tests')
  const state = { pages: 0, queries: 0, system: undefined }
  WarmMemorySystem.prototype.listVectorRecords = async function (...args) {
    state.pages++
    return list.apply(this, args)
  }
  WarmMemorySystem.prototype.queryVectraRecords = async function (...args) {
    state.queries++
    state.system = this
    return native.apply(this, args)
  }
  state.restore = () => {
    WarmMemorySystem.prototype.listVectorRecords = list
    WarmMemorySystem.prototype.queryVectraRecords = native
  }
  return state
}

async function parity(index, items, filter, options = {}) {
  const eligible = items.filter(item =>
    (!options.documentIds || options.documentIds.includes(item.id)) &&
    ItemSelector.select(item.indexedMetadata ?? item.metadata, filter),
  ).map(item => item.id)
  const expected = await index.queryItems(query, { ...options, k: options.k ?? 1000, mode: 'exact', documentIds: eligible })
  const actual = await index.queryItems(query, { ...options, k: options.k ?? 1000, filter })
  assert.deepEqual(actual.results, expected.results, JSON.stringify(filter))
  assert.equal(actual.revision, expected.revision)
  return actual
}

function fixture() {
  const values = [5, '5', 1, 15, null, true, '15', -0, {}, [5], -1, false, 0.25, Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1]
  const items = values.map((n, i) => record(`value-${String(i).padStart(2, '0')}`, { n, group: `g${i % 10}`, 'a.b': 'literal', '': 'empty', '色': '青', $gt: 'ordinary' }, [1, (i % 3) / 10, 0]))
  items.push(record('missing', { group: 'missing' }))
  items.push({ ...record('projected', { group: 'original', hidden: 'secret', n: 7 }), indexedMetadata: { group: 'projection', n: 1.5 } })
  items.push({ ...record('empty-view', { group: 'hidden', n: 5 }), indexedMetadata: {} })
  items.push(record('z-negative', { group: 'negative', n: 5 }, [-1, 0, 0]))
  for (let i = 0; i < 1001; i++) items.push(record(`filler-${String(i).padStart(4, '0')}`, { group: 'filler' }, [0, 1, 0]))
  return items
}

function equalityFilters() {
  return [
    ...['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'absent'].map(group => ({ group })),
    ...[5, '5', true, false, 0, -0, 0.25, Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1].map(n => ({ n })),
    { n: { $eq: 5 } }, { n: { $eq: -0 } }, { n: { $eq: false } },
    { 'a.b': 'literal' }, { '': 'empty' }, { '色': '青' }, { $gt: 'ordinary' },
    { group: 'g0', n: 5 }, { group: 'g0', n: '5' }, { missing: false },
    { group: 'projection' }, { group: 'original' }, { hidden: 'secret' }, { group: 'hidden' }, { n: 1.5 },
  ]
}

async function main() {
  if (phase === 'parity' || phase === 'reopen') {
    let index, items
    if (phase === 'parity') {
      items = fixture()
      index = (await importVectraItems(items, options)).index
    } else {
      index = await VectraMigrationIndex.open({ path: directory })
      items = JSON.parse(await fs.readFile(path.join(root, 'items.json'), 'utf8'))
    }
    const state = monitor()
    try {
      for (const filter of equalityFilters()) await parity(index, items, filter)
      await parity(index, items, { n: 5 }, { documentIds: ['value-00', 'value-01', 'z-negative', 'absent'], k: 1 })
      await parity(index, items, { n: 5 }, { documentIds: [] })
      const negative = await parity(index, items, { group: 'negative' }, { mode: 'graph', k: 1 })
      assert.deepEqual(ids(negative), ['z-negative'])
      assert.ok(negative.results[0].score < 0)
      await parity(index, items, { group: 'negative' }, { minScore: 0 })
      assert.equal(state.pages, 0, 'cold equality filters must not list metadata, including after reopen')
      assert.ok(state.queries >= equalityFilters().length + 3)
      if (phase === 'parity') {
        const before = await index.queryItems(query, { filter: { group: 'g0' } })
        const replacement = record('value-00', { group: 'moved', n: 0.25 }, [0, 0, 1])
        await index.upsertItem(replacement)
        items[items.findIndex(item => item.id === replacement.id)] = replacement
        await index.deleteItem('value-01')
        items = items.filter(item => item.id !== 'value-01')
        const addition = record('new', { group: 'g0', n: 5 }, [1, 0.125, 0])
        await index.insertItem(addition)
        items.push(addition)
        for (const filter of [{ group: 'g0' }, { group: 'moved' }, { n: 5 }, { n: '5' }, { n: 0.25 }]) await parity(index, items, filter)
        await assert.rejects(index.queryItems(query, { filter: { group: 'g0' }, ifRevision: before.revision }), /vector record revision conflict/)
        assert.equal(state.pages, 0, 'writes must update native eligibility without metadata paging')
        await fs.writeFile(path.join(root, 'old-revision'), before.revision)
        await fs.writeFile(path.join(root, 'items.json'), JSON.stringify(items))
        await index.flush()
      } else {
        const stale = await fs.readFile(path.join(root, 'old-revision'), 'utf8')
        await assert.rejects(index.queryItems(query, { filter: { n: 5 }, ifRevision: stale }), /vector record revision conflict/)
        assert.equal(state.pages, 0)
      }
    } finally { state.restore() }
  } else if (phase === 'fallback') {
    const items = fixture().slice(0, 20)
    items.push(record('special', { constructor: 'own', toString: 'own' }))
    const { index } = await importVectraItems(items, options)
    const state = monitor()
    try {
      const filters = [
        { n: { $in: [5] } }, { n: { $in: ['15'] } }, { n: { $nin: ['15'] } },
        { n: { unknown: 5, $eq: 99 } }, { n: { $eq: 99, unknown: 5 } },
        { n: null }, { n: { $eq: null } }, { n: { $eq: {} } },
        { n: { $gt: '4' } }, { n: {} }, { $and: [{ n: 5 }] },
        { $or: [{ n: 5 }, { n: false }] }, { constructor: 'own' }, { toString: 'own' },
        { absent: 'no', n: { $in: 1 } },
      ]
      for (const filter of filters) await parity(index, items, filter)
      assert.equal(state.queries, 0, 'unsupported predicates must not be partially pushed into native filtering')
      assert.equal(state.pages, filters.length)
      const failing = { n: { $in: 1 }, absent: 'no' }
      assert.throws(() => items.filter(item => ItemSelector.select(item.indexedMetadata ?? item.metadata, failing)))
      await assert.rejects(index.queryItems(query, { filter: failing }))
      assert.equal(state.queries, 0)
      Object.defineProperty(Object.prototype, 'inheritedFilter', { value: 'all', enumerable: true, configurable: true })
      try {
        await parity(index, items, { n: 5 })
        await parity(index, items, { n: { $eq: 5 } })
        assert.equal(state.queries, 0, 'inherited filter and operator properties require selector fallback')
      } finally { delete Object.prototype.inheritedFilter }
      const supported = WarmMemorySystem.prototype.queryVectraRecords
      WarmMemorySystem.prototype.queryVectraRecords = undefined
      const pages = state.pages
      try { await parity(index, items, { group: 'g3' }) }
      finally { WarmMemorySystem.prototype.queryVectraRecords = supported }
      assert.equal(state.pages, pages + 1, 'an older addon must retain the complete eligibility scan')
      assert.equal(state.queries, 0)
    } finally { state.restore() }
  } else if (phase === 'validation') {
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`field-${i}`, i]))
    const items = [record('valid', { group: 'a', ...many })]
    const { index } = await importVectraItems(items, options)
    const state = monitor()
    try {
      for (const count of [63, 64, 65]) {
        const filter = Object.fromEntries(Object.entries(many).slice(0, count))
        const before = { pages: state.pages, queries: state.queries }
        await parity(index, items, filter)
        assert.equal(state.pages - before.pages, count === 65 ? 1 : 0)
        assert.equal(state.queries - before.queries, count === 65 ? 0 : 1)
      }
      const native = state.system
      for (const filter of [null, [], {}, { n: null }, { n: {} }, { n: [] }, { n: { $eq: 1 } }, { $and: 'a' }, { constructor: 'a' }, many]) {
        await assert.rejects(async () => native.queryVectraRecords(query, 1, filter))
      }
      for (const size of [65535, 65536, 65537]) {
        const filter = { a: 'x'.repeat(size - 8) }
        assert.equal(Buffer.byteLength(JSON.stringify(filter)), size)
        const pending = native.queryVectraRecords(query, 1, filter)
        if (size <= 65536) assert.deepEqual((await pending).results, [])
        else await assert.rejects(pending)
      }
      for (const metadata of [{}, { warmVectraMigration: 1, metadata: [] }, { warmVectraMigration: false, metadata: {} }]) {
        await native.mutateVectorRecords([{ op: 'upsert', record: record('foreign', metadata) }])
        await assert.rejects(index.queryItems(query, { filter: { absent: 'never matches' } }), /outside|migration|profile/i)
        await assert.rejects(index.queryItems(query, { filter: { group: 'a' }, documentIds: ['valid'] }), /outside|migration|profile/i)
        assert.deepEqual(ids(await index.queryItems(query, { filter: { group: 'a' }, documentIds: [] })), [])
        await native.mutateVectorRecords([{ op: 'delete', id: 'foreign' }])
        await parity(index, items, { group: 'a' })
      }
      await native.mutateVectorRecords([{ op: 'insert', record: record('string-view', { warmVectraMigration: 1, metadata: { group: 'original' }, indexedMetadata: 'abc' }) }])
      const before = state.pages
      assert.deepEqual(ids(await index.queryItems(query, { filter: { 0: 'a' } })), ['string-view'])
      assert.equal(state.pages, before + 1, 'non-object legacy indexed metadata must use the original selector')
      await native.mutateVectorRecords([{ op: 'delete', id: 'string-view' }])
      await parity(index, items, { group: 'a' })
    } finally { state.restore() }
  } else if (phase === 'concurrency') {
    const { index } = await importVectraItems([record('one', { group: 'a' })], options)
    const originalQuery = WarmMemorySystem.prototype.queryVectraRecords
    const originalMutate = WarmMemorySystem.prototype.mutateVectorRecords
    assert.equal(typeof originalQuery, 'function')
    let signal, release, first = true, wrote = false
    const entered = new Promise(resolve => { signal = resolve })
    const gate = new Promise(resolve => { release = resolve })
    WarmMemorySystem.prototype.queryVectraRecords = async function (...args) {
      if (first) { first = false; signal(); await gate }
      return originalQuery.apply(this, args)
    }
    WarmMemorySystem.prototype.mutateVectorRecords = async function (...args) {
      wrote = true
      return originalMutate.apply(this, args)
    }
    try {
      const before = index.queryItems(query, { filter: { group: 'a' } })
      const write = index.upsertItem(record('one', { group: 'b' }, [0, 1, 0]))
      const after = index.queryItems(query, { filter: { group: 'a' } })
      await entered
      assert.equal(wrote, false)
      release()
      const previous = await before
      assert.deepEqual(ids(previous), ['one'])
      await write
      assert.deepEqual(ids(await after), [])
      assert.deepEqual(ids(await index.queryItems(query, { filter: { group: 'b' } })), ['one'])
      await assert.rejects(index.queryItems(query, { filter: { group: 'b' }, ifRevision: previous.revision }), /vector record revision conflict/)
      await index.beginUpdate()
      await assert.rejects(index.queryItems(query, { filter: { group: 'b' } }), /commit or cancel/)
      await index.cancelUpdate()
    } finally {
      release()
      WarmMemorySystem.prototype.queryVectraRecords = originalQuery
      WarmMemorySystem.prototype.mutateVectorRecords = originalMutate
    }
  } else throw new Error(`unknown phase: ${phase}`)
}

main().catch(error => { console.error(error); process.exitCode = 1 })
