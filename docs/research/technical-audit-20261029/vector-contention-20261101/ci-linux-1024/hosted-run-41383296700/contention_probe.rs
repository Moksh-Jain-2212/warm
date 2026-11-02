// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

// Injected into isolated source archives; not compiled into the shipped library.
use super::*;
use crate::core::documents::{DocumentInput, EncodeMode, IngestOptions};
use crate::core::encoding::TextEncoder;
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::{Cell, RefCell};
use std::sync::mpsc;
use std::time::Instant;

const WARMUPS: usize = 8;
const SCHEDULE: usize = 64;
const SAMPLES: usize = 1024;
const ITERATIONS: usize = WARMUPS + SAMPLES;

thread_local! {
    static TRACK: Cell<bool> = const { Cell::new(false) };
    static LIVE: Cell<isize> = const { Cell::new(0) };
    static PEAK: Cell<isize> = const { Cell::new(0) };
    static CALLS: Cell<usize> = const { Cell::new(0) };
    static START_WRITER: RefCell<Option<mpsc::SyncSender<()>>> = const { RefCell::new(None) };
}

struct Counting;
#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn account(delta: isize, allocation: bool) {
    if TRACK.try_with(Cell::get).unwrap_or(false) {
        LIVE.with(|live| {
            let value = live.get() + delta;
            live.set(value);
            PEAK.with(|peak| peak.set(peak.get().max(value)));
        });
        if allocation {
            CALLS.with(|calls| calls.set(calls.get() + 1));
        }
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let result = unsafe { System.alloc(layout) };
        if !result.is_null() { account(layout.size() as isize, true); }
        result
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let result = unsafe { System.alloc_zeroed(layout) };
        if !result.is_null() { account(layout.size() as isize, true); }
        result
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        account(-(layout.size() as isize), false);
        unsafe { System.dealloc(pointer, layout) };
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let result = unsafe { System.realloc(pointer, layout, size) };
        if !result.is_null() { account(size as isize - layout.size() as isize, true); }
        result
    }
}

pub(super) fn scoring_started() {
    START_WRITER.with(|slot| {
        if let Some(sender) = slot.borrow().as_ref() { sender.send(()).unwrap(); }
    });
}

fn document(id: usize, version: usize, dim: usize) -> StoredDocument {
    let values: Vec<f64> = (0..dim)
        .map(|axis| ((id * 131 + axis * 23 + version * 7) as f64 * 0.17).sin())
        .collect();
    let input: DocumentInput = serde_json::from_value(json!({
        "id": format!("d{id:05}"), "version": version.to_string(),
        "text": "fixture", "embeddings": [values], "storeText": false,
    })).unwrap();
    super::super::prepare_with_options(input, 1024, Some(dim), None, TextEncoder::default(),
        &IngestOptions { encode: EncodeMode::Lexical, ..Default::default() }).unwrap()
}

fn signature(hits: &[Hit]) -> Vec<(String, u32, u64)> {
    hits.iter().map(|hit| (hit.document.id.clone(), hit.chunk, hit.score.to_bits())).collect()
}

fn oracle(store: &DocumentStore, query: &[f64]) -> Vec<(String, u32, u64)> {
    let mut all = Vec::new();
    for document in store.documents.values() {
        for (chunk, stored) in document.chunks.iter().enumerate() {
            if let Some(embedding) = &stored.embedding {
                all.push(Hit { document: Arc::clone(document), chunk: chunk as u32,
                    score: embedding.cosine(query) });
            }
        }
    }
    all.sort_by(compare_hits);
    all.truncate(10);
    signature(&all)
}

#[test]
#[ignore]
fn vector_contention_probe() {
    let mut groups = Vec::new();
    for dim in [16, 128, 768] {
        let mut initial = DocumentStore::default();
        let batch: Vec<_> = (0..8192).map(|id| Arc::new(document(id, 0, dim))).collect();
        initial.insert_batch(batch).unwrap();
        let snapshot = build_vector_snapshot(capture_vector_rows(&initial, dim).unwrap().unwrap(), usize::MAX).unwrap();
        let store = Arc::new(RwLock::new(initial));
        for phase in ["fresh_idle", "stale_idle", "stale_writer"] {
            if phase == "stale_idle" {
                let mut live = store.write();
                for id in (0..16).chain(8192..8200) {
                    let doc = document(id, 1, dim);
                    live.insert(doc.id.clone(), doc);
                }
                for id in 16..24 { assert!(live.remove(&format!("d{id:05}")).is_some()); }
            }
            let (start_tx, start_rx) = mpsc::sync_channel(1);
            let (done_tx, done_rx) = mpsc::sync_channel(1);
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            let writer_store = Arc::clone(&store);
            let concurrent = phase == "stale_writer";
            let writer = std::thread::spawn(move || {
                if concurrent {
                    for index in 0..ITERATIONS {
                        let replacement = document(0, index + 2, dim);
                        ready_tx.send(()).unwrap();
                        start_rx.recv().unwrap();
                        let start = Instant::now();
                        let mut guard = writer_store.write();
                        let acquired = Instant::now();
                        guard.insert(replacement.id.clone(), replacement);
                        drop(guard);
                        done_tx.send(((acquired-start).as_nanos() as u64, start.elapsed().as_nanos() as u64)).unwrap();
                    }
                }
            });
            if concurrent { START_WRITER.with(|slot| *slot.borrow_mut() = Some(start_tx)); }
            let mut samples = Vec::new();
            let mut ordered_results = Vec::new();
            for index in 0..ITERATIONS {
                if concurrent { ready_rx.recv().unwrap(); }
                let query_index = if index < WARMUPS { index } else { WARMUPS + (index - WARMUPS) % SCHEDULE };
                let raw: Vec<_> = (0..dim).map(|axis| ((query_index * 17 + axis * 7) as f64 * 0.11).cos()).collect();
                let query = super::super::normalize_embedding(&raw, dim).unwrap();
                let rounded: Vec<_> = query.iter().map(|&v| v as f32).collect();
                let expected = oracle(&store.read(), &query);
                LIVE.with(|v| v.set(0)); PEAK.with(|v| v.set(0)); CALLS.with(|v| v.set(0));
                TRACK.with(|v| v.set(true));
                let start = Instant::now();
                let ranked = rank_vector_snapshot(&snapshot, &store, &rounded, &query, 10,
                    &VectorQueryOptions { mode: VectorIndexMode::Exact, ..Default::default() }).unwrap().unwrap();
                let query_ns = start.elapsed().as_nanos() as u64;
                TRACK.with(|v| v.set(false));
                let peak = PEAK.with(Cell::get);
                let allocations = CALLS.with(Cell::get);
                let (writer_wait_ns, writer_total_ns) = if concurrent { done_rx.recv().unwrap() } else { (0, 0) };
                let actual = signature(&ranked.hits);
                assert_eq!(actual, expected, "dim={dim} phase={phase} sample={index}");
                if index >= WARMUPS {
                    samples.push(json!({"query_ns":query_ns, "writer_wait_ns":writer_wait_ns,
                        "writer_total_ns":writer_total_ns, "peak_requested_bytes":peak, "allocations":allocations}));
                    ordered_results.push(actual);
                }
            }
            START_WRITER.with(|slot| *slot.borrow_mut() = None);
            writer.join().unwrap();
            groups.push(json!({"dimensions":dim, "phase":phase, "samples":samples,
                "oracle_checks":ITERATIONS, "ordered_results":ordered_results}));
        }
    }
    std::fs::write(std::env::var("WARM_PROBE_OUT").unwrap(),
        serde_json::to_vec(&json!({"groups":groups})).unwrap()).unwrap();
}
