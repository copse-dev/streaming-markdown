import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeSafeMarkdownEntities } from './escape.ts'
import { isTableSeparatorLine } from './render-blocks.ts'
import { renderProseInline } from './render-prose-inline.ts'
import { syncAttributes } from './streaming-dom-morph.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { renderEmphasisDelimiters } from './inline-emphasis.ts'
import { tokenizeBlocks } from './block-tokenizer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// Targeted coverage for narrow edge branches that the broader suites don't reach.

describe('decodeSafeMarkdownEntities', () => {
  it('decodes the double-escaped decimal form &amp;#160; to a non-breaking space', () => {
    assert.equal(decodeSafeMarkdownEntities('a&amp;#160;b'), 'a b')
  })

  it('decodes every non-breaking-space spelling, including hex #xa0 (#143)', () => {
    // Regression: the hex arm was `#x0*a` (which matches the line-feed escape
    // `&#xa;`), so `&#xa0;` never decoded. It must, alongside the other spellings.
    for (const spelling of ['&#xa0;', '&#xA0;', '&#x0a0;', '&#x00a0;', '&nbsp;', '&#160;']) {
      assert.equal(decodeSafeMarkdownEntities(`a${spelling}b`), 'a b', spelling)
    }
    assert.equal(decodeSafeMarkdownEntities('a&amp;#xa0;b'), 'a b')
  })

  it('leaves the line-feed escape &#xa; literal (it is not a non-breaking space)', () => {
    // `&#xa;` (U+000A) must NOT decode — only the `#xa0` non-breaking space does.
    assert.equal(decodeSafeMarkdownEntities('a&#xa;b'), 'a&#xa;b')
  })

  it('leaves unrelated entities untouched', () => {
    assert.equal(decodeSafeMarkdownEntities('a&copy;b'), 'a&copy;b')
  })

  it('decodes a hex non-breaking space in the streaming pending tail (#143)', () => {
    // The bug flashed a literal `&#xa0;` while streaming; the pending tail must
    // show a real non-breaking space instead.
    const host = document.createElement('div')
    new StreamingMarkdownRenderer(host).update('foo&#xa0;bar')
    assert.ok(host.textContent?.includes(' '), 'pending tail shows a non-breaking space')
    assert.doesNotMatch(host.innerHTML, /&amp;#xa0;/i, 'no literal hex entity in the pending tail')
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
    const html = renderMarkdownUnsafe('[a]: <foo\\>bar>\n\n[a]')
    assert.match(html, /href="foo(%3E|&gt;|>)bar"/)
  })
})

describe('inline link label with an escaped closing bracket', () => {
  it('treats "\\]" inside a label as a literal, not the label end', () => {
    const html = renderMarkdownUnsafe('[a\\]b](https://example.com)')
    assert.match(html, />a\]b<\/a>/)
    assert.match(html, /href="https:\/\/example\.com"/)
  })

  it('skips a literal backslash from an invalid escape while scanning the label', () => {
    // `\b` is not a CommonMark escape, so the backslash stays literal and is
    // present when the label is scanned for its closing bracket — exercising the
    // backslash-skip branch in parseBracketedLabelOutsideInlineCode (inline-links).
    assert.equal(renderMarkdownUnsafe('[a\\b](/x)'), '<p><a href="/x">a\\b</a></p>')
  })
})

describe('renderEmphasisDelimiters: nested close remainder', () => {
  it('opens a new run from a closing remainder after closing two nested openers', () => {
    // A closing delimiter run that closes one opener, whose leftover closes a
    // second (deeper) opener, still has a left-flanking remainder that opens a
    // fresh run — the remRemainder-opens branch in handleCloseRemainder. Output
    // matches cmark's delimiter algorithm.
    assert.equal(renderEmphasisDelimiters('*a **b*****.'), '<em>a <strong>b</strong></em>**.')
  })
})

describe('tokenizeBlocks: a GFM table directly interrupts a list item', () => {
  it('breaks an unordered item when the next line begins a table', () => {
    // The header+separator table check inside breaksUnorderedListItem.
    const kinds = tokenizeBlocks('- item\n| a | b |\n| --- | --- |\n| 1 | 2 |\n').map(
      (b) => b.kind,
    )
    assert.deepEqual(kinds, ['list_item', 'table'])
  })

  it('breaks an ordered item after a blank line when a table follows', () => {
    // The same header+separator check inside the ordered-list continuation loop.
    const kinds = tokenizeBlocks('1. item\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n').map(
      (b) => b.kind,
    )
    assert.deepEqual(kinds, ['list_item', 'table'])
  })
})
