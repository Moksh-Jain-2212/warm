// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use anyhow::{bail, ensure, Context, Result};
use std::fs::{File, TryLockError};
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub(crate) const LOCK_FILE: &str = ".hms.lock";

/// Process-scoped exclusive ownership of a writable WARM store.
///
/// WARM does not currently expose a read-only mode, so every engine instance is
/// a potential writer. Holding this lock for the engine lifetime prevents two
/// processes (or two instances in one process) from mutating the same store.
pub(crate) struct StoreLock {
    file: File,
    path: PathBuf,
}

impl StoreLock {
    pub(crate) fn acquire(store_path: &Path) -> Result<Self> {
        std::fs::create_dir_all(store_path)
            .with_context(|| format!("failed to create store {}", store_path.display()))?;
        let path = store_path.join(LOCK_FILE);
        let mut file = super::durable_file::open_regular_read_write_create(&path)
            .with_context(|| format!("failed to open store lock {}", path.display()))?;

        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => bail!(
                "WARM store {} is already open by another engine; concurrent writers are not supported",
                store_path.display()
            ),
            Err(TryLockError::Error(error)) => {
                return Err(error)
                    .with_context(|| format!("failed to lock store {}", store_path.display()));
            }
        }

        ensure!(single_link(&file)?, "store lock must have exactly one link");

        // The pid is for a person inspecting the store; the lock is the `flock` above, which
        // nothing on disk records, so the write is not synced.
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        writeln!(file, "pid={}", std::process::id())?;

        Ok(Self { file, path })
    }
}

#[cfg(unix)]
fn single_link(file: &File) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink() == 1)
}

#[cfg(windows)]
fn single_link(file: &File) -> std::io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle and output buffer remain valid throughout the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(info.nNumberOfLinks == 1)
}

#[cfg(not(any(unix, windows)))]
fn single_link(_: &File) -> std::io::Result<bool> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "cannot verify store lock link count on this platform",
    ))
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        if let Err(error) = self.file.unlock() {
            tracing::warn!(path = %self.path.display(), %error, "failed to release WARM store lock");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_is_exclusive_and_released_on_drop() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let first = StoreLock::acquire(dir.path())?;
        let error = StoreLock::acquire(dir.path())
            .err()
            .expect("second lock must fail");
        assert!(error.to_string().contains("already open"));
        drop(first);
        let reacquired = StoreLock::acquire(dir.path())?;
        drop(reacquired);
        Ok(())
    }

    #[test]
    fn lock_refuses_hard_links_without_changing_the_target() -> Result<()> {
        let root = tempfile::tempdir()?;
        let store = root.path().join("store");
        std::fs::create_dir(&store)?;
        let target = root.path().join("external");
        std::fs::write(&target, b"external data")?;
        std::fs::hard_link(&target, store.join(LOCK_FILE))?;
        assert!(StoreLock::acquire(&store).is_err());
        assert_eq!(std::fs::read(&target)?, b"external data");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn lock_refuses_symlinks_without_changing_the_target() -> Result<()> {
        let root = tempfile::tempdir()?;
        let store = root.path().join("store");
        std::fs::create_dir(&store)?;
        let target = root.path().join("external");
        std::fs::write(&target, b"external data")?;
        std::os::unix::fs::symlink(&target, store.join(LOCK_FILE))?;
        assert!(StoreLock::acquire(&store).is_err());
        assert_eq!(std::fs::read(&target)?, b"external data");
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn lock_refuses_a_fifo() -> Result<()> {
        use std::os::unix::ffi::OsStrExt;
        let root = tempfile::tempdir()?;
        let path = root.path().join(LOCK_FILE);
        let name = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        // SAFETY: `name` is NUL-terminated and lives for the call.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(StoreLock::acquire(root.path()).is_err());
        Ok(())
    }
}
