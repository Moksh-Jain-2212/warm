// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

fn modes() -> &'static [bool] {
    #[cfg(feature = "security")]
    {
        &[false, true]
    }
    #[cfg(not(feature = "security"))]
    {
        &[false]
    }
}

fn create(path: &Path, encrypted: bool) -> TextSegment {
    #[cfg(feature = "security")]
    let cipher = encrypted.then(|| {
        Arc::new(
            crate::core::security::EncryptionManager::new("cache-test", path.parent().unwrap())
                .unwrap(),
        )
    });
    #[cfg(not(feature = "security"))]
    assert!(!encrypted);
    TextSegment::create(
        path,
        #[cfg(feature = "security")]
        cipher,
    )
    .unwrap()
}

#[test]
fn staged_tail_rollback_preserves_prefix_and_allows_a_committed_retry() {
    for &encrypted in modes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("text");
        let segment = create(&path, encrypted);
        let kept = {
            let mut stage = segment.stage().unwrap();
            let kept = segment.append("committed prefix").unwrap();
            stage.committed();
            kept
        };
        let before = std::fs::read(&path).unwrap();
        let start = segment.len();
        let discarded = {
            let mut stage = segment.stage().unwrap();
            let first = segment.append("uncommitted héllo").unwrap();
            segment.append("second uncommitted record").unwrap();
            assert_eq!(
                segment.read(first.0, first.1, first.2).unwrap(),
                "uncommitted héllo"
            );
            stage.rollback().unwrap();
            first
        };
        assert_eq!(segment.len(), start);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            segment.read(kept.0, kept.1, kept.2).unwrap(),
            "committed prefix"
        );
        assert!(segment.read(discarded.0, discarded.1, discarded.2).is_err());

        let retried = {
            let mut stage = segment.stage().unwrap();
            let retried = segment.append("committed retry").unwrap();
            stage.committed();
            retried
        };
        segment.prepare_write().unwrap();
        assert_eq!(retried.0, start);
        assert_eq!(
            segment.read(retried.0, retried.1, retried.2).unwrap(),
            "committed retry"
        );
        assert_eq!(segment.file.metadata().unwrap().len(), segment.len());
    }
}

#[test]
fn dropping_or_unwinding_staging_blocks_append_until_tail_repair() {
    for &encrypted in modes() {
        for unwind in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("text");
            let segment = create(&path, encrypted);
            let kept = segment.append("retained live prefix").unwrap();
            let before = std::fs::read(&path).unwrap();
            let start = segment.len();
            let outcome = catch_unwind(AssertUnwindSafe(|| {
                let _stage = segment.stage().unwrap();
                segment.append("uncommitted suffix").unwrap();
                assert!(!unwind, "simulate interruption during staging");
            }));
            assert_eq!(outcome.is_err(), unwind);
            assert_eq!(segment.len(), start);
            assert!(segment.file.metadata().unwrap().len() > start);
            assert!(segment
                .append("must wait for repair")
                .unwrap_err()
                .to_string()
                .contains("awaiting cleanup"));
            assert_eq!(
                segment.read(kept.0, kept.1, kept.2).unwrap(),
                "retained live prefix"
            );

            segment.prepare_write().unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), before);
            let resumed = segment.append("resumed after repair").unwrap();
            assert_eq!(resumed.0, start);
            assert_eq!(
                segment.read(resumed.0, resumed.1, resumed.2).unwrap(),
                "resumed after repair"
            );
        }
    }
}

#[test]
fn failed_partial_append_repairs_physical_tail_even_when_logical_length_did_not_move() {
    for &encrypted in modes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("text");
        let segment = create(&path, encrypted);
        let kept = segment.append("live prefix before failure").unwrap();
        let before = std::fs::read(&path).unwrap();
        let start = segment.len();
        let read_only = segment.read_only_copy(&path).unwrap();
        {
            let mut stage = read_only.stage().unwrap();
            positioned_write(&segment.file, b"partial unwritten tail", start).unwrap();
            assert!(read_only.append("injected write failure").is_err());
            assert_eq!(read_only.len(), start);
            assert!(stage.rollback().is_err());
        }
        assert!(read_only.file.metadata().unwrap().len() > start);
        assert!(read_only.prepare_write().is_err());
        assert!(read_only.append("cannot overwrite before repair").is_err());
        assert_eq!(
            read_only.read(kept.0, kept.1, kept.2).unwrap(),
            "live prefix before failure"
        );

        let recovered = read_only.writable_copy(&path).unwrap();
        recovered.prepare_write().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let retried = recovered.append("recovered append").unwrap();
        assert_eq!(retried.0, start);
        assert_eq!(
            recovered.read(retried.0, retried.1, retried.2).unwrap(),
            "recovered append"
        );
        assert_eq!(
            recovered.read(kept.0, kept.1, kept.2).unwrap(),
            "live prefix before failure"
        );
    }
}

#[test]
fn queued_scrubs_hide_records_before_failed_io_and_retry_after_recovery() {
    for &encrypted in modes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("text");
        let segment = create(&path, encrypted);
        let removed = segment.append("obsolete secret passage").unwrap();
        let kept = segment.append("live retained passage").unwrap();
        let before = std::fs::read(&path).unwrap();
        let read_only = segment.read_only_copy(&path).unwrap();
        read_only.queue_scrub(removed.0, removed.1).unwrap();
        assert_eq!(read_only.read(removed.0, removed.1, removed.2).unwrap(), "");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(read_only.drain_scrubs().is_err());
        assert!(read_only.sync().is_err());
        assert!(read_only.stage().is_err());
        assert_eq!(read_only.read(removed.0, removed.1, removed.2).unwrap(), "");
        assert_eq!(
            read_only.read(kept.0, kept.1, kept.2).unwrap(),
            "live retained passage"
        );

        let recovered = read_only.writable_copy(&path).unwrap();
        recovered.prepare_write().unwrap();
        recovered.sync().unwrap();
        let mut expected = before;
        expected[removed.0 as usize..(removed.0 + u64::from(removed.1)) as usize].fill(0);
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        assert_eq!(recovered.read(removed.0, removed.1, removed.2).unwrap(), "");
        assert_eq!(
            recovered.read(kept.0, kept.1, kept.2).unwrap(),
            "live retained passage"
        );
        recovered.queue_scrub(removed.0, removed.1).unwrap();
        recovered.drain_scrubs().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), expected);
    }
}

#[test]
fn scrub_block_boundaries_preserve_adjacent_records_and_header() {
    for &encrypted in modes() {
        for record_bytes in [65_535, 65_536, 65_537] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("text");
            let segment = create(&path, encrypted);
            let prefix = segment.append("prefix stays live").unwrap();
            let encryption_overhead = if encrypted { 28 } else { 0 };
            let removed = segment
                .append(&"x".repeat(record_bytes - encryption_overhead))
                .unwrap();
            let suffix = segment.append("suffix stays live").unwrap();
            assert_eq!(removed.1 as usize, record_bytes);
            let mut expected = std::fs::read(&path).unwrap();
            expected[removed.0 as usize..(removed.0 + u64::from(removed.1)) as usize].fill(0);
            segment.queue_scrub(removed.0, removed.1).unwrap();
            segment.drain_scrubs().unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), expected);
            assert_eq!(
                segment.read(prefix.0, prefix.1, prefix.2).unwrap(),
                "prefix stays live"
            );
            assert_eq!(
                segment.read(suffix.0, suffix.1, suffix.2).unwrap(),
                "suffix stays live"
            );
            assert_eq!(segment.read(removed.0, removed.1, removed.2).unwrap(), "");
        }
    }
}

#[test]
fn scrub_span_validation_rejects_header_overflow_and_end_plus_one() {
    for length in [7, 8, 9] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("text");
        let segment = create(&path, false);
        let record = segment.append("abcdefgh").unwrap();
        let before = std::fs::read(&path).unwrap();
        for (at, len) in [
            (HEADER_LEN - 1, 1),
            (segment.len(), 1),
            (segment.len() + 1, 0),
            (u64::MAX, 1),
            (u64::MAX - 1, 2),
        ] {
            assert!(segment.queue_scrub(at, len).is_err());
        }
        segment.drain_scrubs().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            segment.read(record.0, record.1, record.2).unwrap(),
            "abcdefgh"
        );
        let queued = segment.queue_scrub(record.0, length);
        assert_eq!(queued.is_ok(), length <= record.1);
        segment.drain_scrubs().unwrap();
        let mut expected = before;
        if length <= record.1 {
            expected[record.0 as usize..record.0 as usize + length as usize].fill(0);
        }
        assert_eq!(std::fs::read(&path).unwrap(), expected);
    }
}
