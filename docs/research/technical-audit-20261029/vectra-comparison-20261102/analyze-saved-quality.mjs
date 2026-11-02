// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const recorded = JSON.parse(await fs.readFile(path.join(here, 'user-stop-receipt.json'), 'utf8'))
const root = '/Volumes/A/.hms-bench-cache/vectra-comparison-20261102-frozen/results'
const expectations = new Map(recorded.trees.results.files.map(file => [file.path, file.sha256]))
const cache = new Map()
async function load(name) {
  if (cache.has(name)) return cache.get(name)
  const file = path.join(root, name), bytes = await fs.readFile(file)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectations.get(name), `saved result changed: ${name}`)
  const rows = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  cache.set(name, rows)
  return rows
}
const sets = [
  { dataset: 'glove-10000', oracle: 'preparation-0020-glove-10000-oracle-oracle.ndjson', exact: 'preparation-0026-glove-10000-warm-quality.ndjson', arms: [['128','preparation-0027-glove-10000-warm-quality.ndjson'],['256','preparation-0028-glove-10000-warm-quality.ndjson'],['512','preparation-0029-glove-10000-warm-quality.ndjson']] },
  { dataset: 'glove-100000', oracle: 'preparation-0030-glove-100000-oracle-oracle.ndjson', exact: 'preparation-0036-glove-100000-warm-quality.ndjson', arms: [['128','preparation-0037-glove-100000-warm-quality.ndjson'],['256','preparation-0038-glove-100000-warm-quality.ndjson']] },
]
const reports=[]
for(const spec of sets){
  const truthRows=(await load(spec.oracle)).filter(row=>row.type==='oracle'&&row.state==='baseline'&&row.filter==='all')
  const exactRows=(await load(spec.exact)).filter(row=>row.type==='query'&&row.filter==='all')
  assert.equal(truthRows.length,1000);assert.equal(exactRows.length,1000)
  const truth=new Map(truthRows.map(row=>[row.query,row])), exact=new Map(exactRows.map(row=>[row.query,row]))
  assert.equal(truth.size,1000);assert.equal(exact.size,1000)
  const total=rows=>{const sum=Math.round(rows.reduce((a,b)=>a+b,0)*10);return {mean:sum/(10*rows.length),worst:Math.min(...rows),below90:rows.filter(x=>x<.9).length,below100:rows.filter(x=>x<1).length}}
  const recall=(hits,expected)=>{const ids=new Set(hits.map(x=>x.ordinal));return expected.filter(x=>ids.has(x.ordinal)).length/expected.length}
  const baseline=[]
  for(let q=0;q<1000;q++){const a=exact.get(q),b=truth.get(q);assert(a?.correctness&&a.route==='fullExact'&&b);assert.equal(a.hits.length,10);assert.equal(b.hits.length,10);baseline.push(recall(a.hits,b.hits))}
  for(const [ef,file] of spec.arms){
    const rows=(await load(file)).filter(row=>row.type==='query'&&row.filter==='all')
    assert.equal(rows.length,1000);assert.equal(new Set(rows.map(row=>row.query)).size,1000)
    const oracle=[],warm=[],worst=[]
    for(const row of rows){const t=truth.get(row.query),e=exact.get(row.query);assert(t&&e&&row.correctness&&row.route==='fullGraph');const o=recall(row.hits,t.hits),w=recall(row.hits,e.hits);assert.equal(o,row.oracleRecall);oracle.push(o);warm.push(w);if(o<.9)worst.push({query:row.query,queryId:row.queryId,oracleRecall:o,warmExactRecall:w})}
    reports.push({dataset:spec.dataset,ef:Number(ef),queries:rows.length,oracle:total(oracle),warmExact:total(warm),exactVsOracle:total(baseline),worstQueries:worst.sort((a,b)=>a.oracleRecall-b.oracleRecall||a.query-b.query).slice(0,10),completeWorker:!(spec.dataset==='glove-100000'&&ef==='256'),sourceSha256:expectations.get(file),exactSha256:expectations.get(spec.exact),oracleSha256:expectations.get(spec.oracle)})
  }
}
console.log(JSON.stringify({scope:'Offline analysis of already saved, hash-verified unfiltered query outputs; no search, new tests, model or timing.',freezeHash:recorded.freezeHash,stopReceiptSha256:createHash('sha256').update(await fs.readFile(path.join(here,'user-stop-receipt.json'))).digest('hex'),reports},null,2))
