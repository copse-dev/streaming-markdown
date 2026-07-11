import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'

// #150: streaming-convergence.test.ts compares only the FINAL committed state of
// the two emitters — which is exactly why the `<details>` desync (#138) slipped
// through: the divergence existed only while the tail was unsettled. This drives
// both emitters through the same cumulative prefixes and asserts, at every cut,
// that the DOM emitter never COMMITS (reveals as settled) content the string
// emitter is still holding.
//
// The invariant is stated on the committed region deliberately. Both emitters
// also render a forming/pending PREVIEW of the unsettled tail, and those may be
// formatted differently (e.g. a forming table's separator row) without either
// being wrong — that is not a leak. The #138 class of bug is the DOM settling
// held content into `.stream-complete`, so the check is: everything the DOM has
// committed must appear somewhere in the string emitter's visible output.

const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** Visible text the string emitter shows (committed + forming/pending preview, minus hidden). */
function stringVisible(html: string): string {
  const d = document.createElement('div')
  d.innerHTML = html
  for (const el of [...d.querySelectorAll('[hidden]')]) el.remove()
  return norm(d.textContent)
}

/** Text the DOM emitter has COMMITTED (settled into `.stream-complete`). */
function domCommitted(host: HTMLElement): string {
  return norm(host.querySelector('.stream-complete')?.textContent)
}

/** Drive both emitters through cumulative prefixes; return the first leaking cut, or null. */
function firstLeak(input: string, step: number): { cut: number; committed: string; shown: string } | null {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  for (let i = 1; i <= input.length; i += step) {
    const prefix = input.slice(0, i)
    renderer.update(prefix)
    const committed = domCommitted(host)
    const shown = stringVisible(renderStreamingMarkdown(prefix))
    if (committed && !shown.includes(committed)) return { cut: i, committed, shown }
  }
  return null
}

// The tail-holding shapes: an open `<details>` (the #138 case), an open fence, a
// half-formed table, plus other unsettled-tail constructs. Stepped char-by-char.
const TARGETED: { name: string; input: string }[] = [
  { name: 'open <details> with soft-broken body', input: '<details>\n<summary>Title</summary>\nheld body text' },
  { name: 'open <details> (blank-line body)', input: '<details>\n<summary>S</summary>\n\nheld paragraph' },
  { name: 'open fenced code block', input: '```js\nconst secret = compute()' },
  { name: 'half-formed table', input: '| a | b |\n| - | - |\n| 1 | 2' },
  { name: 'open blockquote continuation', input: '> quote start\nlazy continuation line' },
  { name: 'forming list item', input: '- one\n- two\n- thre' },
  { name: 'late footnote definition', input: 'cite[^1] here\n\nmore text\n\n[^1]: the note' },
  { name: 'unclosed bold then more', input: 'text **bold and then more words following' },
  { name: 'open inline raw html div', input: 'before <div class="x">held content inside' },
]

describe('mid-stream string/DOM emitter parity (#150)', () => {
  for (const { name, input } of TARGETED) {
    it(`${name}: DOM never commits held content`, () => {
      const leak = firstLeak(input, 1)
      assert.equal(
        leak,
        null,
        leak
          ? `cut ${leak.cut}: DOM committed ${JSON.stringify(leak.committed)} but the string emitter only shows ${JSON.stringify(leak.shown)}`
          : 'parity held',
      )
    })
  }

  it('holds parity across a sample of the CommonMark baseline corpus', () => {
    // Broad net over real documents (stepped, not char-by-char, to stay quick).
    const corpus = loadBaselinePassingExamples()
      .filter((e) => e.markdown.length >= 12 && e.markdown.length <= 300)
      .slice(0, 80)
    const failures: string[] = []
    for (const ex of corpus) {
      const leak = firstLeak(ex.markdown, 3)
      if (leak) failures.push(`example #${String(ex.example)} @cut ${leak.cut}: committed ${JSON.stringify(leak.committed)} ∉ ${JSON.stringify(leak.shown)}`)
    }
    assert.deepEqual(failures, [])
  })
})
