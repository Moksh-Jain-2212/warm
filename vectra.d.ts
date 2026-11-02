// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import type { IndexStatus, WarmConfigJs } from './index.js'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type VectraMetadata = { [key: string]: JsonValue }
/** Finite, acyclic plain JSON; selectors follow pinned Vectra 0.15 behavior. */
export type VectraFilter = VectraMetadata
export interface VectraItem {
  id: string
  vector: number[] | Float32Array | Float64Array
  metadata?: VectraMetadata
}
export interface ImportedVectraItem extends VectraItem {
  /** The source index's filter view; omitted means derive it from indexedMetadata keys. */
  indexedMetadata?: VectraMetadata
}
export interface StoredVectraItem {
  id: string
  /** Original finite f64 values, including signed zero, rather than the normalized search vector. */
  vector: number[]
  metadata: VectraMetadata
}
export interface ListedVectraItem {
  id: string
  vector?: number[]
  metadata: VectraMetadata
}
export type VectraOperation =
  | { op: 'insert' | 'upsert'; record: VectraItem }
  | { op: 'delete'; id: string }
export interface VectraMutationResult {
  revision: string
  outcomes: Array<{ op: string; id: string; created?: boolean; deleted?: boolean }>
}
export type VectraNativeOptions = Omit<WarmConfigJs,
  'vectorRecords' | 'embeddingModel' | 'embeddingRevision' | 'embeddingDimensions' |
  'vectorCandidateDimensions' | 'vectorRerankCandidates' | 'vectorHighRecall'>
export interface VectraOpenOptions {
  path: string
  /** Runtime/security configuration is reapplied on every open, never stored in the profile. */
  native?: VectraNativeOptions
  /** Maximum queued calls, default 32, range 1..4096. */
  maxPending?: number
}
export interface VectraCreateOptions extends VectraOpenOptions {
  /** Explicit identity of the existing vectors; the adapter does not generate embeddings. */
  embeddingSpace: { model: string; revision: string; dimensions: number }
  /** WARM memory dimensions, independent of embedding dimensions; default 1024. */
  dimensions?: number
  /** Empty/omitted means all metadata is indexed, as in Vectra 0.15. */
  indexedMetadata?: string[]
  /** Experimental candidate prefix; must be supplied together with rerankCandidates. */
  candidateDimensions?: number
  rerankCandidates?: number
  /** Opt into a denser graph; this increases construction work and memory. */
  highRecall?: boolean
}
export interface VectraQueryOptions {
  k?: number
  filter?: VectraFilter | null
  /** Intersect with the complete filter result; [] always means no matches. */
  documentIds?: string[]
  /** A caller-supplied revision disables clean-conflict retries. */
  ifRevision?: string
  minScore?: number
  /** Exact by default. A graph query builds a graph deferred by a cold exact query; otherwise an unavailable graph is an error. */
  mode?: 'exact' | 'auto' | 'graph'
  ef?: number
}
export interface VectraQueryResult {
  revision: string
  results: Array<{ item: StoredVectraItem; score: number }>
  diagnostics?: { route: string; candidateDimensions: number; shortlistLimit?: number | null; graphDegree?: number | null; graphBuildEf?: number | null }
}
export interface VectraListOptions {
  /** Inclusive opaque cursor: pass nextFrom unchanged. */
  from?: string
  limit?: number
  ifRevision?: string
  includeVectors?: boolean
}
export interface VectraListResult {
  revision: string
  items: ListedVectraItem[]
  nextFrom: string | null
}
export interface VectraImportResult {
  index: VectraMigrationIndex
  importedItems: number
}
/** A vector-only migration profile, not a drop-in replacement for Vectra LocalIndex. */
export class VectraMigrationIndex {
  private constructor()
  /** Creates a new owned schema-7 directory; any existing destination is rejected. */
  static create(options: VectraCreateOptions): Promise<VectraMigrationIndex>
  static open(options: VectraOpenOptions): Promise<VectraMigrationIndex>
  static importItems(items: Iterable<ImportedVectraItem> | AsyncIterable<ImportedVectraItem>, options: VectraCreateOptions): Promise<VectraImportResult>
  readonly path: string
  insertItem(item: VectraItem): Promise<void>
  upsertItem(item: VectraItem): Promise<void>
  deleteItem(id: string): Promise<void>
  /** Applies ordered operations atomically, including repeated IDs. No automatic write retries. */
  applyBatch(operations: VectraOperation[], options?: { ifRevision?: string }): Promise<VectraMutationResult>
  beginUpdate(): Promise<void>
  endUpdate(): Promise<VectraMutationResult>
  cancelUpdate(): Promise<void>
  getItem(id: string, options?: { ifRevision?: string }): Promise<StoredVectraItem | undefined>
  /** A bounded page, rather than LocalIndex's unbounded listItems array. */
  listItems(options?: VectraListOptions): Promise<VectraListResult>
  queryItems(vector: number[] | Float32Array | Float64Array, options?: VectraQueryOptions): Promise<VectraQueryResult>
  flush(): Promise<void>
  maintainIndices(): Promise<IndexStatus>
}
export function importVectraItems(items: Iterable<ImportedVectraItem> | AsyncIterable<ImportedVectraItem>, options: VectraCreateOptions): Promise<VectraImportResult>
/** Public source methods used to resolve Vectra 0.15's indexed and external metadata separately. */
export interface VectraSource {
  getIndexStats(): Promise<{ metadata_config?: { indexed?: string[] } }>
  listItems(): Promise<Array<VectraItem & { metadataFile?: string }>>
  readonly folderPath: string
  readonly storage: { readFile(path: string): Promise<Buffer> }
  readonly codec: { deserializeMetadata(data: Buffer): VectraMetadata }
}
/** Keep the source read-only throughout import. Partial destinations are quarantined on failure. */
export function importVectraIndex(source: VectraSource, options: Omit<VectraCreateOptions, 'indexedMetadata'>): Promise<VectraImportResult>
