import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownUnsafe } from './renderer.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// Adversarial-input hardening (#142). The renderer's stated input is untrusted
// model/user text, so pathological shapes — deep nesting, long delimiter/bracket
// runs, wide tables — must never crash (a reachable DoS) or blow output up
// super-linearly. These assert no-throw and a bounded output for both emitters;
// a catastrophic-backtracking regex would instead hang and trip the test
// runner's timeout. Perf *scaling* is guarded separately by `npm run bench`.

const N = 2000
/** A hostile input can legitimately expand a few× (escaping, table cells) — but
 *  output is O(input), so far beyond this multiple signals quadratic blow-up. */
const outputCeiling = (input: string): number => input.length * 20 + 200_000

const CASES: Record<string, string> = {
  'deep blockquotes': '> '.repeat(2000) + 'x',
  'deep nested list': Array.from({ length: 300 }, (_, i) => '  '.repeat(i) + '- a').join('\n'),
  'long emphasis run': '*'.repeat(N),
  'long strong run': '**'.repeat(N / 2) + 'x',
  'nested emphasis': '*'.repeat(N / 2) + 'x' + '*'.repeat(N / 2),
  'long tilde run': '~'.repeat(N),
  'bracket flood (open)': '['.repeat(N),
  'bracket flood (pairs)': '[]'.repeat(N / 2),
  'link-label flood': '['.repeat(N / 2) + 'x' + ']'.repeat(N / 2),
  'balanced-paren autolink': 'https://example.com/' + '('.repeat(N / 2) + ')'.repeat(N / 2),
  'backslash flood': '\\'.repeat(N),
  'backtick flood': '`'.repeat(N),
  'angle-bracket flood': '<'.repeat(N),
  'raw-tag flood (passthrough)': '<div>'.repeat(N / 5),
  'entity flood': '&'.repeat(N) + 'amp;',
  'footnote-ref flood': '[^x]'.repeat(N / 4) + '\n\n[^x]: def\n',
  'wide table': '|' + ' c |'.repeat(N / 2) + '\n|' + '---|'.repeat(N / 2) + '\n|' + ' 1 |'.repeat(N / 2),
  'mixed delimiter soup': '*_~`[]()#>-'.repeat(N / 10),
  'many soft-break lines': 'a\n'.repeat(N / 2),
}

// Cases that most stress the streaming/frozen-tail path specifically (the at-rest
// pass already covers block/inline rendering for the whole corpus).
const STREAMING_SUBSET = [
  'deep blockquotes',
  'deep nested list',
  'long emphasis run',
  'bracket flood (open)',
  'raw-tag flood (passthrough)',
  'footnote-ref flood',
  'wide table',
  'many soft-break lines',
]

describe('adversarial input does not crash or blow up (#142)', () => {
  for (const [name, input] of Object.entries(CASES)) {
    it(`at rest: ${name}`, () => {
      let out = ''
      assert.doesNotThrow(() => {
        out = renderMarkdownUnsafe(input)
      })
      assert.ok(
        out.length < outputCeiling(input),
        `output ${String(out.length)} bytes for ${String(input.length)}-byte input`,
      )
    })
  }

  for (const name of STREAMING_SUBSET) {
    it(`streaming: ${name}`, () => {
      assert.doesNotThrow(() => {
        const host = document.createElement('div')
        // Trailing blank line so the whole input commits through the frozen tail.
        new StreamingMarkdownRenderer(host).update((CASES[name] ?? '') + '\n\ntail\n\n')
      })
    })
  }
})
