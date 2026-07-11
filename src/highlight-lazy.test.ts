import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fenceCodeClass, getCodeHighlighter, highlightFenceCode } from './highlight.ts'
import { withConfig } from './config.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

// PROTOTYPE (#lazy-load): proves the core renders code WITHOUT highlight.js
// loaded, then upgrades once the backend is supplied — the plain → highlighted
// transition a streaming UI shows while the grammar chunk is still in flight.
// These tests deliberately do NOT import a test setup that installs a default
// backend; each drives the ambient config directly.

describe('lazy highlighting (prototype)', () => {
  it('renders escaped plain text with a stable class when no backend is loaded', () => {
    // No highlighter in the process defaults, so `activeConfig().codeHighlighter`
    // is null outside any `withConfig` scope.
    assert.equal(getCodeHighlighter(), null)

    const html = renderMarkdownUnsafe('```ts\nconst x = 1 < 2\n```')
    // Class is resolved by the core (ts → typescript) even with no backend, so it
    // is identical before and after load — no className churn on upgrade.
    assert.match(html, /<pre><code class="hljs lang-typescript">/)
    // Interior is plain, escaped text — no highlight.js token spans yet.
    assert.doesNotMatch(html, /hljs-keyword/)
    assert.match(html, /const x = 1 &lt; 2/)
  })

  it('upgrades to token spans once a backend is supplied via config (lazy import)', async () => {
    const { loadHighlightjs } = await import('./highlight-hljs.ts')
    const highlighter = await loadHighlightjs()

    const html = renderMarkdownUnsafe('```ts\nconst x = 1 < 2\n```', { codeHighlighter: highlighter })
    assert.match(html, /<pre><code class="hljs lang-typescript">/)
    assert.match(html, /hljs-keyword/)
    // The `<` inside the code is still safely escaped (hljs wraps the operands in
    // spans, so assert only that no raw `<`/`>` from the source leaked through).
    assert.match(html, /&lt;/)
    assert.doesNotMatch(html, /x = 1 < 2/)
  })

  it('keeps the class identical across the plain → highlighted upgrade', async () => {
    const before = fenceCodeClass('ts')

    const { highlightjsHighlighter } = await import('./highlight-hljs.ts')
    const after = withConfig({ codeHighlighter: highlightjsHighlighter }, () => fenceCodeClass('ts'))

    assert.equal(before, after, 'class is core-resolved, stable across backend load')
    assert.equal(before, 'hljs lang-typescript')
  })

  it('an unknown language stays escaped plain text with or without a backend', async () => {
    assert.equal(highlightFenceCode('<script>', 'weirdlang'), '&lt;script&gt;')

    const { highlightjsHighlighter } = await import('./highlight-hljs.ts')
    assert.equal(
      withConfig({ codeHighlighter: highlightjsHighlighter }, () =>
        highlightFenceCode('<script>', 'weirdlang'),
      ),
      '&lt;script&gt;',
    )
  })
})
