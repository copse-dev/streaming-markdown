import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fenceCodeClass, highlightFenceCode, stripAppCodeDecorations } from './highlight.ts'
import { installHighlightjs } from './highlight-hljs.ts'

// These tests assert highlighted (hljs span) output, so register the backend the
// core now lazy-loads. See highlight-lazy.test.ts for the plain-until-loaded path.
installHighlightjs()

describe('highlightFenceCode', () => {
  it('highlights TypeScript keywords and types', () => {
    const html = highlightFenceCode('export function greet(name: string) {}', 'typescript')
    assert.match(html, /hljs-keyword/)
    assert.match(html, /greet/)
    assert.match(html, /hljs-built_in/)
  })

  it('maps ts alias to typescript', () => {
    const html = highlightFenceCode('const x = 1', 'ts')
    assert.match(html, /hljs-keyword/)
    assert.match(html, /const/)
  })

  it('escapes unknown language tags as plain text', () => {
    const html = highlightFenceCode('<script>', 'weirdlang')
    assert.equal(html, '&lt;script&gt;')
    assert.doesNotMatch(html, /hljs/)
  })

  it('auto-detects when fence lang is empty', () => {
    const html = highlightFenceCode('const x = 1', '')
    assert.match(html, /hljs-keyword|hljs-built_in/)
  })
})

describe('fenceCodeClass', () => {
  it('includes hljs and resolved lang class', () => {
    assert.equal(fenceCodeClass('ts'), 'hljs lang-typescript')
    assert.equal(fenceCodeClass(''), 'hljs lang-text')
  })

  it('escapes an unrecognized language so it cannot break out of the class attribute', () => {
    // The fence parser passes the entity-decoded first word of the info string;
    // an injection payload like `"><img` must not escape the attribute context.
    const cls = fenceCodeClass('"><img')
    assert.ok(!cls.includes('"'), 'no raw quote escapes the attribute')
    assert.ok(!cls.includes('<'), 'no raw angle bracket escapes the attribute')
    assert.equal(cls, 'hljs lang-&quot;&gt;&lt;img')
  })
})

describe('stripAppCodeDecorations', () => {
  it('drops hljs spans and maps the class to the spec shape', () => {
    const html =
      '<pre><code class="hljs lang-typescript"><span class="hljs-keyword">const</span> x = 1</code></pre>'
    assert.equal(
      stripAppCodeDecorations(html),
      '<pre><code class="language-typescript">const x = 1\n</code></pre>',
    )
  })

  it('removes the class entirely for the empty-info lang-text fallback', () => {
    assert.equal(
      stripAppCodeDecorations('<pre><code class="hljs lang-text">aaa</code></pre>'),
      '<pre><code>aaa\n</code></pre>',
    )
  })

  it('leaves empty code blocks and undecorated code spans untouched', () => {
    assert.equal(
      stripAppCodeDecorations('<pre><code class="hljs lang-text"></code></pre>'),
      '<pre><code></code></pre>',
    )
    assert.equal(stripAppCodeDecorations('<p><code>x</code></p>'), '<p><code>x</code></p>')
  })
})
