import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { freeze, verifyFreeze } from './vector.mjs'
import { exec, sha256, writeOnce } from './vector-receipts.mjs'
const root = await fs.mkdtemp(path.join(process.cwd(), 'target', 'synthetic-freeze-'))
const glove = path.join(root, 'glove'), scifact = path.join(root, 'scifact'), sources = path.join(root, 'sources')
await fs.mkdir(glove); await fs.mkdir(scifact); await fs.mkdir(sources)
await fs.writeFile(path.join(glove, 'fixture'), 'synthetic only')
await fs.writeFile(path.join(scifact, 'input.json'), JSON.stringify({ queries: Array.from({length: 300}, (_, i) => ({id:`q${i}`})) }))
await fs.writeFile(path.join(scifact, 'fixture'), 'synthetic only')
const mapping = path.join(root, 'mapping.json'); await fs.writeFile(mapping, '{}')
const inputs = path.join(root, 'inputs.json'), plan = path.join(root, 'plan.md')
await fs.writeFile(plan, 'synthetic freeze verification only')
await writeOnce(inputs, { glove: { directory: glove, files: { fixture: { sha256: await sha256(path.join(glove, 'fixture')) } }, prefixes: [{rows:128}], source_archive_sha256: 'synthetic' }, scifact: { directory: scifact, source_directory: sources, sources: {}, mapping_manifest: 'mapping.json', mapping_manifest_sha256: await sha256(mapping), embedding_model: 'synthetic', effective_revision: 'synthetic', files: { 'input.json': {sha256:await sha256(path.join(scifact, 'input.json'))}, fixture:{sha256:await sha256(path.join(scifact, 'fixture'))} } } })
const config = path.join(root, 'config.json'), output = path.join(root, 'output')
const source = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim()
await writeOnce(config, { plan, inputs, warmPath: process.cwd(), nativeAddon: path.join(process.cwd(), 'warm-sdk.darwin-arm64.node'), warmSourceCommit: source, vectraPath: process.env.VECTRA_TEST_PACKAGE ?? '/Volumes/A/toip-warm-backend/toip-mcp-server/node_modules/vectra', vectraLockfile: process.env.VECTRA_TEST_LOCK ?? '/Volumes/A/toip-warm-backend/toip-mcp-server/package-lock.json', hybrid: { uvPath:process.env.UV_PATH ?? '/Users/davidcondrey/.local/bin/uv', tokenizerPath:process.env.TOKENIZER_PATH ?? '/Volumes/A/hms-models/Qwen3-Embedding-0.6B/tokenizer.json' } })
const frozen = await freeze(config, output)
assert.equal(frozen.hybrid.queryIds.length, 300); assert.equal(frozen.hybrid.timingSchedule.length, 6)
await verifyFreeze(output)
await fs.writeFile(plan, 'changed synthetic plan')
const changedHash = await sha256(plan)
assert.notEqual(changedHash, frozen.protocolSha256)
await assert.rejects(verifyFreeze(output), error => error.actual === changedHash && error.expected === frozen.protocolSha256)
console.log(JSON.stringify({status:'pass', scope:'synthetic freeze and verification only; no study queries or timing', output}))
