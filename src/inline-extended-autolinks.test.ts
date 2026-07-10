// GFM extended autolinks (extension): `www.` hosts, bare email addresses, and
// the `ftp://` scheme, alongside the existing bare `http(s)://` pass. See the
// grammar in `src/inline-spans.ts` and the conformance floor in
// `src/gfm-conformance.test.ts` (Autolinks (extension) 11/11).
import '../tests/setup-dom-jsdom.ts'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderInlineSpans } from './inline-spans.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { setSafeHrefSchemes } from './inline-links.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

const anchor = (href: string, label: string): string =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer" data-browser-link="true">${label}</a>`

describe('extended www autolinks', () => {
  it('links a bare www host, prefixing http://', () => {
    assert.equal(
      renderInlineSpans('www.commonmark.org'),
      anchor('http://www.commonmark.org', 'www.commonmark.org'),
    )
  })

  it('keeps a following path but trims trailing sentence punctuation', () => {
    assert.equal(
      renderInlineSpans('Visit www.commonmark.org/a.b.'),
      `Visit ${anchor('http://www.commonmark.org/a.b', 'www.commonmark.org/a.b')}.`,
    )
  })

  it('drops only the unmatched trailing paren, keeping balanced interior parens', () => {
    assert.equal(
      renderInlineSpans('(www.google.com/search?q=Markup+(business))'),
      `(${anchor('http://www.google.com/search?q=Markup+(business)', 'www.google.com/search?q=Markup+(business)')})`,
    )
  })

  it('excludes an entity-like &word; suffix from the link', () => {
    assert.equal(
      renderInlineSpans('www.google.com/search?q=commonmark&hl;'),
      `${anchor('http://www.google.com/search?q=commonmark', 'www.google.com/search?q=commonmark')}&amp;hl;`,
    )
  })

  it('ends the autolink at the first < character', () => {
    assert.equal(
      renderInlineSpans('www.commonmark.org/he<lp'),
      `${anchor('http://www.commonmark.org/he', 'www.commonmark.org/he')}&lt;lp`,
    )
  })

  it('rejects www hosts with an underscore in the last two segments', () => {
    assert.equal(renderInlineSpans('www.foo_bar.com'), 'www.foo_bar.com')
  })

  it('only starts after a valid left-flank boundary', () => {
    // Preceded by a letter → not an autolink.
    assert.equal(renderInlineSpans('xwww.example.com'), 'xwww.example.com')
  })
})

describe('extended URL autolinks', () => {
  it('links a bare ftp:// URL and trims the trailing period', () => {
    assert.equal(
      renderInlineSpans('at ftp://foo.bar.baz.'),
      `at ${anchor('ftp://foo.bar.baz', 'ftp://foo.bar.baz')}.`,
    )
  })

  it('trims only the unmatched trailing paren on a bare https URL', () => {
    assert.equal(
      renderInlineSpans('(Visit https://encrypted.google.com/search?q=Markup+(business))'),
      `(Visit ${anchor('https://encrypted.google.com/search?q=Markup+(business)', 'https://encrypted.google.com/search?q=Markup+(business)')})`,
    )
  })
})

describe('extended email autolinks', () => {
  it('links a bare email as a mailto: destination', () => {
    assert.equal(renderInlineSpans('foo@bar.baz'), anchor('mailto:foo@bar.baz', 'foo@bar.baz'))
  })

  it('allows + in the local part but not in the domain', () => {
    assert.equal(
      renderInlineSpans("hello@mail+xyz.example isn't valid, but hello+xyz@mail.example is."),
      `hello@mail+xyz.example isn&#39;t valid, but ${anchor('mailto:hello+xyz@mail.example', 'hello+xyz@mail.example')} is.`,
    )
  })

  it('leaves a trailing dot out of the address', () => {
    assert.equal(renderInlineSpans('a.b-c_d@a.b.'), `${anchor('mailto:a.b-c_d@a.b', 'a.b-c_d@a.b')}.`)
  })

  it('rejects an address whose domain ends in - or _', () => {
    assert.equal(renderInlineSpans('a.b-c_d@a.b-'), 'a.b-c_d@a.b-')
    assert.equal(renderInlineSpans('a.b-c_d@a.b_'), 'a.b-c_d@a.b_')
  })

  it('requires an interior dot in the domain', () => {
    assert.equal(renderInlineSpans('foo@bar'), 'foo@bar')
  })
})

describe('generated-href scheme safety', () => {
  afterEach(() => setSafeHrefSchemes(null))

  it('does not linkify a www host when http is not an allowed scheme', () => {
    setSafeHrefSchemes(['https'])
    assert.equal(renderInlineSpans('www.example.com'), 'www.example.com')
  })

  it('does not linkify a bare email when mailto is not an allowed scheme', () => {
    setSafeHrefSchemes(['https'])
    assert.equal(renderInlineSpans('foo@bar.baz'), 'foo@bar.baz')
  })
})

describe('extended autolink streaming convergence', () => {
  // The at-rest render is reached by streaming to full length, and — like the
  // existing bare-URL pass — a half-typed host/address that is re-cut at every
  // prefix still converges to that same render. This is the property the core
  // fuzz (`streaming-convergence.test.ts`) now enforces once examples 621–631
  // join the GFM baseline; these two focused cases pin the new forms directly.
  function streamedDisplay(markdown: string, cuts: number[]): string {
    const host = document.createElement('div')
    const renderer = new StreamingMarkdownRenderer(host)
    for (const cut of cuts) renderer.update(markdown.slice(0, cut))
    return host.innerHTML
  }

  for (const markdown of [
    'Visit www.example.com for more.',
    'Mail me at foo@bar.example today.',
  ]) {
    it(`half-typed prefix reconverges to the full render: ${JSON.stringify(markdown)}`, () => {
      const fresh = streamedDisplay(markdown, [markdown.length])
      // The finalized stream carries the same anchor the at-rest renderer emits.
      const atRestAnchor = renderMarkdownUnsafe(markdown).match(/<a [^>]*>[^<]*<\/a>/)
      assert.ok(atRestAnchor, 'at-rest render should contain an anchor')
      assert.ok(fresh.includes(atRestAnchor[0]), `final stream missing at-rest anchor: ${fresh}`)
      // Cutting mid-host / mid-address and then completing must land on `fresh`.
      for (let cut = 1; cut < markdown.length; cut++) {
        assert.equal(
          streamedDisplay(markdown, [cut, markdown.length]),
          fresh,
          `cut=${String(cut)} did not reconverge`,
        )
      }
    })
  }
})
