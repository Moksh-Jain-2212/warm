// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { atLeast, normalize, normalizeRows, scalarCosine, oracleTopK, liveState, auditExact, qrelMetrics, latency, FILTERS, metadata } from './oracle-vector.mjs'
import { ARMS, timingSchedule, qualityGate, preparationGate, dependencyInventory, hostInfo, verifyHost, verifyGraphEnvironment, runPhase, summarize } from './vector.mjs'
import { parseProcesses, descendants, externalCpuFraction, preflight, writeOnce, readJson, manifest, cloneStore, assertOwnedPath, runMonitored, watchPhase, sha256, exec } from './vector-receipts.mjs'
import { provider, graphProfileCheck, routeCheck, scoreOrderPass, loadTruth } from './vector-worker.mjs'
const require = createRequire(import.meta.url), HERE = path.dirname(fileURLToPath(import.meta.url))
const sources = { vectraPath: process.env.VECTRA_TEST_PACKAGE, warmPath: process.env.WARM_TEST_PACKAGE, nativeAddon: process.env.WARM_TEST_ADDON }
for (const [name, value] of Object.entries(sources)) assert.ok(value, `${name} test path is required; actual API checks must not silently skip`)
async function temporary(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'warm-vector-harness-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory }
async function lines(file) { return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }

test('normalized oracle agrees with independent scalar sorting, including extremes and cutoff ties', () => {
  const vectors = [[1, -0, 0], [1, 0, 0], [1, 1e-4, 0], [1, .001, 0], [1, .01, 0], [0, 1, 0], [-1, 0, 0], [1e30, 1e-30, 0], [1e-30, 1e-30, 0], [2, 1, 0], [3, 1, 0], [4, 1, 0], [-1, -1, 0]]
  const rows = normalizeRows(Float64Array.from(vectors.flat()), 3)
  for (const query of [[1, 0, -0], [1, 1, 1], [-1, 0, 0]]) for (const filter of FILTERS) {
    const truth = oracleTopK(rows, 3, query, liveState(vectors.length), filter.name)
    const expected = vectors.map((vector, ordinal) => ({ ordinal, score: scalarCosine(vector, query) })).filter(hit => filter.name === 'all' || (filter.name === '10pct' && hit.ordinal < 10) || (filter.name === '1pct' && hit.ordinal === 0)).sort((a, b) => b.score - a.score || a.ordinal - b.ordinal).slice(0, 10)
    assert.deepEqual(truth.hits.map(hit => hit.ordinal), expected.map(hit => hit.ordinal))
    truth.hits.forEach((hit, i) => assert.ok(Math.abs(hit.score - expected[i].score) < 1e-14))
  }
  assert.throws(() => normalize([0, -0])); assert.throws(() => normalize([NaN, 1])); assert.throws(() => normalize([Infinity, 1]))
  const scores = Array.from({ length: 12 }, (_, i) => i < 9 ? 1 - i / 100 : .5 - (i - 9) * 1e-6)
  const truth = { hits: scores.slice(0, 10).map((score, ordinal) => ({ score, ordinal })), eligibleCount: 12, cutoff: .5 }
  const eligible = new Set(scores.map((_, i) => i)), score = i => scores[i]
  const substitute = [...truth.hits.slice(0, 9), { ordinal: 10, score: scores[10] }]
  assert.equal(auditExact(substitute, truth, score, eligible).tieBoundarySubstitutions, 1)
  assert.equal(auditExact(substitute, truth, score, eligible).pass, true)
  scores[10] = .5 - 2.001e-6; substitute[9].score = scores[10]
  assert.equal(auditExact(substitute, truth, score, eligible).pass, false)
  const badScore = truth.hits.map(hit => ({ ...hit })); badScore[0].score += 2.001e-6
  assert.equal(auditExact(badScore, truth, score, eligible).pass, false)
  assert.equal(auditExact([...truth.hits.slice(0, 9), truth.hits[0]], truth, score, eligible).pass, false)
  assert.equal(auditExact([], { hits: [], cutoff: null, eligibleCount: 0 }, score, new Set()).pass, true)
})

test('quality gates distinguish exact numerical ties from ANN misses and fail missing references', () => {
  const reference = [{ query: 0, hits: [{ ordinal: 1 }], correctness: true, eligibleCount: 1, oracleRecall: 1, qrel: null }]
  const tie = [{ ...reference[0], hits: [{ ordinal: 2 }], oracleRecall: 0 }]
  assert.equal(qualityGate(tie, reference, true).pass, true)
  assert.equal(qualityGate(tie, reference).pass, false)
  assert.equal(qualityGate(reference, [{ query: 0, error: { message: 'failed' } }], true).pass, false)
  assert.equal(qualityGate([], [], true).pass, false)
  assert.deepEqual(latency([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { count: 10, p50: 5, p95: 10, p99: 10 })
  assert.deepEqual(qrelMetrics(['a'], new Map([['a', 1]]), new Set()), { ndcg10: null, recall10: null, eligibleJudgments: 0 })
  const schedule = timingSchedule([{ name: 'glove-128', rows: 128 }, { name: 'scifact', rows: 5183 }])
  assert.equal(schedule.length, 3 * 4 * (2 + 7)); assert.equal(schedule.filter(job => job.dataset === 'scifact' && job.queryStride === 3).length, 3 * 3 * 7)
  for (const repetition of [0, 1, 2]) assert.equal(schedule.filter(job => job.repetition === repetition && job.filter === 'all' && job.dataset === 'scifact')[0].arm, ARMS[repetition].name)
  assert.equal(routeCheck('warm', { mode: 'graph' }, 'all', 'filteredExact', 'prepared'), false)
  assert.equal(routeCheck('warm', { mode: 'graph' }, '10pct', 'filteredExact', 'prepared'), true)
  assert.equal(graphProfileCheck({ highRecall: true }, 'fullGraph', { graphDegree: 64, graphBuildEf: 500 }), true)
  assert.equal(graphProfileCheck({}, 'fullGraph', { graphDegree: 64, graphBuildEf: 256 }), true)
  assert.equal(graphProfileCheck({}, 'fullGraph', { graphDegree: 32, graphBuildEf: 128 }), false)
  assert.equal(graphProfileCheck({ highRecall: true }, 'fullGraph', { graphDegree: 32, graphBuildEf: 128 }), false)
  assert.equal(graphProfileCheck({}, 'fullGraph', undefined), false)
})

test('quality requires complete unique expected queries on both sides and gates timed ANN results', () => {
  const row = query => ({ query, hits: [{ ordinal: query }], correctness: true, eligibleCount: 1, oracleRecall: 1, qrel: { ndcg10: 1, recall10: 1, eligibleJudgments: 1 } })
  const reference = [row(0), row(1)], expected = [0, 1]
  assert.equal(qualityGate(reference, reference, false, expected).pass, true)
  for (const invalid of [[row(0), row(0)], [row(0)], [row(0), row(2)]]) {
    assert.equal(qualityGate(invalid, reference, false, expected).pass, false)
    assert.equal(qualityGate(reference, invalid, false, expected).pass, false)
  }
  const zeroRecall = reference.map(item => ({ ...item, hits: [{ ordinal: item.query + 10 }], oracleRecall: 0 }))
  assert.equal(qualityGate(zeroRecall, reference, false, expected).pass, false)
  const missingOracle = reference.map(item => ({ ...item, oracleRecall: null }))
  assert.equal(qualityGate(missingOracle, reference, false, expected).pass, false)
  const missingRelevance = reference.map(item => ({ ...item, qrel: null }))
  assert.equal(qualityGate(missingRelevance, reference, false, expected).pass, false)
})

test('ANN recall gate handles exact mean threshold without accumulated rounding error', () => {
  for (const invalid of [NaN, Infinity, -Infinity]) assert.equal(atLeast(invalid, .99), false)
  const hits = Array.from({ length: 10 }, (_, ordinal) => ({ ordinal }))
  const reference = Array.from({ length: 1000 }, (_, query) => ({ query, hits, correctness: true, eligibleCount: 10, oracleRecall: 1, qrel: null }))
  for (const belowPerfect of [99, 100, 101]) {
    const rows = reference.map((row, query) => query >= 1000 - belowPerfect
      ? { ...row, hits: [...hits.slice(0, 9), { ordinal: 10 }], oracleRecall: 0.9 }
      : row)
    const result = qualityGate(rows, reference)
    assert.equal(result.pass, belowPerfect <= 100, `below-perfect queries: ${belowPerfect}`)
  }
  const referenceQrel = [{ ...reference[0], qrel: { ndcg10: 0.9, recall10: 0.9, eligibleJudgments: 1 } }]
  for (const [score, pass] of [[0.890000001, true], [0.89, true], [0.889999999, false]]) {
    const rows = [{ ...referenceQrel[0], qrel: { ndcg10: score, recall10: score, eligibleJudgments: 1 } }]
    assert.equal(qualityGate(rows, referenceQrel).pass, pass)
  }
})

test('graph results must retain descending returned and canonical score order', () => {
  const scores = [1, .8, .8 - 1e-6, .5]
  const hits = scores.map((score, ordinal) => ({ ordinal, score }))
  assert.equal(scoreOrderPass(hits, ordinal => scores[ordinal]), true)
  assert.equal(scoreOrderPass([...hits].reverse(), ordinal => scores[ordinal]), false)
  const nearTie = [hits[0], { ...hits[2], score: .8000001 }, { ...hits[1], score: .8 }, hits[3]]
  assert.equal(scoreOrderPass(nearTie, ordinal => scores[ordinal]), true)
  const outside = [hits[0], { ...hits[3], score: .8000001 }, { ...hits[1], score: .8 }]
  assert.equal(scoreOrderPass(outside, ordinal => scores[ordinal]), false)
})

test('frozen dependency inventory detects installed code changes and refuses symlinks', async t => {
  const root = await temporary(t), pkg = path.join(root, 'node_modules', 'vectra')
  await fs.mkdir(pkg, { recursive: true })
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/vectra': { version: '0.15.0', integrity: 'sha512-test' } } }))
  await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'vectra', version: '0.15.0' }))
  await fs.writeFile(path.join(pkg, 'index.js'), 'first')
  const initial = await dependencyInventory(path.join(root, 'package-lock.json'))
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'))
  lock.packages['node_modules/missing'] = { version: '1.0.0' }
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock))
  await assert.rejects(dependencyInventory(path.join(root, 'package-lock.json')), /required dependency missing/)
  lock.packages['node_modules/missing'].optional = true
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock))
  assert.equal((await dependencyInventory(path.join(root, 'package-lock.json'))).at(-1).installed, false)
  delete lock.packages['node_modules/missing']
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lock))
  await fs.writeFile(path.join(pkg, 'index.js'), 'other')
  assert.notDeepEqual(await dependencyInventory(path.join(root, 'package-lock.json')), initial)
  await fs.symlink('index.js', path.join(pkg, 'alias.js'))
  await assert.rejects(dependencyInventory(path.join(root, 'package-lock.json')), /dependency symlink refused/)
})

test('host drift cannot reuse the frozen hardware receipt', () => {
  assert.doesNotThrow(() => verifyGraphEnvironment({ RAYON_NUM_THREADS: '1' }))
  assert.throws(() => verifyGraphEnvironment({ WARM_QGRAPH_FRONTIER: '0.5' }), /unset experimental graph/)
  const original = hostInfo()
  verifyHost(original, structuredClone(original))
  assert.throws(() => verifyHost(original, { ...original, logicalCpus: original.logicalCpus + 1 }), /host changed/)
})

test('oracle references require the complete unique frozen query identities', async t => {
  const root = await temporary(t), file = path.join(root, 'oracle.ndjson'), dataset = { name: 'fixture', queryCount: 2 }, ids = ['q0', 'q1']
  const rows = ['baseline', 'churn'].flatMap(state => FILTERS.flatMap(filter => ids.map((queryId, query) => ({ type: 'oracle', dataset: dataset.name, state, filter: filter.name, query, queryId }))))
  const write = value => fs.writeFile(file, value.map(row => JSON.stringify(row)).join('\n') + '\n')
  await write(rows); assert.equal((await loadTruth(file, dataset, ids)).size, rows.length)
  await write([...rows.slice(0, -1), rows[0]]); await assert.rejects(loadTruth(file, dataset, ids), /duplicate oracle/)
  await write(rows.slice(0, -1)); await assert.rejects(loadTruth(file, dataset, ids), /incomplete oracle/)
  await write([...rows.slice(0, -1), { ...rows.at(-1), query: 2 }]); await assert.rejects(loadTruth(file, dataset, ids), /unexpected oracle query/)
  await write([...rows.slice(0, -1), { ...rows.at(-1), queryId: 'q0' }]); await assert.rejects(loadTruth(file, dataset, ids), /oracle query identity/)
})

test('resource ownership includes descendants while siblings remain external; admission and copies fail closed', async t => {
  const root = await temporary(t), file = path.join(root, 'preflight.ndjson')
  const ps = parseProcesses('10 1 20.0 1024 node\n11 10 30.0 2048 python\n12 1 70.0 512 compiler')
  assert.equal(ps[1].rssBytes, 2048 * 1024); assert.deepEqual([...descendants(ps, [10])], [10, 11])
  assert.equal(externalCpuFraction(ps, [11], 1).fraction, .9)
  let count = 0
  const failed = await preflight(file, async () => ({ externalCpuFraction: ++count === 3 ? .20001 : .1 }), async () => {})
  assert.equal(failed.pass, false); assert.equal(count, 5); assert.equal((await lines(file)).length, 5)
  assert.equal((await preflight(path.join(root, 'invalid.ndjson'), async () => ({ externalCpuFraction: NaN }), async () => {})).pass, false)
  count = 0; const passed = await preflight(path.join(root, 'pass.ndjson'), async () => { count++; return { externalCpuFraction: .2 } }, async () => {})
  assert.equal(passed.pass, true); assert.equal(count, 10)
  await writeOnce(path.join(root, 'receipt.json'), { retained: true }); await assert.rejects(writeOnce(path.join(root, 'receipt.json'), {}), { code: 'EEXIST' })
  assert.throws(() => assertOwnedPath(root, root)); assert.throws(() => assertOwnedPath(root, path.join(root, '..', 'escape')))
  const source = path.join(root, 'source'), copy = path.join(root, 'copy'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'data'), 'exact'); await fs.writeFile(path.join(source, '.hms.lock'), 'stale')
  await cloneStore(root, source, copy); assert.equal(await fs.readFile(path.join(copy, 'data'), 'utf8'), 'exact'); await assert.rejects(fs.stat(path.join(copy, '.hms.lock')), { code: 'ENOENT' })
  await assert.rejects(cloneStore(root, source, copy), { code: 'EEXIST' })
  await fs.symlink('data', path.join(copy, 'link')); await assert.rejects(manifest(copy), /symlink/)
})

test('phase watchdog rejects external load and sustained owned memory during controller work', async t => {
  const root = await temporary(t), deadline = Date.now() + 5000
  const load = watchPhase(path.join(root, 'load.ndjson'), deadline, true, async () => ({ externalCpuFraction: .20001, processes: [], ownedPids: [] }), async () => {})
  await load.done; assert.equal(load.failure.kind, 'external-load'); assert.equal(load.signal.aborted, true); assert.throws(() => load.check(), /external-load/)
  let samples = 0
  const memory = watchPhase(path.join(root, 'memory.ndjson'), deadline, false, async () => { samples++; return { externalCpuFraction: 0, processes: [{ pid: 7, rssBytes: 8 * 1024 ** 3 + 1 }], ownedPids: [7] } }, async () => {})
  await memory.done; assert.equal(samples, 2); assert.equal(memory.failure.kind, 'rss-limit')
  const expired = watchPhase(path.join(root, 'expired.ndjson'), Date.now() - 1, true)
  await expired.done; assert.equal(expired.failure.kind, 'phase-timeout')
})

test('actual pinned selector and external metadata materialization match the harness provider', async t => {
  const root = await temporary(t), { LocalIndex } = require(path.join(sources.vectraPath, 'lib/index.js'))
  assert.equal(require(path.join(sources.vectraPath, 'package.json')).version, '0.15.0')
  const { ItemSelector } = require(path.join(sources.vectraPath, 'lib/ItemSelector.js')), { select } = require(path.join(sources.warmPath, 'vectra-selector.js'))
  const filters = [{ n: { $in: [5] } }, { n: { $nin: [5] } }, { n: { $in: ['15'] } }, { missing: { $ne: 1 } }, { n: null }, { $and: [{ n: { $gte: 4 } }, { $or: [{ n: 5 }, { s: 'a' }] }] }]
  for (const item of [{ n: 5, s: 'a' }, { n: null }, {}]) for (const filter of filters) assert.equal(select(item, filter), ItemSelector.select(item, filter))
  const directory = path.join(root, 'external'), index = new LocalIndex(directory)
  await index.createIndex({ version: 1, metadata_config: { indexed: ['eligible10'] } })
  await index.insertItem({ id: 'external', vector: [1, -0, 0], metadata: { eligible10: true, full: { text: 'retained sidecar' } } })
  const api = await provider('vectra', sources, directory)
  const stored = await api.all(), found = await api.query([1, 0, 0], { mode: 'exact' }, { eligible10: true })
  assert.deepEqual(found.hits[0].item.metadata, stored[0].metadata); assert.equal(stored[0].metadata.full.text, 'retained sidecar')
  assert.equal(Object.is(stored[0].vector[1], 0), true)
  const { importVectraIndex } = require(path.join(sources.warmPath, 'vectra.js'))
  // Import is exercised in the isolated package below; the public function must be present here.
  assert.equal(typeof importVectraIndex, 'function')
})

test('Vectra initial import commits all records together and cancels a duplicate', async t => {
  const root = await temporary(t)
  const record = i => ({ id: `item-${i}`, vector: [1, i / 100, .5], metadata: metadata(i) })
  for (const count of [99, 100, 101]) {
    const directory = path.join(root, String(count)), index = await provider('vectra', sources, directory, true)
    await index.prepareAll((function *() { for (let i = 0; i < count; i++) yield record(i) })())
    const reopened = await provider('vectra', sources, directory)
    assert.deepEqual(await reopened.all(), Array.from({ length: count }, (_, i) => record(i)))
  }
  const directory = path.join(root, 'duplicate'), index = await provider('vectra', sources, directory, true)
  await assert.rejects(index.prepareAll((function *() { for (let i = 0; i < 101; i++) yield record(i); yield record(0) })()), /already exists/)
  assert.deepEqual(await index.all(), [])
  assert.deepEqual(await (await provider('vectra', sources, directory)).all(), [])
})

test('real Vectra external metadata imports every record and survives a separate-process reopen', { timeout: 120000 }, async t => {
  const root = await temporary(t), sourceDir = path.join(root, 'source'), destination = path.join(root, 'imported')
  const { LocalIndex } = require(path.join(sources.vectraPath, 'lib/index.js')), source = new LocalIndex(sourceDir)
  await source.createIndex({ version: 1, metadata_config: { indexed: ['eligible10'] } })
  await source.beginUpdate()
  for (let i = 0; i < 12; i++) await source.insertItem({ id: `item-${String(i).padStart(2, '0')}`, vector: [1, i === 0 ? -0 : i / 20, .5], metadata: { eligible10: i < 10, extra: { ordinal: i } } })
  await source.endUpdate()
  const child = `const assert=require('node:assert/strict'),path=require('node:path');
    (async()=>{ const [phase,vectraPath,warmPath,sourceDir,destination]=process.argv.slice(1);
      const {LocalIndex}=require(path.join(vectraPath,'lib/index.js'));
      const {VectraMigrationIndex,importVectraIndex}=require(path.join(warmPath,'vectra.js'));
      const source=new LocalIndex(sourceDir); await source.getIndexStats();
      const records=await source.listItems(); assert(records.some(item=>item.metadataFile));
      const expected=[]; for(const item of records){ const metadata=item.metadataFile?source.codec.deserializeMetadata(await source.storage.readFile(path.join(source.folderPath,item.metadataFile))):item.metadata; expected.push({id:item.id,vector:Array.from(item.vector),metadata}); }
      const index=phase==='import'?(await importVectraIndex(source,{path:destination,dimensions:1024,embeddingSpace:{model:'synthetic',revision:'import-v1',dimensions:3}})).index:await VectraMigrationIndex.open({path:destination});
      const found=[]; let from,revision; do { const page=await index.listItems({from,limit:3,includeVectors:true,ifRevision:revision}); revision??=page.revision; assert.equal(page.revision,revision); found.push(...page.items); from=page.nextFrom??undefined; } while(from!==undefined);
      found.sort((a,b)=>a.id.localeCompare(b.id)); expected.sort((a,b)=>a.id.localeCompare(b.id)); assert.equal(found.length,expected.length);
      for(let i=0;i<found.length;i++){ assert.equal(found[i].id,expected[i].id); assert.deepEqual(found[i].metadata,expected[i].metadata); assert(found[i].vector.every((v,j)=>Object.is(v,expected[i].vector[j]))); }
      const a=await source.queryItems([1,0,.5],'',10,{eligible10:true},false),b=await index.queryItems([1,0,.5],{k:10,filter:{eligible10:true},mode:'exact'}); assert.deepEqual(b.results.map(hit=>hit.item.id).sort(),a.map(hit=>hit.item.id).sort());
      if(phase==='import'){ const item=found[0]; await index.beginUpdate(); await index.upsertItem({id:item.id,vector:[1,2,3],metadata:{}}); await index.cancelUpdate(); assert.deepEqual(await index.getItem(item.id),item); await assert.rejects(index.applyBatch([{op:'delete',id:item.id},{op:'insert',record:item},{op:'insert',record:item}])); assert.deepEqual(await index.getItem(item.id),item); await index.flush(); }
    })().catch(error=>{console.error(error.stack);process.exitCode=1})`
  for (const phase of ['import', 'reopen']) await exec(process.execPath, ['-e', child, phase, sources.vectraPath, sources.warmPath, sourceDir, destination], { timeout: 60000 })
})

test('monitor observes owned child RSS and stops a process at its fixed deadline', { timeout: 10000 }, async t => {
  const root = await temporary(t), worker = path.join(root, 'owned-worker.mjs')
  await fs.writeFile(worker, "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.send({type:'stage',name:'descendant',childPid:child.pid}); setTimeout(()=>{child.kill('SIGTERM');process.disconnect();},1400); child.on('exit',()=>{});\n")
  const monitored = await runMonitored({ worker, job: { output: path.join(root, 'unused'), development: true }, jobFile: path.join(root, 'job.json'), receipt: path.join(root, 'receipt.json'), hostFile: path.join(root, 'host.ndjson'), deadline: Date.now() + 5000 })
  assert.equal(monitored.complete, true)
  const descendant = monitored.events.find(event => event.childPid).childPid
  assert.ok(monitored.peakRssByPid[descendant] > 0)
  assert.ok((await lines(path.join(root, 'host.ndjson'))).some(sample => sample.ownedPids.includes(descendant)))
  await fs.writeFile(worker, "setInterval(()=>{},1000)\n")
  const stopped = await runMonitored({ worker, job: { output: path.join(root, 'unused2'), development: true }, jobFile: path.join(root, 'job2.json'), receipt: path.join(root, 'receipt2.json'), hostFile: path.join(root, 'host2.ndjson'), deadline: Date.now() + 100 })
  assert.equal(stopped.complete, false); assert.equal(stopped.resourceQualified, false); assert.equal(stopped.stop.kind, 'phase-timeout'); assert.equal(stopped.exit.signal, 'SIGKILL')
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort({ kind: 'external-load' }), 100)
  const aborted = await runMonitored({ worker, job: { output: path.join(root, 'unused3'), development: true }, jobFile: path.join(root, 'job3.json'), receipt: path.join(root, 'receipt3.json'), hostFile: path.join(root, 'host3.ndjson'), deadline: Date.now() + 5000, signal: controller.signal })
  clearTimeout(abortTimer)
  assert.equal(aborted.complete, false); assert.equal(aborted.stop.kind, 'phase-resource'); assert.equal(aborted.stop.reason.kind, 'external-load'); assert.equal(aborted.exit.signal, 'SIGKILL')
})

test('spontaneous worker exit cleans its residual process group and cannot qualify', { timeout: 10000 }, async t => {
  const root = await temporary(t), worker = path.join(root, 'orphan-worker.mjs')
  await fs.writeFile(worker, "import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.unref(); process.send({type:'stage',name:'leave-owned-child',childPid:child.pid},()=>process.exit(0));\n")
  const result = await runMonitored({ worker, job: { output: path.join(root, 'unused'), development: true }, jobFile: path.join(root, 'job.json'), receipt: path.join(root, 'receipt.json'), hostFile: path.join(root, 'host.ndjson'), deadline: Date.now() + 5000 })
  assert.equal(result.exit.code, 0); assert.equal(result.complete, false); assert.equal(result.resourceQualified, false)
  assert.equal(result.stop.kind, 'unexpected-owned-descendants')
  assert.equal(result.descendantCleanup.processGroup, result.pid); assert.equal(result.descendantCleanup.residualGroupFound, true); assert.equal(result.descendantCleanup.signal, 'SIGKILL')
  const childPid = result.events.find(event => event.childPid).childPid
  let status
  try { status = (await exec('/bin/ps', ['-p', String(childPid), '-o', 'stat='])).stdout.trim() }
  catch (error) { assert.equal(error.code, 1); status = error.stdout.trim() }
  assert.ok(!status || status.startsWith('Z'), `owned descendant remains active: ${status}`)
})

test('actual engines pass tiny oracle, filter, churn, separate-process reopen and controlled interruption checks', { timeout: 120000 }, async t => {
  const root = await temporary(t), packagePath = path.join(root, 'warm-package'); await fs.mkdir(packagePath)
  for (const file of ['index.js', 'vectra.js', 'vectra-selector.js']) await fs.copyFile(path.join(sources.warmPath, file), path.join(packagePath, file))
  const nativeAddon = path.join(packagePath, 'warm-sdk.node'); await fs.copyFile(sources.nativeAddon, nativeAddon)
  const config = path.join(root, 'config.json'); await writeOnce(config, { ...sources, warmPath: packagePath, nativeAddon, inputIdentity: 'synthetic-development-only' })
  const count = 24, dimensions = 3, queryCount = 3
  const vectors = Array.from({ length: count }, (_, i) => [i % 2 ? -1 : 1, i === 0 ? -0 : i / 10, .5]), queries = [[1, 0, .1], [-1, 0, .1], [.1, 1, .1]]
  for (const [name, values] of [['corpus', vectors.flat()], ['queries', queries.flat()]]) { const bytes = Buffer.alloc(values.length * 4); values.forEach((value, i) => bytes.writeFloatLE(value, i * 4)); await fs.writeFile(path.join(root, `${name}.f32`), bytes) }
  const dataset = { name: 'synthetic-only', rows: count, dimensions, queryCount, corpus: path.join(root, 'corpus.f32'), queries: path.join(root, 'queries.f32'), embeddingModel: 'synthetic', embeddingRevision: 'test-v1' }
  let serial = 0
  const run = async (job, killBoundary = null) => {
    const id = `${serial++}-${job.engine ?? 'oracle'}-${job.action}`, output = path.join(root, `${id}.ndjson`)
    const result = await runMonitored({ worker: path.join(HERE, 'vector-worker.mjs'), job: { ...job, dataset, config, output, development: true }, jobFile: path.join(root, `${id}.json`), receipt: path.join(root, `${id}-receipt.json`), hostFile: path.join(root, 'host.ndjson'), deadline: Date.now() + 30000, killBoundary })
    const rows = await lines(output)
    assert.ok(result.complete || result.stop?.kind === 'planned-process-interruption', JSON.stringify(rows.filter(row => row.type === 'worker-error')))
    for (const row of rows) { if (row.type === 'query') { assert.equal(row.correctness, true, JSON.stringify(row)); assert.equal(row.elapsedMs, null) }; if (row.type === 'graph-unavailable' || row.type === 'crash-recovery') assert.equal(row.pass, true, JSON.stringify(row)) }
    return { result, rows, output }
  }
  const oracle = (await run({ action: 'oracle' })).output
  for (const engine of ['vectra', 'warm']) {
    const store = path.join(root, engine), arm = ARMS.find(arm => arm.engine === engine && arm.mode === 'exact')
    const prepared = await run({ action: 'prepare', engine, store })
    assert.equal(prepared.rows.find(row => row.name === 'ingest-acknowledgements').value.batchSize, engine === 'vectra' ? count : 100)
    const validation = prepared.rows.find(row => row.name === 'validate-full-store').value
    assert.equal(validation.sourceZeroCanonicalizations, 0)
    const reopened = await run({ action: 'validate', engine, store })
    assert.equal(reopened.rows.find(row => row.name === 'separate-process-reopen-validation').value.sourceZeroCanonicalizations, engine === 'vectra' ? 1 : 0)
    const quality = await run({ action: 'quality', engine, arm, store, oracle }); assert.equal(quality.rows.filter(row => row.type === 'query').length, queryCount * 4)
    if (engine === 'warm') await run({ action: 'unavailable', engine, arm: ARMS[2], store, oracle })
    const churnStore = path.join(root, `${engine}-churn`); await cloneStore(root, store, churnStore)
    await run({ action: 'churn', engine, arm, store: churnStore, oracle, writeStyle: 'batch' }); await run({ action: 'reopen', engine, arm, store: churnStore, oracle, state: 'churn' })
    for (const boundary of ['operation-return-before-controller-ack', 'ack-before-flush', 'after-flush']) {
      const crashStore = path.join(root, `${engine}-${boundary}`); await cloneStore(root, store, crashStore)
      const stopped = await run({ action: 'crash-write', engine, store: crashStore }, boundary)
      if (engine === 'vectra' && boundary === 'after-flush') assert.ok(stopped.result.events.some(event => event.boundary === 'after-flush-unsupported'))
      else { assert.equal(stopped.result.stop.boundary, boundary); const recovered = await run({ action: 'crash-reopen', engine, store: crashStore, boundary }); assert.equal(recovered.rows.find(row => row.type === 'crash-recovery').state, 'new') }
    }
  }
  const highRecallStore = path.join(root, 'warm-high-recall')
  await run({ action: 'prepare', engine: 'warm', highRecall: true, store: highRecallStore })
  assert.equal((await readJson(path.join(highRecallStore, 'vectra-migration.json'))).highRecall, true)
  await run({ action: 'validate', engine: 'warm', store: highRecallStore })
  const { LocalIndex } = require(path.join(sources.vectraPath, 'lib/index.js')), source = new LocalIndex(path.join(root, 'vectra'))
  await source.getIndexStats()
  const { importVectraIndex } = require(path.join(packagePath, 'vectra.js'))
  const { index: imported } = await importVectraIndex(source, { path: path.join(root, 'migration'), dimensions: 1024, embeddingSpace: { model: 'synthetic', revision: 'test-v1', dimensions } })
  const received = (await source.listItems())[0], retrieved = await imported.getItem(received.id)
  assert.ok(received.vector.every((value, i) => Object.is(value, retrieved.vector[i])))
  await imported.beginUpdate(); await imported.upsertItem({ id: received.id, vector: [1, 2, 3], metadata: {} }); await imported.cancelUpdate()
  assert.deepEqual(await imported.getItem(received.id), retrieved)
  await assert.rejects(imported.applyBatch([{ op: 'delete', id: received.id }, { op: 'insert', record: received }, { op: 'insert', record: received }]))
  assert.deepEqual(await imported.getItem(received.id), retrieved)
  assert.equal(await sha256(nativeAddon), await sha256(sources.nativeAddon))
})

test('failed frozen-phase admission is recorded once without running jobs', async t => {
  const root = await temporary(t), freeze = path.join(root, 'freeze.json')
  await fs.writeFile(freeze, '{}\n')
  const freezeHash = await sha256(freeze)
  await writeOnce(path.join(root, 'freeze-receipt.json'), { freezeHash })
  const grant = path.join(root, 'grant.json')
  await writeOnce(grant, { freezeHash, phase: 'preparation', approved: true, coordinator: 'synthetic-test', approvedAtUtc: '2026-11-02T00:00:00Z' })
  await assert.rejects(runPhase(root, 'preparation', grant))
  assert.equal((await readJson(path.join(root, 'preparation-finished.json'))).complete, false)
  await assert.rejects(fs.stat(path.join(root, 'results')), { code: 'ENOENT' })
  await assert.rejects(runPhase(root, 'preparation', grant), { code: 'EEXIST' })
})

test('measurement admission rejects incomplete preparation and graph availability failures', async t => {
  const root = await temporary(t), dataset = { name: 'tiny', rows: 24, queryCount: 2 }, entries = []
  const add = async (arm, action, rows) => {
    const output = path.join(root, `${entries.length}.ndjson`)
    await fs.writeFile(output, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    entries.push({ id: String(entries.length), job: { dataset, arm, action, output }, result: { complete: true } })
  }
  for (const arm of ARMS) {
    const rows = arm.mode === 'graph' ? [{ type: 'graph-unavailable', pass: true }] : FILTERS.flatMap(filter => [0, 1].map(query => ({ type: 'query', query, filter: filter.name, hits: [{ ordinal: query }], eligibleCount: 1, oracleRecall: 1, qrel: null, correctness: true })))
    await add(arm, arm.mode === 'graph' ? 'unavailable' : 'quality', rows)
  }
  assert.equal((await preparationGate({ datasets: [dataset] }, entries)).pass, true)
  const rows = await lines(entries[1].job.output); rows[1] = rows[0]
  await fs.writeFile(entries[1].job.output, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  assert.equal((await preparationGate({ datasets: [dataset] }, entries)).pass, false)
  await fs.writeFile(entries[1].job.output, rows.map((row, i) => JSON.stringify(i === 1 ? { ...row, query: 1 } : row)).join('\n') + '\n')
  await fs.writeFile(entries[2].job.output, JSON.stringify({ type: 'graph-unavailable', pass: false }) + '\n')
  assert.equal((await preparationGate({ datasets: [dataset] }, entries)).pass, false)
})

test('summary rejects poor timed graph quality and incomplete static or lifecycle identities', async t => {
  const root = await temporary(t), dataset = { name: 'scifact', rows: 4096, queryCount: 2 }
  const build = async (name, defect) => {
    const dir = path.join(root, name); await fs.mkdir(dir)
    await writeOnce(path.join(dir, 'freeze.json'), { datasets: [dataset] })
    const receipts = { preparation: [], measurement: [] }
    const add = async (phase, arm, action, rows, repetition) => {
      const output = path.join(dir, `${phase}-${receipts[phase].length}.ndjson`)
      await fs.writeFile(output, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      receipts[phase].push({ job: { dataset, arm, engine: arm.engine, action, repetition, output } })
    }
    const row = (query, filter, extra = {}) => ({ type: 'query', query, filter, hits: [{ ordinal: query }], correctness: true, eligibleCount: 1, oracleRecall: 1, qrel: { ndcg10: 1, recall10: 1, eligibleJudgments: 1 }, route: 'fullGraph', ...extra })
    for (const arm of ARMS) {
      const staticRows = FILTERS.flatMap(filter => [0, 1].map(query => row(query, filter.name)))
      if (defect === 'static-duplicate' && arm.name === 'warm-graph-128') staticRows[1] = { ...staticRows[0] }
      await add('preparation', arm, 'quality', staticRows)
      const lifecycle = FILTERS.flatMap(filter => ['before-maintenance', 'after-maintenance', 'after-flush-separate-process-reopen-and-maintenance'].flatMap(phase => [0, 1].map(query => row(query, filter.name, { phase }))))
      if (defect === 'lifecycle-duplicate' && arm.name === 'warm-exact') lifecycle[1] = { ...lifecycle[0] }
      await add('measurement', arm, 'churn', lifecycle)
      for (let repetition = 0; repetition < 3; repetition++) {
        const timing = FILTERS.flatMap(filter => (filter.name === 'all' ? [0, 1] : [0]).map(query => row(query, filter.name, { role: 'timing', repetition, elapsedMs: arm.name === 'vectra-exact' ? 2 : 1 })))
        if (defect === 'timed-zero' && arm.name === 'warm-graph-128' && repetition === 1) for (const item of timing.filter(item => item.filter === 'all')) { item.hits = [{ ordinal: item.query + 10 }]; item.oracleRecall = 0 }
        await add('measurement', arm, 'timing', timing, repetition)
      }
    }
    for (const phase of ['preparation', 'measurement']) await writeOnce(path.join(dir, `${phase}-finished.json`), { complete: true, receipts: receipts[phase] })
    return summarize(dir)
  }
  const valid = await build('valid', null); assert.equal(valid.globallyComplete, true); assert.equal(valid.performanceClaimPermitted, true)
  const timed = await build('timed', 'timed-zero'); assert.equal(timed.globallyComplete, false)
  assert.equal(timed.timing.find(item => item.arm === 'warm-graph-128' && item.filter === 'all' && item.repetition === 1).quality.pass, false)
  assert.equal(timed.advantage.find(item => item.arm === 'warm-graph-128' && item.filter === 'all').qualified, false)
  assert.equal((await build('static', 'static-duplicate')).globallyComplete, false)
  assert.equal((await build('lifecycle', 'lifecycle-duplicate')).globallyComplete, false)
})

test('partial summary retains errors and cannot claim an advantage', async t => {
  const root = await temporary(t)
  await writeOnce(path.join(root, 'freeze.json'), { datasets: [{ name: 'tiny', rows: 24, queryCount: 3 }] })
  const result = await summarize(root)
  assert.equal(result.globallyComplete, false); assert.equal(result.performanceClaimPermitted, false)
  assert.ok(result.quality.every(point => !point.pass)); assert.ok(result.lifecycleQuality.every(point => !point.pass))
  await assert.rejects(summarize(root), { code: 'EEXIST' })
})
