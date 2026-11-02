const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const temporary = mkdtempSync(join(tmpdir(), 'warm-package-'))
// Invoke npm's JavaScript CLI directly; Windows cannot execFile a .cmd shim.
const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('Run this check with npm run test:package')
try {
  const [packed] = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { encoding: 'utf8' }))
  console.log(`Packed artifact: ${packed.filename}; integrity=${packed.integrity}`)
  assert.ok(packed.files.some(file => file.path.endsWith('.node')), 'build the native binding before testing the tarball')
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true }))
  execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--omit=optional', '--no-audit', join(temporary, packed.filename)], { cwd: temporary, stdio: 'pipe' })
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    (async () => {
      const cjs = require('warm-sdk');
      const esm = await import('warm-sdk');
      assert.equal(cjs.WarmMemorySystem, esm.WarmMemorySystem);
      const { DocumentMemory } = await import('warm-sdk/semantic');
      const warm = new cjs.WarmMemorySystem(4096, './store');
      const memory = new DocumentMemory(warm);
      await memory.memorize({ id: 'manual', text: 'Backups protect stored documents.', sourceUri: 'manual.md' });
      assert.equal((await memory.search('backups'))[0].sourceUri, 'manual.md');
      await memory.flush();
      const { VectraMigrationIndex } = require('warm-sdk/vectra');
      assert.equal(VectraMigrationIndex, (await import('warm-sdk/vectra')).VectraMigrationIndex);
      const vectors = await VectraMigrationIndex.create({
        path: './vector-store',
        embeddingSpace: { model: 'package-fixture', revision: '1', dimensions: 3 },
        indexedMetadata: ['group'],
      });
      await vectors.insertItem({ id: 'original', vector: [1 + 2 ** -40, -0, Number.MIN_VALUE], metadata: { group: 'visible', extra: 'preserved' } });
      const result = await vectors.queryItems([1, 0, 0], { k: 1, filter: { group: 'visible' } });
      assert.equal(result.results[0].item.id, 'original');
      assert.equal(result.results[0].item.metadata.extra, 'preserved');
      assert.equal(result.results[0].item.vector[0], 1 + 2 ** -40);
      assert.ok(Object.is(result.results[0].item.vector[1], -0));
      assert.equal(result.results[0].item.vector[2], Number.MIN_VALUE);
      assert.deepEqual((await vectors.queryItems([1, 0, 0], { filter: { extra: 'preserved' } })).results, []);
      await vectors.flush();
    })().catch(e => { console.error(e); process.exitCode = 1; });
  `], { cwd: temporary, stdio: 'inherit', timeout: 60000 })
  console.log('Packed CommonJS, ESM, native binding, document and vector migration APIs passed')
} finally { rmSync(temporary, { recursive: true, force: true }) }
