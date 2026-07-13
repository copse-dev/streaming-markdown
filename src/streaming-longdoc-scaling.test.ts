// Long-document work-shape guard (ADR 0004 Phase 3).
//
// Streaming a document TWICE as long must do ~twice the work, not four times.
// Wall-clock doubling probes found real super-linear growth (~2.8×/doubling at
// 200–400 kB, in Chromium as well as jsdom) whose dominant terms were in the
// incremental scanner: a full-prefix rewrite-guard memcmp run up to three
// times per update (advance + both definition views), an O(prefix) string
// re-materialization per update, and an O(total tokens) array rebuild per
// update. These tests pin the fixed shape with deterministic counters —
// timing-free, so CI load can't flake them — on a doubling series of a mixed
// prose/list/fence document streamed in fixed-size chunks.
//
// What each counter must do per size doubling (updates AND length double):
//   scannedChars / suffixTokensScanned / renderedChars / parsedChars — ~2×
//     (the safe boundary tracks the tail, so per-update work is O(new bytes)).
//   prefixChecks — ~2× (ONE rewrite-guard comparison per scanner call; the
//     definition views ride the advance's verification via the identity fast
//     path). Before the fix this grew at the same rate but with a 3× constant,
//     and each check was O(prefix) — the count is the regression tripwire.
// prefixBytesCompared itself stays ~4×/doubling (one O(prefix) memcmp per
// update is inherent to the pull-shaped update(fullString) API — removing it
// entirely is the ADR's "push-shaped boundary" future work) with a native-
// memcmp constant small enough to be irrelevant below multi-MB documents.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

function unitDocument(): string {
  const blocks: string[] = []
  for (let i = 0; i < 12; i++) {
    blocks.push(
      `## Section ${String(i)}\n\nParagraph about topic ${String(i)} with **emphasis**, \`code\`, and a [link](https://example.com/${String(i)}). More prose follows to give the block realistic length.`,
    )
    blocks.push(`- item one of list ${String(i)}\n- item two with *stress*\n- item three`)
    blocks.push(
      '```ts\nconst value' + String(i) + ' = compute(' + String(i) + ')\nexport default value' + String(i) + '\n```',
    )
  }
  return blocks.join('\n\n') + '\n\n'
}

interface StreamShape {
  updates: number
  diag: ReturnType<StreamingMarkdownRenderer['diagnostics']>
  html: string
}

function streamDocument(doc: string, chunk: number): StreamShape {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const renderer = new StreamingMarkdownRenderer(host)
  let updates = 0
  for (let i = 0; i < doc.length; i += chunk) {
    renderer.update(doc.slice(0, Math.min(doc.length, i + chunk)))
    updates++
  }
  // The host wraps output in the stream-complete/forming/pending scaffold;
  // parity is over the completed container's content.
  const shape = {
    updates,
    diag: renderer.diagnostics(),
    html: host.querySelector('.stream-complete')?.innerHTML ?? '',
  }
  host.remove()
  return shape
}

describe('long-document doubling shape (ADR 0004 Phase 3)', () => {
  const unit = unitDocument()
  const CHUNK = 64
  // x1 → x2 → x4 of the mixed unit; updates and length double together, the
  // shape a growing LLM transcript produces.
  const sizes = [1, 2, 4].map((mult) => streamDocument(unit.repeat(mult), CHUNK))

  it('streams correctly at every size (output equals the batch render)', () => {
    for (const [i, shape] of sizes.entries()) {
      const scratch = document.createElement('div')
      scratch.innerHTML = renderMarkdown(unit.repeat([1, 2, 4][i] ?? 1))
      assert.equal(shape.html, scratch.innerHTML, `parity at x${String([1, 2, 4][i])}`)
    }
  })

  it('per-update scan work is O(new bytes): linear counters grow ~2× per doubling', () => {
    for (let i = 1; i < sizes.length; i++) {
      const prev = sizes[i - 1]
      const cur = sizes[i]
      if (!prev || !cur) continue
      for (const key of ['scannedChars', 'suffixTokensScanned', 'renderedChars', 'parsedChars'] as const) {
        const factor: number = cur.diag[key] / Math.max(1, prev.diag[key])
        assert.ok(
          factor < 2.6,
          `${key} grew ${factor.toFixed(2)}× on a 2× larger document (${String(prev.diag[key])} → ${String(cur.diag[key])}) — per-update work is no longer O(new bytes)`,
        )
      }
    }
  })

  it('runs exactly one rewrite-guard comparison per scanner call', () => {
    for (const [i, shape] of sizes.entries()) {
      // Per update: one advance on the content scanner; per commit: one advance
      // on the complete scanner — and NOTHING else. The definition views must
      // contribute zero (identity fast path). Commits ≤ updates, so 2× updates
      // is the ceiling; the slack covers construction-time calls.
      assert.ok(
        shape.diag.prefixChecks <= 2 * shape.updates + 4,
        `x${String([1, 2, 4][i])}: ${String(shape.diag.prefixChecks)} prefix checks for ${String(shape.updates)} updates — a per-update caller is re-running the O(prefix) rewrite guard`,
      )
    }
  })
})
