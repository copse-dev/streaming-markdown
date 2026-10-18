import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createPeleDiagramRenderer, loadPele, peleDiagramRenderer } from './mermaid-pele.ts'
import { diagramRenderer, loadDiagramRenderer } from './diagrams.ts'
import { hydratePendingDiagrams } from './mermaid.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

describe('default Pele backend (real package)', () => {
  const fixtures = {
    flowchart: 'flowchart LR\nA[Start] --> B[End]',
    sequence: 'sequenceDiagram\nAlice->>Bob: Hello',
    class: 'classDiagram\nAnimal <|-- Duck',
    state: 'stateDiagram-v2\n[*] --> Active',
    er: 'erDiagram\nCUSTOMER ||--o{ ORDER : places',
    mindmap: 'mindmap\n  root((Project))\n    Build\n    Test',
    pie: 'pie\n  "Done" : 70\n  "Remaining" : 30',
  }

  for (const [type, source] of Object.entries(fixtures)) {
    it(`renders a ${type} to parseable SVG`, async () => {
      const { svg } = await peleDiagramRenderer.render(source)
      const dom = new JSDOM(svg, { contentType: 'image/svg+xml' })
      try {
        assert.equal(dom.window.document.documentElement.localName, 'svg')
        assert.ok(dom.window.document.querySelector('text'), 'renders labels')
        assert.ok(dom.window.document.documentElement.getAttribute('viewBox'))
      } finally {
        dom.window.close()
      }
    })
  }

  it('uses Pele at the default diagrams entry point', async () => {
    assert.equal(diagramRenderer, peleDiagramRenderer)
    assert.equal(await loadDiagramRenderer(), peleDiagramRenderer)
  })

  it('returns the shared renderer from the lazy loader', async () => {
    assert.equal(await loadPele(), peleDiagramRenderer)
  })

  it('uses distinct accessibility IDs across renderer instances', async () => {
    const source = 'flowchart LR\naccTitle: Accessible diagram\nA --> B'
    const first = await createPeleDiagramRenderer().render(source)
    const second = await createPeleDiagramRenderer().render(source)
    const ids = (svg: string) => {
      const dom = new JSDOM(svg, { contentType: 'image/svg+xml' })
      try {
        return Array.from(dom.window.document.querySelectorAll('[id]'), (node) => node.id)
      } finally {
        dom.window.close()
      }
    }
    assert.ok(ids(first.svg).length > 0)
    assert.ok(ids(first.svg).every((id) => !ids(second.svg).includes(id)))
  })

  it('rejects malformed input and enforces host source limits', async () => {
    await assert.rejects(peleDiagramRenderer.render('this is not a diagram'))
    await assert.rejects(
      createPeleDiagramRenderer({ limit: 10 }).render(fixtures.flowchart),
    )
  })

  it('disables diagram-authored navigation and remote images', async () => {
    const { svg } = await peleDiagramRenderer.render(
      'flowchart LR\nA[Website]\nclick A "https://example.com"',
    )
    const dom = new JSDOM(svg, { contentType: 'image/svg+xml' })
    try {
      assert.equal(dom.window.document.querySelector('a, image, script, foreignObject'), null)
    } finally {
      dom.window.close()
    }
    const image = await peleDiagramRenderer.render(
      'flowchart LR\nA@{ img: "https://example.com/tracker.png", label: "Remote", h: 60 }',
    )
    assert.doesNotMatch(image.svg, /<image\b|https:\/\/example.com/)
  })

  it('hydrates real Markdown fences once and preserves rejected source', async () => {
    const dom = new JSDOM('<body></body>')
    try {
      const host = dom.window.document.body
      host.innerHTML = renderMarkdownUnsafe(
        '\`\`\`mermaid\n' + fixtures.flowchart + '\n\`\`\`\n\n' +
        '\`\`\`mermaid\nnot a diagram\n\`\`\`',
      )
      let transforms = 0
      assert.equal(await hydratePendingDiagrams(host, {
        renderer: peleDiagramRenderer,
        transformSvg(svg) {
          transforms++
          return svg
        },
      }), 1)
      assert.equal(transforms, 1, 'host SVG hook runs before insertion')
      assert.ok(host.querySelector('.mermaid-diagram--rendered svg'))
      assert.equal(host.querySelector('.mermaid-diagram--error pre')?.textContent, 'not a diagram')
      assert.equal(await hydratePendingDiagrams(host, { renderer: peleDiagramRenderer }), 0)
    } finally {
      dom.window.close()
    }
  })
})
