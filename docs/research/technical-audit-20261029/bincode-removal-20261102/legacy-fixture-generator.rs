// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
enum Event {
    Store(String, String, String),
    Strengthen(String, String, String),
    Decay,
}

const MAX_EVENT_BYTES: usize = 16 << 20;

#[path = "../../../../src/core/experimental/connection_graph_codec.rs"]
mod codec;

fn main() {
    let mut cases = Vec::new();
    for tag in 0..=1 {
        for length in [0, 1, 249, 250, 251, 252, 65534, 65535, 65536, 65537,
            MAX_EVENT_BYTES - 9, MAX_EVENT_BYTES - 8, MAX_EVENT_BYTES - 7] {
            let fields = ("x".repeat(length), String::new(), String::new());
            let event = if tag == 0 { Event::Store(fields.0, fields.1, fields.2) }
                else { Event::Strengthen(fields.0, fields.1, fields.2) };
            let old = bincode::serde::encode_to_vec(&event, bincode::config::standard()).unwrap();
            if old.len() <= MAX_EVENT_BYTES {
                assert_eq!(codec::encode(&event).unwrap(), old);
                assert_eq!(codec::decode(&old).unwrap(), event);
                let (decoded, consumed): (Event, usize) = bincode::serde::decode_from_slice(
                    &codec::encode(&event).unwrap(), bincode::config::standard()).unwrap();
                assert_eq!(decoded, event);
                assert_eq!(consumed, old.len());
            } else {
                assert!(codec::encode(&event).is_err());
                assert!(codec::decode(&old).is_err());
            }
            cases.push(serde_json::json!({"tag":tag,"length":length,"encoded_length":old.len(),"crc32":crc32fast::hash(&old)}));
        }
    }
    let mut examples = Vec::new();
    for event in [Event::Decay, Event::Store("\0élève".into(), "色".into(), "🧣".into()),
        Event::Strengthen("é".into(), "".into(), "\0".into())] {
        let bytes = bincode::serde::encode_to_vec(&event, bincode::config::standard()).unwrap();
        assert_eq!(codec::encode(&event).unwrap(), bytes);
        assert_eq!(codec::decode(&bytes).unwrap(), event);
        examples.push(serde_json::json!({"event": event,"bytes":bytes}));
    }
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({"reference":"bincode 2.0.1 serde standard","cases":cases,"examples":examples})).unwrap());
}
