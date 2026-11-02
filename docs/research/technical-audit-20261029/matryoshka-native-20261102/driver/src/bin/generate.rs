use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use warm::core::models::{default_device, Embedder, EmbeddingQueryTask, ModelSource};

const QUERY_PREFIX: &str =
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";
const DIMENSIONS: usize = 1024;

#[derive(Deserialize)]
struct Row {
    id: String,
    text: String,
}

#[derive(Deserialize)]
struct Input {
    documents: Vec<Row>,
    queries: Vec<Row>,
}

#[derive(Deserialize)]
struct Config {
    input: PathBuf,
    model: PathBuf,
    revision: String,
    output_directory: PathBuf,
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let temporary = path.with_extension("writing");
    let mut file = File::create(&temporary)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn validate_vectors(rows: &[Vec<f32>], expected: usize) -> Result<()> {
    ensure!(rows.len() == expected, "wrong vector row count");
    for row in rows {
        ensure!(row.len() == DIMENSIONS, "wrong vector width");
        ensure!(row.iter().all(|v| v.is_finite()), "non-finite vector");
        let norm = row
            .iter()
            .map(|&v| f64::from(v).powi(2))
            .sum::<f64>()
            .sqrt();
        ensure!((norm - 1.0).abs() < 1e-4, "unexpected vector norm {norm}");
    }
    Ok(())
}

fn token_audit(tokenizer: &tokenizers::Tokenizer, rows: &[Row], query: bool) -> Result<Value> {
    let mut lengths = Vec::with_capacity(rows.len());
    let mut truncated = Vec::new();
    for row in rows {
        let input = if query {
            format!("{QUERY_PREFIX}{}", row.text)
        } else {
            row.text.clone()
        };
        let length = tokenizer
            .encode(input, true)
            .map_err(|e| anyhow::anyhow!("token audit: {e}"))?
            .len();
        lengths.push(length);
        if length > 2048 {
            truncated.push(json!({"id": row.id, "tokens": length}));
        }
    }
    Ok(json!({"untruncated_lengths": lengths, "over_cap": truncated, "cap": 2048}))
}

fn generate_rows(
    embedder: &Embedder,
    rows: &[Row],
    query: bool,
    directory: &Path,
) -> Result<Value> {
    let name = if query { "queries" } else { "corpus" };
    let partial = directory.join(format!("{name}.f32.partial"));
    let complete = directory.join(format!("{name}.f32"));
    ensure!(!complete.exists(), "refusing to replace existing vectors");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)?;
    let mut writer = BufWriter::new(file);
    let started = Instant::now();
    let mut completed = 0;
    for batch in rows.chunks(8) {
        let vectors = embedder.embed(
            &batch.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(),
            query,
        )?;
        validate_vectors(&vectors, batch.len())?;
        for row in vectors {
            for value in row {
                writer.write_all(&value.to_le_bytes())?;
            }
        }
        writer.flush()?;
        writer.get_ref().sync_all()?;
        completed += batch.len();
        write_json(
            &directory.join(format!("{name}.progress.json")),
            &json!({
                "completed_rows": completed, "expected_rows": rows.len(), "dimensions": DIMENSIONS,
                "bytes": completed * DIMENSIONS * 4, "generation_seconds": started.elapsed().as_secs_f64(),
                "last_id": batch.last().context("empty generation batch")?.id,
            }),
        )?;
        eprintln!("{name}: {completed}/{}", rows.len());
    }
    writer.flush()?;
    writer.get_ref().sync_all()?;
    drop(writer);
    fs::rename(&partial, &complete)?;
    Ok(
        json!({"rows": completed, "dimensions": DIMENSIONS, "bytes": completed * DIMENSIONS * 4,
        "generation_seconds": started.elapsed().as_secs_f64(), "path": complete}),
    )
}

fn main() -> Result<()> {
    let config_path = std::env::args_os()
        .nth(1)
        .context("usage: generate CONFIG.json")?;
    let config: Config = serde_json::from_slice(&fs::read(config_path)?)?;
    ensure!(
        !config.output_directory.exists(),
        "generation requires a new output directory"
    );
    let input: Input = serde_json::from_slice(&fs::read(&config.input)?)?;
    ensure!(
        input.documents.len() == 5183 && input.queries.len() == 300,
        "unexpected workload"
    );
    fs::create_dir_all(&config.output_directory)?;
    let device = default_device()?;
    ensure!(
        device.is_metal(),
        "protocol requires Metal; no fallback permitted"
    );
    let source = ModelSource::new(config.model.clone(), config.revision.clone());
    let started = Instant::now();
    let mut embedder = Embedder::load(&source, &device)?;
    let load_seconds = started.elapsed().as_secs_f64();
    embedder.set_query_task(EmbeddingQueryTask::Documents);
    embedder.set_batch(1);
    ensure!(
        embedder.dimensions() == DIMENSIONS,
        "unexpected native dimensions"
    );
    let mut tokenizer = tokenizers::Tokenizer::from_file(config.model.join("tokenizer.json"))
        .map_err(|e| anyhow::anyhow!("load audit tokenizer: {e}"))?;
    tokenizer
        .with_truncation(None)
        .map_err(|e| anyhow::anyhow!("audit truncation: {e}"))?;
    tokenizer.with_padding(None);
    let token_counts = json!({
        "documents": token_audit(&tokenizer, &input.documents, false)?,
        "queries": token_audit(&tokenizer, &input.queries, true)?,
    });
    write_json(&config.output_directory.join("tokens.json"), &token_counts)?;
    let start_receipt = json!({
        "input": config.input, "model": config.model, "revision": config.revision,
        "device": "Metal", "native_scalar_type": "F32", "batch": 1,
        "outer_batch": 8, "input_cap": 2048, "query_prefix": QUERY_PREFIX,
        "embedding_space": embedder.space(), "model_load_seconds": load_seconds,
    });
    write_json(
        &config.output_directory.join("started.json"),
        &start_receipt,
    )?;
    let corpus = generate_rows(&embedder, &input.documents, false, &config.output_directory)?;
    let queries = generate_rows(&embedder, &input.queries, true, &config.output_directory)?;
    write_json(
        &config.output_directory.join("complete.json"),
        &json!({
            "configuration": start_receipt, "corpus": corpus, "queries": queries,
            "total_after_model_load_seconds": started.elapsed().as_secs_f64() - load_seconds,
        }),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vectors_reject_nonfinite_wrong_width_and_nonunit_rows() {
        let mut unit = vec![0.0; DIMENSIONS];
        unit[0] = 1.0;
        validate_vectors(&[unit.clone()], 1).unwrap();
        assert!(validate_vectors(&[unit.clone()], 2).is_err());
        for width in [DIMENSIONS - 1, DIMENSIONS + 1] {
            assert!(validate_vectors(&[vec![0.0; width]], 1).is_err());
        }
        for invalid in [f32::NAN, f32::INFINITY, 0.0, 2.0] {
            unit[0] = invalid;
            assert!(validate_vectors(&[unit.clone()], 1).is_err());
        }
    }

    #[test]
    fn token_audit_applies_query_instruction_and_records_cap_boundaries() {
        let mut vocab: tokenizers::models::wordlevel::WordLevelBuilder =
            tokenizers::models::wordlevel::WordLevel::builder();
        vocab = vocab.unk_token("[UNK]".into());
        let model = vocab
            .vocab([(String::from("[UNK]"), 0)].into_iter().collect())
            .build()
            .unwrap();
        let mut tokenizer = tokenizers::Tokenizer::new(model);
        tokenizer.with_pre_tokenizer(Some(
            tokenizers::pre_tokenizers::whitespace::WhitespaceSplit,
        ));
        let rows: Vec<_> = [2047, 2048, 2049]
            .into_iter()
            .map(|n| Row {
                id: n.to_string(),
                text: vec!["x"; n].join(" "),
            })
            .collect();
        let audit = token_audit(&tokenizer, &rows, false).unwrap();
        assert_eq!(audit["untruncated_lengths"], json!([2047, 2048, 2049]));
        assert_eq!(audit["over_cap"], json!([{"id":"2049", "tokens":2049}]));
        let query = token_audit(&tokenizer, &rows[..1], true).unwrap();
        assert!(query["untruncated_lengths"][0].as_u64().unwrap() > 2047);
    }
}
