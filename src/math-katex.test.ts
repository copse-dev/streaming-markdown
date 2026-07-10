import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getMathRenderer, hydratePendingMath, setMathRenderer } from './math.ts'
import {
  __setKatexImporterForTests,
  installKatex,
  katexMathRenderer,
  loadKatex,
} from './math-katex.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

// The KaTeX backend is a thin lazy adapter over the optional `katex` peer
// dependency. Registration and the load-once path are exercised through the
// test seam; unlike mermaid, katex renders fine under Node (renderToString
// needs no DOM), so the real library is also driven end-to-end.

/** A fake `katex` module: records calls and returns deterministic HTML. */
function fakeKatexModule() {
  const calls: { source: string; options: Record<string, unknown> }[] = []
  const lib = {
    renderToString(source: string, options: Record<string, unknown>): string {
      calls.push({ source, options })
      return `<span class="katex" data-display="${String(options['displayMode'])}">${source}</span>`
    },
  }
  return { calls, module: { default: lib } }
}

describe('katex backend adapter', () => {
  afterEach(() => {
    __setKatexImporterForTests(null)
    setMathRenderer(null)
  })

  it('installKatex registers the katex-backed math renderer', () => {
    setMathRenderer(null)
    const renderer = installKatex()
    assert.equal(renderer, katexMathRenderer)
    assert.equal(getMathRenderer(), katexMathRenderer)
  })

  it('loadKatex resolves to the registered renderer (idempotent)', async () => {
    setMathRenderer(null)
    const a = await loadKatex()
    const b = await loadKatex()
    assert.equal(a, katexMathRenderer)
    assert.equal(b, katexMathRenderer)
    assert.equal(getMathRenderer(), katexMathRenderer)
  })

  it('render lazily loads katex once and threads displayMode + safety options', async () => {
    const { calls, module } = fakeKatexModule()
    __setKatexImporterForTests(() => Promise.resolve(module))

    const display = await katexMathRenderer.render('E=mc^2', { displayMode: true })
    assert.match(display.html, /data-display="true"/)
    const inline = await katexMathRenderer.render('a_i', { displayMode: false })
    assert.match(inline.html, /data-display="false"/)

    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.options['throwOnError'], false, 'invalid TeX degrades, not throws')
    assert.equal(calls[0]?.options['trust'], false, 'no \\href/\\html* commands post-sanitizer')
  })

  it('supports a module whose katex API is exported without a default wrapper', async () => {
    const { calls, module } = fakeKatexModule()
    __setKatexImporterForTests(() => Promise.resolve(module.default))

    const out = await katexMathRenderer.render('x', { displayMode: false })
    assert.match(out.html, /class="katex"/)
    assert.equal(calls.length, 1)
  })
})

describe('katex backend end-to-end (real library)', () => {
  afterEach(() => {
    __setKatexImporterForTests(null)
    setMathRenderer(null)
  })

  it('hydrates generator scaffolding into real KaTeX HTML', async () => {
    installKatex()
    const host = document.createElement('div')
    host.innerHTML = renderMarkdownUnsafe('$$\nE = mc^2\n$$\n\nInline $a_i$ here.')

    const count = await hydratePendingMath(host)

    assert.equal(count, 2)
    const block = host.querySelector('.math-block--rendered')
    assert.ok(block, 'block flipped to rendered')
    assert.ok(block?.querySelector('.katex-display'), 'display mode for the block')
    const span = host.querySelector('.math-inline--rendered')
    assert.ok(span?.querySelector('.katex'), 'inline mode for the span')
    assert.ok(!span?.querySelector('.katex-display'))
  })

  it('renders invalid TeX as a visible katex-error (throwOnError: false)', async () => {
    installKatex()
    const host = document.createElement('div')
    host.innerHTML = renderMarkdownUnsafe('$$\n\\badcommand{\n$$')
    const count = await hydratePendingMath(host)
    assert.equal(count, 1, 'still counts as rendered — katex degrades in place')
    assert.ok(host.querySelector('.katex-error'))
  })
})
