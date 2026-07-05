import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  fenceCodeClass,
  getCodeHighlighter,
  highlightFenceCode,
  setCodeHighlighter,
} from './highlight.ts'
import { renderMarkdown } from './renderer.ts'

// PROTOTYPE (#lazy-load): proves the core renders code WITHOUT highlight.js
// loaded, then upgrades once the backend is registered — the plain → highlighted
// transition a streaming UI shows while the grammar chunk is still in flight.
// These tests deliberately do NOT import a test setup that pre-registers a
// backend; each drives the registry directly.

describe('lazy highlighting (prototype)', () => {
  afterEach(() => setCodeHighlighter(null))

  it('renders escaped plain text with a stable class when no backend is loaded', () => {
    setCodeHighlighter(null)
    assert.equal(getCodeHighlighter(), null)

    const html = renderMarkdown('```ts\nconst x = 1 < 2\n```')
    // Class is resolved by the core (ts → typescript) even with no backend, so it
    // is identical before and after load — no className churn on upgrade.
    assert.match(html, /<pre><code class="hljs lang-typescript">/)
    // Interior is plain, escaped text — no highlight.js token spans yet.
    assert.doesNotMatch(html, /hljs-keyword/)
    assert.match(html, /const x = 1 &lt; 2/)
  })

  it('upgrades to token spans after the backend is registered (lazy import)', async () => {
    const { loadHighlightjs } = await import('./highlight-hljs.ts')
    await loadHighlightjs()
    assert.notEqual(getCodeHighlighter(), null)

    const html = renderMarkdown('```ts\nconst x = 1 < 2\n```')
    assert.match(html, /<pre><code class="hljs lang-typescript">/)
    assert.match(html, /hljs-keyword/)
    // The `<` inside the code is still safely escaped (hljs wraps the operands in
    // spans, so assert only that no raw `<`/`>` from the source leaked through).
    assert.match(html, /&lt;/)
    assert.doesNotMatch(html, /x = 1 < 2/)
  })

  it('keeps the class identical across the plain → highlighted upgrade', async () => {
    setCodeHighlighter(null)
    const before = fenceCodeClass('ts')

    const { installHighlightjs } = await import('./highlight-hljs.ts')
    installHighlightjs()
    const after = fenceCodeClass('ts')

    assert.equal(before, after, 'class is core-resolved, stable across backend load')
    assert.equal(before, 'hljs lang-typescript')
  })

  it('an unknown language stays escaped plain text with or without a backend', async () => {
    setCodeHighlighter(null)
    assert.equal(highlightFenceCode('<script>', 'weirdlang'), '&lt;script&gt;')

    const { installHighlightjs } = await import('./highlight-hljs.ts')
    installHighlightjs()
    assert.equal(highlightFenceCode('<script>', 'weirdlang'), '&lt;script&gt;')
  })
})
