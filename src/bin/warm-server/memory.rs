// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

//! The memory API (`POST /api/v1/memory/{remember,recall,explain,forget,get,history,
//! applyForgetting,consolidate}`; docs/memory-api) behind the server's auth, limits, tenant
//! lifecycle and idempotency.

use std::sync::Arc;

use axum::extract::{Request, State};
use axum::http::StatusCode;
use serde_json::{json, Value};
use writerslogic_warm::core::memory_api::{DocumentQuotaExceeded, MemoryError};

use crate::auth::Scope;
use crate::config::{MAX_ID_BYTES, MAX_TEXT_BYTES};
use crate::documents::{check_metadata_size, dense};
use crate::error::{ApiError, ApiResult};
use crate::request::{json_write, parse};
use crate::tenants::AppState;

/// Limits the memory routes share with the document routes, applied to the raw request before
/// the memory API sees it.
fn validate_memory_request(op: &str, request: &Value, state: &AppState) -> Result<(), ApiError> {
    let cfg = &state.cfg;
    let vector = |value: &Value, what: &str| -> Result<(), ApiError> {
        match value {
            Value::Null => Ok(()),
            Value::Array(items) => {
                let values: Option<Vec<f64>> = items.iter().map(Value::as_f64).collect();
                dense(
                    &values.ok_or_else(|| ApiError::bad(format!("{what} must be numbers")))?,
                    cfg.input_dim,
                    what,
                )
            }
            _ => Err(ApiError::bad(format!("{what} must be an array of numbers"))),
        }
    };
    let fact = |fact: &Value| -> Result<(), ApiError> {
        let Value::Object(map) = fact else {
            return Err(ApiError::bad("a fact must be a JSON object"));
        };
        if let Some(Value::String(id)) = map.get("id") {
            if id.len() > MAX_ID_BYTES {
                return Err(ApiError::bad(format!("id exceeds {MAX_ID_BYTES} bytes")));
            }
        }
        if let Some(Value::String(text)) = map.get("text") {
            if text.len() > MAX_TEXT_BYTES {
                return Err(ApiError::bad(format!(
                    "text exceeds {MAX_TEXT_BYTES} bytes"
                )));
            }
        }
        if let Some(metadata) = map.get("metadata") {
            check_metadata_size(metadata)?;
        }
        map.get("embedding")
            .map_or(Ok(()), |v| vector(v, "embedding"))
    };
    match op {
        "remember" => match request.get("facts") {
            Some(Value::Array(facts)) => {
                if facts.is_empty() || facts.len() > cfg.max_batch {
                    return Err(ApiError::bad(format!(
                        "facts must contain 1..={} entries",
                        cfg.max_batch
                    )));
                }
                facts.iter().try_for_each(fact)
            }
            Some(_) => Err(ApiError::bad("facts must be an array")),
            None => fact(request),
        },
        "recall" | "explain" => {
            if let Some(Value::String(query)) = request.get("query") {
                if query.len() > 8192 {
                    return Err(ApiError::bad("query requires at most 8192 bytes"));
                }
            }
            if let Some(k) = request.get("k").and_then(Value::as_f64) {
                if k < 1.0 || k > f64::from(cfg.max_top_k) {
                    return Err(ApiError::bad(format!("k must be 1..={}", cfg.max_top_k)));
                }
            }
            request
                .get("embedding")
                .map_or(Ok(()), |v| vector(v, "embedding"))
        }
        _ => Ok(()),
    }
}

fn memory_error(error: anyhow::Error) -> ApiError {
    match error.downcast_ref::<MemoryError>() {
        Some(MemoryError::Invalid(message)) => ApiError::bad(message.clone()),
        Some(MemoryError::NotFound(message)) => ApiError::not_found(message.clone()),
        Some(MemoryError::Conflict(message)) => ApiError::conflict(message.clone()),
        Some(MemoryError::Concurrent(message)) => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "concurrent_mutation",
            message.clone(),
        )
        .retry_after(1),
        None => ApiError::from_core(error),
    }
}

async fn run(op: &'static str, scope: Scope, state: Arc<AppState>, req: Request) -> ApiResult {
    json_write(state, req, scope, move |state, tenant, bytes| {
        let mut request: Value = if bytes.is_empty() {
            json!({})
        } else {
            parse(&bytes)?
        };
        validate_memory_request(op, &request, state)?;
        let core = state.core(tenant)?;
        if matches!(op, "recall" | "explain")
            && request.get("k").is_none_or(Value::is_null)
            && core.memory().config().default_k > state.cfg.max_top_k
        {
            if let Some(map) = request.as_object_mut() {
                map.insert("k".into(), state.cfg.max_top_k.into());
            }
        }
        let lease = (scope == Scope::Write).then(|| core.quota_lease());
        let _vector_mutation = lease.as_ref().map(|lease| core.vector_mutation(lease));
        let was_valid = if scope == Scope::Write {
            core.vectors()
                .map(|vectors| vectors.begin_memory_mutation())
                .transpose()
                .map_err(ApiError::internal)?
        } else {
            None
        };
        let before = core.revision();
        let response = if op == "remember" && state.cfg.max_documents_per_tenant != 0 {
            core.memory()
                .call_with_document_limit(op, request, state.cfg.max_documents_per_tenant)
        } else {
            core.memory().call(op, request)
        };
        let uncertain = response.as_ref().err().is_some_and(|error| {
            error.is::<writerslogic_warm::CommittedMutationError>()
                || error.is::<writerslogic_warm::IndeterminateMutationError>()
        });
        if scope == Scope::Write && (response.is_ok() || core.revision() != before) {
            core.bump();
        }
        if was_valid == Some(true) && !uncertain {
            let vectors = core.vectors().expect("vector index remains open");
            if core.revision() == before {
                vectors.finish_unchanged_memory_mutation();
            } else {
                let ids = if op == "remember" {
                    response.as_ref().ok().and_then(|response| {
                        response
                            .get("remembered")?
                            .as_array()?
                            .iter()
                            .map(|fact| fact.get("id")?.as_str())
                            .collect::<Option<Vec<_>>>()
                    })
                } else {
                    None
                };
                let reconciled = match ids {
                    Some(ids) => vectors.reconcile_remembered(&core, &ids),
                    None => vectors.reconcile_memory_mutation(&core),
                };
                if let Err(error) = reconciled {
                    return Err(if response.is_ok() {
                        ApiError::committed(error)
                    } else {
                        ApiError::internal(error)
                    });
                }
            }
        }
        let response = response.map_err(|error| {
            if let Some(quota) = error.downcast_ref::<DocumentQuotaExceeded>() {
                state
                    .metrics
                    .quota_rejections
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "quota_exceeded",
                    format!("tenant document quota of {} would be exceeded", quota.limit),
                )
                .retry_after(60)
            } else {
                memory_error(error)
            }
        })?;
        Ok((StatusCode::OK, response))
    })
    .await
}

macro_rules! memory_handler {
    ($name:ident, $op:literal, $scope:expr) => {
        pub async fn $name(State(state): State<Arc<AppState>>, req: Request) -> ApiResult {
            run($op, $scope, state, req).await
        }
    };
}

memory_handler!(remember, "remember", Scope::Write);
memory_handler!(recall, "recall", Scope::Read);
memory_handler!(capabilities, "capabilities", Scope::Read);
memory_handler!(explain, "explain", Scope::Read);
memory_handler!(forget, "forget", Scope::Write);
memory_handler!(get, "get", Scope::Read);
memory_handler!(history, "history", Scope::Read);
memory_handler!(apply_forgetting, "applyForgetting", Scope::Write);
memory_handler!(consolidate, "consolidate", Scope::Write);
