// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { WarmMemorySystem } = require('../../index.js')
const config = { vectorRecords: true, embeddingModel: 'records', embeddingRevision: 'v1', embeddingDimensions: 3 }
const record = id => ({ id, vector: [-0, 0.1, Number.MIN_VALUE], metadata: { group: 'a', $warm_vector_record: 'user-owned' } })

test('native record API preserves f64 bits, explicit nulls and complete eligibility across reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'warm-native-records-'))
  try {
    for (const stage of ['write', 'reopen']) {
      const source = `
        const assert = require('node:assert/strict');
        const { WarmMemorySystem } = require('./index.js');
        (async () => {
          const warm = new WarmMemorySystem(256, process.argv[1], ${JSON.stringify(config)});
          if (process.argv[2] === 'write') {
            const item = {id:'a',vector:[-0,0.1,Number.MIN_VALUE],metadata:{group:'a',$warm_vector_record:'user-owned'}};
            const committed = await warm.mutateVectorRecords([
              {op:'insert',record:item}, {op:'upsert',record:item}, {op:'delete',id:'a'}, {op:'insert',record:item},
              {op:'insert',record:{id:'b',vector:[0,0,1],metadata:{group:'b'}}}, {op:'delete',id:'missing'},
            ]);
            assert.deepEqual(committed.outcomes.map(o => [o.created,o.deleted]), [[true,undefined],[false,undefined],[undefined,true],[true,undefined],[true,undefined],[undefined,false]]);
            await warm.flush();
          }
          const first = await warm.listVectorRecords({limit:1,includeVectors:false});
          assert.equal(first.records[0].id, 'a');
          assert.equal(Object.hasOwn(first.records[0],'vector'), false);
          assert.equal(first.nextFrom, 'b');
          const last = await warm.listVectorRecords({from:first.nextFrom,limit:1,ifRevision:first.revision});
          assert.equal(last.records[0].id, 'b');
          assert.equal(last.nextFrom, null);
          const read = await warm.getVectorRecord('a',{ifRevision:first.revision});
          assert.ok(Object.is(read.record.vector[0],-0));
          assert.ok(Object.is(read.record.vector[1],0.1));
          assert.ok(Object.is(read.record.vector[2],Number.MIN_VALUE));
          assert.equal(read.record.metadata.$warm_vector_record,'user-owned');
          assert.equal((await warm.getVectorRecord('missing')).record, null);
          const found = await warm.queryVectorRecords([0,1,0],1,{documentIds:['b'],ifRevision:first.revision});
          assert.equal(found.results[0].item.id, 'b');
          assert.equal(found.diagnostics.route, 'filteredExact');
          assert.deepEqual((await warm.queryVectorRecords([0,1,0],1,{documentIds:[]})).results, []);
          assert.equal((await warm.queryVectorRecords([0,1,0],1)).results[0].item.id,'a');
          assert.equal(warm.vectorCount, 0);
          await warm.maintainIndices();
        })().catch(error => { console.error(error); process.exit(1); });
      `
      const result = spawnSync(process.execPath, ['-e', source, directory, stage], { cwd: process.cwd(), encoding: 'utf8', timeout: 60000 })
      assert.equal(result.status, 0, result.stderr || result.stdout)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('native revisions, staged preconditions and type/range failures remain atomic', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'warm-native-record-bounds-'))
  try {
    const warm = new WarmMemorySystem(256, directory, config)
    const empty = await warm.listVectorRecords()
    const ops = [{ op: 'insert', record: record('a') }]
    await assert.rejects(warm.mutateVectorRecords([...ops, ...ops]), /absent ID/)
    assert.deepEqual(await warm.listVectorRecords(), empty)
    for (const invalid of [null, {}, [], [{ op: 'unknown', record: record('a') }], [{ op: 'insert', record: { ...record('a'), metadata: [] } }]]) {
      await assert.rejects(async () => warm.mutateVectorRecords(invalid))
    }
    for (const vector of [[0,0,0], [1], [NaN,1,0], [Infinity,1,0]]) {
      await assert.rejects(async () => warm.mutateVectorRecords([{op:'insert',record:{...record('a'),vector}}]))
      await assert.rejects(async () => warm.queryVectorRecords(vector,1))
    }
    for (const limit of [0,0.5,1001,NaN,Infinity]) await assert.rejects(warm.listVectorRecords({limit}), /integer/)
    for (const k of [0,0.5,1001,NaN,Infinity]) await assert.rejects(warm.queryVectorRecords([0,1,0],k), /integer/)
    for (const ef of [0,0.5,4097,NaN,Infinity]) await assert.rejects(warm.queryVectorRecords([0,1,0],1,{ef}), /integer/)
    for (const minScore of [-1.01,1.01,NaN,Infinity]) await assert.rejects(warm.queryVectorRecords([0,1,0],1,{minScore}), /minScore/)
    await assert.rejects(warm.queryVectorRecords([0,1,0],1,{mode:'unknown'}), /mode/)
    await assert.rejects(warm.queryVectorRecords([0,1,0],1,{documentIds:['a','a']}), /unique/)
    const committed = await warm.mutateVectorRecords(ops, {ifRevision:empty.revision})
    await assert.rejects(warm.getVectorRecord('a',{ifRevision:empty.revision}), /vector record revision conflict/)
    await assert.rejects(warm.mutateVectorRecords([{op:'delete',id:'a'}],{ifRevision:empty.revision}), /vector record revision conflict/)
    assert.equal((await warm.getVectorRecord('a',{ifRevision:committed.revision})).record.id,'a')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
