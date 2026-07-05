import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeSafeMarkdownEntities } from './escape.ts'
import { isTableSeparatorLine } from './render-blocks.ts'
import { renderProseInline } from './render-prose-inline.ts'
import { syncAttributes } from './streaming-dom-morph.ts'
import { renderMarkdown } from './renderer.ts'

// Targeted coverage for narrow edge branches that the broader suites don't reach.

describe('decodeSafeMarkdownEntities', () => {
  it('decodes the double-escaped decimal form &amp;#160; to a non-breaking space', () => {
    assert.equal(decodeSafeMarkdownEntities('a&amp;#160;b'), 'a b')
  })

  it('runs the allowlist comparisons without decoding a non-nbsp hex form', () => {
    // `&#xa;` matches the entity scanner but is not one of the nbsp spellings,
    // so it falls through every allowlist arm and is returned verbatim.
    assert.equal(decodeSafeMarkdownEntities('a&#xa;b'), 'a&#xa;b')
  })

  it('leaves unrelated entities untouched', () => {
    assert.equal(decodeSafeMarkdownEntities('a&copy;b'), 'a&copy;b')
  })
})

describe('isTableSeparatorLine', () => {
  it('recognizes a GFM separator line and rejects prose', () => {
    assert.equal(isTableSeparatorLine('| --- | :--: |'), true)
    assert.equal(isTableSeparatorLine('not a separator'), false)
  })
})

describe('renderProseInline: unterminated angle bracket', () => {
  it('emits a trailing "<" run with no closing ">" verbatim', () => {
    // No '>' after the '<' — the scanner pushes the remainder and stops.
    const out = renderProseInline('compare a < b and c')
    assert.ok(out.includes('c'))
    assert.match(out, /a (&lt;|<) b and c/)
  })
})

describe('syncAttributes', () => {
  it('is a no-op when attributes already match', () => {
    const el = document.createElement('ul')
    el.setAttribute('class', 'x')
    const tpl = document.createElement('ul')
    tpl.setAttribute('class', 'x')
    syncAttributes(el, tpl)
    assert.equal(el.getAttribute('class'), 'x')
  })

  it('removes surplus attributes and copies the template set', () => {
    const el = document.createElement('ul')
    el.setAttribute('data-old', '1')
    el.setAttribute('id', 'stale')
    const tpl = document.createElement('ul')
    tpl.setAttribute('class', 'contains-task-list')
    syncAttributes(el, tpl)
    assert.equal(el.getAttribute('class'), 'contains-task-list')
    assert.equal(el.hasAttribute('data-old'), false)
    assert.equal(el.hasAttribute('id'), false)
  })
})

describe('link reference definition with an angle-bracket escaped destination', () => {
  it('parses a <...> destination containing a backslash-escaped ">"', () => {
    // The bare-destination parser must skip the escaped ">" and close on the real one.
    const html = renderMarkdown('[a]: <foo\\>bar>\n\n[a]')
    assert.match(html, /href="foo(%3E|&gt;|>)bar"/)
  })
})

describe('inline link label with an escaped closing bracket', () => {
  it('treats "\\]" inside a label as a literal, not the label end', () => {
    const html = renderMarkdown('[a\\]b](https://example.com)')
    assert.match(html, />a\]b<\/a>/)
    assert.match(html, /href="https:\/\/example\.com"/)
  })
})
