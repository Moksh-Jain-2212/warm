// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

//! Vector query dispatch for the document store.
//!
//! Mechanism: a vector-only, unfiltered query does not need the lexical capture in
//! `search.rs`, which clones one `Arc<StoredDocument>` per stored chunk and scores rows
//! through the document pointers on every query. It is answered from a [`VectorSnapshot`]:
//! the embedded chunks captured at one store generation as a row list over the store's own
//! `f32` embeddings ([`super::Embedding`], one shared allocation per chunk, so the snapshot
//! adds no copy of the matrix), with an optional vertex graph (`qgraph::VGraph`) over the
//! same rows. Every [`VectorIndex`] maps a query to row ids and the snapshot maps rows back
//! to documents. Readers share the snapshot through one `Arc`, so a query holds the store's
//! read lock only to read the generation and the text segment for fresh queries. Stale
//! exact queries derive live-row eligibility from a bounded changed-ID ledger and binary
//! ranges in the ID-ordered rows, then score captured immutable owners after releasing it. Graph scoring stays outside
//! the lock before stale-hit validation and the delta pass.
//!
//! Data layout: `rows[i]` owns the document of row `i` and the chunk index inside it;
//! `exact.rows[i]` is that chunk's embedding handle, l2-normalised `f32` values rounded from
//! the `f64` normalisation at ingest. `members` holds the address of every document
//! allocation the snapshot covers; the addresses stay unique while the snapshot holds the
//! `Arc`s, so a replaced document (a new allocation under the same id) is never mistaken for
//! the captured one. The graph build needs one contiguous matrix; it is assembled for the
//! build and freed with the builder, so it is transient memory, not part of the snapshot.
//!
//! Consistency: the store bumps `generation` on every insert, replace and delete
//! (`index.rs`), and a snapshot records the generation it was captured at.
//! - current (`store.generation == snapshot.generation`): the rows are the live store, hits
//!   are returned as found.
//! - stale: exact captures invalidate the row ranges of changed IDs and capture their live
//!   owners. The generation-covered ledger retains IDs, not deleted payloads, independently
//!   of the dense index; overflow, a coverage gap or a different store takes the complete
//!   generic exact path. Every captured row is scored outside the lock, retaining the best
//!   `k` eligible base rows before merging bounded delta chunks. Graph queries retain their
//!   approximate candidate contract and validate owners against the live store. Exact
//!   capture holds a bit per snapshot row and at most the dense index's delta document/chunk
//!   limits. When fewer than `k` hits survive, the caller takes the generic exact path.
//!   `rebuild_recommended` asks maintenance for a fresh capture
//!   after [`REBUILD_AFTER_MUTATIONS`] mutations, so the stale window is bounded by the
//!   maintenance interval.
//! - third implementation slot: [`VectorIndexKind::Scan`] is reserved for the graph-free
//!   scan under research in `benchmarks/research/scan`; nothing implements it here.
//!
//! Scores: exact-mode selection uses [`super::Embedding::cosine`], the canonical `f64`
//! accumulation. Graph candidates use the `f32` dot before canonical re-scoring; graph
//! membership remains approximate. Ties break on `(document id, chunk)` ascending.

use std::{cmp::Ordering, collections::BinaryHeap, sync::Arc};

use crate::core::hash::FastSet;
use crate::core::sync::{Mutex, MutexGuard, RwLock};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};

use super::dense::{MAX_DELTA_CHUNKS, MAX_DELTA_DOCUMENTS};
use super::index::{text_scrubbed, try_text_of, StoreIdentity};
use super::{DocumentResult, DocumentStore, Embedding, StoredDocument, TextSegment};
use crate::core::qgraph::{BuildParams, Graph, VGraph, VSearchParams};

/// Fewest embedded chunks worth a snapshot; smaller stores take the generic exact path.
pub const SNAPSHOT_MIN_ROWS: usize = 1;
/// Default `graph_min_rows`: a snapshot with fewer rows carries only the exact scan, which
/// beats a graph traversal at that size.
pub const DEFAULT_GRAPH_MIN_ROWS: usize = 4096;
/// Default beam width of a graph query. The accepted qgraph rows reached recall 0.95 at
/// `ef` 736 on glove-100-angular (1.18M vectors, `benchmarks/results/ann_modal_confirm_v1.json`);
/// stores of up to a few hundred thousand embedding rows reach it with a far smaller beam, and
/// `tests/server_ann.rs` holds the default to recall >= 0.95 on its corpus.
pub const DEFAULT_EF: usize = 128;
pub const MAX_EF: usize = 4096;
pub const MAX_K: usize = 1000;
/// Mutations since the capture after which maintenance builds a fresh snapshot.
pub const REBUILD_AFTER_MUTATIONS: u64 = 64;
const MAX_ROWS: usize = 1 << 22;
/// Upper bound on the graph build matrix: 512 Mi `f32` values (2 GiB).
const MAX_MATRIX_VALUES: usize = 512 * 1024 * 1024;

/// Which implementation answered, or may answer, a vector query.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VectorIndexKind {
    /// Exact cosine over the store's `f32` rows.
    Exact,
    /// The vertex graph (`qgraph::VGraph`) with exact re-scoring of the fetched rows.
    Graph,
    /// Reserved for the graph-free scan under research in `benchmarks/research/scan`.
    Scan,
}

/// Route of one vector query.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VectorIndexMode {
    /// The graph when the snapshot has one, the exact scan otherwise.
    #[default]
    Auto,
    /// Always the exact scan (the generic path when no snapshot exists).
    Exact,
    /// The graph, or [`GraphUnavailable`] when none is built.
    Graph,
}

impl VectorIndexMode {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "auto" => Some(Self::Auto),
            "exact" => Some(Self::Exact),
            "graph" => Some(Self::Graph),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Exact => "exact",
            Self::Graph => "graph",
        }
    }
}

/// Per-query options of [`crate::WarmCore::search_vectors`].
#[derive(Clone, Debug)]
pub struct VectorQueryOptions {
    pub mode: VectorIndexMode,
    /// Beam width of a graph query (`1..=MAX_EF`); ignored by the exact scan.
    pub ef: usize,
    /// Lowest cosine returned, in `[-1, 1]`.
    pub min_score: f64,
}

impl Default for VectorQueryOptions {
    fn default() -> Self {
        Self {
            mode: VectorIndexMode::Auto,
            ef: DEFAULT_EF,
            min_score: -1.0,
        }
    }
}

/// State of the snapshot relative to the live store.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorIndexStatus {
    /// Embedded chunks the snapshot covers (0 without a snapshot).
    pub rows: usize,
    /// Store generation the snapshot was captured at.
    pub generation: u64,
    /// Whether the snapshot is the live store.
    pub current: bool,
    /// Inserts, replaces and deletes since the capture.
    pub stale_mutations: u64,
    /// Whether the snapshot carries a graph index.
    pub graph: bool,
    /// Whether maintenance should capture a fresh snapshot.
    pub rebuild_recommended: bool,
}

/// A `graph` query reached a store without a graph index.
#[derive(Debug, Clone, Copy)]
pub struct GraphUnavailable;

impl std::fmt::Display for GraphUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("no graph index is built; run index maintenance")
    }
}

impl std::error::Error for GraphUnavailable {}

/// A nearest-neighbour index over the rows of one `VectorSnapshot`.
pub trait VectorIndex: Send + Sync {
    fn kind(&self) -> VectorIndexKind;
    fn rows(&self) -> usize;
    /// The `k` best rows by cosine, best first, as `(row, score)`; `ef` is the beam of an
    /// approximate index and ignored by an exact one. `query` is l2-normalised and has the
    /// snapshot's dimensions.
    fn search(&self, query: &[f32], k: usize, ef: usize) -> Result<Vec<(u32, f32)>>;
}

#[derive(Clone, Copy)]
struct Ranked {
    score: f32,
    row: u32,
}

impl PartialEq for Ranked {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Ranked {}
impl PartialOrd for Ranked {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Ranked {
    /// Greater is worse: a lower score, or the same score at a higher row.
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .score
            .total_cmp(&self.score)
            .then(self.row.cmp(&other.row))
    }
}

/// Bounded best-`k` set; the heap top is the worst kept candidate.
struct TopK {
    heap: BinaryHeap<Ranked>,
    k: usize,
}

impl TopK {
    fn new(k: usize) -> Self {
        Self {
            heap: BinaryHeap::with_capacity(k + 1),
            k,
        }
    }

    fn offer(&mut self, row: u32, score: f32) {
        let candidate = Ranked { score, row };
        if self.k == 0 {
            return;
        }
        if self.heap.len() < self.k {
            self.heap.push(candidate);
        } else if let Some(mut worst) = self.heap.peek_mut() {
            if candidate < *worst {
                *worst = candidate;
            }
        }
    }

    fn into_sorted(self) -> Vec<(u32, f32)> {
        self.heap
            .into_sorted_vec()
            .into_iter()
            .map(|ranked| (ranked.row, ranked.score))
            .collect()
    }
}

/// Dot product with eight independent accumulators so the loop vectorises.
#[inline]
fn dot(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut lanes = [0.0f32; 8];
    let (wide_a, tail_a) = a.as_chunks::<8>();
    let (wide_b, tail_b) = b.as_chunks::<8>();
    for (x, y) in wide_a.iter().zip(wide_b) {
        for ((lane, x), y) in lanes.iter_mut().zip(x).zip(y) {
            *lane += x * y;
        }
    }
    let mut sum = lanes.iter().sum::<f32>();
    for (x, y) in tail_a.iter().zip(tail_b) {
        sum += x * y;
    }
    sum
}

/// Exact cosine over the snapshot rows, one query per thread. Each row is the store's own
/// embedding allocation (one pointer per row, shared with the chunk).
pub(crate) struct ExactScan {
    dim: usize,
    rows: Arc<[Embedding]>,
}

impl ExactScan {
    fn row(&self, row: u32) -> &[f32] {
        &self.rows[row as usize]
    }

    fn search_canonical(
        &self,
        query: &[f64],
        k: usize,
        include: impl Fn(usize) -> bool,
    ) -> Vec<(u32, f64)> {
        #[derive(Clone, Copy)]
        struct Candidate {
            row: u32,
            score: f64,
        }
        impl PartialEq for Candidate {
            fn eq(&self, other: &Self) -> bool {
                self.cmp(other) == Ordering::Equal
            }
        }
        impl Eq for Candidate {}
        impl PartialOrd for Candidate {
            fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
                Some(self.cmp(other))
            }
        }
        impl Ord for Candidate {
            fn cmp(&self, other: &Self) -> Ordering {
                other
                    .score
                    .total_cmp(&self.score)
                    .then(self.row.cmp(&other.row))
            }
        }
        #[cfg(test)]
        tests::before_canonical_scoring();
        let k = k.min(self.rows.len());
        let mut best = BinaryHeap::<Candidate>::with_capacity(k);
        for (row, values) in self.rows.iter().enumerate() {
            if !include(row) {
                continue;
            }
            let candidate = Candidate {
                row: row as u32,
                score: values.cosine(query),
            };
            if best.len() < k {
                best.push(candidate);
            } else if let Some(mut worst) = best.peek_mut() {
                if candidate < *worst {
                    *worst = candidate;
                }
            }
        }
        best.into_sorted_vec()
            .into_iter()
            .map(|hit| (hit.row, hit.score))
            .collect()
    }
}

impl VectorIndex for ExactScan {
    fn kind(&self) -> VectorIndexKind {
        VectorIndexKind::Exact
    }

    fn rows(&self) -> usize {
        self.rows.len()
    }

    fn search(&self, query: &[f32], k: usize, _ef: usize) -> Result<Vec<(u32, f32)>> {
        ensure!(
            query.len() == self.dim,
            "query has {} dimensions, the index {}",
            query.len(),
            self.dim
        );
        let mut best = TopK::new(k.min(self.rows()));
        for (row, values) in self.rows.iter().enumerate() {
            best.offer(row as u32, dot(query, values));
        }
        Ok(best.into_sorted())
    }
}

/// The vertex graph over the snapshot rows; fetched ids are re-scored exactly.
pub(crate) struct GraphIndex {
    graph: VGraph,
    exact: ExactScan,
}

impl VectorIndex for GraphIndex {
    fn kind(&self) -> VectorIndexKind {
        VectorIndexKind::Graph
    }

    fn rows(&self) -> usize {
        self.exact.rows()
    }

    fn search(&self, query: &[f32], k: usize, ef: usize) -> Result<Vec<(u32, f32)>> {
        ensure!(
            query.len() == self.exact.dim,
            "query has {} dimensions, the index {}",
            query.len(),
            self.exact.dim
        );
        let k = k.min(self.rows());
        if k == 0 {
            return Ok(Vec::new());
        }
        let ef = ef.clamp(k, MAX_EF.max(k));
        let params = VSearchParams {
            ef,
            rerank: ef,
            ..VSearchParams::default()
        };
        let mut ids = Vec::with_capacity(k);
        self.graph
            .searcher()
            .search(query, k, params, &mut ids)
            .map_err(|e| anyhow::anyhow!("graph search: {e}"))?;
        let mut hits: Vec<(u32, f32)> = ids
            .into_iter()
            .filter(|&id| (id as usize) < self.rows())
            .map(|id| (id, dot(query, self.exact.row(id))))
            .collect();
        hits.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        hits.dedup_by(|a, b| a.0 == b.0);
        hits.truncate(k);
        Ok(hits)
    }
}

struct RowRef {
    document: Arc<StoredDocument>,
    chunk: u32,
}

/// The embedded chunks of one store generation with the indexes over them.
pub(crate) struct VectorSnapshot {
    identity: StoreIdentity,
    generation: u64,
    dim: usize,
    rows: Vec<RowRef>,
    members: FastSet<usize>,
    exact: ExactScan,
    graph: Option<GraphIndex>,
}

impl VectorSnapshot {
    pub(crate) fn rows(&self) -> usize {
        self.rows.len()
    }

    pub(crate) fn has_graph(&self) -> bool {
        self.graph.is_some()
    }

    fn index(&self, mode: VectorIndexMode) -> Result<&dyn VectorIndex> {
        match mode {
            VectorIndexMode::Exact => Ok(&self.exact),
            VectorIndexMode::Graph => self
                .graph
                .as_ref()
                .map(|graph| graph as &dyn VectorIndex)
                .ok_or_else(|| anyhow::Error::new(GraphUnavailable)),
            VectorIndexMode::Auto => Ok(self
                .graph
                .as_ref()
                .map_or(&self.exact as &dyn VectorIndex, |graph| {
                    graph as &dyn VectorIndex
                })),
        }
    }
}

/// The rows captured under the store's read lock; [`build_vector_snapshot`] turns it into a
/// snapshot without any lock. `embeddings[i]` is the handle of `rows[i]`'s chunk embedding,
/// shared with the store (a reference count, not a copy).
pub(crate) struct VectorCapture {
    identity: StoreIdentity,
    generation: u64,
    dim: usize,
    rows: Vec<RowRef>,
    embeddings: Vec<Embedding>,
}

/// Captures every embedded chunk's embedding handle. `None` when the store has fewer than
/// [`SNAPSHOT_MIN_ROWS`] embedded chunks.
pub(crate) fn capture_vector_rows(
    store: &DocumentStore,
    dim: usize,
) -> Result<Option<VectorCapture>> {
    let count = store.embedded_count();
    if dim == 0 || count < SNAPSHOT_MIN_ROWS {
        return Ok(None);
    }
    ensure!(
        count <= MAX_ROWS,
        "vector snapshot exceeds {MAX_ROWS} embedded chunks"
    );
    ensure!(
        count
            .checked_mul(dim)
            .is_some_and(|values| values <= MAX_MATRIX_VALUES),
        "vector snapshot exceeds {MAX_MATRIX_VALUES} embedding values"
    );
    let mut rows = Vec::new();
    rows.try_reserve_exact(count)
        .context("cannot allocate vector snapshot rows")?;
    let mut embeddings = Vec::new();
    embeddings
        .try_reserve_exact(count)
        .context("cannot allocate vector snapshot embedding handles")?;
    for id in &store.embedded_documents {
        let Some(document) = store.documents.get(id) else {
            bail!("embedded document {id:?} is missing from the store");
        };
        for (chunk, stored) in document.chunks.iter().enumerate() {
            let Some(embedding) = &stored.embedding else {
                continue;
            };
            ensure!(
                embedding.len() == dim,
                "stored embedding has {} dimensions, the embedding space {dim}",
                embedding.len()
            );
            ensure!(
                rows.len() < count,
                "store counts {count} embedded chunks but holds more"
            );
            embeddings.push(embedding.clone());
            rows.push(RowRef {
                document: Arc::clone(document),
                chunk: u32::try_from(chunk).context("chunk index over u32")?,
            });
        }
    }
    ensure!(
        rows.len() == count,
        "store counts {count} embedded chunks but holds {}",
        rows.len()
    );
    store.vector_changes.write().capture(store.generation);
    Ok(Some(VectorCapture {
        identity: store.identity,
        generation: store.generation,
        dim,
        rows,
        embeddings,
    }))
}

/// Builds the exact scan and, with at least `graph_min_rows` rows, the vertex graph. The
/// graph build is deterministic (`BuildParams::default()`, fixed seed) and uses the rayon
/// pool; its contiguous input matrix (`rows * dim * 4` bytes) lives only for the build.
pub(crate) fn build_vector_snapshot(
    capture: VectorCapture,
    graph_min_rows: usize,
) -> Result<VectorSnapshot> {
    let VectorCapture {
        identity,
        generation,
        dim,
        rows,
        embeddings,
    } = capture;
    let members = rows
        .iter()
        .map(|row| Arc::as_ptr(&row.document) as usize)
        .collect();
    let embeddings: Arc<[Embedding]> = embeddings.into();
    let exact = ExactScan {
        dim,
        rows: Arc::clone(&embeddings),
    };
    let graph = if rows.len() >= graph_min_rows.max(SNAPSHOT_MIN_ROWS) {
        let mut matrix = Vec::new();
        matrix
            .try_reserve_exact(rows.len() * dim)
            .context("cannot allocate the graph build matrix")?;
        for embedding in embeddings.iter() {
            matrix.extend_from_slice(embedding);
        }
        let built = Graph::build_owned(matrix, dim, &BuildParams::default())
            .map_err(|e| anyhow::anyhow!("graph build: {e}"))?;
        let encoded =
            VGraph::from_graph(&built, true).map_err(|e| anyhow::anyhow!("graph encode: {e}"))?;
        drop(built);
        // The builder's matrix (`rows * dim * 4` bytes) and its per-vertex neighbour lists
        // are freed now; hand the allocator's free pages back so they leave the resident set.
        crate::core::os_memory::release_free_heap();
        ensure!(
            encoded.len() == rows.len(),
            "graph index has {} vertices for {} rows",
            encoded.len(),
            rows.len()
        );
        Some(GraphIndex {
            graph: encoded,
            exact: ExactScan {
                dim,
                rows: Arc::clone(&embeddings),
            },
        })
    } else {
        None
    };
    Ok(VectorSnapshot {
        identity,
        generation,
        dim,
        rows,
        members,
        exact,
        graph,
    })
}

fn staleness(store_generation: u64, snapshot_generation: u64) -> u64 {
    if store_generation == snapshot_generation {
        0
    } else {
        store_generation.abs_diff(snapshot_generation).max(1)
    }
}

pub(crate) fn vector_index_status(
    snapshot: Option<&VectorSnapshot>,
    store: &DocumentStore,
) -> VectorIndexStatus {
    match snapshot {
        None => VectorIndexStatus {
            rows: 0,
            generation: 0,
            current: false,
            stale_mutations: 0,
            graph: false,
            rebuild_recommended: store.embedded_count() >= SNAPSHOT_MIN_ROWS,
        },
        Some(snapshot) => {
            let same_store = snapshot.identity == store.identity;
            let stale =
                staleness(store.generation, snapshot.generation).max(u64::from(!same_store));
            VectorIndexStatus {
                rows: snapshot.rows(),
                generation: snapshot.generation,
                current: stale == 0,
                stale_mutations: stale,
                graph: snapshot.has_graph(),
                rebuild_recommended: !same_store || stale >= REBUILD_AFTER_MUTATIONS,
            }
        }
    }
}

struct Hit {
    document: Arc<StoredDocument>,
    chunk: u32,
    /// Candidate score from the `f32` scan, replaced by the `f64` re-score before ranking.
    score: f64,
}

fn compare_hits(a: &Hit, b: &Hit) -> Ordering {
    b.score
        .total_cmp(&a.score)
        .then_with(|| a.document.id.cmp(&b.document.id))
        .then(a.chunk.cmp(&b.chunk))
}

fn to_result(hit: &Hit, segment: Option<&TextSegment>) -> Result<DocumentResult> {
    let document = &hit.document;
    let chunk = &document.chunks[hit.chunk as usize];
    let score = hit.score.clamp(-1.0, 1.0);
    Ok(DocumentResult {
        id: chunk.id.clone(),
        document_id: document.id.clone(),
        source_uri: document.source_uri.clone(),
        version: document.version.clone(),
        metadata: document.metadata.clone(),
        text: try_text_of(chunk, segment)?,
        start_byte: chunk.start_byte,
        end_byte: chunk.end_byte,
        score,
        lexical_score: 0.0,
        semantic_score: Some(score),
    })
}

/// Answers an unfiltered vector query from the snapshot. `query` is l2-normalised. `None`
/// means the snapshot is too stale to answer this query (the exact delta exceeds its
/// capture limits, fewer than `k` hits survived validation, or a hit's text was scrubbed
/// before it was read); the caller takes the generic exact path.
pub(crate) fn search_vector_snapshot(
    snapshot: &VectorSnapshot,
    store: &RwLock<DocumentStore>,
    query: &[f32],
    exact_query: &[f64],
    k: usize,
    options: &VectorQueryOptions,
) -> Result<Option<Vec<DocumentResult>>> {
    let Some(ranked) = rank_vector_snapshot(snapshot, store, query, exact_query, k, options)?
    else {
        return Ok(None);
    };
    read_vector_hits(ranked, &store.read())
}

/// The ranked hits of [`search_vector_snapshot`]; [`read_vector_hits`] reads their text.
pub(crate) struct RankedVectorHits {
    hits: Vec<Hit>,
    segment: Option<Arc<TextSegment>>,
}

struct StaleExactCapture {
    live_rows: Vec<u64>,
    delta: Vec<Arc<StoredDocument>>,
    segment: Option<Arc<TextSegment>>,
}

fn capture_stale_exact(
    snapshot: &VectorSnapshot,
    store: &DocumentStore,
) -> Result<Option<StaleExactCapture>> {
    if snapshot.identity != store.identity {
        return Ok(None);
    }
    let changes = store.vector_changes.read();
    let Some(changes) = changes.since(snapshot.generation, store.generation) else {
        return Ok(None);
    };
    let mut live_rows = Vec::new();
    let words = snapshot.rows.len().div_ceil(64);
    live_rows
        .try_reserve_exact(words)
        .context("cannot allocate vector snapshot eligibility")?;
    live_rows.resize(words, u64::MAX);
    let mut delta = Vec::new();
    delta
        .try_reserve_exact(MAX_DELTA_DOCUMENTS.min(store.documents.len()))
        .context("cannot allocate vector snapshot delta owners")?;
    let mut chunks = 0;
    for id in changes {
        let start = snapshot
            .rows
            .partition_point(|row| row.document.id.as_str() < id);
        let end =
            start + snapshot.rows[start..].partition_point(|row| row.document.id.as_str() == id);
        if start < end {
            let first = start / 64;
            let last = (end - 1) / 64;
            let first_mask = u64::MAX << (start % 64);
            let last_mask = u64::MAX >> (63 - (end - 1) % 64);
            if first == last {
                live_rows[first] &= !(first_mask & last_mask);
            } else {
                live_rows[first] &= !first_mask;
                live_rows[first + 1..last].fill(0);
                live_rows[last] &= !last_mask;
            }
        }
        let Some(document) = store.get(id) else {
            continue;
        };
        let before = chunks;
        for chunk in &document.chunks {
            if chunk
                .embedding
                .as_ref()
                .is_some_and(|embedding| embedding.len() == snapshot.dim)
            {
                chunks += 1;
                if chunks > MAX_DELTA_CHUNKS {
                    return Ok(None);
                }
            }
        }
        if chunks != before {
            delta.push(Arc::clone(document));
        }
    }
    Ok(Some(StaleExactCapture {
        live_rows,
        delta,
        segment: store.text_segment(),
    }))
}

/// The hits with their text, or `None` when the text of one was scrubbed since the ranking
/// (its document replaced or deleted). `_store` is the store's read guard: logical hiding
/// is published under its write lock before physical erasure, preventing reads of hidden text.
pub(crate) fn read_vector_hits(
    ranked: RankedVectorHits,
    _store: &DocumentStore,
) -> Result<Option<Vec<DocumentResult>>> {
    let segment = ranked.segment.as_deref();
    ranked
        .hits
        .iter()
        .map(|hit| {
            let scrubbed = text_scrubbed(&hit.document.chunks[hit.chunk as usize], segment);
            if scrubbed {
                Ok(None)
            } else {
                to_result(hit, segment).map(Some)
            }
        })
        .collect()
}

pub(crate) fn rank_vector_snapshot(
    snapshot: &VectorSnapshot,
    store: &RwLock<DocumentStore>,
    query: &[f32],
    exact_query: &[f64],
    k: usize,
    options: &VectorQueryOptions,
) -> Result<Option<RankedVectorHits>> {
    ensure!(
        query.len() == snapshot.dim,
        "query has {} dimensions, the index {}",
        query.len(),
        snapshot.dim
    );
    ensure!(
        exact_query.len() == snapshot.dim,
        "canonical query dimension mismatch"
    );
    ensure!((1..=MAX_K).contains(&k), "require 1 <= k <= {MAX_K}");
    ensure!(
        (1..=MAX_EF).contains(&options.ef),
        "require 1 <= ef <= {MAX_EF}"
    );
    ensure!(
        options.min_score.is_finite() && (-1.0..=1.0).contains(&options.min_score),
        "minScore must be in [-1,1]"
    );
    let index = snapshot.index(options.mode)?;
    let (generation, segment) = {
        let store = store.read();
        if snapshot.identity != store.identity {
            return Ok(None);
        }
        (store.generation, store.text_segment())
    };
    let stale = staleness(generation, snapshot.generation);
    let exact_index = index.kind() == VectorIndexKind::Exact;
    let extra = usize::try_from(stale).unwrap_or(usize::MAX).min(4 * k);
    let fetch = (k + extra + 8).min(snapshot.rows());
    if stale != 0 && exact_index {
        return rank_stale_exact_snapshot(
            snapshot,
            store,
            exact_query,
            k,
            fetch,
            options.min_score,
        );
    }
    let graph_hits = if exact_index {
        Vec::new()
    } else {
        index.search(query, fetch, options.ef)?
    };
    let mut found: Vec<Hit> = Vec::with_capacity(fetch);
    if stale == 0 {
        let hits = if exact_index {
            snapshot
                .exact
                .search_canonical(exact_query, fetch, |_| true)
        } else {
            graph_hits
                .into_iter()
                .map(|(row, score)| (row, f64::from(score)))
                .collect()
        };
        for (row, score) in hits {
            let row = &snapshot.rows[row as usize];
            found.push(Hit {
                document: Arc::clone(&row.document),
                chunk: row.chunk,
                score,
            });
        }
    } else {
        let store = store.read();
        for (row, score) in graph_hits {
            let row = &snapshot.rows[row as usize];
            let live = store
                .get(&row.document.id)
                .is_some_and(|live| Arc::ptr_eq(live, &row.document));
            if live {
                found.push(Hit {
                    document: Arc::clone(&row.document),
                    chunk: row.chunk,
                    score: f64::from(score),
                });
            }
        }
        for document in store.documents.values() {
            if snapshot.members.contains(&(Arc::as_ptr(document) as usize)) {
                continue;
            }
            for (chunk, stored) in document.chunks.iter().enumerate() {
                let Some(embedding) = &stored.embedding else {
                    continue;
                };
                if embedding.len() != snapshot.dim {
                    continue;
                }
                found.push(Hit {
                    document: Arc::clone(document),
                    chunk: u32::try_from(chunk).context("chunk index over u32")?,
                    score: f64::from(dot(query, embedding)),
                });
            }
        }
        drop(store);
        if found.len() < k.min(snapshot.rows()) {
            return Ok(None);
        }
    }
    Ok(Some(finish_vector_hits(
        found,
        segment,
        exact_query,
        k,
        options.min_score,
    )))
}

#[inline(never)]
fn rank_stale_exact_snapshot(
    snapshot: &VectorSnapshot,
    store: &RwLock<DocumentStore>,
    exact_query: &[f64],
    k: usize,
    fetch: usize,
    min_score: f64,
) -> Result<Option<RankedVectorHits>> {
    let captured = {
        let store = store.read();
        capture_stale_exact(snapshot, &store)?
    };
    let Some(captured) = captured else {
        return Ok(None);
    };
    let segment = captured.segment;
    let mut found = Vec::with_capacity(fetch);
    let hits = snapshot.exact.search_canonical(exact_query, k, |row| {
        captured.live_rows[row / 64] & (1 << (row % 64)) != 0
    });
    for (row, score) in hits {
        let row = &snapshot.rows[row as usize];
        found.push(Hit {
            document: Arc::clone(&row.document),
            chunk: row.chunk,
            score,
        });
    }
    for document in &captured.delta {
        for (chunk, stored) in document.chunks.iter().enumerate() {
            if stored
                .embedding
                .as_ref()
                .is_some_and(|embedding| embedding.len() == snapshot.dim)
            {
                found.push(Hit {
                    document: Arc::clone(document),
                    chunk: u32::try_from(chunk).context("chunk index over u32")?,
                    score: 0.0,
                });
            }
        }
    }
    if found.len() < k.min(snapshot.rows()) {
        return Ok(None);
    }

    Ok(Some(finish_vector_hits(
        found,
        segment,
        exact_query,
        k,
        min_score,
    )))
}

fn finish_vector_hits(
    mut found: Vec<Hit>,
    segment: Option<Arc<TextSegment>>,
    exact_query: &[f64],
    k: usize,
    min_score: f64,
) -> RankedVectorHits {
    for hit in &mut found {
        if let Some(embedding) = hit
            .document
            .chunks
            .get(hit.chunk as usize)
            .and_then(|chunk| chunk.embedding.as_ref())
        {
            hit.score = embedding.cosine(exact_query);
        }
    }
    found.sort_by(compare_hits);
    found.retain(|hit| hit.score >= min_score);
    found.truncate(k);
    RankedVectorHits {
        hits: found,
        segment,
    }
}

/// The engine's published snapshot and the build lock.
#[derive(Default)]
pub(crate) struct VectorIndexSlot {
    current: RwLock<Option<Arc<VectorSnapshot>>>,
    building: Mutex<()>,
}

impl VectorIndexSlot {
    pub(crate) fn get(&self) -> Option<Arc<VectorSnapshot>> {
        self.current.read().clone()
    }

    pub(crate) fn publish(&self, snapshot: Arc<VectorSnapshot>) {
        *self.current.write() = Some(snapshot);
    }

    pub(crate) fn clear(&self) {
        *self.current.write() = None;
    }

    /// `None` while another build is running.
    pub(crate) fn try_build(&self) -> Option<MutexGuard<'_, ()>> {
        self.building.try_lock()
    }

    /// The build lock, waiting for a running build to finish.
    pub(crate) fn build(&self) -> MutexGuard<'_, ()> {
        self.building.lock()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::documents::{prepare, DocumentInput};
    use crate::core::encoding::TextEncoder;
    use serde_json::json;
    use std::cell::RefCell;
    use std::sync::{atomic::AtomicBool, atomic::Ordering as AtomicOrdering, mpsc};
    use std::time::Duration;

    thread_local! {
        static CANONICAL_HOOK: RefCell<Option<Box<dyn FnOnce()>>> = const { RefCell::new(None) };
    }

    pub(super) fn before_canonical_scoring() {
        if let Some(hook) = CANONICAL_HOOK.with(|slot| slot.borrow_mut().take()) {
            hook();
        }
    }

    fn matrix(rows: &[[f32; 4]]) -> ExactScan {
        let rows: Vec<Embedding> = rows
            .iter()
            .map(|row| {
                let norm = row.iter().map(|v| v * v).sum::<f32>().sqrt();
                Embedding::from_f32(row.iter().map(|v| v / norm).collect())
            })
            .collect();
        ExactScan {
            dim: 4,
            rows: rows.into(),
        }
    }

    #[test]
    fn exact_scan_orders_by_score_then_row_and_bounds_k() {
        let scan = matrix(&[
            [0.0, 1.0, 0.0, 0.0],
            [1.0, 0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0, 0.0],
            [0.5, 0.5, 0.0, 0.0],
        ]);
        let hits = scan.search(&[1.0, 0.0, 0.0, 0.0], 3, 0).unwrap();
        assert_eq!(hits.iter().map(|h| h.0).collect::<Vec<_>>(), [1, 2, 3]);
        assert!(
            (hits[0].1 - 1.0).abs() < 1e-6
                && (hits[2].1 - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-3
        );
        assert_eq!(scan.search(&[1.0, 0.0, 0.0, 0.0], 10, 0).unwrap().len(), 4);
        assert!(scan.search(&[1.0, 0.0, 0.0], 1, 0).is_err());
    }

    #[test]
    fn audit_regression_exact_snapshot_retains_all_canonical_rounding_winners() {
        for distractors in [8, 9, 10, 100] {
            let mut store = DocumentStore::default();
            for i in 0..=distractors {
                let input: DocumentInput = serde_json::from_value(json!({
                    "id": if i == distractors { "z".to_owned() } else { format!("a{i:03}") },
                    "text": "rounding regression",
                    "embeddings": [[1.0, if i == distractors { 0.0001 } else { 0.0 }]],
                }))
                .unwrap();
                let document = prepare(input, 1024, Some(2), TextEncoder::default()).unwrap();
                store.insert(document.id.clone(), document);
            }
            let snapshot =
                build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                    .unwrap();
            let query = super::super::normalize_embedding(&[1.0, 0.0001], 2).unwrap();
            let rounded: Vec<f32> = query.iter().map(|&x| x as f32).collect();
            let store = RwLock::new(store);
            for minimum in [-1.0, 0.999_999_999] {
                let hits = search_vector_snapshot(
                    &snapshot,
                    &store,
                    &rounded,
                    &query,
                    1,
                    &VectorQueryOptions {
                        mode: VectorIndexMode::Exact,
                        min_score: minimum,
                        ..Default::default()
                    },
                )
                .unwrap()
                .unwrap();
                assert_eq!(
                    hits.len(),
                    1,
                    "{distractors} distractors, threshold {minimum}"
                );
                assert_eq!(hits[0].document_id, "z", "{distractors} distractors");
                assert_eq!(hits[0].semantic_score, Some(1.0));
            }
        }
    }

    fn vector_input(id: &str, text: &str, embeddings: Vec<Vec<f64>>) -> DocumentInput {
        serde_json::from_value(json!({
            "id": id,
            "text": text,
            "chunkWords": 1,
            "overlapWords": 0,
            "embeddings": embeddings,
        }))
        .unwrap()
    }

    fn put_vector(store: &mut DocumentStore, id: &str, text: &str, embeddings: Vec<Vec<f64>>) {
        let document = prepare(
            vector_input(id, text, embeddings),
            1024,
            Some(2),
            TextEncoder::default(),
        )
        .unwrap();
        store.insert(document.id.clone(), document);
    }

    fn delete_vector(store: &mut DocumentStore, id: &str) {
        assert!(store.remove(id).is_some());
    }

    fn snapshot_results(
        snapshot: &VectorSnapshot,
        store: &RwLock<DocumentStore>,
        query: &[f64],
        k: usize,
        min_score: f64,
    ) -> Vec<(String, String, f64)> {
        let normalized = super::super::normalize_embedding(query, 2).unwrap();
        let rounded: Vec<f32> = normalized.iter().map(|&value| value as f32).collect();
        search_vector_snapshot(
            snapshot,
            store,
            &rounded,
            &normalized,
            k,
            &VectorQueryOptions {
                mode: VectorIndexMode::Exact,
                min_score,
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap()
        .into_iter()
        .map(|hit| (hit.document_id, hit.id, hit.semantic_score.unwrap()))
        .collect()
    }

    fn live_scan_results(
        store: &DocumentStore,
        query: &[f64],
        k: usize,
        min_score: f64,
    ) -> Vec<(String, String, f64)> {
        let normalized = super::super::normalize_embedding(query, 2).unwrap();
        let mut hits = Vec::new();
        for document in store.documents.values() {
            for (chunk, stored) in document.chunks.iter().enumerate() {
                let Some(embedding) = &stored.embedding else {
                    continue;
                };
                if embedding.len() == 2 {
                    let score = embedding.cosine(&normalized);
                    if score >= min_score {
                        hits.push((document.id.clone(), chunk as u32, score));
                    }
                }
            }
        }
        hits.sort_by(|a, b| {
            b.2.total_cmp(&a.2)
                .then_with(|| a.0.cmp(&b.0))
                .then(a.1.cmp(&b.1))
        });
        hits.truncate(k);
        hits.into_iter()
            .map(|(id, chunk, score)| {
                let row = &store.documents[&id].chunks[chunk as usize];
                (id, row.id.clone(), score.clamp(-1.0, 1.0))
            })
            .collect()
    }

    #[test]
    fn stale_exact_snapshot_matches_complete_live_scan_after_mutations() {
        for obsolete_chunks in [9, 10, 11, 12, 13, 14] {
            let mut store = DocumentStore::default();
            put_vector(
                &mut store,
                "a",
                &vec!["same"; obsolete_chunks].join(" "),
                vec![vec![1.0, 0.0]; obsolete_chunks],
            );
            put_vector(&mut store, "b", "candidate", vec![vec![0.8, 0.6]]);
            put_vector(&mut store, "tie-a", "tie", vec![vec![0.0, 1.0]]);
            put_vector(&mut store, "tie-b", "tie", vec![vec![0.0, 1.0]]);
            for stable in 0..12 {
                put_vector(
                    &mut store,
                    &format!("stable-{stable:02}"),
                    "stable",
                    vec![vec![0.6, 0.8]],
                );
            }
            let snapshot =
                build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                    .unwrap();

            let store = RwLock::new(store);
            for stage in 0..4 {
                {
                    let mut live = store.write();
                    match stage {
                        0 => put_vector(&mut live, "a", "changed", vec![vec![0.0, 1.0]]),
                        1 => put_vector(&mut live, "fresh", "fresh", vec![vec![0.7, 0.7]]),
                        2 => delete_vector(&mut live, "tie-b"),
                        _ => put_vector(&mut live, "inserted", "inserted", vec![vec![0.75, 0.25]]),
                    }
                }
                for k in [1, 10] {
                    for min_score in [-1.0, 0.8] {
                        let expected = live_scan_results(&store.read(), &[1.0, 0.0], k, min_score);
                        let actual = snapshot_results(&snapshot, &store, &[1.0, 0.0], k, min_score);
                        assert_eq!(
                            actual, expected,
                            "obsolete chunks {obsolete_chunks}, stage {stage}, k {k}, min {min_score}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn stale_exact_scoring_allows_writes_and_retains_a_coherent_ordered_capture() {
        let mut initial = DocumentStore::default();
        for row in 0..65 {
            put_vector(
                &mut initial,
                &format!("d{row:03}"),
                "base",
                vec![vec![1.0, row as f64 / 100.0]],
            );
        }
        let snapshot = build_vector_snapshot(
            capture_vector_rows(&initial, 2).unwrap().unwrap(),
            usize::MAX,
        )
        .unwrap();
        put_vector(&mut initial, "d000", "before", vec![vec![0.8, 0.6]]);
        delete_vector(&mut initial, "d064");
        put_vector(&mut initial, "inserted", "before", vec![vec![1.0, 0.0]]);
        let expected = live_scan_results(&initial, &[1.0, 0.0], 65, -1.0);
        let store = Arc::new(RwLock::new(initial));
        let (score_tx, score_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let writer_store = Arc::clone(&store);
        let writer = std::thread::spawn(move || {
            score_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let mut live = writer_store.write();
            put_vector(&mut live, "d000", "after", vec![vec![0.0, 1.0]]);
            delete_vector(&mut live, "d001");
            put_vector(&mut live, "inserted", "after", vec![vec![0.0, 1.0]]);
            put_vector(&mut live, "new-winner", "after", vec![vec![1.0, 0.0]]);
            drop(live);
            done_tx.send(()).unwrap();
        });
        let progressed = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&progressed);
        CANONICAL_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move || {
                score_tx.send(()).unwrap();
                observed.store(
                    done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
                    AtomicOrdering::SeqCst,
                );
            }));
        });
        let actual = snapshot_results(&snapshot, &store, &[1.0, 0.0], 65, -1.0);
        writer.join().unwrap();
        assert!(
            progressed.load(AtomicOrdering::SeqCst),
            "writer blocked during scoring"
        );
        assert_eq!(actual, expected);
        assert_ne!(
            actual,
            live_scan_results(&store.read(), &[1.0, 0.0], 65, -1.0)
        );
    }

    #[test]
    fn stale_exact_capture_preserves_live_rows_across_bitmap_boundaries() {
        for rows in [63, 64, 65, 127, 128, 129] {
            let mut store = DocumentStore::default();
            for row in 0..rows {
                put_vector(
                    &mut store,
                    &format!("d{row:03}"),
                    "tie",
                    vec![vec![1.0, 0.0]],
                );
            }
            let snapshot =
                build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                    .unwrap();
            put_vector(&mut store, "d000", "replacement", vec![vec![0.0, 1.0]]);
            delete_vector(&mut store, &format!("d{:03}", rows - 1));
            put_vector(&mut store, "new", "new", vec![vec![1.0, 0.0]]);
            let store = RwLock::new(store);
            for k in [1, rows] {
                for minimum in [-1.0, 0.5] {
                    assert_eq!(
                        snapshot_results(&snapshot, &store, &[1.0, 0.0], k, minimum),
                        live_scan_results(&store.read(), &[1.0, 0.0], k, minimum),
                        "rows={rows} k={k} min={minimum}"
                    );
                }
            }
        }
    }

    #[test]
    fn stale_exact_capture_bounds_delta_documents_and_chunks_without_truncating() {
        for (documents, chunks, accepted) in [
            (MAX_DELTA_DOCUMENTS - 1, 1, true),
            (MAX_DELTA_DOCUMENTS, 1, true),
            (MAX_DELTA_DOCUMENTS + 1, 1, false),
            (1, MAX_DELTA_CHUNKS - 1, true),
            (1, MAX_DELTA_CHUNKS, true),
            (1, MAX_DELTA_CHUNKS + 1, false),
        ] {
            let mut store = DocumentStore::default();
            put_vector(&mut store, "base", "base", vec![vec![0.0, 1.0]]);
            let snapshot =
                build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                    .unwrap();
            for document in 0..documents {
                put_vector(
                    &mut store,
                    &format!("delta{document:03}"),
                    &vec!["delta"; chunks].join(" "),
                    vec![vec![1.0, 0.0]; chunks],
                );
            }
            let expected = live_scan_results(&store, &[1.0, 0.0], 10, -1.0);
            let store = RwLock::new(store);
            let capture = capture_stale_exact(&snapshot, &store.read()).unwrap();
            assert_eq!(
                capture.is_some(),
                accepted,
                "documents={documents} chunks={chunks}"
            );
            let ranked = search_vector_snapshot(
                &snapshot,
                &store,
                &[1.0, 0.0],
                &[1.0, 0.0],
                10,
                &VectorQueryOptions {
                    mode: VectorIndexMode::Exact,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(ranked.is_some(), accepted);
            let results = ranked.unwrap_or_else(|| {
                super::super::search(
                    &store.read(),
                    "",
                    &super::super::SearchOptions {
                        k: Some(10),
                        embedding: Some(vec![1.0, 0.0]),
                        lexical_weight: Some(0.0),
                        semantic_weight: Some(1.0),
                        min_semantic_score: Some(-1.0),
                        ..Default::default()
                    },
                    Some(2),
                )
                .unwrap()
            });
            let actual: Vec<_> = results
                .into_iter()
                .map(|hit| (hit.document_id, hit.id, hit.semantic_score.unwrap()))
                .collect();
            assert_eq!(actual, expected, "documents={documents} chunks={chunks}");
        }
    }

    #[test]
    fn tracked_vector_changes_deduplicate_updates_and_delete_reinsert() {
        let mut store = DocumentStore::default();
        put_vector(&mut store, "base", "base", vec![vec![1.0, 0.0]]);
        put_vector(&mut store, "stable", "stable", vec![vec![0.8, 0.6]]);
        let snapshot =
            build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                .unwrap();
        let store = RwLock::new(store);
        for revision in 0..MAX_DELTA_DOCUMENTS + 1 {
            {
                let mut live = store.write();
                delete_vector(&mut live, "base");
                put_vector(
                    &mut live,
                    "base",
                    "new",
                    vec![vec![1.0, revision as f64 / 100.0]],
                );
            }
            assert_eq!(
                snapshot_results(&snapshot, &store, &[1.0, 0.0], 1, -1.0),
                live_scan_results(&store.read(), &[1.0, 0.0], 1, -1.0),
            );
        }
        let mut live = store.write();
        put_vector(&mut live, "temporary", "sensitive", vec![vec![1.0, 0.0]]);
        let removed = Arc::downgrade(&live.documents["temporary"]);
        delete_vector(&mut live, "temporary");
        assert!(
            removed.upgrade().is_none(),
            "ledger retained deleted payload"
        );
    }

    #[test]
    fn tracked_vector_changes_bound_id_bytes_and_recover_after_a_new_capture() {
        use super::super::dense::MAX_DELTA_ID_BYTES;
        for bytes in [
            MAX_DELTA_ID_BYTES - 1,
            MAX_DELTA_ID_BYTES,
            MAX_DELTA_ID_BYTES + 1,
        ] {
            let mut store = DocumentStore::default();
            put_vector(&mut store, "base", "base", vec![vec![0.0, 1.0]]);
            let snapshot =
                build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                    .unwrap();
            let mut ids = Vec::new();
            for item in 0..17 {
                let size = match item {
                    0..15 => 4096,
                    15 => 2048,
                    _ => bytes - 15 * 4096 - 2048,
                };
                let prefix = format!("delta{item:02}");
                let id = prefix.clone() + &"x".repeat(size - prefix.len());
                put_vector(&mut store, &id, "delta", vec![vec![1.0, 0.0]]);
                ids.push(id);
            }
            let store = RwLock::new(store);
            assert_eq!(
                capture_stale_exact(&snapshot, &store.read())
                    .unwrap()
                    .is_some(),
                bytes <= MAX_DELTA_ID_BYTES,
                "id bytes {bytes}"
            );
            if bytes <= MAX_DELTA_ID_BYTES {
                assert_eq!(
                    snapshot_results(&snapshot, &store, &[1.0, 0.0], 1, -1.0),
                    live_scan_results(&store.read(), &[1.0, 0.0], 1, -1.0),
                );
            }
            let rebuilt = build_vector_snapshot(
                capture_vector_rows(&store.read(), 2).unwrap().unwrap(),
                usize::MAX,
            )
            .unwrap();
            delete_vector(&mut store.write(), &ids[0]);
            assert_eq!(
                snapshot_results(&rebuilt, &store, &[1.0, 0.0], 1, -1.0),
                live_scan_results(&store.read(), &[1.0, 0.0], 1, -1.0),
            );
        }
    }

    #[test]
    fn tracked_vector_changes_cover_independent_snapshots_and_dense_lifecycles() {
        use super::super::dense::{build_dense_index, capture_dense_index, publish_dense_index};
        let mut store = DocumentStore::default();
        for id in 0..=MAX_DELTA_DOCUMENTS {
            put_vector(
                &mut store,
                &format!("d{id:03}"),
                "base",
                vec![vec![1.0, 0.0]],
            );
        }
        let first =
            build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                .unwrap();
        put_vector(&mut store, "d000", "changed", vec![vec![0.0, 1.0]]);
        let capture = capture_vector_rows(&store, 2).unwrap().unwrap();
        put_vector(&mut store, "d000", "changed again", vec![vec![0.8, 0.6]; 2]);
        let second = build_vector_snapshot(capture, usize::MAX).unwrap();
        let trained = build_dense_index(capture_dense_index(&store, 2).unwrap().unwrap())
            .unwrap()
            .unwrap();
        assert!(publish_dense_index(&mut store, &trained));
        put_vector(&mut store, "d001", "changed", vec![vec![0.0, 1.0]]);
        store.discard_stale_dense_index();
        assert!(store.dense_index.is_none());
        let store = RwLock::new(store);
        for snapshot in [&first, &second] {
            assert_eq!(
                snapshot_results(snapshot, &store, &[1.0, 0.0], 10, -1.0),
                live_scan_results(&store.read(), &[1.0, 0.0], 10, -1.0),
            );
        }
        {
            let mut live = store.write();
            for id in 2..MAX_DELTA_DOCUMENTS {
                put_vector(
                    &mut live,
                    &format!("d{id:03}"),
                    "changed",
                    vec![vec![0.0, 1.0]],
                );
            }
        }
        let newest = build_vector_snapshot(
            capture_vector_rows(&store.read(), 2).unwrap().unwrap(),
            usize::MAX,
        )
        .unwrap();
        put_vector(&mut store.write(), "d128", "latest", vec![vec![1.0, 0.0]]);
        assert!(capture_stale_exact(&first, &store.read())
            .unwrap()
            .is_none());
        assert!(capture_stale_exact(&second, &store.read())
            .unwrap()
            .is_none());
        assert_eq!(
            snapshot_results(&newest, &store, &[1.0, 0.0], 10, -1.0),
            live_scan_results(&store.read(), &[1.0, 0.0], 10, -1.0),
        );
    }

    #[test]
    fn tracked_vector_changes_reject_identity_aliases_and_generation_gaps() {
        let mut original = DocumentStore::default();
        put_vector(&mut original, "old", "old", vec![vec![1.0, 0.0]]);
        let snapshot = build_vector_snapshot(
            capture_vector_rows(&original, 2).unwrap().unwrap(),
            usize::MAX,
        )
        .unwrap();
        let mut other = DocumentStore::default();
        put_vector(&mut other, "new", "new", vec![vec![0.0, 1.0]]);
        assert_eq!(original.generation, other.generation);
        let status = vector_index_status(Some(&snapshot), &other);
        assert!(!status.current && status.rebuild_recommended);
        assert!(rank_vector_snapshot(
            &snapshot,
            &RwLock::new(other),
            &[1.0, 0.0],
            &[1.0, 0.0],
            1,
            &VectorQueryOptions::default(),
        )
        .unwrap()
        .is_none());
        original.generation += 1;
        assert!(capture_stale_exact(&snapshot, &original).unwrap().is_none());
        put_vector(&mut original, "old", "after gap", vec![vec![0.0, 1.0]; 2]);
        assert!(capture_stale_exact(&snapshot, &original).unwrap().is_none());
        let rebuilt = build_vector_snapshot(
            capture_vector_rows(&original, 2).unwrap().unwrap(),
            usize::MAX,
        )
        .unwrap();
        put_vector(&mut original, "new", "new", vec![vec![1.0, 0.0]]);
        let store = RwLock::new(original);
        assert_eq!(
            snapshot_results(&rebuilt, &store, &[1.0, 0.0], 1, -1.0),
            live_scan_results(&store.read(), &[1.0, 0.0], 1, -1.0),
        );
    }

    #[test]
    fn tracked_vector_changes_cover_batched_publication_and_replacements() {
        for count in [
            MAX_DELTA_DOCUMENTS - 1,
            MAX_DELTA_DOCUMENTS,
            MAX_DELTA_DOCUMENTS + 1,
        ] {
            let mut store = DocumentStore::default();
            put_vector(&mut store, "base", "base", vec![vec![0.0, 1.0]]);
            let snapshot =
                build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                    .unwrap();
            let batch = (0..count)
                .map(|id| {
                    Arc::new(
                        prepare(
                            vector_input(&format!("d{id:03}"), "batch", vec![vec![1.0, 0.0]]),
                            1024,
                            Some(2),
                            TextEncoder::default(),
                        )
                        .unwrap(),
                    )
                })
                .collect();
            store.insert_batch(batch).unwrap();
            let store = RwLock::new(store);
            assert_eq!(
                capture_stale_exact(&snapshot, &store.read())
                    .unwrap()
                    .is_some(),
                count <= MAX_DELTA_DOCUMENTS,
            );
            if count <= MAX_DELTA_DOCUMENTS {
                let batch = [
                    vector_input("d000", "changed length", vec![vec![0.0, 1.0]; 2]),
                    vector_input("d001", "changed", vec![vec![0.0, 1.0]]),
                    vector_input("d000", "last", vec![vec![0.8, 0.6]]),
                ]
                .into_iter()
                .map(|input| {
                    Arc::new(prepare(input, 1024, Some(2), TextEncoder::default()).unwrap())
                })
                .collect();
                store.write().insert_batch(batch).unwrap();
                assert_eq!(
                    snapshot_results(&snapshot, &store, &[1.0, 0.0], 10, -1.0),
                    live_scan_results(&store.read(), &[1.0, 0.0], 10, -1.0),
                );
            }
        }
    }

    #[test]
    fn tracked_vector_changes_fall_back_after_slot_rebuilding() {
        let mut store = DocumentStore::default();
        for id in 0..1026 {
            put_vector(
                &mut store,
                &format!("d{id:04}"),
                "base",
                vec![vec![1.0, 0.0]],
            );
        }
        let snapshot =
            build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                .unwrap();
        for id in 0..514 {
            delete_vector(&mut store, &format!("d{id:04}"));
        }
        assert_ne!(snapshot.identity, store.identity, "slots were not rebuilt");
        assert!(capture_stale_exact(&snapshot, &store).unwrap().is_none());
        let rebuilt =
            build_vector_snapshot(capture_vector_rows(&store, 2).unwrap().unwrap(), usize::MAX)
                .unwrap();
        put_vector(&mut store, "d0514", "changed", vec![vec![0.0, 1.0]]);
        let store = RwLock::new(store);
        assert_eq!(
            snapshot_results(&rebuilt, &store, &[1.0, 0.0], 10, -1.0),
            live_scan_results(&store.read(), &[1.0, 0.0], 10, -1.0),
        );
    }

    #[test]
    fn tracked_vector_changes_clear_complete_document_row_ranges() {
        for prefix in [0, 1, 63, 64, 65] {
            for replaced in [1, 2, 63, 64, 65, 127, 128, 129] {
                let mut store = DocumentStore::default();
                if prefix != 0 {
                    put_vector(
                        &mut store,
                        "a-prefix",
                        &vec!["prefix"; prefix].join(" "),
                        vec![vec![0.0, 1.0]; prefix],
                    );
                }
                put_vector(
                    &mut store,
                    "b-replaced",
                    &vec!["obsolete"; replaced].join(" "),
                    vec![vec![1.0, 0.0]; replaced],
                );
                put_vector(&mut store, "c-stable", "stable", vec![vec![0.8, 0.6]]);
                let snapshot = build_vector_snapshot(
                    capture_vector_rows(&store, 2).unwrap().unwrap(),
                    usize::MAX,
                )
                .unwrap();
                put_vector(&mut store, "b-replaced", "new", vec![vec![0.0, 1.0]]);
                let store = RwLock::new(store);
                assert_eq!(
                    snapshot_results(&snapshot, &store, &[1.0, 0.0], 1, -1.0),
                    live_scan_results(&store.read(), &[1.0, 0.0], 1, -1.0),
                    "prefix={prefix}, replaced={replaced}"
                );
            }
        }
    }

    #[test]
    fn dot_matches_the_scalar_sum_with_a_remainder() {
        let a: Vec<f32> = (0..19).map(|i| i as f32 * 0.25).collect();
        let b: Vec<f32> = (0..19).map(|i| 1.0 - i as f32 * 0.1).collect();
        let expected: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        assert!((dot(&a, &b) - expected).abs() < 1e-4);
    }

    /// The snapshot holds the store's embedding allocations, not copies, and the graph-free
    /// and graph snapshots both answer from them.
    #[test]
    fn snapshot_rows_share_the_store_embeddings() {
        const DIM: usize = 16;
        let axis = |lead: usize, second: usize, value: f64| -> Vec<f64> {
            let mut values = vec![0.0; DIM];
            values[lead] = 1.0;
            values[second] = value;
            values
        };
        let mut store = DocumentStore::default();
        for i in 0..40 {
            let input: DocumentInput = serde_json::from_value(json!({
                "id": format!("d{i:03}"),
                "text": format!("document {i} with a few words of text for two chunks here"),
                "chunkWords": 6, "overlapWords": 0,
                "embeddings": [axis(0, 1, i as f64 / 50.0), axis(2, 3, i as f64 / 40.0)]
            }))
            .unwrap();
            let document = prepare(input, 1024, Some(DIM), TextEncoder::default()).unwrap();
            store.insert(document.id.clone(), document);
        }
        let capture = capture_vector_rows(&store, DIM).unwrap().unwrap();
        assert_eq!(capture.rows.len(), 80);
        for (row, embedding) in capture.rows.iter().zip(&capture.embeddings) {
            let stored = store.documents[&row.document.id].chunks[row.chunk as usize]
                .embedding
                .as_ref()
                .unwrap();
            assert!(embedding.shares_allocation(stored));
        }
        for graph_min_rows in [usize::MAX, 1] {
            let capture = capture_vector_rows(&store, DIM).unwrap().unwrap();
            let snapshot = build_vector_snapshot(capture, graph_min_rows).unwrap();
            assert_eq!(snapshot.has_graph(), graph_min_rows == 1);
            for (row, embedding) in snapshot.rows.iter().zip(snapshot.exact.rows.iter()) {
                let stored = store.documents[&row.document.id].chunks[row.chunk as usize]
                    .embedding
                    .as_ref()
                    .unwrap();
                assert!(embedding.shares_allocation(stored));
            }
            let query = Embedding::from_f64(
                &super::super::normalize_embedding(&axis(0, 1, 39.0 / 50.0), DIM).unwrap(),
            );
            let hits = snapshot
                .index(VectorIndexMode::Auto)
                .unwrap()
                .search(&query, 1, DEFAULT_EF)
                .unwrap();
            let row = &snapshot.rows[hits[0].0 as usize];
            assert_eq!((row.document.id.as_str(), row.chunk), ("d039", 0));
            assert!((hits[0].1 - 1.0).abs() < 1e-6);
        }
    }
}
