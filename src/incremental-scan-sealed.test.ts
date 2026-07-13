// ADR 0004 Phase 1: the sealed-block event stream must be a pure re-statement
// of what full scans already prove — sealed tokens are exactly the safe prefix
// (fired once, in document order, never retreating), the definition deltas
// reconstruct the collectors' maps, and a rewrite voids everything explicitly.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'
import { IncrementalSourceScanner } from './incremental-scan.ts'
import {
  collectFootnoteDefinitions,
  collectLinkReferenceDefinitions,
  tokenizeBlocks,
  type BlockToken,
} from './block-tokenizer.ts'
import { withConfig } from './config.ts'

/** Replay `doc` prefix-by-prefix, asserting the ScanAdvance contract at each cut. */
function replayAsserting(doc: string, ctx: string): void {
  const scanner = new IncrementalSourceScanner()
  const sealedAcc: BlockToken[] = []
  let prevFormingFrom = 0
  for (let cut = 1; cut <= doc.length; cut++) {
    const source = doc.slice(0, cut)
    const step = scanner.advance(source)
    const where = `${ctx} cut=${String(cut)}`

    // Token equivalence: the full array is what a fresh scan produces.
    assert.deepEqual(step.tokens, tokenizeBlocks(source), `tokens ${where}`)
    assert.equal(step.reset, false, `unexpected reset ${where}`)

    // Monotone seal: the boundary never retreats, each sealed token fires once,
    // and the accumulated events are exactly the sealed prefix.
    assert.ok(step.formingFrom >= prevFormingFrom, `formingFrom retreated ${where}`)
    assert.equal(step.sealed.length, step.formingFrom - prevFormingFrom, `sealed count ${where}`)
    prevFormingFrom = step.formingFrom
    sealedAcc.push(...step.sealed)
    assert.deepEqual(sealedAcc, step.tokens.slice(0, step.formingFrom), `sealed prefix ${where}`)

    // The verified prefix is exactly the sealed region's source extent — the
    // append-only promise consumers (the commit path's prefix trust, ADR 0004
    // Phase 2) ride on.
    assert.equal(
      step.verifiedUpTo,
      step.tokens[step.formingFrom - 1]?.end ?? 0,
      `verifiedUpTo ${where}`,
    )

    // Definition views equal the full collectors at every prefix.
    assert.deepEqual(
      new Map(scanner.footnoteDefs(source)),
      new Map(collectFootnoteDefinitions(source)),
      `footnoteDefs ${where}`,
    )
    assert.deepEqual(
      new Map(scanner.linkRefs(source)),
      new Map(collectLinkReferenceDefinitions(source)),
      `linkRefs ${where}`,
    )
  }
}

describe('sealed-block event stream (ADR 0004 Phase 1)', () => {
  const hazardDoc = [
    'intro paragraph\n',
    '\n',
    'uses a footnote[^a] and a [ref] link\n',
    '\n',
    '- item one\n',
    '\n',
    '  continuation of item one after a blank\n',
    '- item two\n',
    '\n',
    '[^a]: footnote body line\n',
    '\n',
    '    indented continuation of the footnote after a blank\n',
    '\n',
    'settling paragraph\n',
    '\n',
    '[ref]: https://example.com "title"\n',
    '\n',
    '> quote\n',
    '\n',
    '> same quote token after blank\n',
    '\n',
    '```\n',
    '[fake]: https://inside-fence.example\n',
    '[^fake]: not a footnote\n',
    '```\n',
    '\n',
    'closing paragraph\n',
    '\n',
  ].join('')

  it('replays the definition/extendable-container hazards byte-identically', () => {
    replayAsserting(hazardDoc, 'hazard doc')
  })

  it('replays a sample of baseline examples byte-identically', () => {
    // The full baseline corpus is covered by incremental-scan.test.ts; here a
    // deterministic sample keeps the per-cut event assertions affordable.
    const examples = loadBaselinePassingExamples().filter((_, i) => i % 25 === 0)
    for (const ex of examples) {
      replayAsserting(ex.markdown, `example #${String(ex.example)}`)
    }
  })

  it('seals each token exactly once across a chunked replay', () => {
    const scanner = new IncrementalSourceScanner()
    const seen: BlockToken[] = []
    for (let cut = 7; cut <= hazardDoc.length + 7; cut += 7) {
      const step = scanner.advance(hazardDoc.slice(0, Math.min(cut, hazardDoc.length)))
      seen.push(...step.sealed)
    }
    const final = tokenizeBlocks(hazardDoc)
    // Every sealed token is a token of the final document at the same span
    // (sealed means final: no later append may change it), with no duplicates.
    const spans = new Set<string>()
    for (const token of seen) {
      const key = `${String(token.start)}:${String(token.end)}`
      assert.ok(!spans.has(key), `token sealed twice at ${key}`)
      spans.add(key)
      assert.deepEqual(
        final.find((t) => t.start === token.start),
        token,
        `sealed token diverges from final document at ${key}`,
      )
    }
  })

  it('reports sealed definition deltas that reconstruct the collectors', () => {
    const scanner = new IncrementalSourceScanner()
    const refs = new Map<string, unknown>()
    const defs = new Map<string, unknown>()
    let sealedEnd = 0
    for (let cut = 5; cut <= hazardDoc.length + 5; cut += 5) {
      const source = hazardDoc.slice(0, Math.min(cut, hazardDoc.length))
      const step = scanner.advance(source)
      for (const [label, ref] of step.sealedLinkRefs) {
        assert.ok(!refs.has(label), `link ref '${label}' sealed twice`)
        refs.set(label, ref)
      }
      for (const [label, def] of step.sealedFootnoteDefs) {
        assert.ok(!defs.has(label), `footnote def '${label}' sealed twice`)
        defs.set(label, def)
      }
      const lastSealed = step.tokens[step.formingFrom - 1]
      sealedEnd = lastSealed ? lastSealed.end : 0
      // The accumulated deltas are exactly the collectors over the sealed prefix.
      const sealedPrefix = source.slice(0, sealedEnd)
      assert.deepEqual(new Map(refs), new Map(collectLinkReferenceDefinitions(sealedPrefix)))
      assert.deepEqual(new Map(defs), new Map(collectFootnoteDefinitions(sealedPrefix)))
    }
    // The stream ends with both definitions sealed.
    assert.ok(refs.has('REF') || refs.size === 1, 'link ref never sealed')
    assert.equal(defs.size, 1, 'footnote def never sealed')
  })

  it('flags a rewrite with reset=true and restarts the event stream', () => {
    const scanner = new IncrementalSourceScanner()
    const alpha = '# Alpha\n\npara one\n\n[r]: /a\n\nsettled\n\n'
    let sealedCount = 0
    for (let cut = 1; cut <= alpha.length; cut++) {
      const step = scanner.advance(alpha.slice(0, cut))
      assert.equal(step.reset, false)
      sealedCount += step.sealed.length
    }
    assert.ok(sealedCount > 0, 'nothing sealed in the append-only run')

    const bravo = '# Bravo\n\npara one\n\n[r]: /a\n\nsettled\n\n'
    const step = scanner.advance(bravo)
    assert.equal(step.reset, true, 'rewrite must be flagged')
    // After the reset the stream restarts from zero: the sealed events plus the
    // forming region again cover the whole document.
    assert.deepEqual(step.tokens, tokenizeBlocks(bravo))
    assert.deepEqual(step.sealed, step.tokens.slice(0, step.formingFrom))
  })

  it('falls back to a full scan when footnoteDefs is asked about a different string', () => {
    const scanner = new IncrementalSourceScanner()
    const doc = 'text[^a]\n\n[^a]: note\n\nsettled paragraph\n\nafter\n\n'
    scanner.advance(doc)
    const other = 'other[^z]\n\n[^z]: zzz\n\nsettled paragraph\n\nafter\n\n'
    assert.deepEqual(new Map(scanner.footnoteDefs(other)), new Map(collectFootnoteDefinitions(other)))
  })

  it('definition views fall back correctly for strings other than the last advance', () => {
    const scanner = new IncrementalSourceScanner()
    const doc = 'uses [r] and a note[^f]\n\n[r]: /url\n\nsettled paragraph\n\nafter\n\n'
    scanner.advance(doc)
    // Appended-but-not-yet-advanced snapshot: shares the safe prefix (sealed
    // maps reusable) but the cached tokens are stale — the suffix must be
    // scanned fresh, not read from tokens.
    const extended = doc + '[^f]: late footnote\n\n[late]: /late\n\ncloser\n\n'
    assert.deepEqual(new Map(scanner.linkRefs(extended)), new Map(collectLinkReferenceDefinitions(extended)))
    assert.deepEqual(new Map(scanner.footnoteDefs(extended)), new Map(collectFootnoteDefinitions(extended)))
    // A rewrite (different bytes in the cached prefix) gets a full scan.
    const rewritten = 'other[^z] and [q]\n\n[^z]: zzz\n\n[q]: /q\n\nsettled paragraph\n\n'
    assert.deepEqual(new Map(scanner.linkRefs(rewritten)), new Map(collectLinkReferenceDefinitions(rewritten)))
    assert.deepEqual(new Map(scanner.footnoteDefs(rewritten)), new Map(collectFootnoteDefinitions(rewritten)))
  })

  it('honours the grammar feature gates', () => {
    withConfig({ footnotes: false, linkReferences: false }, () => {
      const scanner = new IncrementalSourceScanner()
      const doc = 'text[^a]\n\n[^a]: note\n\n[r]: /url\n\nsettled paragraph\n\nafter\n\n'
      for (let cut = 1; cut <= doc.length; cut++) {
        const step = scanner.advance(doc.slice(0, cut))
        assert.equal(step.sealedFootnoteDefs.size, 0)
        assert.equal(step.sealedLinkRefs.size, 0)
        assert.deepEqual(step.tokens, tokenizeBlocks(doc.slice(0, cut)))
      }
      assert.equal(scanner.footnoteDefs(doc).size, 0)
      assert.equal(scanner.linkRefs(doc).size, 0)
    })
  })
})
