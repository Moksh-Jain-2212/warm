use super::*;
use axum::body::{to_bytes, Body};
use axum::extract::Request;
use serde_json::json;
use std::process::{Command, Output};

const TTL: Duration = Duration::from_secs(60);
const CAPACITY: usize = 16;
const BYTES: usize = 65536;

fn open(root: &Path) -> Idempotency {
    Idempotency::open(root, TTL, CAPACITY, BYTES).unwrap()
}

fn begin(store: &Idempotency, tenant: &str, key: &str) -> IdempotencyGuard {
    match store.begin(tenant, key, [7; 32]).unwrap() {
        Begin::Proceed(guard) => guard,
        Begin::Replay(_) => panic!("unexpected replay"),
    }
}

fn response(text: &str) -> StoredResponse {
    StoredResponse::new(StatusCode::CREATED, &json!({"text": text}), false)
}

fn files(root: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(root.join("http-retries"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect()
}

fn assert_replay(store: &Idempotency, tenant: &str, key: &str, expected: &StoredResponse) {
    let Begin::Replay(actual) = store.begin(tenant, key, [7; 32]).unwrap() else {
        panic!("completed request was reexecuted");
    };
    assert_eq!(actual.status, expected.status);
    assert_eq!(actual.body, expected.body);
}

#[test]
fn restart_replays_exact_outcomes_and_keeps_uncertain_keys_protected() {
    let root = tempfile::tempdir().unwrap();
    let store = open(root.path());
    let success = response("exact retained response");
    let committed = StoredResponse::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        &json!({"code": "mutation_committed"}),
        true,
    );
    begin(&store, "t", "ok").complete(&success).unwrap();
    begin(&store, "t", "committed")
        .complete(&committed)
        .unwrap();
    begin(&store, "t", "transient")
        .complete(&StoredResponse::new(
            StatusCode::SERVICE_UNAVAILABLE,
            &json!({"code": "server_busy"}),
            false,
        ))
        .unwrap();
    drop(begin(&store, "t", "abandoned"));
    drop(store);

    let store = open(root.path());
    assert_replay(&store, "t", "ok", &success);
    assert_replay(&store, "t", "committed", &committed);
    assert_eq!(
        store.begin("t", "abandoned", [7; 32]).err().unwrap().code,
        "idempotency_reconciliation_required"
    );
    assert_eq!(
        store.begin("t", "ok", [8; 32]).err().unwrap().code,
        "idempotency_key_reused"
    );
    drop(begin(&store, "other", "ok"));
    drop(begin(&store, "t", "transient"));
    assert!(Idempotency::open(root.path(), TTL, CAPACITY, BYTES).is_err());
}

#[test]
fn erasure_blocks_admission_scrubs_old_bodies_and_rejects_late_completion() {
    let root = tempfile::tempdir().unwrap();
    let store = open(root.path());
    let other = response("other tenant response");
    begin(&store, "t", "old")
        .complete(&response("forgotten unique text"))
        .unwrap();
    begin(&store, "u", "other").complete(&other).unwrap();
    let late = begin(&store, "t", "late");
    let forgetting = begin(&store, "t", "forget");
    let barrier = store.erase("t", Some(&forgetting)).unwrap().unwrap();
    assert_eq!(
        store.begin("t", "new", [7; 32]).err().unwrap().code,
        "tenant_busy"
    );
    assert_replay(&store, "u", "other", &other);
    late.complete(&response("late forgotten unique text"))
        .unwrap();
    let erased = response("erasure complete");
    forgetting.complete(&erased).unwrap();
    barrier.finish().unwrap();
    for path in files(root.path()) {
        let bytes = std::fs::read(path).unwrap();
        assert!(!bytes
            .windows(b"forgotten unique text".len())
            .any(|s| s == b"forgotten unique text"));
    }
    drop(store);
    let store = open(root.path());
    for key in ["old", "late"] {
        assert_eq!(
            store.begin("t", key, [7; 32]).err().unwrap().code,
            "idempotency_reconciliation_required"
        );
    }
    assert_replay(&store, "t", "forget", &erased);
    assert_replay(&store, "u", "other", &other);
}

#[test]
fn restart_preserves_bounds_and_does_not_shorten_recorded_ttl() {
    let retained = response("bounded body");
    for bound in [
        retained.allocated_bytes - 1,
        retained.allocated_bytes,
        retained.allocated_bytes + 1,
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = Idempotency::open(root.path(), TTL, 2, bound).unwrap();
        begin(&store, "t", "first").complete(&retained).unwrap();
        drop(begin(&store, "t", "second"));
        assert_eq!(
            store.begin("t", "third", [7; 32]).err().unwrap().code,
            "server_busy"
        );
        assert!(store.usage().1 <= bound);
        drop(store);
        assert!(Idempotency::open(root.path(), TTL, 1, bound).is_err());
        let store = Store::open(root.path(), Duration::from_secs(1), 3, bound).unwrap();
        assert_eq!(store.cache.ttl, TTL);
        assert_eq!(store.cache.usage().0, 2);
        if bound < retained.allocated_bytes {
            let id = identities("t", "first");
            assert!(matches!(
                store.cache.inner.lock().records[&id].state,
                State::Unreplayable
            ));
        } else {
            let id = identities("t", "first");
            assert_replay(&store.cache, &id.0, &id.1, &retained);
        }
    }
}

#[test]
fn monotonic_expiry_retires_receipts_at_the_ttl_boundary() {
    for delta in [-1_i64, 0, 1] {
        let root = tempfile::tempdir().unwrap();
        let mut store = Store::open(root.path(), TTL, CAPACITY, BYTES).unwrap();
        let Admission::Proceed(token) = store.begin("t", "key", [7; 32]).unwrap().unwrap() else {
            panic!()
        };
        store.complete(token, &response("expires")).unwrap();
        let created = store.cache.inner.lock().completed[0].0;
        let deadline = created + TTL;
        let now = if delta < 0 {
            deadline - Duration::from_nanos(1)
        } else {
            deadline + Duration::from_nanos(delta as u64)
        };
        store.prune(now).unwrap();
        assert_eq!(store.path(&identities("t", "key")).exists(), delta < 0);
    }
}

#[test]
fn corrupt_or_unbounded_receipts_fail_closed_at_startup() {
    for alteration in ["header", "body", "length", "truncate", "trailing"] {
        let root = tempfile::tempdir().unwrap();
        let store = open(root.path());
        begin(&store, "t", "key")
            .complete(&response("integrity protected"))
            .unwrap();
        drop(store);
        let path = files(root.path()).pop().unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        match alteration {
            "header" => bytes[20] ^= 1,
            "body" => {
                let at = bytes.len() - 5;
                bytes[at] ^= 1;
            }
            "length" => bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes()),
            "truncate" => {
                bytes.pop();
            }
            "trailing" => bytes.push(0),
            _ => unreachable!(),
        }
        std::fs::write(path, bytes).unwrap();
        assert!(
            Idempotency::open(root.path(), TTL, CAPACITY, BYTES).is_err(),
            "{alteration}"
        );
    }
}

fn child(root: &Path, mode: &str, crash: Option<&str>, fault: Option<&str>) -> Output {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "limits::durable::tests::subprocess_entry",
            "--nocapture",
        ])
        .env("WARM_RETRY_TEST_ROOT", root)
        .env("WARM_RETRY_TEST_MODE", mode)
        .env_remove("WARM_RETRY_CRASH_AT")
        .env_remove("WARM_RETRY_FAULT_AT");
    if let Some(phase) = crash {
        command.env("WARM_RETRY_CRASH_AT", phase);
    }
    if let Some(phase) = fault {
        command.env("WARM_RETRY_FAULT_AT", phase);
    }
    command.output().unwrap()
}

#[test]
fn interrupted_http_requests_reconcile_or_replay_without_reexecution() {
    for (phase, count, status, replayed) in [
        ("reservation-staged", 1, 200, false),
        ("reserved", 0, 409, false),
        ("after-work", 1, 409, false),
        ("completed", 1, 200, true),
    ] {
        let root = tempfile::tempdir().unwrap();
        let interrupted = child(root.path(), "request", Some(phase), None);
        assert_eq!(
            interrupted.status.code(),
            Some(85),
            "{phase}: {}",
            String::from_utf8_lossy(&interrupted.stderr)
        );
        let resumed = child(root.path(), "request", None, None);
        assert!(
            resumed.status.success(),
            "{phase}: {}",
            String::from_utf8_lossy(&resumed.stderr)
        );
        let result: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("result.json")).unwrap())
                .unwrap();
        assert_eq!(result["status"], status, "{phase}");
        assert_eq!(result["replayed"], replayed, "{phase}");
        let events = std::fs::read(root.path().join("business-events")).unwrap_or_default();
        assert_eq!(events.len(), count, "{phase}");
    }
}

#[test]
fn interrupted_erasure_and_retirement_are_recoverable() {
    for phase in ["erase-barrier", "scrubbed"] {
        let root = tempfile::tempdir().unwrap();
        let store = open(root.path());
        begin(&store, "t", "key")
            .complete(&response("sensitive receipt body"))
            .unwrap();
        drop(store);
        assert_eq!(
            child(root.path(), "erase", Some(phase), None).status.code(),
            Some(85)
        );
        let store = open(root.path());
        assert_eq!(
            store.begin("t", "key", [7; 32]).err().unwrap().code,
            "idempotency_reconciliation_required"
        );
        for path in files(root.path()) {
            assert!(!String::from_utf8_lossy(&std::fs::read(path).unwrap())
                .contains("sensitive receipt body"));
        }
        drop(begin(&store, "t", "fresh"));
    }
    let root = tempfile::tempdir().unwrap();
    assert_eq!(
        child(root.path(), "retire", Some("receipt-retired"), None)
            .status
            .code(),
        Some(85)
    );
    let store = open(root.path());
    begin(&store, "t", "key")
        .complete(&response("replacement"))
        .unwrap();
    assert!(files(root.path()).iter().all(|path| !path
        .file_name()
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with(".pending-")));
}

#[test]
fn failed_scrub_keeps_the_barrier_until_restart_cleanup_succeeds() {
    for phase in ["scrub-write", "scrub-sync"] {
        let root = tempfile::tempdir().unwrap();
        let store = open(root.path());
        begin(&store, "t", "key")
            .complete(&response("sensitive receipt body"))
            .unwrap();
        drop(store);
        let failed = child(root.path(), "erase-failure", None, Some(phase));
        assert!(
            failed.status.success(),
            "{}",
            String::from_utf8_lossy(&failed.stderr)
        );
        assert!(files(root.path())
            .iter()
            .any(|path| path.extension().is_some_and(|ext| ext == "erase")));
        let store = open(root.path());
        assert_eq!(
            store.begin("t", "key", [7; 32]).err().unwrap().code,
            "idempotency_reconciliation_required"
        );
        assert!(files(root.path())
            .iter()
            .all(|path| path.extension().is_none_or(|ext| ext != "erase")));
    }
}

#[tokio::test]
async fn subprocess_entry() {
    let Ok(root) = std::env::var("WARM_RETRY_TEST_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    match std::env::var("WARM_RETRY_TEST_MODE").unwrap().as_str() {
        "request" => {
            let state = crate::tests::state_with(root, 2, &[]);
            let mut request = Request::builder()
                .method("POST")
                .uri("/api/v1/documents")
                .header("Authorization", "Bearer test-key")
                .header("Idempotency-Key", "request")
                .body(Body::from("{}"))
                .unwrap();
            let principal = state.auth.authenticate(request.headers()).unwrap();
            request.extensions_mut().insert(Arc::new(principal));
            let result = crate::request::json_write(
                state,
                request,
                crate::auth::Scope::Write,
                |state, tenant, _| {
                    let mut events = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(state.cfg.data_dir.join("business-events"))
                        .map_err(ApiError::internal)?;
                    events.write_all(b"x").map_err(ApiError::internal)?;
                    events.sync_all().map_err(ApiError::internal)?;
                    let document = serde_json::from_value(
                        json!({"id":"committed", "text":"durable business effect"}),
                    )
                    .unwrap();
                    state
                        .core(tenant)?
                        .memorize_document(document)
                        .map_err(ApiError::from_core)?;
                    Ok((StatusCode::OK, json!({"result":"exact response"})))
                },
            )
            .await;
            let recorded = match result {
                Ok(response) => {
                    let status = response.status().as_u16();
                    let replayed = response.headers().contains_key("idempotent-replayed");
                    let body = to_bytes(response.into_body(), BYTES).await.unwrap();
                    assert_eq!(
                        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                        json!({"result":"exact response"})
                    );
                    json!({"status":status,"replayed":replayed})
                }
                Err(error) => {
                    json!({"status":error.status.as_u16(),"replayed":false,"code":error.code})
                }
            };
            std::fs::write(
                root.join("result.json"),
                serde_json::to_vec(&recorded).unwrap(),
            )
            .unwrap();
        }
        "erase" => {
            open(root)
                .erase("t", None)
                .unwrap()
                .unwrap()
                .finish()
                .unwrap();
        }
        "erase-failure" => {
            let store = open(root);
            assert!(store.erase("t", None).is_err());
            assert_eq!(
                store.begin("t", "new", [7; 32]).err().unwrap().code,
                "idempotency_storage_unavailable"
            );
        }
        "retire" => {
            let store = Idempotency::open(root, Duration::from_millis(1), CAPACITY, BYTES).unwrap();
            begin(&store, "t", "key")
                .complete(&response("expired private response"))
                .unwrap();
            std::thread::sleep(Duration::from_millis(2));
            drop(begin(&store, "t", "new"));
        }
        other => panic!("unknown child mode {other}"),
    }
}
