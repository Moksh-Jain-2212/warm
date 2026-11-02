// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use super::{Event, MAX_EVENT_BYTES};
use std::io::{Error, ErrorKind, Result};

fn invalid() -> Error {
    Error::new(ErrorKind::InvalidData, "invalid connection graph event")
}

fn integer_size(value: usize) -> usize {
    match value {
        0..=250 => 1,
        251..=65535 => 3,
        _ => 5,
    }
}

fn write_integer(value: usize, output: &mut Vec<u8>) {
    match integer_size(value) {
        1 => output.push(value as u8),
        3 => {
            output.push(251);
            output.extend_from_slice(&(value as u16).to_le_bytes());
        }
        _ => {
            output.push(252);
            output.extend_from_slice(&(value as u32).to_le_bytes());
        }
    }
}

fn take<'a>(input: &mut &'a [u8], length: usize) -> Result<&'a [u8]> {
    let (head, tail) = input.split_at_checked(length).ok_or_else(invalid)?;
    *input = tail;
    Ok(head)
}

fn read_integer(input: &mut &[u8], max_width: usize) -> Result<u64> {
    let tag = take(input, 1)?[0];
    let width = match tag {
        0..=250 => return Ok(u64::from(tag)),
        251 => 2,
        252 => 4,
        253 => 8,
        _ => return Err(invalid()),
    };
    if width > max_width {
        return Err(invalid());
    }
    let mut bytes = [0; 8];
    bytes[..width].copy_from_slice(take(input, width)?);
    Ok(u64::from_le_bytes(bytes))
}

// Preserve the existing bincode-2 standard wire layout for this fixed three-variant
// event type; every length is checked against the actual frame before allocation.
pub(super) fn encode(event: &Event) -> Result<Vec<u8>> {
    let (tag, fields) = match event {
        Event::Store(s, r, o) => (0, [s, r, o]),
        Event::Strengthen(s, r, o) => (1, [s, r, o]),
        Event::Decay => return Ok(vec![2]),
    };
    let length = fields.iter().try_fold(1usize, |total, field| {
        total
            .checked_add(field.len())
            .and_then(|n| n.checked_add(integer_size(field.len())))
            .filter(|&n| n <= MAX_EVENT_BYTES)
            .ok_or_else(invalid)
    })?;
    let mut bytes = Vec::with_capacity(length);
    bytes.push(tag);
    for field in fields {
        write_integer(field.len(), &mut bytes);
        bytes.extend_from_slice(field.as_bytes());
    }
    Ok(bytes)
}

pub(super) fn decode(mut input: &[u8]) -> Result<Event> {
    if input.len() > MAX_EVENT_BYTES {
        return Err(invalid());
    }
    let tag = read_integer(&mut input, 4)?;
    let event = match tag {
        0 | 1 => {
            let mut field = || -> Result<String> {
                let length =
                    usize::try_from(read_integer(&mut input, 8)?).map_err(|_| invalid())?;
                let bytes = take(&mut input, length)?;
                Ok(std::str::from_utf8(bytes)
                    .map_err(|_| invalid())?
                    .to_owned())
            };
            let (s, r, o) = (field()?, field()?, field()?);
            if tag == 0 {
                Event::Store(s, r, o)
            } else {
                Event::Strengthen(s, r, o)
            }
        }
        2 => Event::Decay,
        _ => return Err(invalid()),
    };
    if !input.is_empty() {
        return Err(invalid());
    }
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_legacy_fixtures_cover_integer_and_frame_boundaries() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/research/technical-audit-20261029/bincode-removal-20261102/legacy-fixtures.json"
        )).unwrap();
        for case in fixtures["cases"].as_array().unwrap() {
            let field = "x".repeat(case["length"].as_u64().unwrap() as usize);
            let event = if case["tag"] == 0 {
                Event::Store(field, "".into(), "".into())
            } else {
                Event::Strengthen(field, "".into(), "".into())
            };
            let length = case["encoded_length"].as_u64().unwrap() as usize;
            if length > MAX_EVENT_BYTES {
                assert!(encode(&event).is_err());
            } else {
                let bytes = encode(&event).unwrap();
                assert_eq!(bytes.len(), length);
                assert_eq!(
                    crc32fast::hash(&bytes) as u64,
                    case["crc32"].as_u64().unwrap()
                );
                assert_eq!(decode(&bytes).unwrap(), event);
            }
        }
        for case in fixtures["examples"].as_array().unwrap() {
            let event: Event = serde_json::from_value(case["event"].clone()).unwrap();
            let bytes: Vec<u8> = serde_json::from_value(case["bytes"].clone()).unwrap();
            assert_eq!(encode(&event).unwrap(), bytes);
            assert_eq!(decode(&bytes).unwrap(), event);
        }
    }

    #[test]
    fn corrupt_lengths_tags_utf8_and_trailing_data_are_rejected() {
        for bytes in [
            vec![],
            vec![3],
            vec![255],
            vec![0, 251],
            vec![0, 252, 0, 0],
            vec![0, 253, 255, 255, 255, 255, 255, 255, 255, 255],
            vec![0, 254],
            vec![0, 1, 255, 0, 0],
            vec![2, 0],
            vec![253, 2, 0, 0, 0, 0, 0, 0, 0],
        ] {
            assert!(decode(&bytes).is_err(), "{bytes:?}");
        }
        assert_eq!(decode(&[251, 2, 0]).unwrap(), Event::Decay);
        assert_eq!(decode(&[252, 2, 0, 0, 0]).unwrap(), Event::Decay);
        let old_nonminimal = [0, 253, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert_eq!(
            decode(&old_nonminimal).unwrap(),
            Event::Store("".into(), "".into(), "".into())
        );
    }
}
