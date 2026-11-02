# Copyright 2024-2026 WritersLogic Contributors
# SPDX-License-Identifier: Apache-2.0
"""Allocation-only instrumentation injected into an isolated baseline source archive."""

from pathlib import Path


PROFILE = r'''
static PROFILE_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PROFILE_STAGE: AtomicUsize = AtomicUsize::new(0);
static PROFILE_BASE: AtomicUsize = AtomicUsize::new(0);
static PROFILE_START: [AtomicUsize; 7] = [const { AtomicUsize::new(0) }; 7];
static PROFILE_END: [AtomicUsize; 7] = [const { AtomicUsize::new(0) }; 7];
static PROFILE_PEAK: [AtomicUsize; 7] = [const { AtomicUsize::new(0) }; 7];
static PROFILE_BYTES: [AtomicUsize; 7] = [const { AtomicUsize::new(0) }; 7];
static PROFILE_CALLS: [AtomicUsize; 7] = [const { AtomicUsize::new(0) }; 7];
static PROFILE_LARGEST: [AtomicUsize; 7] = [const { AtomicUsize::new(0) }; 7];

fn profile_allocation(size: usize) {
    if PROFILE_ACTIVE.load(Ordering::Relaxed) {
        let stage = PROFILE_STAGE.load(Ordering::Relaxed);
        PROFILE_PEAK[stage].fetch_max(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
        PROFILE_BYTES[stage].fetch_add(size, Ordering::Relaxed);
        PROFILE_CALLS[stage].fetch_add(1, Ordering::Relaxed);
        PROFILE_LARGEST[stage].fetch_max(size, Ordering::Relaxed);
    }
}

pub(super) fn profile_stage(stage: usize) {
    if PROFILE_ACTIVE.load(Ordering::Relaxed) {
        let live = LIVE.load(Ordering::Relaxed);
        let previous = PROFILE_STAGE.swap(stage, Ordering::Relaxed);
        PROFILE_END[previous].store(live, Ordering::Relaxed);
        PROFILE_START[stage].store(live, Ordering::Relaxed);
        PROFILE_PEAK[stage].store(live, Ordering::Relaxed);
    }
}

fn profile_begin() {
    for table in [&PROFILE_START, &PROFILE_END, &PROFILE_PEAK, &PROFILE_BYTES, &PROFILE_CALLS, &PROFILE_LARGEST] {
        for value in table { value.store(0, Ordering::Relaxed); }
    }
    PROFILE_BASE.store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
    PROFILE_STAGE.store(0, Ordering::Relaxed);
    PROFILE_ACTIVE.store(true, Ordering::Relaxed);
}

fn profile_finish() -> Value {
    let stage = PROFILE_STAGE.load(Ordering::Relaxed);
    PROFILE_END[stage].store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
    PROFILE_ACTIVE.store(false, Ordering::Relaxed);
    let base = PROFILE_BASE.load(Ordering::Relaxed);
    let names = ["dispatch", "documents", "slot_mask", "eligible_owners", "words_and_dfs", "lexical_ranking", "captured_chunks"];
    Value::Array((0..7).map(|stage| json!({
        "stage": names[stage],
        "live_start": PROFILE_START[stage].load(Ordering::Relaxed).saturating_sub(base),
        "live_end": PROFILE_END[stage].load(Ordering::Relaxed).saturating_sub(base),
        "peak": PROFILE_PEAK[stage].load(Ordering::Relaxed).saturating_sub(base),
        "requested_allocation_bytes": PROFILE_BYTES[stage].load(Ordering::Relaxed),
        "allocation_calls": PROFILE_CALLS[stage].load(Ordering::Relaxed),
        "largest_allocation": PROFILE_LARGEST[stage].load(Ordering::Relaxed),
    })).collect())
}
'''


def instrument(source: Path):
    path = source / "src/core/documents/campaign_probe.rs"
    text = path.read_text().replace("fn allocated(size: usize) {", PROFILE + "\nfn allocated(size: usize) {")
    text = text.replace("CALLS.fetch_add(1, Ordering::Relaxed);\n}", "CALLS.fetch_add(1, Ordering::Relaxed);\n    profile_allocation(size);\n}", 1)
    text = text.replace("PEAK.fetch_max(live, Ordering::Relaxed);\n        }", "PEAK.fetch_max(live, Ordering::Relaxed);\n            profile_allocation(size);\n        }")
    text = text.replace("let captured = capture_search(store, vec![prepared]);", "if !hot && index == 1 { profile_begin(); }\n            let captured = capture_search(store, vec![prepared]);\n            let allocation_profile = if !hot && index == 1 { profile_finish() } else { Value::Null };")
    text = text.replace('"allocations":allocations}', '"allocations":allocations, "allocation_profile":allocation_profile}')
    path.write_text(text)
    path = source / "src/core/documents/search.rs"
    text = path.read_text()
    start = text.index("fn capture_planned_query(")
    end = text.index("impl CapturedSearch", start)
    body = text[start:end]
    for needle, stage in [
        ("let candidates = store.candidate_ids", 1),
        ("let slots = (store.slot_count", 2),
        ("if slots.is_some() && dense.is_some()", 3),
        ("let words = documents", 4),
        ("let mut ranked = Vec::new();", 5),
        ("let mut chunks: Vec<_> = ranked", 6),
    ]:
        assert body.count(needle) == 1, needle
        body = body.replace(needle, f"campaign_probe::profile_stage({stage});\n        {needle}")
    path.write_text(text[:start] + body + text[end:])
