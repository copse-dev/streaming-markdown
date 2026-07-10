// #30: incremental tokenization + link-ref scanning must be indistinguishable
// from fresh full-string scans — at every prefix of an append-only stream, and
// after rewrites/retreats (which reset the cache). The equivalence oracle is
// exact deep-equality against `tokenizeBlocks` / `collectLinkReferenceDefinitions`.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'
import { IncrementalSourceScanner } from './incremental-scan.ts'
import { collectLinkReferenceDefinitions, tokenizeBlocks } from './block-tokenizer.ts'

function assertScannerMatchesFresh(scanner: IncrementalSourceScanner, source: string, ctx: string): void {
  assert.deepEqual(scanner.tokenize(source), tokenizeBlocks(source), `tokens ${ctx}`)
  assert.deepEqual(
    new Map(scanner.linkRefs(source)),
    new Map(collectLinkReferenceDefinitions(source)),
    `linkRefs ${ctx}`,
  )
}

describe('IncrementalSourceScanner equivalence', () => {
  it('matches fresh scans at every prefix of every baseline example', () => {
    for (const ex of loadBaselinePassingExamples()) {
      const scanner = new IncrementalSourceScanner()
      for (let cut = 1; cut <= ex.markdown.length; cut++) {
        assertScannerMatchesFresh(
          scanner,
          ex.markdown.slice(0, cut),
          `example #${String(ex.example)} cut=${String(cut)}`,
        )
      }
    }
  })

  it('matches fresh scans through the blank-crossing hazards', () => {
    // Every construct whose token can extend backward across blank lines (the
    // safe-boundary exclusions), plus multi-line ref defs and a fenced block
    // containing a fake definition — the shapes that would break a naive
    // resume-at-any-blank rule.
    const doc = [
      'intro paragraph\n',
      '\n',
      '- item one\n',
      '\n',
      '  continuation of item one after a blank\n', // list_item token spans the blank
      '- item two\n',
      '\n',
      '    indented code\n',
      '\n',
      '    same code block after blank\n', // indented_code token spans the blank
      '\n',
      '> quote\n',
      '\n',
      '> same quote token after blank\n', // blockquote token spans the blank
      '\n',
      '[ml]: https://example.com\n',
      '   "a title on the next line"\n', // multi-line ref def
      '\n',
      '```\n',
      '[fake]: https://inside-fence.example\n',
      '```\n',
      '\n',
      'Heading\n',
      '===\n',
      '\n',
      '| A | B |\n',
      '| - | - |\n',
      '| 1 | 2 |\n',
      '\n',
      'closing paragraph with a [used][ml] reference\n',
      '\n',
    ].join('')
    const scanner = new IncrementalSourceScanner()
    for (let cut = 1; cut <= doc.length; cut++) {
      assertScannerMatchesFresh(scanner, doc.slice(0, cut), `hazard doc cut=${String(cut)}`)
    }
  })

  it('resets on an in-place rewrite and on a retreating snapshot', () => {
    const scanner = new IncrementalSourceScanner()
    const alpha = '# Alpha\n\npara one\n\n- a\n- b\n\n'
    for (let cut = 1; cut <= alpha.length; cut++) scanner.tokenize(alpha.slice(0, cut))
    // Rewrite: same shape, different bytes in the cached prefix.
    assertScannerMatchesFresh(scanner, '# Bravo\n\npara one\n\n- a\n- b\n\n', 'rewrite')
    // Retreat: shorter than the retained safe prefix.
    assertScannerMatchesFresh(scanner, '# Bravo\n', 'retreat')
    // And growth resumes incrementally afterwards.
    assertScannerMatchesFresh(scanner, '# Bravo\n\nmore\n\n', 'regrow')
  })

  it('re-tokenizes O(n) total characters over an append-only stream (#30 CI guard)', () => {
    // Deterministic, timing-free: scannedChars counts what was actually
    // re-tokenized. Without resume this is Θ(n²) (~4× per doubling); with it,
    // doubling the document roughly doubles the total.
    function scannedFor(paras: number): number {
      const doc =
        Array.from(
          { length: paras },
          (_, i) => `Paragraph ${String(i)} with **bold**, \`code\` and a [link](https://e.com/${String(i)}).`,
        ).join('\n\n') + '\n'
      const scanner = new IncrementalSourceScanner()
      for (let cut = 1; cut <= doc.length; cut++) scanner.tokenize(doc.slice(0, cut))
      return scanner.scannedChars
    }
    const small = scannedFor(30)
    const large = scannedFor(60)
    const ratio = large / small
    assert.ok(
      ratio < 3,
      `re-tokenized chars grew ${ratio.toFixed(2)}× when input doubled (expected ~2×; ~4× = resume regression)`,
    )
  })

  it('matches fresh scans at every prefix of long list- and blockquote-shaped streams (#111)', () => {
    // The LLM answer shape: loose ordered/unordered lists and quotes. The
    // extendable-container boundary relaxation must stay byte-identical to a
    // fresh scan through loose lists, lazy continuations and interior blanks.
    const docs: Record<string, string> = {
      'ordered-loose':
        Array.from({ length: 12 }, (_, i) => `${String(i + 1)}. **Point ${String(i + 1)}** with \`code_${String(i)}\` and text.`).join('\n\n') + '\n',
      'unordered-loose':
        Array.from({ length: 12 }, (_, i) => `- **Point ${String(i + 1)}** with \`code_${String(i)}\` and text.`).join('\n\n') + '\n',
      'ordered-prose-fold':
        '1. First point.\n\nProse folded into item one for the LLM numbered-list shape.\n\n2. Second point.\n\n3. Third point.\n',
      'blockquote-lazy':
        '> quote start\n' + Array.from({ length: 12 }, (_, i) => `lazy continuation line ${String(i)}`).join('\n') + '\n> back to marked\n\naftermath paragraph\n',
      'blockquote-paras':
        Array.from({ length: 8 }, (_, i) => `> Quote paragraph ${String(i)} with \`code_${String(i)}\`.`).join('\n\n') + '\n',
      'loose-list-continuation':
        '- item one\n\n  continuation of item one across a blank\n\n- item two\n\n- item three\n',
    }
    for (const [name, doc] of Object.entries(docs)) {
      const scanner = new IncrementalSourceScanner()
      for (let cut = 1; cut <= doc.length; cut++) {
        assertScannerMatchesFresh(scanner, doc.slice(0, cut), `${name} cut=${String(cut)}`)
      }
    }
  })

  it('re-tokenizes list- and blockquote-shaped streams O(n), comparable to prose (#111)', () => {
    // Before #111 a loose list or quote re-tokenized from its container top on
    // every update — ~40-140× the prose baseline. The boundary now advances
    // per item/quote, so the total stays a small multiple of the prose case.
    function scannedFor(build: (n: number) => string, n: number): number {
      const doc = build(n)
      const scanner = new IncrementalSourceScanner()
      for (let cut = 1; cut <= doc.length; cut++) scanner.tokenize(doc.slice(0, cut))
      return scanner.scannedChars
    }
    const prose = (n: number): string =>
      Array.from({ length: n }, (_, i) => `Paragraph ${String(i)} with \`code_${String(i)}\` and a bit of text here.`).join('\n\n') + '\n'
    const ordered = (n: number): string =>
      Array.from({ length: n }, (_, i) => `${String(i + 1)}. Point ${String(i)} with \`code_${String(i)}\` and a bit of text here.`).join('\n\n') + '\n'
    const unordered = (n: number): string =>
      Array.from({ length: n }, (_, i) => `- Point ${String(i)} with \`code_${String(i)}\` and a bit of text here.`).join('\n\n') + '\n'
    const quotes = (n: number): string =>
      Array.from({ length: n }, (_, i) => `> Quote ${String(i)} with \`code_${String(i)}\` and a bit of text here.`).join('\n\n') + '\n'

    const proseChars = scannedFor(prose, 40)
    for (const [name, build] of [
      ['ordered', ordered],
      ['unordered', unordered],
      ['quotes', quotes],
    ] as const) {
      const chars = scannedFor(build, 40)
      const ratio = chars / proseChars
      // Comfortably below the pre-fix ~40-140×; a container-top rescan regression
      // would blow past this immediately.
      assert.ok(
        ratio < 8,
        `${name} re-tokenized ${ratio.toFixed(1)}× the prose baseline (expected a small multiple; container-top rescan regressed)`,
      )
      // O(n): doubling the document roughly doubles the total, not quadruples it.
      const small = scannedFor(build, 20)
      const large = scannedFor(build, 40)
      const growth = large / small
      assert.ok(
        growth < 3,
        `${name} scanned chars grew ${growth.toFixed(2)}× when doubled (expected ~2×; super-linear = boundary regression)`,
      )
    }
  })
})
