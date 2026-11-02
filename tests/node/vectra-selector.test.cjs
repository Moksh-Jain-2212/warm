// Copyright 2024-2026 WritersLogic Contributors
// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { select } = require('../../vectra-selector.js')
const { ItemSelector } = require('../fixtures/vectra-0.15/ItemSelector.js')

test('selectors retain pinned Vectra 0.15 quirks instead of silently applying Mongo semantics', () => {
  const cases = [
    [{}, {}, true], [{}, null, true], [{}, { absent: { $ne: 1 } }, false],
    [{ n: null }, { n: null }, false], [{ n: 5 }, { n: {} }, true],
    [{ n: 5 }, { n: { $in: [5] } }, false], [{ n: 5 }, { n: { $nin: [5] } }, true],
    [{ n: 5 }, { n: { $in: ['15'] } }, true], [{ n: 5 }, { n: { $nin: ['15'] } }, false],
    [{ s: 'a' }, { s: { $in: ['cat'] } }, false], [{ s: 'a' }, { s: { $nin: ['cat'] } }, false],
    [{ s: 'a' }, { s: { $in: ['a'] } }, true],
    [{ b: true }, { b: { $in: [true] } }, false], [{ b: true }, { b: { $nin: [] } }, false],
    [{ n: 5 }, { n: { unknown: 5, $eq: 99 } }, true],
    [{ n: 5 }, { n: { $eq: 99, unknown: 5 } }, false],
    [{ n: 5 }, { $and: [{ n: { $gt: 4 } }, { $or: [{ n: 5 }, { n: 6 }] }] }, true],
    [{ n: '5' }, { n: { $gte: 4 } }, false], [{ n: 5 }, { n: { $gte: '4' } }, true],
    [{}, { $and: [] }, true], [{}, { $or: [] }, false],
  ]
  for (const [metadata, filter, expected] of cases) {
    assert.equal(ItemSelector.select(metadata, filter), expected)
    assert.equal(select(metadata, filter), expected)
  }
})

test('selector differential corpus matches the retained published implementation', () => {
  const values = [null, false, true, -1, 0, 1, 12, '', '1', '12', 'x', [], {}, ['x']]
  const operands = [...values, [1, '12', true]]
  let cases = 0
  for (const value of values) for (const operand of operands) {
    for (const operator of ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', 'unknown']) {
      if ((operator === '$in' || operator === '$nin') && !Array.isArray(operand)) continue
      const filter = { value: { [operator]: operand } }
      const metadata = { value }
      assert.equal(select(metadata, filter), ItemSelector.select(metadata, filter))
      assert.equal(select(metadata, { $or: [filter, { missing: 1 }] }), ItemSelector.select(metadata, { $or: [filter, { missing: 1 }] }))
      cases++
    }
  }
  assert.ok(cases > 1000)
})
