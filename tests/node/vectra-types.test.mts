// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import { VectraMigrationIndex, importVectraItems, importVectraIndex, type VectraSource, type StoredVectraItem } from 'warm-sdk/vectra'

const options = { path: './types-only-new-store', embeddingSpace: { model: 'fixture', revision: '1', dimensions: 3 } }
const index = await VectraMigrationIndex.create(options)
await VectraMigrationIndex.create({ ...options, highRecall: true })
await index.beginUpdate()
await index.insertItem({ id: 'a', vector: [1, -0, 0], metadata: { kind: 'fixture' } })
const committed = await index.endUpdate()
const result = await index.queryItems(new Float64Array([1, 0, 0]), { k: 1, filter: { kind: { $in: ['fixture'] } }, ifRevision: committed.revision, mode: 'exact' })
const item: StoredVectraItem | undefined = await index.getItem('a')
const page = await index.listItems({ includeVectors: false })
await index.listItems({ from: page.nextFrom ?? undefined, ifRevision: page.revision })
await index.applyBatch([{ op: 'delete', id: 'a' }, { op: 'insert', record: { id: 'a', vector: [0, 1, 0] } }])
await importVectraItems([{ id: 'x', vector: [1, 0, 0], metadata: { extra: true }, indexedMetadata: {} }], options)
declare const source: VectraSource
await importVectraIndex(source, options)
void [result.diagnostics?.route, item, await index.maintainIndices()]

// @ts-expect-error embeddings have an explicit space
await VectraMigrationIndex.create({ path: 'missing-space' })
// @ts-expect-error records never fabricate text or infer vectors
await index.insertItem({ id: 'text-only', text: 'text' })
// @ts-expect-error mode is constrained
await index.queryItems([1, 0, 0], { mode: 'hybrid' })
// @ts-expect-error the owned native store is private
void index.system
// @ts-expect-error controlled store configuration cannot be overridden
await VectraMigrationIndex.create({ ...options, native: { vectorRecords: false } })
// @ts-expect-error construction profile is owned by the migration adapter
await VectraMigrationIndex.create({ ...options, native: { vectorHighRecall: true } })
// @ts-expect-error graph profile is an explicit boolean
await VectraMigrationIndex.create({ ...options, highRecall: 'yes' })
