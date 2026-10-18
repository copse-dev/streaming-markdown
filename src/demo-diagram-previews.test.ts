import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDiagramPreviews, removeDiagramPreviews } from '../docs/diagram-previews.mjs'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'
import { hydratePendingDiagrams, type DiagramRenderer } from './mermaid.ts'
import { sanitizeDiagramSvg } from './sanitize-dompurify.ts'

const open = '```mermaid\ngraph LR\nA --> B\n'
const closed = open + '```\n\n'
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>Ready</text></svg>'

function previews(renderer: DiagramRenderer) {
  return createDiagramPreviews({
    hydrate: hydratePendingDiagrams, renderer, transformSvg: sanitizeDiagramSvg,
  })
}

describe('demo early diagram previews', () => {
  it('waits for fence closure in both emitters and preserves source for fidelity', async () => {
    for (const mode of ['string', 'dom']) {
      const root = document.createElement('div')
      const dom = new StreamingMarkdownRenderer(root)
      const update = (text: string) => {
        if (mode === 'dom') dom.update(text)
        else root.innerHTML = renderStreamingMarkdown(text)
      }
      let renders = 0
      const controller = previews({ render: async () => { renders++; return { svg } } })
      update(open)
      controller.update(root)
      await flush()
      assert.equal(renders, 0)
      update(closed + 'Still streaming')
      const before = root.innerHTML
      controller.update(root)
      await flush()
      assert.equal(renders, 1)
      assert.ok(root.querySelector('.diagram-preview-ready svg'))
      const normalized = root.cloneNode(true) as HTMLElement
      removeDiagramPreviews(normalized)
      assert.equal(normalized.innerHTML, before)

      const firstSvg = root.querySelector('svg')
      update(closed + 'Still streaming more text')
      controller.update(root)
      assert.ok(root.querySelector('svg'), 'cached preview restores synchronously')
      await flush()
      assert.equal(renders, 1, 'subsequent chunks do not render the diagram again')
      assert.equal(root.querySelector('svg'), firstSvg, 'reuse SVG in both emitters')
    }
  })

  it('drops stale async results when reset or edited', async () => {
    const root = document.createElement('div')
    let finish!: (value: { svg: string }) => void
    const controller = previews({ render: () => new Promise(resolve => { finish = resolve }) })
    root.innerHTML = renderStreamingMarkdown(closed)
    controller.update(root)
    await flush()
    root.innerHTML = '<p>New document</p>'
    controller.update(root)
    finish({ svg })
    await flush()
    assert.equal(root.innerHTML, '<p>New document</p>')
  })

  it('keeps the preview node through later block commits and reference resolution', async () => {
    const root = document.createElement('div')
    const dom = new StreamingMarkdownRenderer(root)
    const controller = previews({ render: async () => ({ svg }) })
    const prefix = 'Intro[^later].\n\n' + closed
    dom.update(prefix)
    controller.update(root)
    await flush()
    const first = root.querySelector('svg')
    assert.ok(first)
    const tail = 'A paragraph.\n\n- First\n- Second\n\n## Heading\n\n[^later]: Resolved definition.\n'
    for (let i = 1; i <= tail.length; i++) {
      dom.update(prefix + tail.slice(0, i))
      controller.update(root)
      assert.equal(root.querySelector('svg'), first, 'stable preview at suffix ' + JSON.stringify(tail.slice(0, i)))
    }
  })

  it('does not evict live previews in a long string-pane document', async () => {
    const root = document.createElement('div')
    let renders = 0
    const controller = previews({ render: async () => { renders++; return { svg } } })
    const documentText = closed.repeat(33)
    root.innerHTML = renderStreamingMarkdown(documentText)
    controller.update(root)
    await flush()
    assert.equal(renders, 33)
    root.innerHTML = renderStreamingMarkdown(documentText + 'More text')
    controller.update(root)
    assert.equal(root.querySelectorAll('.diagram-preview-output svg').length, 33)
    await flush()
    assert.equal(renders, 33)
  })

  it('deduplicates in-flight renders and sanitizes before showing the preview', async () => {
    const root = document.createElement('div')
    let finish!: (value: { svg: string }) => void
    let renders = 0
    const controller = previews({ render: () => {
      renders++
      return new Promise(resolve => { finish = resolve })
    } })
    root.innerHTML = renderStreamingMarkdown(closed)
    controller.update(root)
    await flush()
    root.innerHTML = renderStreamingMarkdown(closed + 'More')
    controller.update(root)
    finish({ svg: svg.replace('<text>', '<script>alert(1)</script><text onclick="alert(1)">') })
    await flush()
    assert.equal(renders, 1)
    assert.ok(root.querySelector('svg text'))
    assert.equal(root.querySelector('script, [onclick]'), null)
    assert.equal(root.querySelectorAll('.diagram-preview-output').length, 1)
  })

  it('retains reader-controlled expansion after string pane replacement', async () => {
    const root = document.createElement('div')
    const controller = previews({ render: async () => ({ svg }) })
    root.innerHTML = renderStreamingMarkdown(closed)
    controller.update(root)
    await flush()
    root.querySelector<HTMLButtonElement>('button')!.click()
    assert.ok(root.querySelector('.diagram-preview-expanded'))
    root.innerHTML = renderStreamingMarkdown(closed + 'More')
    controller.update(root)
    assert.equal(root.querySelector('button')?.getAttribute('aria-expanded'), 'true')
    root.querySelector<HTMLButtonElement>('button')!.click()
    assert.equal(root.querySelector('.diagram-preview-expanded'), null)
  })

  it('keeps failed source inert and avoids retrying it on every chunk', async () => {
    const root = document.createElement('div')
    let renders = 0
    const controller = previews({ render: async () => { renders++; throw new Error('bad diagram') } })
    root.innerHTML = renderStreamingMarkdown(closed)
    controller.update(root)
    await flush()
    const attempts = renders
    assert.ok(attempts > 0)
    assert.ok(root.querySelector('.diagram-preview-error pre.mermaid'))
    root.innerHTML = renderStreamingMarkdown(closed + 'More')
    controller.update(root)
    await flush()
    assert.equal(renders, attempts)
    assert.equal(root.querySelector('svg'), null)
  })
})
