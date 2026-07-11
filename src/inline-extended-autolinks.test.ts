// GFM extended autolinks (extension): `www.` hosts, bare email addresses, and
// the `ftp://` scheme, alongside the existing bare `http(s)://` pass. See the
// grammar in `src/inline-spans.ts` and the conformance floor in
// `src/gfm-conformance.test.ts` (Autolinks (extension) 11/11).
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderInlineSpans } from './inline-spans.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { withConfig } from './config.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'

// Neutral default link output (#124): a plain `<a href>` with no
// target/rel/decorator attributes unless a host installs a link decorator.
const anchor = (href: string, label: string): string => `<a href="${href}">${label}</a>`

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
  it('does not linkify a www host when http is not an allowed scheme', () => {
    withConfig({ safeHrefSchemes: ['https'] }, () => {
      assert.equal(renderInlineSpans('www.example.com'), 'www.example.com')
    })
  })

  it('does not linkify a bare email when mailto is not an allowed scheme', () => {
    withConfig({ safeHrefSchemes: ['https'] }, () => {
      assert.equal(renderInlineSpans('foo@bar.baz'), 'foo@bar.baz')
    })
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

describe('extended autolink boundary and path-validation fixes (#115 review)', () => {
  // This pass runs AFTER emphasis/strikethrough rendering, so a source flank
  // char (`*`/`_`/`~`) has already become a tag; the run's preceding char is the
  // tag-closing `>`. Without `>` as a left boundary these rendered as styled
  // plain text where GitHub renders styled links.
  it('links a www host directly inside emphasis / strong / strikethrough', () => {
    assert.equal(
      renderInlineSpans('*www.example.com*'),
      `<em>${anchor('http://www.example.com', 'www.example.com')}</em>`,
    )
    assert.equal(
      renderInlineSpans('**www.example.com**'),
      `<strong>${anchor('http://www.example.com', 'www.example.com')}</strong>`,
    )
    assert.equal(
      renderInlineSpans('~~www.example.com~~'),
      `<del>${anchor('http://www.example.com', 'www.example.com')}</del>`,
    )
    assert.equal(
      renderInlineSpans('_www.example.com_'),
      `<em>${anchor('http://www.example.com', 'www.example.com')}</em>`,
    )
  })

  it('still links after an unpaired literal flank char', () => {
    assert.equal(
      renderInlineSpans('*www.example.com'),
      `*${anchor('http://www.example.com', 'www.example.com')}`,
    )
  })

  it('applies the valid-domain underscore rule to schemed URLs too, not just www', () => {
    // GFM runs the same check_domain on a schemed URL: an underscore in the last
    // two domain segments makes it not a valid domain, so it stays prose.
    assert.equal(
      renderInlineSpans('http://foo_bar.example_baz.com/x'),
      'http://foo_bar.example_baz.com/x',
    )
    // A valid schemed domain (and a short host with no dot) still links.
    assert.equal(
      renderInlineSpans('http://example.com/x'),
      anchor('http://example.com/x', 'http://example.com/x'),
    )
    assert.equal(
      renderInlineSpans('http://localhost:3000/x'),
      anchor('http://localhost:3000/x', 'http://localhost:3000/x'),
    )
  })

  it('leaves a lone non-entity trailing ; out of the link (matches cmark / bare-URL pass)', () => {
    assert.equal(
      renderInlineSpans('https://example.com/a;'),
      `${anchor('https://example.com/a', 'https://example.com/a')};`,
    )
    // An entity-like `&word;` tail is still trimmed as a whole (excluded from
    // the link, then emitted as escaped trailing text) — not treated as a lone `;`.
    assert.equal(
      renderInlineSpans('www.google.com/s?q=commonmark&hl;'),
      `${anchor('http://www.google.com/s?q=commonmark', 'www.google.com/s?q=commonmark')}&amp;hl;`,
    )
  })
})

describe('email autolink toggle (#115)', () => {
  it('links a bare email by default', () => {
    assert.equal(renderInlineSpans('foo@bar.com'), anchor('mailto:foo@bar.com', 'foo@bar.com'))
  })

  it('leaves a bare email as plain text when disabled', () => {
    withConfig({ emailAutolinks: false }, () => {
      assert.equal(renderInlineSpans('Reach foo@bar.com today'), 'Reach foo@bar.com today')
    })
  })

  it('still linkifies www/URL autolinks when only email is disabled', () => {
    withConfig({ emailAutolinks: false }, () => {
      assert.equal(
        renderInlineSpans('www.example.com'),
        anchor('http://www.example.com', 'www.example.com'),
      )
    })
  })

  it('an inner enable overrides an outer disable', () => {
    withConfig({ emailAutolinks: false }, () => {
      withConfig({ emailAutolinks: true }, () => {
        assert.equal(renderInlineSpans('foo@bar.com'), anchor('mailto:foo@bar.com', 'foo@bar.com'))
      })
    })
  })
})

describe('extended autolink performance guards (pathological input, #115 review)', () => {
  // These forms were O(n²) before the fix: the email domain scan consumed `@`
  // as a domain char and rescanned the whole tail from every `@`
  // (GHSA-29g3-96g3-jg6c), and each trailing `)` re-counted every paren in the
  // link. A single hostile chat message froze the streaming renderer for many
  // seconds per update. The bound is generous — the linear fix runs in
  // milliseconds while a quadratic regression takes tens of seconds — so it
  // catches a regression without flaking.
  const BUDGET_MS = 2000

  it('linkifies a pathological a@a@a@… run in linear time', () => {
    const input = 'a@'.repeat(30000)
    const started = Date.now()
    renderInlineSpans(input)
    const elapsed = Date.now() - started
    assert.ok(elapsed < BUDGET_MS, `email scan took ${String(elapsed)}ms (> ${String(BUDGET_MS)}ms) — quadratic?`)
  })

  it('trims a long trailing ) run in linear time', () => {
    const input = `www.a.b/${')'.repeat(100000)}`
    const started = Date.now()
    renderInlineSpans(input)
    const elapsed = Date.now() - started
    assert.ok(elapsed < BUDGET_MS, `paren trim took ${String(elapsed)}ms (> ${String(BUDGET_MS)}ms) — quadratic?`)
  })
})
