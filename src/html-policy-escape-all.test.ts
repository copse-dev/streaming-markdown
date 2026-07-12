// `htmlPolicy: 'escape-all'`: every raw tag literalizes except the void
// `<br>`, so markdown text can never form an element — which retires the
// streaming path's raw tag-balance guards. These tests pin the policy's
// rendering semantics, the streaming byte-parity, and the performance
// contract that motivates it: the shapes that are fallback cliffs under the
// other policies (an unclosed `<b>`, an unclosed `<details>`) stream in O(n).
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, renderMarkdownUnsafe } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { splitForStreaming } from './streaming-split.ts'
import type { MarkdownConfig } from './config.ts'
import type { FrozenTailRenderer } from './streaming-frozen-tail.ts'

const CFG: MarkdownConfig = { htmlPolicy: 'escape-all' }

function completeEl(host: HTMLElement): HTMLElement {
  const el = host.querySelector('.stream-complete')
  assert.ok(el instanceof HTMLElement, 'stream-complete host exists')
  return el
}

/** Stream chunk-by-chunk asserting whole-string parity; returns renderedChars. */
function streamAsserting(md: string, config: MarkdownConfig, step = 3): number {
  const host = document.createElement('div')
  const scratch = document.createElement('div')
  const r = new StreamingMarkdownRenderer(host, config)
  for (let cut = step; cut <= md.length + step; cut += step) {
    const prefix = md.slice(0, Math.min(cut, md.length))
    r.update(prefix)
    const split = splitForStreaming(prefix)
    if (split.pending !== '') continue
    scratch.innerHTML = String(renderMarkdown(split.complete, config))
    assert.equal(completeEl(host).innerHTML, scratch.innerHTML, `cut=${String(Math.min(cut, md.length))}`)
  }
  const frozenTail = (r as unknown as { frozenTail: FrozenTailRenderer }).frozenTail
  return frozenTail.renderedChars
}

const paragraphs = (n: number, label: string): string =>
  Array.from({ length: n }, (_, i) => `Paragraph ${label}-${String(i)} with **bold** and \`code\`.`).join('\n\n')

describe("htmlPolicy: 'escape-all'", () => {
  it('literalizes every raw tag, including the benign inline set', () => {
    const html = renderMarkdownUnsafe('a <b>bold</b> tag, <kbd>K</kbd>, and a <details> block\n', CFG)
    assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/)
    assert.match(html, /&lt;kbd&gt;K&lt;\/kbd&gt;/)
    assert.match(html, /&lt;details&gt;/)
    assert.doesNotMatch(html, /<(?:b|kbd|details)>/)
  })

  it('keeps the void <br> and the renderer’s own markup', () => {
    const html = renderMarkdownUnsafe('line one<br>line two with **bold** and a [link](https://example.com)\n', CFG)
    assert.match(html, /<br>/)
    assert.match(html, /<strong>bold<\/strong>/)
    assert.match(html, /<a href="https:\/\/example\.com"/)
  })

  it("leaves 'escape' behaviour untouched (benign inline still passes there)", () => {
    const html = renderMarkdownUnsafe('a <b>bold</b> tag\n', { htmlPolicy: 'escape' })
    assert.match(html, /<b>bold<\/b>/)
  })

  it('streams an unclosed <b> with byte-parity and no fallback (the reconstruction cliff)', () => {
    // Under 'passthrough' and 'escape' an unclosed benign inline tag is
    // terminally unfreezable (formatting-element reconstruction); under
    // escape-all it is literal text and must stream in O(n).
    const clean = streamAsserting(`${paragraphs(24, 'x')}\n\n`, CFG)
    const openB = streamAsserting(`before <b>bold\n\n${paragraphs(22, 'y')}\n\n`, CFG)
    assert.ok(openB / clean < 2, `open <b> rendered ${(openB / clean).toFixed(1)}× a clean stream (fallback regressed)`)
  })

  it('streams an unclosed <details> with byte-parity and no hold, no frames', () => {
    const md = `${paragraphs(2, 'a')}\n\n<details>\n\n${paragraphs(5, 'b')}\n\npending tail here`
    const host = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host, CFG)
    for (let cut = 4; cut <= md.length + 4; cut += 4) r.update(md.slice(0, Math.min(cut, md.length)))
    // Literal text — no element, so the #138 hold must NOT engage: the
    // pending tail stays visible like any other prose.
    const pendingText = [...host.querySelectorAll('.stream-pending-block, .stream-pending:not([hidden])')]
      .map((el) => el.textContent ?? '')
      .join('')
    assert.match(pendingText, /pending tail here/)
    assert.match(completeEl(host).textContent ?? '', /<details>/)
  })

  it('replays mixed raw-HTML content byte-identically at every commit', () => {
    const md = [
      'intro with <span class="x">attributed</span> and <b>benign\n',
      '\n',
      '<div>\n',
      '\n',
      'text after the div line with <br> break\n',
      '\n',
      '```\n<details> inside a fence stays code\n```\n',
      '\n',
      'closing paragraph </div> with the stray close\n',
      '\n',
    ].join('')
    streamAsserting(md, CFG)
  })
})
