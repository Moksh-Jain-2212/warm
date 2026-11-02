import { WarmMemorySystem, type DocumentInput } from 'warm-sdk'
import { DocumentMemory, createLocalEmbedder, type Embedder } from 'warm-sdk/semantic'

const input: DocumentInput = {
  id: 'guide', text: 'Restore verified backups.', metadata: { project: 'alpha' },
}
const warm = new WarmMemorySystem(16384, './types-only')
const memory = new DocumentMemory(warm, { maxPending: 16 })
await memory.memorize(input)
const chunks: number[] = await warm.memorizeDocuments([input])
await warm.trainDocumentIndex()
const documentIndexTrained: boolean = warm.documentIndexTrained
void chunks
void documentIndexTrained
const results = await memory.search('backups', { filter: { project: 'alpha' }, k: 3 })
const documentId: string | undefined = results[0]?.documentId
void documentId
const embedder: Embedder = await createLocalEmbedder({ modelPath: './model', modelId: 'example', revision: '1' })
const values: ArrayLike<number> = await embedder.encodeQuery('query')
void values

// These operations must remain invalid at the public TypeScript boundary.
// @ts-expect-error document text must be a string
await memory.memorize({ id: 'bad', text: 42 })
// @ts-expect-error the candidate limit must be numeric
await memory.search('query', { candidateLimit: 'many' })

const vectors = new WarmMemorySystem(1024, './vectors-types-only', {
  embeddingModel: 'matryoshka-model', embeddingRevision: '1', embeddingDimensions: 1024,
  vectorCandidateDimensions: 256, vectorRerankCandidates: 100,
})
const vectorOptions: import('warm-sdk').VectorSearchOptions = {
  mode: 'auto', ef: 128, minScore: -1, filter: { project: 'alpha' },
  sourceUri: 'guide.md', documentIds: ['guide'],
}
const vectorResults = await vectors.searchVectors(Array(1024).fill(0.1), 10, vectorOptions)
const vectorScore: number | undefined = vectorResults[0]?.score
void vectorScore
// @ts-expect-error vector candidate dimensions must be numeric
new WarmMemorySystem(1024, './invalid-vector-types', { vectorCandidateDimensions: '256' })
// @ts-expect-error vector queries must be arrays of numbers
await vectors.searchVectors(['invalid'], 1)
