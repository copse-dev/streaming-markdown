// `DATA_ATTR_NAME_SOURCE` is the sink walk's definition of a custom data
// attribute; `escape.ts` spells the same shape as a regex *literal* so it
// tree-shakes out of entries that want only `escapeHtml` (see the note there).
// Two spellings can drift — two copies of an attribute allowlist drifting is
// what #146 left behind — so pin them against each other behaviourally: the
// escape gate must carry through exactly the names the sink calls `data-*`.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { DATA_ATTR_NAME_RE } from './data-attributes.ts'

const CANDIDATES = [
  'data-x',
  'data-workspace-link',
  'data-browser-link',
  'data-footnote-ref',
  'data-foo-bar-baz',
  'data-a1',
  'data-1',
  'data-UPPER',
  // Not custom data attributes, and not otherwise allowlisted on an anchor:
  'data-',
  'datax',
  'data_x',
  'datum-x',
  'xdata-x',
]

describe('data-* shape parity between the escape gate and the sink', () => {
  for (const name of CANDIDATES) {
    it(`agrees about \`${name}\``, () => {
      const html = renderMarkdownUnsafe(`<a href="https://example.com" ${name}="v">y</a>`, {
        htmlPolicy: 'escape',
      })
      // The gate carried the attribute through iff the sink calls it `data-*`.
      assert.equal(html.includes(`${name}="v"`), DATA_ATTR_NAME_RE.test(name), html)
    })
  }
})
