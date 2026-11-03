// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exec, readJson, runMonitored } from '../../public/vectra_comparison/vector-receipts.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../../..')
test('update diagnostic validates a synthetic graph across mutation and separate-process reopen', { timeout: 180000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'warm-update-diagnostic-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const packagePath = path.join(root, 'package'); await fs.mkdir(packagePath)
  for (const name of ['index.js', 'vectra.js', 'vectra-selector.js', 'warm-sdk.node']) await fs.copyFile(path.join(repo, name), path.join(packagePath, name))
  const rows = 4096, dimensions = 100, queryCount = 3, corpus = path.join(root, 'corpus.f32'), queries = path.join(root, 'queries.f32')
  const bytes = Buffer.alloc(rows * dimensions * 4)
  for (let i = 0; i < rows * dimensions; i++) bytes.writeFloatLE(Math.sin((Math.floor(i / dimensions) + 1) * (i % dimensions + 1)) * .5, i * 4)
  await fs.writeFile(corpus, bytes); await fs.writeFile(queries, bytes.subarray(0, queryCount * dimensions * 4))
  const store = path.join(root, 'store')
  const create = `const fs=require('node:fs'),path=require('node:path');
    (async()=>{const [pkg,store,corpus,rows]=process.argv.slice(1),{VectraMigrationIndex}=require(path.join(pkg,'vectra.js'));
    const index=await VectraMigrationIndex.create({path:store,dimensions:1024,embeddingSpace:{model:'synthetic',revision:'test',dimensions:100}}), data=fs.readFileSync(corpus);
    for(let offset=0;offset<+rows;offset+=100){const ops=[];for(let i=offset;i<Math.min(+rows,offset+100);i++){const vector=Array.from({length:100},(_,j)=>data.readFloatLE((i*100+j)*4));ops.push({op:'insert',record:{id:'row-'+String(i).padStart(8,'0'),vector,metadata:{ordinal:i,bucket100:i%100,eligible10:i%100<10,eligible1:i%100===0,epoch:0}}})}await index.applyBatch(ops)}await index.flush()})().catch(e=>{console.error(e.stack);process.exitCode=1})`
  await exec(process.execPath, ['-e', create, packagePath, store, corpus, String(rows)], { timeout: 90000 })
  const dataset = { name: 'synthetic', rows, dimensions, queryCount, corpus, queries }
  for (const action of ['update', 'reopen']) {
    const stem = path.join(root, action), output = `${stem}.ndjson`
    const receipt = await runMonitored({ worker: path.join(here, 'update-worker.mjs'), job: { development: true, action, package: packagePath, addon: path.join(packagePath, 'warm-sdk.node'), store, dataset, ef: 128, degree: 64, buildEf: 256, output }, jobFile: `${stem}-job.json`, receipt: `${stem}-receipt.json`, hostFile: `${stem}-host.ndjson`, deadline: Date.now() + 90000 })
    if (!receipt.complete) throw new Error(`${JSON.stringify(receipt)}\n${await fs.readFile(`${stem}-receipt.json.stderr.log`, 'utf8')}\n${await fs.readFile(output, 'utf8')}`)
    const lines = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(lines.at(-1), { type: 'complete', action })
    assert.equal((await readJson(`${stem}-receipt.json`)).resourceQualified, true)
  }
})
