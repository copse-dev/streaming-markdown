// Property test for mid-stream display sanity. The convergence suite proves
// every streaming history reaches the same final render; this invariant
// constrains the frames along the way, where a regression can hide without
// changing the destination: the v0.5.0 table regression hid the header row
// and showed a table of literal dashes while the separator row streamed,
// then converged to a correct final table.
//
// Invariant — settled table content is never unwritten: a word (letter/digit
// run) shown inside rendered table structure (a <thead>, or a <tbody> row not
// marked pending) must stay visible in every later frame, provided the final
// render contains it. Rendering a table header or body row is a visual
// commitment; later keystrokes must not retract it.
//
// Why table structure, and not all visible text: mid-line frames morph by
// design — a half-arrived `\*` escape renders literally then becomes `*`,
// `[label](url…` echoes source then collapses to the label, emphasis opened
// on a previous line can retract its text while spanning a soft break. Table
// cells are different: the renderer only fills them with hold-filtered,
// settled inline content, so their words are contractually stable. Two
// guards keep the corpus noise-free:
// - Only words the final render contains are constrained, so a construct the
//   final render drops (e.g. a header-only "table" that dissolves back to a
//   paragraph under GFM spec 203) is exempt automatically — and a dissolved
//   table's text survives as paragraph text anyway, which the check accepts
//   since presence is asserted against the whole frame, not just tables.
// - Presence is a substring check on the frame's letters+digits, so a locked
//   word that later grows ("Blockty" locked mid-cell, then "Blocktype")
//   stays covered.
//
// The v0.5.0 regression fails this instantly: the header row's words
// ("Block", "type", "Pending", ...) had been rendered in a <thead> and exist
// in the final table, yet the moment `|-` of the delimiter row arrived the
// display showed only a dashes-only table.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'
import { loadGfmExtensionBaselineExamples } from '../tests/gfm/baseline-examples.ts'
import { streamingCutIndices } from '../tests/streaming-cuts.ts'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from './streaming.ts'

/** The demo site's mixed preset table section — the exact regression surface. */
const FIXTURES = [
  {
    name: 'demo mixed preset (mermaid fence + table + blockquote)',
    markdown: [
      '### Example: a mermaid diagram',
      '',
      '```mermaid',
      'flowchart LR',
      '    tokens[LLM tokens] --> split[splitForStreaming]',
      '    split --> committed[committed blocks]',
      '    split --> pending[pending tail]',
      '```',
      '',
      '| Block type | Pending class | Settled class |',
      '|------------|---------------|---------------|',
      '| Paragraph  | `stream-pending-paragraph` | `<p>` |',
      '| List item  | `stream-pending-list-item` | `<li>` |',
      '',
      '> "The best way to predict the future is to invent it."',
      '> — Alan Kay',
      '',
    ].join('\n'),
  },
]

const WORD_RE = /[\p{L}\p{N}]+/gu

/** Letters and digits only — the running text words are matched against. */
function readableText(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, '')
}

interface Frame {
  /** Letters+digits of all visible text. */
  full: string
  /** Words rendered inside settled table structure. */
  tableWords: string[]
}

function captureFrame(root: HTMLElement): Frame {
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('[hidden]').forEach((el) => el.remove())
  const full = readableText(clone.textContent ?? '')
  const tableWords: string[] = []
  clone.querySelectorAll('table thead, table tbody tr:not([class*="pending"])').forEach((el) => {
    tableWords.push(...((el.textContent ?? '').match(WORD_RE) ?? []))
  })
  return { full, tableWords }
}

function assertTableWordsPersist(
  frames: Frame[],
  cuts: number[],
  markdown: string,
  label: string,
): void {
  const finalFull = frames.at(-1)?.full ?? ''
  const locked = new Set<string>()
  for (let k = 0; k < frames.length; k++) {
    const frame = frames[k]
    const cut = cuts[k]
    assert.ok(frame && cut !== undefined)
    for (const word of locked) {
      assert.ok(
        frame.full.includes(word),
        `settled table word ${JSON.stringify(word)} was unwritten mid-stream — ${label} cut=${String(cut)} tail=${JSON.stringify(markdown.slice(Math.max(0, cut - 24), cut))} frame=${JSON.stringify(frame.full)}`,
      )
    }
    for (const word of frame.tableWords) {
      if (finalFull.includes(word)) locked.add(word)
    }
  }
}

interface CorpusEntry {
  label: string
  markdown: string
}

const corpus: CorpusEntry[] = [
  ...loadBaselinePassingExamples().map((ex) => ({
    label: `CommonMark #${String(ex.example)} (${ex.section})`,
    markdown: ex.markdown,
  })),
  ...loadGfmExtensionBaselineExamples().map((ex) => ({
    label: `GFM #${String(ex.example)} (${ex.section})`,
    markdown: ex.markdown,
  })),
  ...FIXTURES.map((f) => ({ label: f.name, markdown: f.markdown })),
]

describe('streaming display invariants (mid-stream frames)', () => {
  it('incremental DOM frames never unwrite settled table content', () => {
    for (const { label, markdown } of corpus) {
      const host = document.createElement('div')
      const renderer = new StreamingMarkdownRenderer(host)
      const cuts = streamingCutIndices(markdown)
      const frames = cuts.map((cut) => {
        renderer.update(markdown.slice(0, cut))
        return captureFrame(host)
      })
      assertTableWordsPersist(frames, cuts, markdown, `${label} [DOM]`)
    }
  })

  it('string API frames never unwrite settled table content', () => {
    for (const { label, markdown } of corpus) {
      const host = document.createElement('div')
      const cuts = streamingCutIndices(markdown)
      const frames = cuts.map((cut) => {
        host.innerHTML = renderStreamingMarkdown(markdown.slice(0, cut))
        return captureFrame(host)
      })
      assertTableWordsPersist(frames, cuts, markdown, `${label} [string]`)
    }
  })
})
