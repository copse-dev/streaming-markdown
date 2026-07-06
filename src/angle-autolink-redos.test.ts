import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './renderer.ts'

// The angle-autolink verbatim pattern must match email autolinks in linear time;
// an unclosed `<a@word.word…` previously drove quadratic backtracking (ReDoS) on
// every inline segment the code-span / backslash-escape passes scan.
describe('angle-autolink ReDoS resistance', () => {
  it('renders a long unclosed pseudo-autolink without super-linear blowup', () => {
    const md = 'before <a@' + 'word.'.repeat(20000) + ' after'
    const start = process.hrtime.bigint()
    renderMarkdown(md)
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    // Quadratic behaviour took seconds at a fraction of this size; a generous
    // ceiling still fails loudly if the backtracking pattern is reintroduced.
    assert.ok(elapsedMs < 1000, `render took ${elapsedMs.toFixed(0)}ms (expected linear)`)
  })
})
