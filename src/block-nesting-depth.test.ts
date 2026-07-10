import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// Regression for #136: block rendering recurses once per nesting level, so
// untrusted model output like `'> '.repeat(2000)` (a single ~4 KB line) used to
// overflow the call stack. A depth cap now renders past-cap content as literal
// text instead of recursing. These assert no throw, bounded output, and that
// ordinary nesting is unaffected.

describe('deep block nesting does not overflow the stack (#136)', () => {
  it('renders a 2000-level blockquote as literal text past the cap, no crash', () => {
    const input = '> '.repeat(2000) + 'x'
    let html = ''
    assert.doesNotThrow(() => {
      html = renderMarkdownUnsafe(input)
    })
    // Nesting is capped, so the blockquote count is bounded (not 2000), and the
    // innermost quote markers survive as escaped literal text rather than more
    // <blockquote> elements.
    const depth = (html.match(/<blockquote>/g) ?? []).length
    assert.ok(depth > 0 && depth <= 200, `bounded blockquote depth, got ${String(depth)}`)
    assert.ok(html.includes('&gt;'), 'past-cap quote markers render as escaped literal text')
  })

  it('renders a deeply indented list without crashing', () => {
    const input = Array.from({ length: 1500 }, (_, i) => '  '.repeat(i) + '- a').join('\n')
    assert.doesNotThrow(() => {
      renderMarkdownUnsafe(input)
    })
  })

  it('does not crash the streaming DOM emitter on a deep blockquote commit', () => {
    const input = '> '.repeat(2000) + 'x\n\ntail\n\n'
    assert.doesNotThrow(() => {
      const host = document.createElement('div')
      new StreamingMarkdownRenderer(host).update(input)
    })
  })

  it('leaves ordinary nesting depths byte-identical', () => {
    assert.equal(
      renderMarkdownUnsafe('> > > hi'),
      '<blockquote><blockquote><blockquote><p>hi</p></blockquote></blockquote></blockquote>',
    )
    assert.equal(
      renderMarkdownUnsafe('- a\n  - b\n    - c'),
      '<ul><li>a\n<ul><li>b\n<ul><li>c</li></ul></li></ul></li></ul>',
    )
  })
})
