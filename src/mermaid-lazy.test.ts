import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  type DiagramRenderer,
  getDiagramRenderer,
  hydratePendingDiagrams,
  setDiagramRenderer,
} from './mermaid.ts'
import { renderMarkdown } from './renderer.ts'

// PROTOTYPE (#lazy-load): proves the diagram-renderer registry + hydration flow
// without the mermaid library (which can't render in jsdom). A stub
// DiagramRenderer stands in for the real backend; `mermaid-mermaidjs.ts` is the
// thin adapter that dynamically imports the actual library.

/** Build a detached DOM subtree from the generator's mermaid scaffolding. */
function renderToDom(md: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = renderMarkdown(md)
  return host
}

const MERMAID_MD = '```mermaid\ngraph TD\nA[Start] --> B[End]\n```'

describe('lazy diagram hydration (prototype)', () => {
  afterEach(() => setDiagramRenderer(null))

  it('emits inert pending scaffolding and hydrates to nothing with no backend', async () => {
    setDiagramRenderer(null)
    assert.equal(getDiagramRenderer(), null)

    const host = renderToDom(MERMAID_MD)
    const diagram = host.querySelector('.mermaid-diagram')
    assert.ok(diagram, 'diagram container is emitted')
    assert.ok(diagram?.classList.contains('mermaid-diagram--pending'))

    const count = await hydratePendingDiagrams(host)
    assert.equal(count, 0, 'no backend → no-op')
    // The inert source <pre> is still there, still pending.
    assert.ok(host.querySelector('pre.mermaid'))
    assert.ok(host.querySelector('.mermaid-diagram--pending'))
  })

  it('hydrates pending diagrams to SVG once a renderer is registered', async () => {
    const stub: DiagramRenderer = {
      render: (source) =>
        Promise.resolve({ svg: `<svg data-src="${source.includes('graph TD') ? 'ok' : 'no'}"></svg>` }),
    }
    setDiagramRenderer(stub)

    const host = renderToDom(MERMAID_MD)
    const count = await hydratePendingDiagrams(host)

    assert.equal(count, 1)
    const diagram = host.querySelector('.mermaid-diagram')
    assert.ok(diagram?.classList.contains('mermaid-diagram--rendered'))
    assert.ok(!diagram?.classList.contains('mermaid-diagram--pending'))
    assert.ok(host.querySelector('svg[data-src="ok"]'), 'SVG injected from the backend')
    assert.ok(!host.querySelector('pre.mermaid'), 'inert source <pre> replaced')
  })

  it('falls back to the aggressive source candidate when the gentle one is rejected', async () => {
    // Plain labels the gentle pass leaves unquoted but the aggressive pass quotes.
    // The stub stands in for a lexer that only accepts quoted labels, so it rejects
    // the gentle candidate (`A[Start]`) and accepts the aggressive one (`A["Start"]`).
    const attempts: string[] = []
    const stub: DiagramRenderer = {
      render(source) {
        attempts.push(source)
        if (/\[[A-Za-z]/.test(source)) return Promise.reject(new Error('unquoted label'))
        return Promise.resolve({ svg: '<svg data-ok="1"></svg>' })
      },
    }
    setDiagramRenderer(stub)

    // One line-leading node so the aggressive pass fully quotes it (`Start[Begin]`
    // → `Start["Begin"]`); the gentle pass leaves the plain label unquoted.
    const host = renderToDom('```mermaid\ngraph TD\nStart[Begin]\n```')
    const count = await hydratePendingDiagrams(host)

    assert.equal(count, 1, 'aggressive candidate rendered after the gentle one failed')
    assert.equal(attempts.length, 2, 'gentle then aggressive candidate attempted')
    assert.match(attempts[1] ?? '', /Start\["Begin"\]/, 'second attempt is the quoted candidate')
    assert.ok(host.querySelector('svg[data-ok="1"]'))
  })

  it('marks the diagram as errored when every candidate throws', async () => {
    const stub: DiagramRenderer = { render: () => Promise.reject(new Error('boom')) }
    setDiagramRenderer(stub)

    const host = renderToDom(MERMAID_MD)
    const count = await hydratePendingDiagrams(host)

    assert.equal(count, 0)
    const diagram = host.querySelector('.mermaid-diagram')
    assert.ok(diagram?.classList.contains('mermaid-diagram--error'))
    assert.ok(!diagram?.classList.contains('mermaid-diagram--pending'))
  })

  it('applies a transformSvg hook (host SVG sanitizer seam)', async () => {
    const stub: DiagramRenderer = {
      render: () => Promise.resolve({ svg: '<svg><script>evil()</script></svg>' }),
    }
    setDiagramRenderer(stub)

    const host = renderToDom(MERMAID_MD)
    await hydratePendingDiagrams(host, {
      transformSvg: (svg) => svg.replace(/<script>[\s\S]*?<\/script>/g, ''),
    })

    assert.ok(!host.querySelector('script'), 'transformSvg ran before injection')
    assert.ok(host.querySelector('svg'))
  })

  it('marks the diagram errored without retrying candidates when injection fails', async () => {
    // An injection failure (e.g. Trusted Types rejecting a plain-string SVG)
    // is candidate-independent — re-rendering the aggressive candidate would
    // only hit the same sink error.
    let renders = 0
    const stub: DiagramRenderer = {
      render: () => {
        renders++
        return Promise.resolve({ svg: '<svg></svg>' })
      },
    }
    setDiagramRenderer(stub)

    const host = renderToDom(MERMAID_MD)
    const count = await hydratePendingDiagrams(host, {
      transformSvg: () => {
        throw new TypeError('TrustedHTML required')
      },
    })

    assert.equal(count, 0)
    assert.equal(renders, 1, 'no candidate retry after an injection failure')
    const diagram = host.querySelector('.mermaid-diagram')
    assert.ok(diagram?.classList.contains('mermaid-diagram--error'))
  })
})
