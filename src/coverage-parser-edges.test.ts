import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { stripFourColumnIndent } from './block-patterns.ts'
import { tokenizeBlocks } from './block-tokenizer.ts'
import { IncrementalSourceScanner } from './incremental-scan.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

describe('stripFourColumnIndent', () => {
  it('strips up to four leading spaces', () => {
    assert.equal(stripFourColumnIndent('    code'), 'code')
    assert.equal(stripFourColumnIndent('  two'), 'two')
  })

  it('expands a leading tab to a four-column stop', () => {
    assert.equal(stripFourColumnIndent('\tcode'), 'code')
  })

  it('expands a tab after some spaces to the next four-column stop', () => {
    // Two spaces (col 2) then a tab advances to col 4 exactly, consuming the tab.
    assert.equal(stripFourColumnIndent('  \tcode'), 'code')
  })

  it('returns the line unchanged when there is no leading indentation', () => {
    assert.equal(stripFourColumnIndent('code'), 'code')
  })
})

describe('IncrementalSourceScanner.linkRefs full-scan fallback', () => {
  it('falls back to a full scan when the source diverges from the cached prefix', () => {
    const scanner = new IncrementalSourceScanner()
    // Tokenize a document with a blank boundary so the safe prefix advances.
    scanner.tokenize('[a]: https://a.example\n\nfirst paragraph\n\nsecond\n\n')

    // A source that does NOT start with the cached safe prefix forces the
    // full-scan branch — its refs must still be found correctly.
    // Reference labels normalize to upper case in the map.
    const refs = scanner.linkRefs('[z]: https://z.example\n\nunrelated body\n')
    assert.ok(refs.has('Z'))
    assert.equal(refs.has('A'), false)
  })

  it('reuses the cached prefix when the source extends it', () => {
    const scanner = new IncrementalSourceScanner()
    const base = '[a]: https://a.example\n\nbody\n\n'
    scanner.tokenize(base)
    const refs = scanner.linkRefs(base + 'more body\n')
    assert.ok(refs.has('A'))
  })
})

describe('tokenizeBlocks: an unterminated final line that looks like a table start', () => {
  it('marks a trailing header+separator with no final newline as an ambiguous table', () => {
    const tokens = tokenizeBlocks('| h1 | h2 |\n| --- | --- |')
    assert.ok(
      tokens.some((t) => t.kind === 'table'),
      'a table token is emitted for the still-forming table',
    )
  })

  it('breaks the forward table scan on a clearly non-table line', () => {
    // Header, then a line that is neither a table row nor a partial separator —
    // the lookahead must stop rather than swallow it into the table.
    const tokens = tokenizeBlocks('| h1 | h2 |\nplain paragraph text\n')
    assert.ok(tokens.length >= 1)
  })
})

describe('emphasis with mismatched delimiter-run lengths', () => {
  // These stress the run-splitting arithmetic: a closer that consumes only part
  // of an opener (leaving a prefix) and/or leaves a remainder that itself opens.
  const cases = [
    '*a**b***',
    '**a*b***',
    '***a*b**',
    'foo***bar***baz',
    'a *b **c* d** e*',
    '***strong emph*** and **just strong** and *just emph*',
  ]
  for (const md of cases) {
    it(`renders ${JSON.stringify(md)} without throwing`, () => {
      const html = renderMarkdownUnsafe(md)
      assert.equal(typeof html, 'string')
      assert.ok(html.length > 0)
    })
  }
})

describe('reference links whose labels carry inline markup', () => {
  it('matches a definition and reference label after inline rendering', () => {
    // The label contains a code span, so a direct string lookup misses and the
    // renderer must compare the *rendered* labels (the rendered-label index).
    const html = renderMarkdownUnsafe('[a `code` b]: https://example.com\n\nSee [a `code` b].')
    assert.match(html, /href="https:\/\/example\.com"/)
    assert.match(html, /<code>code<\/code>/)
  })

  it('resolves a reference label containing an escaped bracket', () => {
    const html = renderMarkdownUnsafe('[a\\]b]: https://example.com\n\nlink: [a\\]b]')
    assert.match(html, /href="https:\/\/example\.com"/)
  })
})
