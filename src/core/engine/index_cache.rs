// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use anyhow::{ensure, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::io::{Read, Write};
use std::path::Path;

use super::shard::Shard;
use crate::core::{entangled::EntangledHVec, ivf::IVFIndex, nsg::NSGIndex};

pub(super) const ENCODING: &str = "cbor-v1";
const MAGIC: &[u8] = b"\xffWARMIDX\x01";
const MAX_BYTES: usize = 512 << 20;

struct LimitedBuffer {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl Write for LimitedBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(std::io::Error::other("index cache exceeds byte limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn encode_with_limit<T: Serialize>(value: &T, limit: usize) -> Result<Option<Vec<u8>>> {
    let mut writer = LimitedBuffer {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    let result = writer
        .write_all(MAGIC)
        .map_err(anyhow::Error::from)
        .and_then(|()| ciborium::ser::into_writer(value, &mut writer).map_err(Into::into));
    if writer.exceeded {
        return Ok(None);
    }
    result?;
    Ok(Some(writer.bytes))
}

pub(super) fn encode<T: Serialize>(value: &T) -> Result<Option<Vec<u8>>> {
    encode_with_limit(value, MAX_BYTES)
}

pub(super) fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    ensure!(bytes.len() <= MAX_BYTES, "index cache exceeds byte limit");
    let mut input = bytes
        .strip_prefix(MAGIC)
        .ok_or_else(|| anyhow::anyhow!("unsupported index cache encoding"))?;
    let value = ciborium::de::from_reader_with_recursion_limit(&mut input, 32)?;
    ensure!(input.is_empty(), "trailing index cache data");
    Ok(value)
}

pub(super) fn read(path: &Path) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    // Allow the encryption envelope outside the decoded payload budget.
    let limit = MAX_BYTES + 4096;
    ensure!(
        file.metadata()?.len() <= limit as u64,
        "index cache exceeds byte limit"
    );
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= limit, "index cache exceeds byte limit");
    Ok(bytes)
}

fn valid_vector(vector: &EntangledHVec, dimensions: usize) -> bool {
    vector.dim == dimensions
        && vector.indices.windows(2).all(|pair| pair[0] < pair[1])
        && vector
            .indices
            .last()
            .is_none_or(|&index| (index as usize) < dimensions)
}

pub(super) fn validate_nsg(index: &NSGIndex, shard: &Shard, dimensions: usize) -> Result<()> {
    let vectors = shard.vectors.read();
    let count = vectors.len();
    ensure!(
        index.trained
            && count > 0
            && index.vectors.len() == count
            && index.id_map.len() == count
            && index.neighbors.len() == count
            && (index.navigating_node as usize) < count,
        "invalid NSG cache dimensions"
    );
    let mut ids = std::collections::HashSet::with_capacity(count);
    for (id, vector) in index.id_map.iter().zip(&index.vectors) {
        ensure!(
            ids.insert(id)
                && valid_vector(vector, dimensions)
                && vectors
                    .get(id)
                    .is_some_and(|current| current.indices == vector.indices),
            "NSG cache differs from durable vectors"
        );
    }
    ensure!(
        index
            .neighbors
            .iter()
            .flatten()
            .all(|&index| (index as usize) < count),
        "invalid NSG cache edge"
    );
    Ok(())
}

pub(super) fn validate_ivf(index: &IVFIndex, dimensions: usize) -> Result<()> {
    let transform = &index.projector.transform;
    ensure!(
        index.trained
            && index.dim == dimensions
            && index.pq.dim == dimensions
            && index.pq.sub_range == dimensions / 16
            && transform.nrows() == index.projector.landmarks.len()
            && transform.ncols() > 0
            && transform.ncols() <= transform.nrows()
            && transform.iter().all(|v| v.is_finite())
            && index
                .projector
                .landmarks
                .iter()
                .all(|v| valid_vector(v, dimensions)),
        "invalid IVF cache projection"
    );
    ensure!(
        index.kmeans.k > 0
            && index.kmeans.k == index.kmeans.centroids.len()
            && index
                .kmeans
                .centroids
                .iter()
                .all(|c| c.len() == transform.ncols() && c.iter().all(|v| v.is_finite())),
        "invalid IVF cache centroids"
    );
    ensure!(
        index.pq.codebooks.len() == 16,
        "invalid IVF cache codebooks"
    );
    for (part, book) in index.pq.codebooks.iter().enumerate() {
        let start = part * index.pq.sub_range;
        let end = if part == 15 {
            dimensions
        } else {
            start + index.pq.sub_range
        };
        ensure!(
            !book.is_empty()
                && book.len() <= 256
                && book
                    .iter()
                    .all(|centroid| centroid.windows(2).all(|pair| pair[0] < pair[1])
                        && centroid
                            .iter()
                            .all(|&v| (start..end).contains(&(v as usize)))),
            "invalid IVF cache codebook range"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{WarmConfig, WarmCore};
    use super::*;

    fn trained(path: &Path) -> Result<WarmCore> {
        trained_with_encryption(path, false)
    }

    fn trained_with_encryption(path: &Path, encrypted: bool) -> Result<WarmCore> {
        let mut config = WarmConfig::default();
        config.security.encryption_enabled = encrypted;
        config.security.encryption_passphrase = encrypted.then(|| "cache-test-passphrase".into());
        config.ivf.n_clusters = 4;
        config.ivf.n_landmarks = 16;
        config.ivf.d_reduced = 8;
        config.ivf.n_probe = 2;
        config.nsg.max_degree = 8;
        config.nsg.ef_construction = 16;
        let core = WarmCore::new(1024, Some(path.display().to_string()), Some(config))?;
        for i in 0..48 {
            core.memorize(format!("v{i}"), EntangledHVec::new_deterministic(1024, i))?;
        }
        core.train_nsg()?;
        core.train_ivf()?;
        core.flush()?;
        Ok(core)
    }

    #[cfg(feature = "security")]
    #[test]
    fn encrypted_cache_round_trip_keeps_trained_indexes() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let core = trained_with_encryption(dir.path(), true)?;
        let mut config = core.config.clone();
        config.security.encryption_passphrase = Some("cache-test-passphrase".into());
        drop(core);
        assert!(!std::fs::read(dir.path().join("nsg_index.bin"))?.starts_with(MAGIC));
        let core = WarmCore::new(1024, Some(dir.path().display().to_string()), Some(config))?;
        core.shards.read().try_for_each_shard_indexed(|_, shard| {
            assert!(shard.nsg.read().is_some());
            assert!(shard.ivf.read().is_some());
            Ok(())
        })?;
        assert_eq!(
            core.query(&EntangledHVec::new_deterministic(1024, 17), 1)?[0].id,
            "v17"
        );
        Ok(())
    }

    #[test]
    fn trained_caches_reload_and_legacy_metadata_uses_durable_vectors() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let core = trained(dir.path())?;
        let query = EntangledHVec::new_deterministic(1024, 17);
        let results = |core: &WarmCore| -> Result<Vec<Vec<(String, u64)>>> {
            let mut answers = Vec::new();
            core.shards.read().try_for_each_shard_indexed(|_, shard| {
                let nsg = shard.nsg.read();
                let ivf = shard.ivf.read();
                let nsg = nsg.as_ref().expect("NSG cache must load");
                let ivf = ivf.as_ref().expect("IVF cache must load");
                for hits in [nsg.query(&query, 4, 32), ivf.query(&query, 4, 2)?] {
                    answers.push(
                        hits.into_iter()
                            .map(|h| (h.id, h.similarity.to_bits()))
                            .collect(),
                    );
                }
                Ok(())
            })?;
            Ok(answers)
        };
        let expected = results(&core)?;
        drop(core);
        let reopened = WarmCore::new(1024, Some(dir.path().display().to_string()), None)?;
        assert_eq!(results(&reopened)?, expected);
        drop(reopened);
        let metadata = dir.path().join("indices.json");
        let mut saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&metadata)?)?;
        saved.as_object_mut().unwrap().remove("encoding");
        std::fs::write(&metadata, serde_json::to_vec(&saved)?)?;
        let reopened = WarmCore::new(1024, Some(dir.path().display().to_string()), None)?;
        assert_eq!(reopened.vector_count(), 48);
        reopened
            .shards
            .read()
            .try_for_each_shard_indexed(|_, shard| {
                assert!(shard.nsg.read().is_none());
                assert!(shard.ivf.read().is_none());
                Ok(())
            })?;
        assert_eq!(reopened.query(&query, 1)?[0].id, "v17");
        Ok(())
    }

    #[test]
    fn malformed_but_checksummed_cache_is_discarded_before_query() -> Result<()> {
        let dir = tempfile::tempdir()?;
        drop(trained(dir.path())?);
        let nsg_path = dir.path().join("nsg_index.bin");
        let ivf_path = dir.path().join("ivf_index.bin");
        let mut nsg: NSGIndex = decode(&std::fs::read(&nsg_path)?)?;
        nsg.id_map.pop();
        let mut ivf: IVFIndex = decode(&std::fs::read(&ivf_path)?)?;
        ivf.projector.transform = nalgebra::DMatrix::zeros(1, 1);
        let nsg = encode(&nsg)?.unwrap();
        let ivf = encode(&ivf)?.unwrap();
        std::fs::write(nsg_path, &nsg)?;
        std::fs::write(ivf_path, &ivf)?;
        let metadata = dir.path().join("indices.json");
        let mut saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&metadata)?)?;
        saved["shards"][0]["nsgCrc"] = crc32fast::hash(&nsg).into();
        saved["shards"][0]["ivfCrc"] = crc32fast::hash(&ivf).into();
        std::fs::write(metadata, serde_json::to_vec(&saved)?)?;
        let core = WarmCore::new(1024, Some(dir.path().display().to_string()), None)?;
        core.shards.read().try_for_each_shard_indexed(|_, shard| {
            assert!(shard.nsg.read().is_none());
            assert!(shard.ivf.read().is_none());
            Ok(())
        })?;
        assert_eq!(
            core.query(&EntangledHVec::new_deterministic(1024, 17), 1)?[0].id,
            "v17"
        );
        Ok(())
    }

    #[test]
    fn forged_projection_shape_cannot_overflow_during_decode() -> Result<()> {
        let projector = serde_json::json!({"transform": [[], u64::MAX, 2], "landmarks": []});
        let bytes = encode(&projector)?.unwrap();
        assert!(decode::<crate::core::ivf::nystrom::NystromProjector>(&bytes).is_err());
        Ok(())
    }

    #[test]
    fn cached_degree_cannot_force_allocation_beyond_available_candidates() -> Result<()> {
        let dir = tempfile::tempdir()?;
        drop(trained(dir.path())?);
        let path = dir.path().join("nsg_index.bin");
        let mut nsg: NSGIndex = decode(&std::fs::read(&path)?)?;
        nsg.config.max_degree = usize::MAX;
        nsg.config.ef_construction = usize::MAX;
        let encoded = encode(&nsg)?.unwrap();
        std::fs::write(path, &encoded)?;
        let metadata = dir.path().join("indices.json");
        let mut saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&metadata)?)?;
        saved["shards"][0]["nsgCrc"] = crc32fast::hash(&encoded).into();
        std::fs::write(metadata, serde_json::to_vec(&saved)?)?;
        let core = WarmCore::new(1024, Some(dir.path().display().to_string()), None)?;
        core.shards.read().try_for_each_shard_indexed(|_, shard| {
            assert!(shard.nsg.read().is_some());
            Ok(())
        })?;
        let query = EntangledHVec::new_deterministic(1024, 1234);
        core.memorize("later".into(), query.clone())?;
        core.flush()?;
        drop(core);
        let core = WarmCore::new(1024, Some(dir.path().display().to_string()), None)?;
        assert_eq!(core.vector_count(), 49);
        assert_eq!(core.query(&query, 1)?[0].id, "later");
        Ok(())
    }

    #[test]
    fn cache_encoding_preserves_float_bits_and_rejects_trailing_or_legacy_data() {
        let values = [0.0f32, -0.0, f32::from_bits(1), f32::MAX, -f32::MAX];
        let mut encoded = encode(&values).unwrap().unwrap();
        let actual: Vec<f32> = decode(&encoded).unwrap();
        assert_eq!(
            actual.iter().map(|x| x.to_bits()).collect::<Vec<_>>(),
            values.map(f32::to_bits)
        );
        encoded.push(0);
        assert!(decode::<Vec<f32>>(&encoded).is_err());
        assert!(decode::<Vec<f32>>(&[0, 1, 2]).is_err());
        assert!(decode::<Vec<f32>>(&encoded[..MAGIC.len()]).is_err());
    }

    #[test]
    fn oversized_cache_is_omitted_without_failing_the_durable_flush() {
        let bytes = encode(&"cache").unwrap().unwrap();
        for limit in [bytes.len() - 1, bytes.len(), bytes.len() + 1] {
            let actual = encode_with_limit(&"cache", limit).unwrap();
            assert_eq!(actual.is_some(), limit >= bytes.len());
            if let Some(actual) = actual {
                assert_eq!(actual, bytes);
            }
        }
    }
}
