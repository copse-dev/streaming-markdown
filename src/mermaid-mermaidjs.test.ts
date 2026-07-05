import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getDiagramRenderer, setDiagramRenderer } from './mermaid.ts'
import {
  __setMermaidImporterForTests,
  installMermaid,
  loadMermaid,
  mermaidDiagramRenderer,
} from './mermaid-mermaidjs.ts'

// The mermaid backend is a thin lazy adapter over the optional `mermaid` peer
// dependency, which needs a browser-grade DOM and can't render under Node. These
// tests inject a fake mermaid module via the test seam to exercise the wiring:
// registration, lazy load-and-initialize (once), and id sequencing.

/** A fake `mermaid` module: records calls and returns deterministic SVG. */
function fakeMermaidModule() {
  const calls: { initialize: number; render: string[] } = { initialize: 0, render: [] }
  const lib = {
    initialize(_config: Record<string, unknown>): void {
      calls.initialize += 1
    },
    render(id: string, source: string): Promise<{ svg: string }> {
      calls.render.push(id)
      return Promise.resolve({ svg: `<svg data-id="${id}" data-src="${source}"></svg>` })
    },
  }
  return { calls, module: { default: lib } }
}

describe('mermaid backend adapter', () => {
  afterEach(() => {
    __setMermaidImporterForTests(null)
    setDiagramRenderer(null)
  })

  it('installMermaid registers the mermaid-backed diagram renderer', () => {
    setDiagramRenderer(null)
    const renderer = installMermaid()
    assert.equal(renderer, mermaidDiagramRenderer)
    assert.equal(getDiagramRenderer(), mermaidDiagramRenderer)
  })

  it('loadMermaid resolves to the registered renderer (idempotent)', async () => {
    setDiagramRenderer(null)
    const a = await loadMermaid()
    const b = await loadMermaid()
    assert.equal(a, mermaidDiagramRenderer)
    assert.equal(b, mermaidDiagramRenderer)
    assert.equal(getDiagramRenderer(), mermaidDiagramRenderer)
  })

  it('render lazily loads and initializes mermaid, then returns its SVG', async () => {
    const { calls, module } = fakeMermaidModule()
    __setMermaidImporterForTests(() => Promise.resolve(module))

    const first = await mermaidDiagramRenderer.render('graph TD\nA-->B')
    assert.match(first.svg, /<svg data-id="smd-mermaid-1"/)
    assert.match(first.svg, /data-src="graph TD\nA-->B"/)
    assert.equal(calls.initialize, 1, 'library initialized once on first render')

    // Second render reuses the cached, already-initialized library and advances
    // the diagram id sequence.
    const second = await mermaidDiagramRenderer.render('graph LR\nC-->D')
    assert.match(second.svg, /<svg data-id="smd-mermaid-2"/)
    assert.equal(calls.initialize, 1, 'initialize not called again')
    assert.deepEqual(calls.render, ['smd-mermaid-1', 'smd-mermaid-2'])
  })

  it('supports a module whose mermaid API is exported without a default wrapper', async () => {
    const { calls, module } = fakeMermaidModule()
    // Some builds expose the API on the namespace object directly (no `default`).
    __setMermaidImporterForTests(() => Promise.resolve(module.default))

    const out = await mermaidDiagramRenderer.render('graph TD\nX-->Y')
    assert.match(out.svg, /<svg data-id="smd-mermaid-/)
    assert.equal(calls.initialize, 1)
  })
})
