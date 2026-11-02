# Integrated Node and package qualification

Qualified source: `53a4e3a6e35029a464b7c9cff7bc23149ec690c8`, consisting of integrated source `3431f997e21a47a2e3a137075e08b696168baadb` plus the canonical type-gate fix. The Rust source, manifest and lockfile match the integrated input exactly. The fix adds the previously omitted native vector-record TypeScript regression to `npm run test:types`.

| Gate | Result |
| --- | --- |
| Offline default Node build | Passed with Rust 1.99.0, two jobs, `node-api,security`, optimized dev profile |
| Full Node functional suite | 25 passed, 0 failed, 3 optional-feature skips |
| Separate optional addon | All 3 skipped tests passed with `local-embed` and the checked-in 36 KiB synthetic fixture; no download feature |
| TypeScript | All four base/memory/vector-record/Vectra regression files passed |
| Generated files | `index.js` and `index.d.ts` unchanged |
| Bundled package consumer | Offline CJS/ESM imports and real document/Vectra queries passed |
| JavaScript-only root + native platform package | Offline darwin-arm64 install passed semantic/full-vector/temporal/Vectra queries, atomic batch, chain purge, original f64 retrieval and empty eligibility |
| Cargo package inventory | The new `legacy-fixtures.json` is included; no extra Rust package build was performed |

The default skips are exactly `tests/node/embedding-limits.test.cjs`: the default addon does not export the optional `LocalEmbedder`. Its separate fixture-only run passed 3/3 with zero skips. The default run therefore remains recorded as 25 passed and 3 skipped, rather than being relabeled as a zero-skip run.

`verification.json` retains exact source, toolchain, commands, addon and tarball hashes. Every retained log is compressed with both raw and gzip SHA-256 recorded. The bundled tarball's SHA-512 integrity equals the package actually tested. The default addon, renamed platform binding and installed consumer binding have identical SHA-256. Large binaries and tarballs remain at the absolute local paths recorded in the receipt.

`platform-consumer.cjs` is the exact consumer program run from a fresh offline install of the retained JavaScript-only root and darwin-arm64 tarballs. The platform package generator retained the existing eight-target root metadata; this local run qualifies only macOS arm64. Other platform binaries and Rust package verification remain separate gates.

No full model inference, model downloads, paid services, benchmarks, publishing or push occurred. Both build/test pipelines finished and released the private Cargo cache before the receipt was written.
