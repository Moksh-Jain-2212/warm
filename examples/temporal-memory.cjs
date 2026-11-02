// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0

// Run remember, replace, forget, then verify in separate processes with the same directory.
// See docs/memory-api/README.md for the complete commands.
const assert = require('node:assert/strict')
const { WarmMemorySystem } = require('../index.js')
const { Memory } = require('../memory.js')

const originalId = 'alice-city-2020-01-01'
const replacementId = 'alice-city-2025-01-01'
const subject = 'alice/city'
const query = 'where does Alice live'
const asOf = new Date('2021-06-01T00:00:00Z')

async function main() {
  const [phase, directory] = process.argv.slice(2)
  if (!['remember', 'replace', 'forget', 'verify'].includes(phase) || !directory) {
    throw new Error('Usage: node examples/temporal-memory.cjs <remember|replace|forget|verify> <store-directory>')
  }
  const warm = new WarmMemorySystem(4096, directory)
  // Policies are runtime configuration: apply them again whenever the store is opened.
  const memory = new Memory(warm, { supersession: 'latest-by-subject' })
  const recall = async options => (await memory.recall(query, { subject, ...options }))
    .map(({ id, text, status }) => ({ id, text, status }))
  let result

  if (phase === 'remember') {
    const stored = await memory.remember('Alice lives in Paris', {
      id: originalId, subject, validFrom: new Date('2020-01-01T00:00:00Z'),
    })
    result = { stored, current: await recall() }
  } else if (phase === 'replace') {
    const stored = await memory.remember('Alice lives in Berlin', {
      id: replacementId, subject, validFrom: new Date('2025-01-01T00:00:00Z'),
    })
    result = {
      stored,
      current: await recall(),
      asOf: await recall({ asOf }),
      explanation: await memory.explain(query, replacementId),
    }
  } else if (phase === 'forget') {
    const before = { current: await recall(), asOf: await recall({ asOf }) }
    const forgotten = await memory.forget({ ids: [replacementId] }, {
      includeChain: true, purge: true, dryRun: false,
    })
    result = { before, forgotten, remaining: await recall({ history: 'all' }) }
  } else {
    result = {
      current: await recall(),
      asOf: await recall({ asOf }),
      all: await recall({ history: 'all' }),
      original: await memory.get(originalId),
      replacement: await memory.get(replacementId),
      documents: await warm.searchDocuments('Alice'),
    }
    assert.deepEqual(result, {
      current: [], asOf: [], all: [], original: null, replacement: null, documents: [],
    })
  }

  await warm.flush()
  console.log(JSON.stringify({ phase, ...result }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
