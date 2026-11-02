// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { readFile, writeFile, open } from 'node:fs/promises'
import { resolve, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createTokenCounter, loadSciFact, normalizeResults, openEngine, packContext,
  prepareEngine, qrelMetrics, queryEngine, sha256, validateData, validateResults, eligibleDocuments, loadedNativeAddon } from './hybrid.mjs'

async function checkedJson(path, hash) {
  assert(isAbsolute(path), 'absolute config input path')
  const bytes = await readFile(path)
  assert.equal(sha256(bytes), hash, 'configuration input hash')
  return JSON.parse(bytes)
}

export async function runWorker(config, onObservation = async () => {}) {
  assert(['warm', 'vectra'].includes(config.engine))
  assert(['prepare', 'quality', 'timing'].includes(config.phase), 'unknown hybrid phase')
  assert(isAbsolute(config.modulePath) && isAbsolute(config.store), 'absolute module/store paths')
  const measured = config.phase === 'timing'
  assert(config.measure === undefined, 'timing is selected only by the admitted phase')
  const synthetic = config.purpose === 'synthetic-development'
  assert(!measured || (!synthetic && process.send && config.monitorPid === process.ppid), 'timing requires the frozen monitored study controller')
  let expectedAddon = null, expectedRuntime = null
  if (!synthetic) {
    assert.equal(config.purpose, 'frozen-study')
    const freeze = await checkedJson(config.freezePath, config.freezeSha256)
    assert.equal(freeze.authorized, true, 'explicit execution receipt required')
    assert(freeze.allowedPhases?.includes(config.phase))
    assert.equal(freeze.inputManifestSha256, sha256(await readFile(config.inputManifest)))
    assert.equal(freeze.workerSha256, sha256(await readFile(new URL('./hybrid-worker.mjs', import.meta.url))))
    assert.equal(freeze.helperSha256, sha256(await readFile(new URL('./hybrid.mjs', import.meta.url))))
    assert.equal(freeze.modulePaths[config.engine], config.modulePath)
    if (config.engine === 'warm') {
      assert(isAbsolute(freeze.nativeAddonPath))
      assert.equal(sha256(await readFile(freeze.nativeAddonPath)), freeze.nativeAddonSha256)
      expectedAddon = freeze.nativeAddonPath
    }
    assert.equal(freeze.tokenizerBridgeSha256, sha256(await readFile(new URL('./hybrid-tokenizer.py', import.meta.url))))
    assert.equal(freeze.nodeVersion, process.version)
    assert.equal(config.uvPath, freeze.uvPath)
    assert.equal(config.tokenizerPath, freeze.tokenizerPath)
    assert.equal(config.tokenizerSha256, freeze.tokenizerSha256)
    expectedRuntime = freeze.pythonRuntime
    assert(expectedRuntime && isAbsolute(expectedRuntime.executable) && isAbsolute(expectedRuntime.tokenizersRoot), 'frozen tokenizer runtime required')
    assert(Array.isArray(freeze.artifacts) && freeze.artifacts.length > 0, 'frozen module/addon artifacts required')
    for (const artifact of freeze.artifacts) {
      assert(isAbsolute(artifact.path) && /^[a-f0-9]{64}$/.test(artifact.sha256), 'absolute hash-bound artifact required')
      assert.equal(sha256(await readFile(artifact.path)), artifact.sha256)
    }
    if (measured) {
      assert(Number.isInteger(config.repetition) && config.repetition >= 0 && config.repetition < 3)
      const admission = await checkedJson(config.admissionPath, config.admissionSha256)
      assert.equal(admission.freezeHash, config.freezeSha256)
      assert.equal(admission.phase, 'measurement')
      assert.equal(admission.approved, true)
      assert(typeof admission.coordinator === 'string' && admission.coordinator.length > 0)
      const preflight = await checkedJson(config.preflightPath, config.preflightSha256)
      assert.equal(preflight.pass, true, 'both quiet preflights must pass before timing')
      assert.equal(preflight.freezeHash, config.freezeSha256)
    }
  }
  process.send?.({ type: 'stage', name: 'load-data' })
  const data = synthetic
    ? validateData(await checkedJson(config.fixturePath, config.fixtureSha256), true)
    : await loadSciFact(config.inputManifest)
  const baselineRss = process.memoryUsage().rss
  if (config.phase === 'prepare') {
    if (expectedAddon) assert.equal(loadedNativeAddon(config.modulePath), expectedAddon, 'loaded native addon differs from freeze')
    process.send?.({ type: 'stage', name: 'prepare' })
    const prepared = await prepareEngine(config.engine, config.modulePath, config.store, data)
    return { engine: config.engine, phase: config.phase, purpose: config.purpose, pid: process.pid,
      documents: data.documents.length, queries: data.queries.length, prepared, baselineRss,
      rssAfter: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 }
  }
  const tokenizerStart = performance.now()
  const countTokens = await createTokenCounter(config.uvPath ?? 'uv', config.tokenizerPath, config.tokenizerSha256, expectedRuntime)
  const tokenizerSetupMs = performance.now() - tokenizerStart
  const observations = []
  let openMs = null
  try {
    process.send?.({ type: 'stage', name: 'open' })
    const openStart = performance.now()
    const context = await openEngine(config.engine, config.modulePath, config.store, data)
    openMs = performance.now() - openStart
    if (expectedAddon) assert.equal(loadedNativeAddon(config.modulePath), expectedAddon, 'loaded native addon differs from freeze')
    process.send?.({ type: 'opened', openMs: measured ? openMs : null, scope: 'process total includes verified dataset and tokenizer setup; openMs isolates package import and engine open' })
    const textById = new Map(data.documents.map(row => [row.id, row.text]))
    const record = async row => { observations.push(row); await onObservation(row) }
    const filters = synthetic ? (config.filters ?? ['all', 'ten-percent', 'one-percent', 'empty']) : ['all', 'ten-percent', 'one-percent', 'empty']
    assert(Array.isArray(filters) && filters.length > 0 && filters.length <= 4)
    for (const eligibility of filters) {
      if (measured) {
        process.send?.({ type: 'stage', name: `warmup-${eligibility}` })
        for (const [warmupOrdinal, query] of data.queries.slice(0, 20).entries()) {
          const firstStart = performance.now()
          let raw
          try { raw = await queryEngine(context, query, eligibility) }
          catch (error) { await record({ warmup: true, queryId: query.id, eligibility, errorElapsedMs: performance.now() - firstStart, engineError: { name: error.name, message: error.message } }); continue }
          const firstRankEnd = performance.now()
          const rows = normalizeResults(raw, context.engine)
          validateResults(rows, context, data, eligibility)
          const firstPackStart = performance.now()
          await packContext(rows, textById, countTokens)
          if (eligibility === 'all' && warmupOrdinal === 0) await record({ warmup: true, firstQuery: true, queryId: query.id, eligibility, rankingMs: firstRankEnd - firstStart, packingMs: performance.now() - firstPackStart })
        }
      }
      process.send?.({ type: 'stage', name: `${config.phase}-${eligibility}` })
      const queries = measured && eligibility !== 'all' ? data.queries.filter((_, i) => i % 3 === 0) : data.queries
      for (const query of queries) {
        const rankStart = performance.now()
        let raw
        try { raw = await queryEngine(context, query, eligibility) }
        catch (error) {
          const errorElapsedMs = performance.now() - rankStart
          await record({ queryId: query.id, eligibility,
            ...(measured ? { errorElapsedMs } : {}),
            eligibleCount: eligibleDocuments(data, eligibility).length,
            qualified: false, engineError: { name: error.name, message: error.message },
            ...(context.state ? { readerErrors: [...context.state.errors] } : {}) })
          continue
        }
        const rankEnd = performance.now()
        const rows = normalizeResults(raw, context.engine)
        const eligible = validateResults(rows, context, data, eligibility)
        const packStart = performance.now()
        const packed = await packContext(rows, textById, countTokens)
        const packEnd = performance.now()
        assert(rankEnd >= rankStart && packEnd >= packStart)
        const ids = rows.map(row => row.documentId)
        await record({ queryId: query.id, eligibility, eligibleCount: eligible.size,
          ...(measured ? { rankingMs: rankEnd - rankStart, packingMs: packEnd - packStart,
            rankingAndPackingMs: rankEnd - rankStart + packEnd - packStart } : {}),
          policy: config.engine === 'warm' ? 'document-rrf-k20' : 'semantic10-then-bm25-append10',
          actualRoute: null, routeUnavailable: 'document API has no typed route report; no ANN claim',
          ranking: rows.map(({ text, ...row }) => row),
          ranked: qrelMetrics(ids, data.qrels[query.id], eligible),
          packed: { ...packed, ...qrelMetrics(packed.ids, data.qrels[query.id], eligible, 20) },
          ...(context.state ? { reader: { reads: context.state.reads, bytes: context.state.bytes,
            added: context.state.added, errors: [...context.state.errors] } } : {}),
        })
      }
    }
  } finally { await countTokens.close() }
  return { engine: config.engine, phase: config.phase, purpose: config.purpose, pid: process.pid,
    tokenizer: { ...countTokens.receipt, peakRssBytes: countTokens.peakRssBytes },
    ...(measured ? { openMs, tokenizerSetupMs, repetition: config.repetition } : {}),
    freezeSha256: config.freezeSha256 ?? null,
    baselineRss, rssAfter: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024,
    timingsCollected: measured, observations,
    querySetComplete: observations.filter(row => !row.warmup).every(row => !row.engineError),
    successfulQueries: observations.filter(row => !row.warmup && !row.engineError).length,
    failedQueries: observations.filter(row => !row.warmup && row.engineError).length }
}

async function main() {
  const [configPath, outputArgument] = process.argv.slice(2)
  assert(configPath, 'usage: node hybrid-worker.mjs CONFIG.json [OUTPUT.json]')
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8'))
  const outputPath = outputArgument ?? config.output
  assert(isAbsolute(outputPath), 'absolute fresh output path required')
  let result, completedObservations = 0
  const progressPath = `${resolve(outputPath)}.queries.jsonl`
  const progress = await open(progressPath, 'wx')
  try {
    result = { complete: true, ...(await runWorker(config, async row => {
      await progress.write(`${JSON.stringify(row)}\n`)
      completedObservations++
    })) }
  } catch (error) {
    result = { complete: false, engine: config.engine, phase: config.phase,
      pid: process.pid, error: { name: error.name, message: error.message, stack: error.stack } }
    process.exitCode = 1
  } finally { await progress.close() }
  await writeFile(resolve(outputPath), `${JSON.stringify({ ...result, progressPath, completedObservations })}\n`, { flag: 'wx' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 }).finally(() => { if (process.connected) process.disconnect() })
}
