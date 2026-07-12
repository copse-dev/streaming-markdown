// Limitation-J narrowing: a committed link-ref map change full-morphs ONLY
// when it can actually rewrite frozen output. An added definition whose label
// was never seen among the frozen source's bracketed spans is inert — the
// commit stays on the fast path — and a definition whose label IS referenced
// by frozen content is absorbed as a targeted per-part patch (ADR 0004
// Phase 2), while a value change (e.g. a title still streaming in) keeps the
// full-morph upgrade behaviour byte-identical to the whole-string render.
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

/** Stream chunk-by-chunk asserting whole-string parity; returns the frozen-tail diagnostics. */
function streamAsserting(md: string, step = 4): FrozenTailRenderer {
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
  return (r as unknown as { frozenTail: FrozenTailRenderer }).frozenTail
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
    // The inert path: none of the frozen bracketed spans matches a new label,
    // so def arrivals neither full-morph nor patch — rendered work stays at
    // the O(n) streaming baseline (well under one extra whole-document
    // re-render per definition).
    const defs = Array.from({ length: 6 }, (_, i) => `[label-${String(i)}]: /url-${String(i)}`).join('\n\n')
    const inert = `${paragraphs(8)}\n\n${defs}\n\ntrailer here\n\n`
    const ft = streamAsserting(inert)
    assert.equal(ft.linkRefPatchCommits, 0, 'no frozen span matches — nothing to patch')
    const wholeDoc = String(renderMarkdown(splitForStreaming(inert).complete)).length
    assert.ok(
      ft.renderedChars < wholeDoc * 4,
      `inert defs rendered ${String(ft.renderedChars)} chars for a ${String(wholeDoc)}-char document — ` +
        'a full morph per definition would blow well past this bound',
    )
  })

  it('referenced definitions patch only the citing parts, not the whole document (ADR 0004)', () => {
    // Six definitions, each referenced by one earlier paragraph. Every
    // arrival used to full-morph the entire committed prefix (the remaining
    // limitation-J cliff); now each is a targeted per-part patch, so total
    // rendered work stays near the O(n) baseline while output remains
    // byte-identical at every commit (streamAsserting checks parity).
    const defs = Array.from({ length: 6 }, (_, i) => `[label-${String(i)}]: /url-${String(i)}`).join('\n\n')
    const referenced =
      Array.from({ length: 8 }, (_, i) => `Paragraph ${String(i)} uses [label-${String(i % 6)}] now.`).join('\n\n') +
      `\n\n${defs}\n\ntrailer here\n\n`
    const ft = streamAsserting(referenced)
    assert.ok(
      ft.linkRefPatchCommits >= 6,
      `expected a targeted patch per definition arrival, got ${String(ft.linkRefPatchCommits)}`,
    )
    const wholeDoc = String(renderMarkdown(splitForStreaming(referenced).complete)).length
    assert.ok(
      ft.renderedChars < wholeDoc * 4,
      `referenced defs rendered ${String(ft.renderedChars)} chars for a ${String(wholeDoc)}-char document — ` +
        'expected targeted patches, not a full morph per definition',
    )
  })
})
