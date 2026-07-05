import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFormingFenceHtml,
  clearFormingFenceDom,
  syncFormingFenceDom,
} from './streaming-fence-dom.ts'

// Direct coverage of the forming-fence DOM emitter — the incremental path the
// streaming renderer uses while a code fence is still open (no closing ```).

function container(): HTMLElement {
  return document.createElement('div')
}

describe('buildFormingFenceHtml (string path)', () => {
  it('returns empty string when the source is not an open fence', () => {
    assert.equal(buildFormingFenceHtml('just prose, no fence'), '')
  })

  it('renders a forming <pre><code> for a code fence', () => {
    const html = buildFormingFenceHtml('```ts\nconst x = 1')
    assert.match(html, /<pre class="stream-fence-forming">/)
    assert.match(html, /<code class="hljs lang-typescript">/)
    // A highlighter is registered in the DOM test setup, so tokens are wrapped
    // in spans — assert the words are present without requiring them contiguous.
    assert.match(html, /const/)
    assert.match(html, />1</)
  })

  it('renders pending mermaid scaffolding for a mermaid fence', () => {
    const html = buildFormingFenceHtml('```mermaid\ngraph TD\nA-->B')
    assert.match(html, /mermaid-diagram--pending/)
    assert.match(html, /<pre class="mermaid">/)
    assert.match(html, /graph TD/)
  })
})

describe('syncFormingFenceDom (DOM path)', () => {
  it('clears the container when the source is not an open fence', () => {
    const el = container()
    el.innerHTML = '<pre>stale</pre>'
    syncFormingFenceDom(el, 'not a fence')
    assert.equal(el.childNodes.length, 0)
  })

  it('creates then reuses the <pre><code> node across incremental updates', () => {
    const el = container()

    syncFormingFenceDom(el, '```ts\nconst x = 1')
    const pre = el.querySelector('pre.stream-fence-forming')
    const code = el.querySelector('pre.stream-fence-forming > code')
    assert.ok(pre && code)
    assert.equal(code?.className, 'hljs lang-typescript')

    // A second update on more content must reuse the same nodes (no churn).
    syncFormingFenceDom(el, '```ts\nconst x = 12')
    assert.equal(el.querySelectorAll('pre.stream-fence-forming').length, 1)
    assert.equal(el.querySelector('pre.stream-fence-forming'), pre, 'pre reused')
    assert.equal(el.querySelector('pre.stream-fence-forming > code'), code, 'code reused')
    assert.equal(code?.textContent, 'const x = 12')
  })

  it('creates then reuses the mermaid scaffolding across incremental updates', () => {
    const el = container()

    syncFormingFenceDom(el, '```mermaid\ngraph TD\nA-->B')
    const diagram = el.querySelector('.mermaid-diagram.stream-fence-forming')
    const pre = el.querySelector('pre.mermaid')
    assert.ok(diagram && pre)
    assert.equal(pre?.textContent, 'graph TD\nA-->B')

    syncFormingFenceDom(el, '```mermaid\ngraph TD\nA-->B\nB-->C')
    assert.equal(el.querySelectorAll('.mermaid-diagram.stream-fence-forming').length, 1)
    assert.equal(el.querySelector('.mermaid-diagram.stream-fence-forming'), diagram, 'diagram reused')
    assert.equal(el.querySelector('pre.mermaid')?.textContent, 'graph TD\nA-->B\nB-->C')
  })

  it('switches cleanly from a code fence to a mermaid fence', () => {
    const el = container()
    syncFormingFenceDom(el, '```ts\nconst x = 1')
    assert.ok(el.querySelector('pre.stream-fence-forming'))

    // Re-classifying to mermaid replaces the code <pre> with mermaid scaffolding.
    syncFormingFenceDom(el, '```mermaid\ngraph TD\nA-->B')
    assert.equal(el.querySelectorAll('pre.stream-fence-forming > code').length, 0)
    assert.ok(el.querySelector('.mermaid-diagram.stream-fence-forming'))
  })
})

describe('clearFormingFenceDom', () => {
  it('empties the container', () => {
    const el = container()
    el.innerHTML = '<pre class="stream-fence-forming"><code>x</code></pre>'
    clearFormingFenceDom(el)
    assert.equal(el.childNodes.length, 0)
  })
})
