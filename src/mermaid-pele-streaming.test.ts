import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { diagramRenderer } from './diagrams.ts'
import { sanitizeDiagramSvg } from './sanitize-dompurify.ts'

// jsdom has no canvas implementation. Exercise Pele's documented fallback
// measurements, without jsdom's unimplemented-canvas diagnostic.
Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: () => null,
})

describe('default Pele streaming backend', () => {
  it('hydrates a closed fence and keeps its SVG when more Markdown arrives', async () => {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host, {
      diagramRenderer,
    })
    const open = '\`\`\`mermaid\nflowchart LR\nA[Start] --> B[End]\n'
    renderer.update(open)
    assert.ok(host.querySelector('.stream-fence-forming'))
    assert.equal(host.querySelector('svg'), null)

    const closed = open + '\`\`\`\n\n'
    renderer.update(closed)
    const counts = await renderer.hydrate({ transformSvg: sanitizeDiagramSvg })
    assert.equal(counts.diagrams, 1)
    const svg = host.querySelector('svg')
    assert.ok(svg)
    assert.match(svg.textContent ?? '', /Start/)
    assert.equal(host.querySelector('.mermaid-diagram--pending'), null)

    renderer.update(closed + 'Following paragraph.\n\n')
    assert.equal((await renderer.hydrate({ transformSvg: sanitizeDiagramSvg })).diagrams, 0)
    assert.equal(host.querySelector('svg'), svg, 'hydrated diagram survives append')
    assert.match(host.textContent ?? '', /Following paragraph/)
  })
})
