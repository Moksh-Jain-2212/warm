// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use std::hint::black_box;
use std::time::Duration;
use writerslogic_warm::core::vector_records::{
    VectorRecordInput, VectorRecordOperation, VectorRecordQueryOptions,
};
use writerslogic_warm::core::WarmConfig;
use writerslogic_warm::{EmbeddingSpace, WarmCore};

fn query(c: &mut Criterion) {
    const RECORDS: usize = 16_384;
    const DIM: usize = 8;
    let directory = tempfile::tempdir().unwrap();
    let config = WarmConfig {
        vector_records: true,
        embedding_space: Some(EmbeddingSpace {
            model: "synthetic".into(),
            revision: "1".into(),
            dimensions: DIM,
            normalization: "l2".into(),
            metric: "cosine".into(),
        }),
        ..Default::default()
    };
    let core = WarmCore::new(
        256,
        Some(directory.path().display().to_string()),
        Some(config),
    )
    .unwrap();
    for start in (0..RECORDS).step_by(1024) {
        let operations = (start..start + 1024)
            .map(|index| VectorRecordOperation::Insert {
                record: VectorRecordInput {
                    id: format!("record-{index:05}"),
                    vector: vec![1.0; DIM],
                    metadata: serde_json::json!({}),
                },
            })
            .collect();
        core.mutate_vector_records(operations, &Default::default())
            .unwrap();
    }
    let mut group = c.benchmark_group("vector_record_eligibility_16384");
    group.sample_size(20);
    group.warm_up_time(Duration::from_secs(1));
    group.measurement_time(Duration::from_secs(3));
    for count in [0, 1, 64, RECORDS] {
        let options = VectorRecordQueryOptions {
            document_ids: Some((0..count).map(|id| format!("record-{id:05}")).collect()),
            ..Default::default()
        };
        group.bench_with_input(
            BenchmarkId::from_parameter(count),
            &options,
            |b, options| {
                b.iter(|| {
                    black_box(
                        core.query_vector_records(black_box(&[1.0; DIM]), 1, black_box(options))
                            .unwrap(),
                    )
                });
            },
        );
    }
    group.finish();
}

criterion_group!(benches, query);
criterion_main!(benches);
