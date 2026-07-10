import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { StreamingMarkdownRenderer, splitForStreaming } from './streaming.ts'

/**
 * #110 — the streaming footnote path re-morphs only the reference blocks a new
 * definition changed plus the new section items, instead of full-re-morphing on
 * every commit. These tests pin its *correctness*: numbering, `fnref` ids, and
 * backrefs must match the one-shot render at EVERY committed state as definitions
 * stream in — the perf win must never renumber or mis-link a footnote.
 */

const atRest = (markdown: string): string =>
  sanitizeRenderedMarkdown(renderMarkdownUnsafe(markdown)).toString()

/** Committed HTML after feeding `markdown` one byte at a time (exercises every commit). */
function streamCharByChar(markdown: string): HTMLElement {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  for (let cut = 1; cut <= markdown.length; cut++) renderer.update(markdown.slice(0, cut))
  return host
}

/**
 * At every prefix whose split leaves nothing pending (a clean commit), the
 * incrementally-streamed committed subtree must equal the at-rest render of that
 * exact prefix. Streaming each prefix byte-by-byte drives the in-place footnote
 * upgrades and section freezing through many commits, so a numbering/backref bug
 * at any intermediate definition would surface here.
 */
function assertConvergesAtEveryCommit(markdown: string): void {
  for (let len = 1; len <= markdown.length; len++) {
    const prefix = markdown.slice(0, len)
    if (splitForStreaming(prefix).pending !== '') continue
    const host = streamCharByChar(prefix)
    const committed = host.querySelector('.stream-complete')?.innerHTML ?? ''
    assert.equal(committed, atRest(prefix), `prefix length ${String(len)}: ${JSON.stringify(prefix)}`)
  }
}

describe('footnote streaming stays correct as definitions arrive (#110)', () => {
  it('in-order definitions: each upgrades its reference and appends its section item', () => {
    assertConvergesAtEveryCommit(
      'A[^1] and B[^2] and C[^3].\n\n[^1]: first\n[^2]: second\n[^3]: third\n',
    )
  })

  it('scattered references across many paragraphs converge as their defs stream in', () => {
    const body = Array.from(
      { length: 5 },
      (_, i) => `Paragraph ${String(i)} cites a source.[^s${String(i)}]`,
    ).join('\n\n')
    const defs = Array.from({ length: 5 }, (_, i) => `[^s${String(i)}]: Source ${String(i)}.`).join(
      '\n',
    )
    assertConvergesAtEveryCommit(`${body}\n\n${defs}\n`)
  })

  it('out-of-order definitions renumber earlier references correctly', () => {
    // First-use order is b (pos 0) then a (pos 1): b→1, a→2. But `[^a]`'s
    // definition commits first, so `[^a]` is momentarily the only resolved
    // reference (number 1) until `[^b]`'s definition arrives and renumbers it.
    assertConvergesAtEveryCommit('First[^b] then[^a].\n\n[^a]: note A\n[^b]: note B\n')
  })

  it('repeated references keep distinct fnref ids and a single section item', () => {
    assertConvergesAtEveryCommit('One[^x], two[^x], three[^x].\n\n[^x]: shared source\n')
  })

  it('a footnote whose content references another footnote converges', () => {
    assertConvergesAtEveryCommit('See[^a] here.\n\n[^a]: refers on[^b]\n[^b]: the deeper note\n')
  })

  it('references mixed with an unrelated resolved footnote stay independently numbered', () => {
    assertConvergesAtEveryCommit(
      'Intro[^i] with a list:\n\n- item one[^one]\n- item two[^two]\n\n[^i]: intro\n[^one]: first\n[^two]: second\n',
    )
  })

  it('final streamed state equals the at-rest render for a large footnote document', () => {
    const paras = 30
    const body = Array.from(
      { length: paras },
      (_, i) => `Paragraph ${String(i)} makes a claim.[^${String(i)}]`,
    ).join('\n\n')
    const defs = Array.from(
      { length: paras },
      (_, i) => `[^${String(i)}]: Source number ${String(i)}.`,
    ).join('\n')
    const markdown = `${body}\n\n${defs}\n`
    const host = streamCharByChar(markdown)
    const committed = host.querySelector('.stream-complete')?.innerHTML ?? ''
    assert.equal(committed, atRest(markdown))
  })
})
