# Vectra migration adapter qualification

The adapter production source is signed/DCO `f1af798c5013f6a0b06b9a15769feb4105183633` with the portable metadata-filename refinement in `d7b7709ba0e557522220ec14626d70cecfb1eddc`. It was qualified with native vector-record source `5154eb94a3350b0143f7e0923a5003fff912f077`, generated declarations and that source's actual macOS arm64 debug addon. The adapter worktree reused the native owner's artifact; it did not perform another Rust build.

`verification.json` records exact source, addon, declaration and retained package hashes, commands, and compressed-log hashes. The retained tarball's SHA-512 integrity equals the package tested by the offline consumer gate. The receipt follow-up changes only evidence and adds package-integrity logging to the consumer script.

| Check | Result |
| --- | --- |
| Pinned selector differential and actual-native adapter scenarios | 7 passed, 0 skipped against the final native addon, before the filename refinement |
| Source-import test after the filename refinement | 1 selected test passed, 0 skipped; rejected names never reach `storage.readFile` |
| Public TypeScript examples | Passed against the generated declaration hash, unchanged in final native source |
| Final offline packed CJS/ESM consumer | Passed real document/vector queries, original f64/signed-zero retrieval and indexed/full metadata separation |

The full suite includes process restart and stale-token rejection, original subnormal and maximum finite f64 recovery, ordered repeated-ID transactions and atomic rollback, cancellation, cloned staging inputs, response loss after a real commit without automatic retry, complete 1002-record eligibility with a negative-score match beyond page one, real native writes between metadata pages, bounded clean-conflict retries, transaction/resource boundaries, and Vectra sidecar import. The standard test fixture's export files were produced by the real retained Vectra 0.15.0 package; its source/hash provenance is checked in separately. WARM storage and search in these tests use the real native addon.

Reproduce on an integrated checkout containing both native and adapter commits, with its matching `node-api,security` addon and generated `index.d.ts`:

```sh
npm ci --offline --ignore-scripts --no-audit --no-fund
node --test tests/node/vectra-selector.test.cjs tests/node/vectra.test.cjs
npm run test:types
npm_config_offline=true npm run test:package
```

`before-filename-guard/` preserves the preceding qualification rather than replacing it. This evidence covers the migration contract and functional boundaries. It contains no performance measurements, model inference or downloaded models, paid API calls, publishing, or claims of drop-in `LocalIndex`/hybrid ranking parity. The API and supported differences are documented in [the migration guide](../../../integrations/vectra-migration.md).
