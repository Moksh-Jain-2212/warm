// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
//! File-backed chunk text: the store keeps `(offset, length, checksum)` per chunk and reads a chunk's
//! text back with a positioned read when a result needs it, so the serving process holds no
//! copy of the corpus text. The journal frames still carry every document's text, so the
//! segment is a cache rebuilt from the journal at open (truncated, then re-appended as the
//! documents are replayed); it needs no durability of its own. Positioned reads leave the
//! bytes in the page cache rather than in the process (a mapping would count every touched
//! page in RSS).

use std::fs::{File, OpenOptions};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::core::durable_file::{positioned_read, positioned_write};
use anyhow::{ensure, Context, Result};

/// Live appends and tail rollback share the engine's writer lease. Publication hides deleted
/// spans before physical cleanup, so captured searches cannot expose an obsolete passage.
pub(crate) struct TextSegment {
    file: File,
    len: AtomicU64,
    truncate_pending: AtomicBool,
    scrubbed: crate::core::sync::RwLock<Scrubs>,
    #[cfg(feature = "security")]
    cipher: Option<std::sync::Arc<crate::core::security::EncryptionManager>>,
}

#[derive(Clone, Default)]
struct Scrubs {
    hidden: crate::core::hash::FastSet<(u64, u32)>,
    pending: crate::core::hash::FastSet<(u64, u32)>,
}

pub(crate) struct StagedText<'a> {
    segment: &'a TextSegment,
    start: u64,
    armed: bool,
}

impl StagedText<'_> {
    pub(crate) fn committed(&mut self) {
        self.armed = false;
    }

    pub(crate) fn rollback(&mut self) -> Result<()> {
        self.segment.discard_tail(self.start);
        self.segment.repair_tail()?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for StagedText<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.segment.discard_tail(self.start);
        }
    }
}

/// Segment header: magic, format version, flags. Version 2 adds the header and, with
/// `FLAG_ENCRYPTED`, stores every record as `[nonce:12][AES-256-GCM ciphertext+tag]`
/// authenticated with the record's segment offset as AAD, so a record cannot be moved.
/// Version 1 segments (no header, plaintext) are a cache truncated at open, so they are
/// never read back.
const MAGIC: &[u8; 4] = b"HMST";
const VERSION: u8 = 2;
#[cfg(feature = "security")]
const FLAG_ENCRYPTED: u8 = 1;
const HEADER_LEN: u64 = 8;
const SCRUB_ZEROS: &[u8; 64 * 1024] = &[0; 64 * 1024];

impl TextSegment {
    /// Creates or truncates the segment at `path`.
    pub(crate) fn create(
        path: &Path,
        #[cfg(feature = "security")] cipher: Option<
            std::sync::Arc<crate::core::security::EncryptionManager>,
        >,
    ) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .with_context(|| format!("creating text segment {}", path.display()))?;
        #[cfg(feature = "security")]
        let flags = if cipher.is_some() { FLAG_ENCRYPTED } else { 0 };
        #[cfg(not(feature = "security"))]
        let flags = 0;
        let mut header = [0u8; HEADER_LEN as usize];
        header[..4].copy_from_slice(MAGIC);
        header[4] = VERSION;
        header[5] = flags;
        positioned_write(&file, &header, 0).context("writing text segment header")?;
        Ok(Self {
            file,
            len: AtomicU64::new(HEADER_LEN),
            truncate_pending: AtomicBool::new(false),
            scrubbed: Default::default(),
            #[cfg(feature = "security")]
            cipher,
        })
    }

    /// A new, empty segment at `path` (created or truncated) sealed like this one.
    pub(crate) fn recreate(&self, path: &Path) -> Result<Self> {
        Self::create(
            path,
            #[cfg(feature = "security")]
            self.cipher.clone(),
        )
    }

    /// Appends `text` and returns its location.
    pub(crate) fn append(&self, text: &str) -> Result<(u64, u32, u32)> {
        ensure!(
            !self.truncate_pending.load(Ordering::Acquire),
            "text segment has an uncommitted tail awaiting cleanup"
        );
        let at = self.len.load(Ordering::Acquire);
        #[cfg(feature = "security")]
        let sealed;
        let bytes = {
            #[cfg(feature = "security")]
            if let Some(cipher) = &self.cipher {
                sealed = cipher.encrypt_with_aad(text.as_bytes(), &at.to_le_bytes())?;
                sealed.as_slice()
            } else {
                text.as_bytes()
            }
            #[cfg(not(feature = "security"))]
            text.as_bytes()
        };
        let len = u32::try_from(bytes.len()).context("chunk text over 4 GiB")?;
        let end = at
            .checked_add(u64::from(len))
            .context("text segment length overflow")?;
        if let Err(error) = positioned_write(&self.file, bytes, at) {
            self.truncate_pending.store(true, Ordering::Release);
            return Err(error).context("appending chunk text");
        }
        self.len.store(end, Ordering::Release);
        Ok((at, len, crc32fast::hash(text.as_bytes())))
    }

    pub(crate) fn append_document(
        &self,
        document: Arc<super::StoredDocument>,
    ) -> Result<Arc<super::StoredDocument>> {
        if document.chunks.iter().all(|chunk| chunk.text.is_none()) {
            return Ok(document);
        }
        let mut owned = super::StoredDocument::clone(&document);
        for chunk in &mut owned.chunks {
            if let Some(text) = chunk.text.take() {
                chunk.text_at = Some(self.append(&text)?);
            }
        }
        Ok(Arc::new(owned))
    }

    /// The caller owns the engine's writer lease until staging is committed or rolled back.
    pub(crate) fn stage(&self) -> Result<StagedText<'_>> {
        self.prepare_write()?;
        Ok(StagedText {
            segment: self,
            start: self.len(),
            armed: true,
        })
    }

    pub(crate) fn prepare_write(&self) -> Result<()> {
        self.repair_tail()?;
        self.drain_scrubs()
    }

    fn discard_tail(&self, start: u64) {
        if self.len.swap(start, Ordering::AcqRel) != start {
            self.truncate_pending.store(true, Ordering::Release);
        }
    }

    fn repair_tail(&self) -> Result<()> {
        if self.truncate_pending.load(Ordering::Acquire) {
            self.file
                .set_len(self.len())
                .context("discarding uncommitted text")?;
            self.truncate_pending.store(false, Ordering::Release);
        }
        Ok(())
    }

    /// Overwrites the record at a location returned by [`TextSegment::append`] with zeros, so a
    /// deleted chunk's text is gone from the file. Readers that captured the chunk before its
    /// deletion read the zeroed record as empty text. Durable only after [`TextSegment::sync`].
    #[cfg(test)]
    pub(crate) fn scrub(&self, at: u64, len: u32) -> Result<()> {
        self.queue_scrub(at, len)?;
        self.drain_scrubs()
    }

    pub(crate) fn queue_scrub(&self, at: u64, len: u32) -> Result<()> {
        ensure!(
            at >= HEADER_LEN
                && at
                    .checked_add(u64::from(len))
                    .is_some_and(|end| end <= self.len.load(Ordering::Acquire)),
            "chunk text location outside the text segment"
        );
        let mut scrubbed = self.scrubbed.write();
        scrubbed.hidden.insert((at, len));
        scrubbed.pending.insert((at, len));
        Ok(())
    }

    pub(crate) fn drain_scrubs(&self) -> Result<()> {
        let pending: Vec<_> = self.scrubbed.read().pending.iter().copied().collect();
        let mut failure = None;
        for (at, len) in pending {
            let result = (|| {
                let mut written = 0u64;
                while written < u64::from(len) {
                    let count = (u64::from(len) - written).min(SCRUB_ZEROS.len() as u64) as usize;
                    positioned_write(&self.file, &SCRUB_ZEROS[..count], at + written)
                        .context("scrubbing chunk text")?;
                    written += count as u64;
                }
                Ok::<_, anyhow::Error>(())
            })();
            match result {
                Ok(()) => {
                    self.scrubbed.write().pending.remove(&(at, len));
                }
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Whether this segment scrubbed the record. The segment is recreated on every open.
    pub(crate) fn is_scrubbed(&self, at: u64, len: u32) -> bool {
        self.scrubbed.read().hidden.contains(&(at, len))
    }

    /// Flushes scrubbed records to stable storage.
    pub(crate) fn sync(&self) -> Result<()> {
        self.drain_scrubs()?;
        self.file.sync_data().context("syncing text segment")
    }

    /// Reads the text stored at a location returned by [`TextSegment::append`].
    pub(crate) fn read(&self, at: u64, len: u32, checksum: u32) -> Result<String> {
        ensure!(
            at.checked_add(u64::from(len))
                .is_some_and(|end| end <= self.len.load(Ordering::Acquire)),
            "chunk text location outside the text segment"
        );
        ensure!(
            at >= HEADER_LEN,
            "chunk text location inside the segment header"
        );
        if self.is_scrubbed(at, len) {
            return Ok(String::new());
        }
        let mut bytes = vec![0u8; len as usize];
        positioned_read(&self.file, &mut bytes, at).context("reading chunk text")?;
        #[cfg(feature = "security")]
        if let Some(cipher) = &self.cipher {
            bytes = cipher.decrypt_with_aad(&bytes, &at.to_le_bytes())?;
        }
        ensure!(
            crc32fast::hash(&bytes) == checksum,
            "chunk text checksum mismatch"
        );
        String::from_utf8(bytes).context("chunk text is not UTF-8")
    }

    pub(crate) fn len(&self) -> u64 {
        self.len.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(super) fn read_only_copy(&self, path: &Path) -> Result<Self> {
        self.access_copy(path, false)
    }

    #[cfg(test)]
    pub(super) fn writable_copy(&self, path: &Path) -> Result<Self> {
        self.access_copy(path, true)
    }

    #[cfg(test)]
    fn access_copy(&self, path: &Path, writable: bool) -> Result<Self> {
        Ok(Self {
            file: OpenOptions::new().read(true).write(writable).open(path)?,
            len: AtomicU64::new(self.len.load(Ordering::Acquire)),
            truncate_pending: AtomicBool::new(self.truncate_pending.load(Ordering::Acquire)),
            scrubbed: crate::core::sync::RwLock::new(self.scrubbed.read().clone()),
            #[cfg(feature = "security")]
            cipher: self.cipher.clone(),
        })
    }
}

#[cfg(test)]
mod recovery_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nul_prefixed_live_text_is_not_scrubbed() {
        let dir = tempfile::tempdir().unwrap();
        let segment = create(&dir.path().join("text"));
        for prefix in [15, 16, 17] {
            let text = format!("{}live searchable text", "\0".repeat(prefix));
            let (at, len, checksum) = segment.append(&text).unwrap();
            assert_eq!(segment.read(at, len, checksum).unwrap(), text);
            assert!(
                !segment.is_scrubbed(at, len),
                "live prefix of {prefix} NUL bytes triggers the deleted-record path"
            );
        }
    }

    #[test]
    fn checksum_rejects_equal_length_utf8_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("text");
        let segment = create(&path);
        let (at, len, checksum) = segment.append("alpha beta").unwrap();
        positioned_write(&segment.file, b"o", at).unwrap();
        let error = segment.read(at, len, checksum).unwrap_err();
        assert!(error.to_string().contains("checksum mismatch"));
        positioned_write(&segment.file, b"a", at).unwrap();
        assert_eq!(segment.read(at, len, checksum).unwrap(), "alpha beta");
    }

    fn create(path: &Path) -> TextSegment {
        TextSegment::create(
            path,
            #[cfg(feature = "security")]
            None,
        )
        .unwrap()
    }

    #[cfg(feature = "security")]
    #[test]
    fn encrypted_records_are_sealed_unique_and_bound_to_their_position() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t");
        let manager = crate::core::security::EncryptionManager::new("pw", dir.path()).unwrap();
        let segment = TextSegment::create(&path, Some(std::sync::Arc::new(manager))).unwrap();
        let a = segment.append("same text").unwrap();
        let b = segment.append("same text").unwrap();
        assert_eq!(segment.read(a.0, a.1, a.2).unwrap(), "same text");
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.windows(9).any(|w| w == b"same text"));
        // Equal plaintexts never share a nonce or ciphertext.
        let (ra, rb) = (a.0 as usize, b.0 as usize);
        assert_ne!(raw[ra..ra + 12], raw[rb..rb + 12]);
        // A record copied to another position fails authentication.
        let mut moved = raw.clone();
        moved.copy_within(ra..ra + a.1 as usize, rb);
        std::fs::write(&path, &moved).unwrap();
        assert!(segment.read(b.0, b.1, b.2).is_err());
    }

    #[test]
    fn scrubbed_records_are_gone_from_the_file_and_read_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t");
        let segment = create(&path);
        let a = segment.append("deleted passage").unwrap();
        let b = segment.append("kept passage").unwrap();
        segment.scrub(a.0, a.1).unwrap();
        segment.sync().unwrap();
        let raw = std::fs::read(&path).unwrap();
        assert!(!raw.windows(7).any(|w| w == b"deleted"));
        assert_eq!(segment.read(a.0, a.1, a.2).unwrap(), "");
        assert_eq!(segment.read(b.0, b.1, b.2).unwrap(), "kept passage");
        // limit+1 stays an error; the header is never scrubbed.
        assert!(segment.scrub(b.0, b.1 + 1).is_err());
        assert!(segment.scrub(0, 4).is_err());
    }

    #[test]
    fn locations_round_trip_and_stay_inside_the_segment() {
        let dir = tempfile::tempdir().unwrap();
        let segment = create(&dir.path().join("t"));
        let a = segment.append("").unwrap();
        let b = segment.append("héllo wörld").unwrap();
        let c = segment.append(&"x".repeat(70_000)).unwrap();
        assert_eq!((a.0, a.1), (HEADER_LEN, 0));
        assert_eq!((b.0, b.1), (HEADER_LEN, "héllo wörld".len() as u32));
        assert_eq!(c.0, HEADER_LEN + u64::from(b.1));
        assert_eq!(segment.read(a.0, a.1, a.2).unwrap(), "");
        assert_eq!(segment.read(b.0, b.1, b.2).unwrap(), "héllo wörld");
        assert_eq!(segment.read(c.0, c.1, c.2).unwrap().len(), 70_000);
        assert_eq!(segment.len(), HEADER_LEN + u64::from(b.1) + 70_000);
        // Past the end, and a length that overflows, are errors, never reads.
        assert!(segment.read(c.0, c.1 + 1, c.2).is_err());
        assert!(segment.read(segment.len(), 1, 0).is_err());
        assert!(segment.read(u64::MAX, 1, 0).is_err());
        // A slice that splits a multi-byte character is rejected as text.
        assert!(segment.read(b.0 + 1, 1, b.2).is_err());
        // Reopening truncates: the journal replay rebuilds it.
        let reopened = create(&dir.path().join("t"));
        assert_eq!(reopened.len(), HEADER_LEN);
    }
}
