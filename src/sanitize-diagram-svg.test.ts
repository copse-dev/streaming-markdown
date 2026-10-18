import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeDiagramSvg } from './sanitize-dompurify.ts'
import { hydratePendingDiagrams } from './mermaid.ts'
import { peleDiagramRenderer } from './mermaid-pele.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => null,
})

describe('diagram SVG sanitization', () => {
  it('strips scripts, event handlers, HTML and unsafe links before hydration inserts SVG', async () => {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdownUnsafe('```mermaid\nflowchart LR\nA --> B\n```')
    const payload = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
      '<script>alert(1)</script><foreignObject><div>HTML</div></foreignObject>' +
      '<a href="javascript:alert(1)"><text>Label</text></a>' +
      '<defs><marker id="arrow" markerWidth="10" markerHeight="10"><path d="M0 0L10 5L0 10Z"/></marker></defs>' +
      '<path d="M0 0L10 10" marker-end="url(#arrow)" onclick="alert(1)"/></svg>'
    let sanitizations = 0
    assert.equal(await hydratePendingDiagrams(host, {
      renderer: { async render() { return { svg: payload } } },
      transformSvg(svg) {
        sanitizations++
        return sanitizeDiagramSvg(svg)
      },
    }), 1)
    assert.equal(sanitizations, 1)
    assert.ok(host.querySelector('svg path'), 'drawing elements survive')
    assert.equal(host.querySelector('svg')?.querySelector('script, foreignObject, div'), null)
    assert.ok(host.querySelector('svg marker'))
    assert.equal(host.querySelector('svg > path')?.getAttribute('marker-end'), 'url(#arrow)')
    assert.equal(host.querySelector('[onload], [onclick]'), null)
    assert.doesNotMatch(host.innerHTML, /javascript:|alert\(1\)/)
    assert.match(host.textContent ?? '', /Label/)
  })

  it('preserves real Pele SVG shapes, labels and accessibility references', async () => {
    const host = document.createElement('div')
    host.innerHTML = renderMarkdownUnsafe(
      '```mermaid\nflowchart LR\naccTitle: Sanitized diagram\nA[Start] --> B[End]\n```',
    )
    assert.equal(await hydratePendingDiagrams(host, {
      renderer: peleDiagramRenderer,
      transformSvg: sanitizeDiagramSvg,
    }), 1)
    const svg = host.querySelector('svg')
    assert.ok(svg)
    assert.ok(svg.getAttribute('viewBox'))
    assert.ok(svg.querySelector('path, rect'))
    assert.match(svg.textContent ?? '', /Start/)
    assert.match(svg.textContent ?? '', /End/)
    const labelledBy = svg.getAttribute('aria-labelledby')
    assert.ok(labelledBy)
    for (const id of labelledBy.split(/\s+/)) {
      assert.ok(Array.from(svg.querySelectorAll('[id]')).some((node) => node.id === id))
    }
  })
})
