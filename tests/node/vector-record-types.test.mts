// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

import { WarmMemorySystem, type VectorRecordInput } from '../../index.js'

const warm = new WarmMemorySystem(1024, undefined, {
  vectorRecords: true, embeddingModel: 'records', embeddingRevision: '1', embeddingDimensions: 3, vectorHighRecall: true,
})
const item: VectorRecordInput = { id: 'one', vector: [-0, 0.1, Number.MIN_VALUE], metadata: { selected: true } }
const committed = await warm.mutateVectorRecords([{ op: 'insert', record: item }, { op: 'delete', id: 'absent' }])
const fetched = await warm.getVectorRecord('one', { ifRevision: committed.revision })
const nullableRecord: VectorRecordInput | null = fetched.record
const page = await warm.listVectorRecords({ limit: 10, includeVectors: false, ifRevision: fetched.revision })
const nullableCursor: string | null = page.nextFrom
const found = await warm.queryVectorRecords([0, 1, 0], 1, { documentIds: ['one'], ifRevision: page.revision, mode: 'exact', ef: 128, minScore: -1 })
const vector: number[] = found.results[0].item.vector
const route: string = found.diagnostics.route
void [nullableRecord, nullableCursor, vector, route]
// @ts-expect-error a delete requires its ID
await warm.mutateVectorRecords([{ op: 'delete', record: item }])
// @ts-expect-error numeric vector inputs remain numeric
await warm.queryVectorRecords(['not-a-number'], 1)
