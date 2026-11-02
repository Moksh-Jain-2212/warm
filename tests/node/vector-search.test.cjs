// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')
const { WarmMemorySystem } = require('../../index.js')
const config = { embeddingModel: 'synthetic', embeddingRevision: 'v1', embeddingDimensions: 4 }

test('projected candidate configuration rejects partial and invalid quality settings', () => {
  for (const partial of [{ vectorCandidateDimensions: 2 }, { vectorRerankCandidates: 10 }]) {
    assert.throws(() => new WarmMemorySystem(1024, undefined, { ...config, ...partial }), /supplied together/)
  }
  for (const [name, limit] of [['vectorCandidateDimensions', 65536], ['vectorRerankCandidates', 4096]]) {
    for (const value of [-1, 0, 0.5, NaN, Infinity, limit + 1]) {
      assert.throws(() => new WarmMemorySystem(1024, undefined, {
        ...config, vectorCandidateDimensions: 2, vectorRerankCandidates: 10, [name]: value,
      }), /must be an integer/)
    }
  }
  assert.throws(() => new WarmMemorySystem(1024, undefined, {
    ...config, vectorCandidateDimensions: 5, vectorRerankCandidates: 10,
  }), /embedding space dimensions/)
})

test('vector API preserves full scores, preselection, input validation and reopen behavior', () => {
  const directory = mkdtempSync(join(tmpdir(), 'warm-node-vectors-'))
  try {
    for (const stage of ['write', 'reopen']) {
      const source = `
        const assert = require('node:assert/strict');
        const { WarmMemorySystem } = require('./index.js');
        (async () => {
          const warm = new WarmMemorySystem(1024, process.argv[1], {
            ...${JSON.stringify(config)}, vectorCandidateDimensions: 2, vectorRerankCandidates: 1,
          });
          if (process.argv[2] === 'write') {
            await warm.memorizeDocuments([
              { id: 'excluded', text: 'retained excluded', sourceUri: 'other', metadata: { group: 'other' }, embeddings: [[1, 0, 0, 0]] },
              { id: 'best', text: 'retained best', version: 'v1', sourceUri: 'selected', metadata: { group: 'keep' }, embeddings: [[-0.2, 1, 0, 0]] },
              { id: 'second', text: 'retained second', sourceUri: 'selected', metadata: { group: 'keep' }, embeddings: [[-1, 1, 0, 0]] },
            ]);
          }
          const query = [1, 0, 0, 0];
          const expected = await warm.searchVectors(query, 2, { mode: 'exact', filter: { group: 'keep' } });
          for (const filter of [{ filter: { group: 'keep' } }, { sourceUri: 'selected' }, { documentIds: ['best', 'second'] }]) {
            const hits = await warm.searchVectors(query, 2, { mode: 'graph', ...filter });
            assert.deepEqual(hits, expected);
            assert.deepEqual(hits.map(hit => hit.documentId), ['best', 'second']);
            assert.ok(hits.every(hit => hit.score < 0 && hit.score === hit.semanticScore));
            assert.equal(hits[0].text, 'retained best');
            assert.equal(hits[0].version, 'v1');
          }
          assert.deepEqual(await warm.searchVectors(query, 2, { documentIds: [] }), []);
          for (const k of [-1, 0, 1.5, NaN, Infinity, 1001]) await assert.rejects(warm.searchVectors(query, k), /k must be an integer/);
          for (const ef of [-1, 0, 1.5, NaN, Infinity, 4097]) await assert.rejects(warm.searchVectors(query, 1, { ef }), /ef must be an integer/);
          for (const minScore of [-1.01, 1.01, NaN, Infinity]) await assert.rejects(warm.searchVectors(query, 1, { minScore }), /minScore/);
          for (const vector of [[1], [NaN, 0, 0, 1], [Infinity, 0, 0, 1]]) await assert.rejects(warm.searchVectors(vector, 1));
          await assert.rejects(warm.searchVectors(query, 1, { mode: 'unknown' }), /mode must be/);
          await assert.rejects(warm.searchVectors(query, 1, { filter: [] }), /filter/);
          assert.equal((await warm.searchVectors(query, 1, { mode: 'exact' }))[0].documentId, 'excluded');
          await warm.flush();
        })().catch(error => { console.error(error); process.exit(1); });
      `
      const result = spawnSync(process.execPath, ['-e', source, directory, stage], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 60000,
      })
      assert.equal(result.status, 0, result.stderr || result.stdout)
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
