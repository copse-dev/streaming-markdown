// Limitation-J narrowing: a committed link-ref map change full-morphs ONLY
// when it can actually rewrite frozen output. An added definition whose label
// was never seen among the frozen source's bracketed spans is inert — the
// commit stays on the fast path — while a referenced label, a value change
// (e.g. a title still streaming in), or an escaped-label match keeps the
// upgrade behaviour byte-identical to the whole-string render.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { splitForStreaming } from './streaming-split.ts'
import type { FrozenTailRenderer } from './streaming-frozen-tail.ts'

function completeEl(host: HTMLElement): HTMLElement {
  const el = host.querySelector('.stream-complete')
  assert.ok(el instanceof HTMLElement, 'stream-complete host exists')
  return el
}

/** Stream chunk-by-chunk asserting whole-string parity; returns renderedChars. */
function streamAsserting(md: string, step = 4): number {
  const host = document.createElement('div')
  const scratch = document.createElement('div')
  const r = new StreamingMarkdownRenderer(host)
  for (let cut = step; cut <= md.length + step; cut += step) {
    const prefix = md.slice(0, Math.min(cut, md.length))
    r.update(prefix)
    const split = splitForStreaming(prefix)
    if (split.pending !== '') continue
    scratch.innerHTML = String(renderMarkdown(split.complete))
    assert.equal(completeEl(host).innerHTML, scratch.innerHTML, `cut=${String(Math.min(cut, md.length))}`)
  }
  const frozenTail = (r as unknown as { frozenTail: FrozenTailRenderer }).frozenTail
  return frozenTail.renderedChars
}

const paragraphs = (n: number): string =>
  Array.from({ length: n }, (_, i) => `Paragraph ${String(i)} with **bold** and \`code\`.`).join('\n\n')

describe('link-ref definition arrival (limitation J narrowing)', () => {
  it('a late definition still upgrades earlier literal references, byte-identically', () => {
    const md = `see [the spec] here\n\n${paragraphs(4)}\n\n[the spec]: https://example.com "T"\n\nafter\n\n`
    streamAsserting(md)
  })

  it('a definition with a streaming title (value change mid-stream) stays byte-identical', () => {
    // While the title's closing quote has not arrived, the def parses
    // differently across commits — a value change, never treated as inert.
    const md = `use [x] twice [x]\n\n[x]: /url "a long streaming title"\n\ntrailer paragraph\n\n`
    streamAsserting(md, 3)
  })

  it('an escaped-label reference still matches its late definition', () => {
    const md = `ref [foo\\!] here\n\n${paragraphs(3)}\n\n[foo!]: /u\n\nafter\n\n`
    streamAsserting(md)
  })

  it('unreferenced definitions skip the full morph (rendered-chars guard)', () => {
    // Same size and def count; only difference: the frozen prefix references
    // the labels (forcing upgrades) or never mentions them (inert). The
    // referenced variant must re-render the document per def arrival; the
    // inert variant must not — the gap is the limitation-J saving.
    const defs = Array.from({ length: 6 }, (_, i) => `[label-${String(i)}]: /url-${String(i)}`).join('\n\n')
    const inert = `${paragraphs(8)}\n\n${defs}\n\ntrailer here\n\n`
    const referenced =
      Array.from({ length: 8 }, (_, i) => `Paragraph ${String(i)} uses [label-${String(i % 6)}] now.`).join('\n\n') +
      `\n\n${defs}\n\ntrailer here\n\n`
    const inertChars = streamAsserting(inert)
    const referencedChars = streamAsserting(referenced)
    assert.ok(
      inertChars * 2 < referencedChars,
      `inert defs rendered ${String(inertChars)} chars vs ${String(referencedChars)} referenced — expected a large gap (full morphs skipped)`,
    )
  })
})
