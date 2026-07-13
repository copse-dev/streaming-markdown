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

  it('releases the settled leading definitions of an open blank-free run (ADR 0004 Phase 2)', () => {
    // While the run's last definition is still streaming, everything before it
    // is already unre-parseable (each def is followed by the next one's `[`
    // line, which can never be a title/destination continuation) and commits.
    const doc = 'body\n\n[a]: /a\n[b]: /b\n[c]: /c'
    const split = splitForStreaming(doc)
    assert.equal(split.complete, 'body\n\n[a]: /a\n[b]: /b\n')
    assert.equal(split.pending, '[c]: /c')
  })

  it('holds a single-definition open run in full (nothing settled yet)', () => {
    const split = splitForStreaming('body\n\n[only]: /still-streaming')
    assert.equal(split.complete, 'body\n\n')
    assert.equal(split.pending, '[only]: /still-streaming')
  })

  it('holds a multi-line last definition (destination on its own line) whole', () => {
    // The final definition can span lines (spec 193/217); only IT stays
    // pending — the settled leading definition still commits.
    const split = splitForStreaming('[a]: /a\n[b]:\n/dest-on-next-line')
    assert.equal(split.complete, '[a]: /a\n')
    assert.equal(split.pending, '[b]:\n/dest-on-next-line')
  })

  it('never retreats `complete` while a blank-free definition run streams in', () => {
    // The old hold released the whole run when its last line terminated and
    // re-held it when the next definition started parsing, so `complete`
    // oscillated past every committed definition. Monotonicity is the pin.
    const doc = `cites [a] and [b] and [c]\n\n[a]: /a\n[b]: /b\n[c]: /c\n\nend\n\n`
    let lastComplete = ''
    for (let cut = 1; cut <= doc.length; cut++) {
      const { complete } = splitForStreaming(doc.slice(0, cut))
      assert.ok(
        complete.startsWith(lastComplete),
        `complete retreated at cut=${String(cut)}: ${JSON.stringify(lastComplete)} -> ${JSON.stringify(complete)}`,
      )
      lastComplete = complete
    }
  })

  it('a blank-free definition run at the bottom stays on the targeted-patch path', () => {
    // keepachangelog shape: every section cites its version label and the
    // definitions sit at the bottom joined by single newlines (one blank-free
    // run). The old whole-run hold flipped the committed map once per
    // definition line — each flip a bounded full morph, since most frozen
    // parts cite a label. With the leading definitions released as they
    // settle, each arrival changes ONE label and lands on the targeted patch
    // path; parity is asserted at every commit by streamAsserting.
    const sections = Array.from(
      { length: 8 },
      (_, i) => `## [v0.${String(i)}]\n\nRelease notes citing [v0.${String(i)}] here.`,
    ).join('\n\n')
    const defs = Array.from({ length: 8 }, (_, i) => `[v0.${String(i)}]: /releases/v0.${String(i)}`).join('\n')
    const md = `${sections}\n\n${defs}\n`
    const ft = streamAsserting(md, 3)
    assert.ok(
      ft.linkRefPatchCommits >= 7,
      `expected a targeted patch per settled definition, got ${String(ft.linkRefPatchCommits)}`,
    )
    const wholeDoc = String(renderMarkdown(splitForStreaming(md).complete)).length
    assert.ok(
      ft.renderedChars < wholeDoc * 4,
      `blank-free run rendered ${String(ft.renderedChars)} chars for a ${String(wholeDoc)}-char document — ` +
        'the whole-run hold would full-morph per definition line and blow past this bound',
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
