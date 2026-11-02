// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{ensure, Context, Result};
use axum::http::StatusCode;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    ApiError, Begin, Idempotency, IdempotencyGuard, Inner, Key, Record, State, StoredResponse,
};

const MAGIC: &[u8; 8] = b"WMRTRY01";
const MAX_HEADER: usize = 1024;
const QUEUE: usize = 64;

#[cfg(test)]
#[path = "durable/tests.rs"]
mod tests;

#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
enum Outcome {
    Pending,
    Complete,
    Unknown,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    key: [u8; 32],
    tenant: [u8; 32],
    fingerprint: [u8; 32],
    ttl_seconds: u64,
    ttl_nanos: u32,
    outcome: Outcome,
    status: u16,
    body_len: u64,
}

type Reply<T> = SyncSender<Result<T, ApiError>>;

enum Admission {
    Proceed(u64),
    Replay(StoredResponse),
}

enum Command {
    Begin(String, String, [u8; 32], Reply<Admission>),
    Complete(u64, StoredResponse, Reply<()>),
    Abandon(u64),
    Erase(String, Option<u64>, Reply<()>),
    EndErase(String, Reply<()>),
}

pub(super) struct Writer {
    sender: Option<SyncSender<Command>>,
    thread: Option<JoinHandle<()>>,
}

pub struct Erasure {
    writer: Arc<Writer>,
    tenant: String,
}

impl Erasure {
    pub fn finish(self) -> Result<(), ApiError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.writer.send(Command::EndErase(self.tenant, reply))?;
        receiver.recv().map_err(|_| unavailable())?
    }
}

pub struct Guard {
    writer: Arc<Writer>,
    token: u64,
    done: bool,
}

struct Store {
    directory: PathBuf,
    _ownership: crate::restore::TenantLock,
    cache: Idempotency,
    pending: HashMap<u64, IdempotencyGuard>,
    next_token: u64,
    erasing: HashSet<String>,
}

fn unavailable() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "idempotency_storage_unavailable",
        "retry protection is unavailable; restore access to its storage and restart the server",
    )
}

fn reconcile() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "idempotency_reconciliation_required",
        "the request may have executed but its outcome could not be retained; reconcile state before retrying",
    )
}

impl Writer {
    pub(super) fn open(
        root: &Path,
        ttl: Duration,
        capacity: usize,
        max_bytes: usize,
    ) -> Result<(Self, Arc<Mutex<Inner>>)> {
        let store = Store::open(root, ttl, capacity, max_bytes)?;
        let inner = Arc::clone(&store.cache.inner);
        let (sender, receiver) = mpsc::sync_channel(QUEUE);
        let thread = std::thread::Builder::new()
            .name("warm-retry-writer".into())
            .spawn(move || store.run(receiver))?;
        Ok((
            Self {
                sender: Some(sender),
                thread: Some(thread),
            },
            inner,
        ))
    }

    fn send(&self, command: Command) -> Result<(), ApiError> {
        self.sender
            .as_ref()
            .expect("live retry writer")
            .send(command)
            .map_err(|_| unavailable())
    }

    pub(super) fn begin(
        self: &Arc<Self>,
        tenant: &str,
        key: &str,
        fingerprint: [u8; 32],
    ) -> Result<Begin, ApiError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.send(Command::Begin(
            tenant.into(),
            key.into(),
            fingerprint,
            reply,
        ))?;
        match receiver.recv().map_err(|_| unavailable())?? {
            Admission::Proceed(token) => Ok(Begin::Proceed(IdempotencyGuard::Durable(Guard {
                writer: Arc::clone(self),
                token,
                done: false,
            }))),
            Admission::Replay(response) => Ok(Begin::Replay(response)),
        }
    }

    pub(super) fn erase(
        self: &Arc<Self>,
        tenant: &str,
        preserve: Option<&IdempotencyGuard>,
    ) -> Result<Erasure, ApiError> {
        let token = match preserve {
            Some(IdempotencyGuard::Durable(guard)) if Arc::ptr_eq(self, &guard.writer) => {
                Some(guard.token)
            }
            None => None,
            _ => return Err(unavailable()),
        };
        let (reply, receiver) = mpsc::sync_channel(1);
        self.send(Command::Erase(tenant.into(), token, reply))?;
        receiver.recv().map_err(|_| unavailable())??;
        Ok(Erasure {
            writer: Arc::clone(self),
            tenant: tenant.into(),
        })
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        drop(self.sender.take());
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                crate::log_event!(Error, "retry_writer_panicked");
            }
        }
    }
}

impl Guard {
    pub(super) fn complete(mut self, response: &StoredResponse) -> Result<(), ApiError> {
        let (reply, receiver) = mpsc::sync_channel(1);
        self.writer
            .send(Command::Complete(self.token, response.clone(), reply))
            .map_err(|_| reconcile())?;
        let result = receiver.recv().map_err(|_| reconcile())?;
        self.done = true;
        result
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.writer.send(Command::Abandon(self.token));
        }
    }
}

fn digest(parts: &[&[u8]]) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"warm-http-retry-v1");
    for part in parts {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part);
    }
    hash.finalize().into()
}

fn identities(tenant: &str, key: &str) -> Key {
    (
        crate::auth::hex(&digest(&[tenant.as_bytes()])),
        crate::auth::hex(&digest(&[tenant.as_bytes(), key.as_bytes()])),
    )
}

fn decoded_key(key: &str) -> Result<[u8; 32]> {
    crate::auth::unhex(key)
        .and_then(|bytes| bytes.try_into().ok())
        .context("invalid retry receipt identity")
}

impl Store {
    fn open(root: &Path, ttl: Duration, capacity: usize, max_bytes: usize) -> Result<Self> {
        ensure!(
            !ttl.is_zero() && capacity > 0 && max_bytes > 0,
            "retry protection limits must be positive"
        );
        let ownership = crate::restore::lock_tenant(root, "http-retries")?;
        let directory = root.join("http-retries");
        match directory.symlink_metadata() {
            Ok(metadata) => {
                ensure!(
                    metadata.is_dir() && !metadata.file_type().is_symlink(),
                    "retry storage is not a real directory"
                );
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    ensure!(
                        metadata.permissions().mode() & 0o077 == 0,
                        "retry storage permissions must be private"
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                {
                    use std::os::unix::fs::DirBuilderExt;
                    builder.mode(0o700);
                }
                builder.create(&directory)?;
                crate::vindex::sync_dir(root)?;
            }
            Err(error) => return Err(error.into()),
        }
        let mut store = Self {
            directory,
            _ownership: ownership,
            cache: Idempotency::new(ttl, capacity, max_bytes),
            pending: HashMap::new(),
            next_token: 0,
            erasing: HashSet::new(),
        };
        for entry in std::fs::read_dir(&store.directory)? {
            let entry = entry?;
            if let Some(tenant) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.strip_suffix(".erase"))
            {
                ensure!(
                    store.erasing.len() < capacity,
                    "too many retry erasure barriers"
                );
                let tenant = decoded_key(tenant)?;
                let mut file = open_regular(&entry.path(), false)?;
                ensure!(
                    file.metadata()?.len() == 36,
                    "invalid retry erasure barrier"
                );
                let mut bytes = [0; 36];
                file.read_exact(&mut bytes)?;
                ensure!(
                    bytes[..32] == tenant
                        && crc32fast::hash(&bytes[..32])
                            == u32::from_le_bytes(bytes[32..].try_into()?),
                    "invalid retry erasure barrier checksum"
                );
                store.erasing.insert(crate::auth::hex(&tenant));
            }
        }
        let now = Instant::now();
        let mut cleanup = false;
        let mut pending = Vec::new();
        for entry in std::fs::read_dir(&store.directory)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("invalid retry storage entry"))?;
            if name.starts_with(".pending-") {
                scrub(&entry.path(), 0)?;
                std::fs::remove_file(entry.path())?;
                cleanup = true;
                continue;
            }
            if name.ends_with(".erase") {
                continue;
            }
            let encoded = name
                .strip_suffix(".receipt")
                .context("unexpected retry storage entry")?;
            ensure!(encoded.len() == 64, "invalid retry receipt name");
            let key = decoded_key(encoded)?;
            ensure!(
                crate::auth::hex(&key) == encoded,
                "noncanonical retry receipt name"
            );
            let (count, retained, _) = store.cache.usage();
            ensure!(
                count < capacity,
                "retry capacity is below the retained receipt count"
            );
            let mut file = open_regular(&entry.path(), false)?;
            let (mut header, offset) = read_header(&mut file)?;
            ensure!(header.key == key, "retry receipt identity mismatch");
            if store.erasing.contains(&crate::auth::hex(&header.tenant)) {
                scrub(&entry.path(), offset)?;
                header.outcome = Outcome::Unknown;
                header.status = 0;
                header.body_len = 0;
                store.write_receipt(&header, &[])?;
                file = open_regular(&entry.path(), false)?;
                let _ = read_header(&mut file)?;
            }
            let body = read_body(&mut file, &header, max_bytes - retained)?;
            let lifetime = Duration::new(header.ttl_seconds, header.ttl_nanos);
            store.cache.ttl = store.cache.ttl.max(lifetime);
            let id = (crate::auth::hex(&header.tenant), encoded.to_owned());
            let state = if header.outcome == Outcome::Complete {
                State::Done(StoredResponse {
                    status: StatusCode::from_u16(header.status)?,
                    allocated_bytes: body.capacity(),
                    body: body.into(),
                    committed: false,
                })
            } else {
                if header.outcome == Outcome::Pending {
                    pending.push(id.clone());
                }
                State::Unreplayable
            };
            let mut inner = store.cache.inner.lock();
            if let State::Done(response) = &state {
                inner.body_bytes += response.allocated_bytes;
            }
            ensure!(
                inner.body_bytes <= max_bytes,
                "retry response allocation exceeds the configured bound"
            );
            inner.records.insert(
                id.clone(),
                Record {
                    fingerprint: header.fingerprint,
                    state,
                },
            );
            inner.completed.push_back((now, id));
        }
        if cleanup {
            crate::vindex::sync_dir(&store.directory)?;
        }
        for id in pending {
            store.persist(&id, Outcome::Unknown, None)?;
        }
        for tenant in store.erasing.clone() {
            store.end_erase_digest(&tenant)?;
        }
        Ok(store)
    }

    fn path(&self, id: &Key) -> PathBuf {
        self.directory.join(format!("{}.receipt", id.1))
    }

    fn persist(&self, id: &Key, outcome: Outcome, response: Option<&StoredResponse>) -> Result<()> {
        let fingerprint = self
            .cache
            .inner
            .lock()
            .records
            .get(id)
            .context("retry reservation missing")?
            .fingerprint;
        let header = Header {
            key: decoded_key(&id.1)?,
            tenant: decoded_key(&id.0)?,
            fingerprint,
            ttl_seconds: self.cache.ttl.as_secs(),
            ttl_nanos: self.cache.ttl.subsec_nanos(),
            outcome,
            status: response.map_or(0, |response| response.status.as_u16()),
            body_len: response.map_or(0, |response| response.body.len() as u64),
        };
        let body = response.map_or(&[][..], |response| response.body.as_ref());
        self.write_receipt(&header, body)
    }

    fn write_receipt(&self, header: &Header, body: &[u8]) -> Result<()> {
        let encoded = serde_json::to_vec(header)?;
        ensure!(
            encoded.len() <= MAX_HEADER,
            "retry receipt header exceeds its bound"
        );
        let mut temp = tempfile::Builder::new()
            .prefix(".pending-")
            .tempfile_in(&self.directory)?;
        let length = (encoded.len() as u32).to_le_bytes();
        let mut crc = crc32fast::Hasher::new();
        for bytes in [MAGIC.as_slice(), length.as_slice(), encoded.as_slice()] {
            temp.write_all(bytes)?;
            crc.update(bytes);
        }
        temp.write_all(&crc.finalize().to_le_bytes())?;
        temp.write_all(body)?;
        temp.write_all(&crc32fast::hash(body).to_le_bytes())?;
        temp.as_file().sync_all()?;
        if header.outcome == Outcome::Pending {
            crash_point("reservation-staged");
        }
        temp.persist(
            self.directory
                .join(format!("{}.receipt", crate::auth::hex(&header.key))),
        )
        .map_err(|error| error.error)?;
        crate::vindex::sync_dir(&self.directory)?;
        Ok(())
    }

    fn remove(&self, id: &Key) -> Result<()> {
        let (file, retired) = tempfile::Builder::new()
            .prefix(".pending-")
            .tempfile_in(&self.directory)?
            .keep()
            .map_err(|error| error.error)?;
        drop(file);
        std::fs::rename(self.path(id), &retired)?;
        crate::vindex::sync_dir(&self.directory)?;
        crash_point("receipt-retired");
        scrub(&retired, 0)?;
        std::fs::remove_file(retired)?;
        crate::vindex::sync_dir(&self.directory)?;
        Ok(())
    }

    fn prune(&self, now: Instant) -> Result<()> {
        let expired: Vec<_> = self
            .cache
            .inner
            .lock()
            .completed
            .iter()
            .take_while(|(created, _)| now.saturating_duration_since(*created) >= self.cache.ttl)
            .map(|(_, id)| id.clone())
            .collect();
        for id in &expired {
            self.remove(id)?;
        }
        Ok(())
    }

    fn begin(
        &mut self,
        tenant: &str,
        key: &str,
        fingerprint: [u8; 32],
    ) -> Result<Result<Admission, ApiError>> {
        ensure!(crate::tenants::valid_tenant(tenant), "invalid retry tenant");
        ensure!(
            (1..=128).contains(&key.len()) && key.bytes().all(|byte| (0x21..=0x7e).contains(&byte)),
            "invalid retry key"
        );
        let now = Instant::now();
        self.prune(now)?;
        let id = identities(tenant, key);
        if self.erasing.contains(&id.0) {
            return Ok(Err(tenant_busy()));
        }
        match self.cache.begin_at(&id.0, &id.1, fingerprint, now) {
            Err(error) => Ok(Err(error)),
            Ok(Begin::Replay(response)) => Ok(Ok(Admission::Replay(response))),
            Ok(Begin::Proceed(guard)) => {
                self.persist(&id, Outcome::Pending, None)?;
                crash_point("reserved");
                self.next_token = self
                    .next_token
                    .checked_add(1)
                    .context("retry token exhausted")?;
                self.pending.insert(self.next_token, guard);
                Ok(Ok(Admission::Proceed(self.next_token)))
            }
        }
    }

    fn complete(&mut self, token: u64, response: &StoredResponse) -> Result<()> {
        let guard = self
            .pending
            .get(&token)
            .context("retry completion missing its reservation")?;
        let IdempotencyGuard::Volatile(guard) = guard else {
            unreachable!()
        };
        let id = guard.key.clone();
        let (invalidated, available) = {
            let inner = self.cache.inner.lock();
            (
                matches!(
                    inner
                        .records
                        .get(&id)
                        .context("retry record disappeared")?
                        .state,
                    State::RunningInvalidated
                ),
                self.cache.max_bytes.saturating_sub(inner.body_bytes),
            )
        };
        let retryable = !response.committed
            && (response.status.is_server_error() || matches!(response.status.as_u16(), 408 | 429));
        if retryable && !invalidated {
            self.remove(&id)?;
        } else if !invalidated && response.allocated_bytes <= available {
            self.persist(&id, Outcome::Complete, Some(response))?;
        } else {
            self.persist(&id, Outcome::Unknown, None)?;
        }
        crash_point("completed");
        let guard = self.pending.remove(&token).expect("checked reservation");
        let IdempotencyGuard::Volatile(guard) = guard else {
            unreachable!()
        };
        guard.complete(response);
        Ok(())
    }

    fn abandon(&mut self, token: u64) -> Result<()> {
        let guard = self
            .pending
            .get(&token)
            .context("abandoned retry reservation missing")?;
        let IdempotencyGuard::Volatile(guard) = guard else {
            unreachable!()
        };
        self.persist(&guard.key, Outcome::Unknown, None)?;
        drop(self.pending.remove(&token));
        Ok(())
    }

    fn erase(&mut self, tenant: &str, preserve: Option<u64>) -> Result<Result<(), ApiError>> {
        ensure!(crate::tenants::valid_tenant(tenant), "invalid retry tenant");
        let tenant = crate::auth::hex(&digest(&[tenant.as_bytes()]));
        if self.erasing.contains(&tenant) || self.erasing.len() >= self.cache.capacity {
            return Ok(Err(tenant_busy()));
        }
        let preserved = preserve
            .map(|token| match self.pending.get(&token) {
                Some(IdempotencyGuard::Volatile(guard)) if guard.key.0 == tenant => {
                    Ok(guard.key.clone())
                }
                _ => anyhow::bail!("erasure reservation missing or belongs to another tenant"),
            })
            .transpose()?;
        let bytes = decoded_key(&tenant)?;
        let mut temp = tempfile::Builder::new()
            .prefix(".pending-")
            .tempfile_in(&self.directory)?;
        temp.write_all(&bytes)?;
        temp.write_all(&crc32fast::hash(&bytes).to_le_bytes())?;
        temp.as_file().sync_all()?;
        temp.persist(self.directory.join(format!("{tenant}.erase")))
            .map_err(|error| error.error)?;
        crate::vindex::sync_dir(&self.directory)?;
        self.erasing.insert(tenant.clone());
        crash_point("erase-barrier");
        let keys: Vec<_> = self
            .cache
            .inner
            .lock()
            .records
            .keys()
            .filter(|id| id.0 == tenant && Some(*id) != preserved.as_ref())
            .cloned()
            .collect();
        for id in &keys {
            let mut file = open_regular(&self.path(id), false)?;
            let (_, offset) = read_header(&mut file)?;
            scrub(&self.path(id), offset)?;
            self.persist(id, Outcome::Unknown, None)?;
        }
        let mut inner = self.cache.inner.lock();
        let mut released = 0;
        for id in keys {
            let record = inner.records.get_mut(&id).expect("erasure record retained");
            match &record.state {
                State::Running => record.state = State::RunningInvalidated,
                State::Done(response) => {
                    released += response.allocated_bytes;
                    record.state = State::Unreplayable;
                }
                State::RunningInvalidated | State::Unreplayable => {}
            }
        }
        inner.body_bytes = inner
            .body_bytes
            .checked_sub(released)
            .expect("retained replay bytes accounted");
        Ok(Ok(()))
    }

    fn end_erase_digest(&mut self, tenant: &str) -> Result<()> {
        ensure!(
            self.erasing.contains(tenant),
            "retry erasure barrier missing"
        );
        std::fs::remove_file(self.directory.join(format!("{tenant}.erase")))?;
        crate::vindex::sync_dir(&self.directory)?;
        self.erasing.remove(tenant);
        Ok(())
    }

    fn run(mut self, receiver: Receiver<Command>) {
        for command in receiver {
            let failed = match command {
                Command::Begin(tenant, key, fingerprint, reply) => {
                    match self.begin(&tenant, &key, fingerprint) {
                        Ok(result) => match reply.send(result) {
                            Err(mpsc::SendError(Ok(Admission::Proceed(token)))) => {
                                self.abandon(token).is_err()
                            }
                            _ => false,
                        },
                        Err(_) => {
                            let _ = reply.send(Err(unavailable()));
                            true
                        }
                    }
                }
                Command::Complete(token, response, reply) => {
                    let result = self.complete(token, &response);
                    let failed = result.is_err();
                    let _ = reply.send(result.map_err(|_| reconcile()));
                    failed
                }
                Command::Abandon(token) => self.abandon(token).is_err(),
                Command::Erase(tenant, token, reply) => {
                    let result = self.erase(&tenant, token);
                    let failed = result.is_err();
                    let _ = reply.send(result.unwrap_or_else(|_| Err(unavailable())));
                    failed
                }
                Command::EndErase(tenant, reply) => {
                    let result =
                        self.end_erase_digest(&crate::auth::hex(&digest(&[tenant.as_bytes()])));
                    let failed = result.is_err();
                    let _ = reply.send(result.map_err(|_| unavailable()));
                    failed
                }
            };
            if failed {
                crate::log_event!(Error, "retry_storage_failed");
                break;
            }
        }
    }
}

fn open_regular(path: &Path, write: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && !metadata.file_type().is_symlink(),
        "retry receipt is not a regular file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        ensure!(
            metadata.nlink() == 1,
            "retry receipt must have exactly one link"
        );
        ensure!(
            metadata.permissions().mode() & 0o077 == 0,
            "retry receipt permissions must be private"
        );
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        ensure!(
            metadata.file_attributes() & 0x400 == 0,
            "retry receipt is a reparse point"
        );
    }
    Ok(file)
}

fn tenant_busy() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "tenant_busy",
        "tenant retry receipts are being invalidated; retry later",
    )
}

fn scrub(path: &Path, offset: u64) -> Result<()> {
    let mut file = open_regular(path, true)?;
    let mut remaining = file
        .metadata()?
        .len()
        .checked_sub(offset)
        .context("invalid retry scrub range")?;
    file.seek(SeekFrom::Start(offset))?;
    let zeros = [0; 8192];
    while remaining > 0 {
        let count = remaining.min(zeros.len() as u64) as usize;
        fault_point("scrub-write")?;
        file.write_all(&zeros[..count])?;
        remaining -= count as u64;
        crash_point("scrubbed");
    }
    fault_point("scrub-sync")?;
    file.sync_all()?;
    Ok(())
}

fn read_header(file: &mut File) -> Result<(Header, u64)> {
    let mut prefix = [0; 12];
    file.read_exact(&mut prefix)?;
    ensure!(&prefix[..8] == MAGIC, "unknown retry receipt version");
    let length = u32::from_le_bytes(prefix[8..12].try_into().expect("header length")) as usize;
    ensure!(
        length <= MAX_HEADER,
        "retry receipt header exceeds its bound"
    );
    let mut encoded = vec![0; length];
    file.read_exact(&mut encoded)?;
    let mut checksum = [0; 4];
    file.read_exact(&mut checksum)?;
    let mut crc = crc32fast::Hasher::new();
    crc.update(&prefix);
    crc.update(&encoded);
    ensure!(
        crc.finalize() == u32::from_le_bytes(checksum),
        "retry receipt header checksum mismatch"
    );
    let header: Header =
        serde_json::from_slice(&encoded).context("invalid retry receipt header")?;
    ensure!(
        header.ttl_nanos < 1_000_000_000 && (header.ttl_seconds != 0 || header.ttl_nanos != 0),
        "invalid retry receipt lifetime"
    );
    let offset = (16 + length) as u64;
    ensure!(
        header.body_len.checked_add(offset + 4) == Some(file.metadata()?.len()),
        "retry receipt is truncated or has trailing data"
    );
    if header.outcome == Outcome::Complete {
        ensure!(
            header.body_len > 0 && (100..=599).contains(&header.status),
            "invalid completed retry receipt"
        );
    } else {
        ensure!(
            header.body_len == 0 && header.status == 0,
            "invalid unfinished retry receipt"
        );
    }
    Ok((header, offset))
}

fn read_body(file: &mut File, header: &Header, remaining: usize) -> Result<Vec<u8>> {
    ensure!(
        header.body_len <= remaining as u64,
        "retry response exceeds retained response limit"
    );
    let mut body = vec![0; usize::try_from(header.body_len)?];
    file.read_exact(&mut body)?;
    let mut checksum = [0; 4];
    file.read_exact(&mut checksum)?;
    ensure!(
        crc32fast::hash(&body) == u32::from_le_bytes(checksum),
        "retry receipt body checksum mismatch"
    );
    if header.outcome == Outcome::Complete {
        serde_json::from_slice::<serde::de::IgnoredAny>(&body)
            .context("retry response is not JSON")?;
    }
    Ok(body)
}

fn fault_point(phase: &str) -> Result<()> {
    #[cfg(test)]
    ensure!(
        std::env::var("WARM_RETRY_FAULT_AT").ok().as_deref() != Some(phase),
        "injected retry storage failure"
    );
    let _ = phase;
    Ok(())
}

pub(crate) fn crash_point(phase: &str) {
    #[cfg(test)]
    if std::env::var("WARM_RETRY_CRASH_AT").ok().as_deref() == Some(phase) {
        std::process::exit(85);
    }
    let _ = phase;
}
