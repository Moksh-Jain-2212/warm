// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { VectraMigrationIndex, importVectraItems, importVectraIndex } = require('../../../vectra.js')
const { WarmMemorySystem } = require('../../../index.js')
const [phase, root] = process.argv.slice(2)
const directory = path.join(root, 'index')
const options = { path: directory, embeddingSpace: { model: 'synthetic-vectra-fixture', revision: '1', dimensions: 3 } }
const original = [1 + 2 ** -40, -0, Number.MIN_VALUE]
const extreme = [Number.MAX_VALUE, Number.MIN_VALUE, -0]
const bits = values => Buffer.from(Float64Array.from(values).buffer).toString('hex')
const hitIds = result => result.results.map(hit => hit.item.id)
const record = (id, vector = [1, 0, 0], metadata = {}) => ({ id, vector, metadata })

async function main() {
  if (phase === 'import') {
    const { index, importedItems } = await importVectraItems([
      { ...record('raw', original, { group: 'a', hidden: 'preserve me', n: 5 }), indexedMetadata: { group: 'a', n: 5 } },
      record('other', [0, 1, 0], { group: 'b' }),
      record('extreme', extreme, { group: 'b' }),
    ], { ...options, indexedMetadata: ['group', 'n'] })
    assert.equal(importedItems, 3)
    assert.equal(bits((await index.getItem('raw')).vector), bits(original))
    assert.equal(bits((await index.getItem('extreme')).vector), bits(extreme))
    assert.equal((await index.getItem('raw')).metadata.hidden, 'preserve me')
    assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], { filter: { hidden: 'preserve me' } })), [])
    assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], { filter: { n: { $in: [5] } } })), [])
    const result = await index.queryItems([1, 0, 0], { filter: { n: { $in: ['15'] } }, k: 1 })
    assert.deepEqual(hitIds(result), ['raw'])
    assert.equal(bits(result.results[0].item.vector), bits(original))
    assert.ok(result.results[0].score > 0.99999)
    assert.ok(result.diagnostics.route)
    assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], { documentIds: [] })), [])
    await fs.writeFile(path.join(root, 'old-revision'), result.revision)
    await index.flush()
  } else if (phase === 'reopen') {
    const index = await VectraMigrationIndex.open({ path: directory })
    assert.equal(bits((await index.getItem('raw')).vector), bits(original))
    assert.equal(bits((await index.getItem('extreme')).vector), bits(extreme))
    assert.equal((await index.getItem('raw')).metadata.hidden, 'preserve me')
    assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], { filter: { hidden: 'preserve me' } })), [])
    const oldRevision = await fs.readFile(path.join(root, 'old-revision'), 'utf8')
    await assert.rejects(index.queryItems([1, 0, 0], { ifRevision: oldRevision }), /vector record revision conflict/)
    assert.equal(await index.getItem('missing'), undefined)
    await assert.rejects(VectraMigrationIndex.create(options), /exist/i)
    assert.equal((await index.listItems()).items.length, 3)
  } else if (phase === 'transactions') {
    const index = await VectraMigrationIndex.create(options)
    await index.insertItem(record('kept'))
    const before = await index.listItems()
    await index.beginUpdate()
    const input = record('staged', [0, 1, 0], { n: 1 })
    const staged = index.insertItem(input)
    input.vector[0] = 99; input.metadata.n = 99
    await staged
    await assert.rejects(index.getItem('staged'), /commit or cancel/)
    await index.cancelUpdate()
    assert.equal(await index.getItem('staged'), undefined)
    await index.beginUpdate()
    await index.insertItem(record('same'))
    await index.upsertItem(record('same', [0, 1, 0]))
    await index.deleteItem('same')
    await index.insertItem(record('same', [0, 0, 1]))
    const ordered = await index.endUpdate()
    assert.deepEqual(ordered.outcomes.map(item => item.op), ['insert', 'upsert', 'delete', 'insert'])
    assert.deepEqual((await index.getItem('same')).vector, [0, 0, 1])
    await assert.rejects(index.applyBatch([
      { op: 'delete', id: 'kept' },
      { op: 'insert', record: record('new') },
      { op: 'insert', record: record('same') },
    ]), /exist|duplicate|absent/i)
    assert.ok(await index.getItem('kept'))
    assert.equal(await index.getItem('new'), undefined)
    await assert.rejects(index.applyBatch([{ op: 'delete', id: 'kept' }], { ifRevision: before.revision }), /vector record revision conflict/)
    await index.beginUpdate()
    const cloned = record('cloned', [0, 1, 0], { n: 1 })
    const cloning = index.insertItem(cloned)
    cloned.vector[0] = 99; cloned.metadata.n = 99
    await cloning
    await index.endUpdate()
    assert.deepEqual(await index.getItem('cloned'), record('cloned', [0, 1, 0], { n: 1 }))
    // A lost response after a real commit must never cause an automatic write retry.
    const mutate = WarmMemorySystem.prototype.mutateVectorRecords
    let calls = 0
    WarmMemorySystem.prototype.mutateVectorRecords = async function (...args) {
      calls++
      await mutate.apply(this, args)
      throw new Error('vector record commit uncertain: simulated lost response')
    }
    try {
      await assert.rejects(index.insertItem(record('uncertain')), /commit uncertain/)
      assert.equal(calls, 1)
    } finally { WarmMemorySystem.prototype.mutateVectorRecords = mutate }
    assert.ok(await index.getItem('uncertain'))
    await index.flush()
  } else if (phase === 'transactions-reopen') {
    const index = await VectraMigrationIndex.open({ path: directory })
    assert.deepEqual((await index.getItem('same')).vector, [0, 0, 1])
    assert.ok(await index.getItem('kept'))
    assert.ok(await index.getItem('uncertain'))
    assert.equal(await index.getItem('new'), undefined)
    assert.equal(await index.getItem('staged'), undefined)
  } else if (phase === 'paging') {
    const items = Array.from({ length: 1001 }, (_, n) => record(`a${String(n).padStart(4, '0')}`, [1, 0, 0], { group: 'excluded' }))
    items.push(record('z-negative', [-1, 0, 0], { group: 'eligible' }))
    const { index } = await importVectraItems(items, options)
    const first = await index.listItems({ limit: 1000, includeVectors: false })
    assert.equal(first.items.length, 1000)
    assert.equal(first.items[0].vector, undefined)
    const second = await index.listItems({ from: first.nextFrom, limit: 1000, ifRevision: first.revision })
    assert.equal(second.items.length, 2)
    assert.equal(second.nextFrom, null)
    const query = { filter: { group: 'eligible' }, k: 1 }
    const result = await index.queryItems([1, 0, 0], query)
    assert.deepEqual(hitIds(result), ['z-negative'])
    assert.ok(Math.abs(result.results[0].score + 1) < 1e-6)
    assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], { ...query, minScore: 0 })), [])
    assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], { ...query, documentIds: ['a0000'] })), [])
    await assert.rejects(index.queryItems([1, 0, 0], { mode: 'graph' }), /graph|Graph/)

    const list = WarmMemorySystem.prototype.listVectorRecords
    let calls = 0
    let changed = false
    WarmMemorySystem.prototype.listVectorRecords = async function (args) {
      calls++
      const page = await list.call(this, args)
      if (!changed) {
        changed = true
        const current = await this.getVectorRecord('z-negative')
        current.record.metadata.metadata.group = 'excluded'
        await this.mutateVectorRecords([{ op: 'upsert', record: current.record }])
      }
      return page
    }
    try {
      assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], query)), [])
      assert.equal(calls, 4)
    } finally { WarmMemorySystem.prototype.listVectorRecords = list }

    calls = 0
    WarmMemorySystem.prototype.listVectorRecords = async function (args) {
      calls++
      const page = await list.call(this, args)
      if (!args.from) {
        const current = await this.getVectorRecord('z-negative')
        current.record.metadata.metadata.revisionTest = calls
        await this.mutateVectorRecords([{ op: 'upsert', record: current.record }])
      }
      return page
    }
    try {
      await assert.rejects(index.queryItems([1, 0, 0], query), /vector record revision conflict/)
      assert.equal(calls, 6, 'three complete attempts, then stop')
    } finally { WarmMemorySystem.prototype.listVectorRecords = list }
    await index.flush()
  } else if (phase === 'bounds') {
    const index = await VectraMigrationIndex.create({ ...options, maxPending: 1 })
    await index.insertItem(record('kept'))
    for (const k of [1, 999, 1000]) assert.equal((await index.queryItems([1, 0, 0], { k })).results.length, 1)
    for (const k of [0, 1001, 1.5]) assert.throws(() => index.queryItems([1, 0, 0], { k }), /integer/)
    for (const limit of [999, 1000]) assert.equal((await index.listItems({ limit })).items.length, 1)
    assert.throws(() => index.listItems({ limit: 1001 }), /integer/)
    for (const bad of [[0, 0, 0], [NaN, 0, 1], [Infinity, 1, 0], [1, 0], [1, , 0]]) {
      assert.throws(() => index.insertItem(record('bad', bad)), /vector/)
    }
    for (const bad of ['', '\ud800', 'a\0b', 'hms:chunk:reserved', 'x'.repeat(65524)]) {
      assert.throws(() => index.insertItem(record(bad)), /UTF-8/)
    }
    assert.throws(() => index.queryItems([1, 0, 0], { filter: { value: '\udfff' } }), /Unicode/)
    assert.throws(() => index.queryItems([1, 0, 0], { ifRevision: 'x'.repeat(257) }), /token/)
    const metadata = {}; Object.defineProperty(metadata, 'value', { enumerable: true, get() { throw new Error('accessor invoked') } })
    assert.throws(() => index.insertItem(record('bad', [1, 0, 0], metadata)), /accessors/)
    const hiddenToJSON = { good: true }; Object.defineProperty(hiddenToJSON, 'toJSON', { value() { throw new Error('toJSON invoked') } })
    await index.insertItem(record('plain', [1, 0, 0], hiddenToJSON))
    assert.deepEqual((await index.getItem('plain')).metadata, { good: true })
    assert.throws(() => index.applyBatch(Array.from({ length: 4097 }, () => ({ op: 'delete', id: 'missing' }))), /4096/)
    for (const n of [4095, 4096]) {
      const result = await index.applyBatch(Array.from({ length: n }, () => ({ op: 'delete', id: 'missing' })))
      assert.equal(result.outcomes.length, n)
    }
    const pending = index.getItem('kept')
    await assert.rejects(index.getItem('kept'), /queue is full/)
    assert.ok(await pending)
    assert.ok(await index.getItem('kept'))
    await assert.rejects(index.insertItem(record('too-big', [1, 0, 0], { value: 'x'.repeat(64 * 1024 - 30) })), /metadata|64|limit|size/i)
    assert.equal(await index.getItem('too-big'), undefined)
    await index.flush()
  } else if (phase === 'source') {
    const fixture = path.resolve('tests/fixtures/vectra-0.15/export')
    const snapshot = require('../../fixtures/vectra-0.15/export-api.json')
    const hashFiles = async () => Promise.all((await fs.readdir(fixture)).sort().map(async name => [name, createHash('sha256').update(await fs.readFile(path.join(fixture, name))).digest('hex')]))
    const before = await hashFiles()
    const source = {
      async getIndexStats() { return snapshot.stats }, async listItems() { return snapshot.items },
      folderPath: fixture, storage: { readFile: file => fs.readFile(file) },
      codec: { deserializeMetadata: data => JSON.parse(data.toString('utf8')) },
    }
    const { index } = await importVectraIndex(source, options)
    assert.deepEqual((await index.getItem('external')).metadata, { group: 'public', private: 'original metadata', count: 7 })
    assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], { filter: { private: 'original metadata' } })), [])
    assert.deepEqual(hitIds(await index.queryItems([1, 0, 0], { filter: { group: 'public' } })), ['external'])
    assert.deepEqual(await hashFiles(), before)
    await index.flush()
    const failedPath = path.join(root, 'failed')
    await assert.rejects(importVectraItems([record('same'), record('same')], { ...options, path: failedPath }), /exist|duplicate|absent/i)
    await assert.rejects(VectraMigrationIndex.open({ path: failedPath }), /incomplete/)
    assert.equal(JSON.parse(await fs.readFile(path.join(failedPath, 'vectra-migration.json'))).state, 'failed')
    async function* partialSource() {
      for (let n = 0; n < 129; n++) yield record(`item-${n}`)
      yield record('invalid', [0, 0, 0])
    }
    const partialPath = path.join(root, 'partial-import')
    await assert.rejects(importVectraItems(partialSource(), { ...options, path: partialPath }), /nonzero/)
    const partialProfile = JSON.parse(await fs.readFile(path.join(partialPath, 'vectra-migration.json')))
    assert.equal(partialProfile.state, 'failed')
    assert.equal(partialProfile.importedItems, 128)
    await assert.rejects(VectraMigrationIndex.open({ path: partialPath }), /incomplete/)
    const badSource = { ...source, async listItems() { return [{ ...snapshot.items[0], metadataFile: '../escape.json' }] } }
    await assert.rejects(importVectraIndex(badSource, { ...options, path: path.join(root, 'bad-source') }), /filename/)
    await assert.rejects(VectraMigrationIndex.create({ ...options, path: path.join(root, 'partial'), candidateDimensions: 2 }), /together/)
  } else throw new Error(`unknown phase: ${phase}`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
