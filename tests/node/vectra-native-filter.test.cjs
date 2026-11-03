// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawnSync } = require('node:child_process')

function scenario(phases) {
  const directory = mkdtempSync(join(tmpdir(), 'warm-vectra-native-filter-'))
  try {
    for (const phase of phases) {
      const result = spawnSync(process.execPath, [join(__dirname, 'helpers/vectra-native-filter-scenario.cjs'), phase, directory], {
        cwd: join(__dirname, '../..'), encoding: 'utf8', timeout: 120000,
      })
      assert.equal(result.status, 0, `${phase}: ${result.stderr || result.stdout}`)
    }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('native equality filters preserve exact results and projection across mutation and restart without metadata paging', () => scenario(['parity', 'reopen']))
test('unsupported Vectra filters retain selector ordering and old-addon fallback', () => scenario(['fallback']))
test('native equality filters enforce bounds and reject unrelated migration records', () => scenario(['validation']))
test('native filtered reads respect queued writes and stale revisions', () => scenario(['concurrency']))
