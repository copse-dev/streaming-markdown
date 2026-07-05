import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseLinkReferenceDefinitions } from './link-references.ts'
import {
  getSafeHrefSchemes,
  renderInlineLinks,
  safeLinkHref,
  setSafeHrefSchemes,
} from './inline-links.ts'
import { renderInlineSpans } from './inline-spans.ts'

describe('renderInlineLinks', () => {
  it('renders relative inline links with optional titles (#483, #482)', () => {
    assert.equal(
      renderInlineLinks('[link](/uri "title")', new Map(), (label) => label),
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true" title="title">link</a>',
    )
    assert.equal(
      renderInlineLinks('[link](/uri)', new Map(), (label) => label),
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true">link</a>',
    )
  })

  it('parses empty inline destinations (#485, #487)', () => {
    assert.equal(
      renderInlineLinks('[link]()', new Map(), (label) => label),
      '<a href="" target="_blank" rel="noopener noreferrer" data-browser-link="true">link</a>',
    )
    assert.equal(
      renderInlineLinks('[]()', new Map(), (label) => label),
      '<a href="" target="_blank" rel="noopener noreferrer" data-browser-link="true"></a>',
    )
  })

  it('rejects nested links inside link labels (#518)', () => {
    assert.equal(
      renderInlineSpans('[foo [bar](/uri)](/uri)'),
      '[foo <a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true">bar</a>](/uri)',
    )
  })

  it('resolves reference links and images (#527, #531)', () => {
    const refs = parseLinkReferenceDefinitions('[ref]: /uri\n')
    assert.equal(
      renderInlineSpans('[foo][ref]', refs),
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true">foo</a>',
    )
    assert.equal(
      renderInlineSpans('[![moon](moon.jpg)][ref]', refs),
      '<a href="/uri" target="_blank" rel="noopener noreferrer" data-browser-link="true"><img src="moon.jpg" alt="moon" data-md-rendered="1" /></a>',
    )
  })

  it('parses links whose labels contain rendered <code> spans', () => {
    assert.equal(
      renderInlineLinks('[<code>docs/foo.md</code>](docs/foo.md)', new Map(), (label) => label),
      '<a href="docs/foo.md" class="workspace-markdown-link" data-workspace-link="true"><code>docs/foo.md</code></a>',
    )
  })

  it('reduces image alt text to plain text (spec 574/575/577)', () => {
    assert.equal(
      renderInlineSpans('![foo *bar*](train.jpg)'),
      '<img src="train.jpg" alt="foo bar" data-md-rendered="1" />',
    )
    assert.equal(
      renderInlineSpans('![foo [bar](/url)](/url2)'),
      '<img src="/url2" alt="foo bar" data-md-rendered="1" />',
    )
    assert.equal(
      renderInlineSpans('![foo ![bar](/url)](/url2)'),
      '<img src="/url2" alt="foo bar" data-md-rendered="1" />',
    )
  })

  it('falls back to a shortcut reference when the parens are not a destination (spec 568)', () => {
    const refs = parseLinkReferenceDefinitions('[foo]: /url1\n')
    assert.equal(
      renderInlineSpans('[foo](not a link)', refs),
      '<a href="/url1" class="workspace-markdown-link" data-workspace-link="true">foo</a>(not a link)',
    )
  })

  it('does not resolve empty or bracket-nesting reference labels (spec 551/590)', () => {
    const refs = parseLinkReferenceDefinitions('[[foo]]: /url\n')
    assert.equal(refs.size, 0)
    assert.equal(renderInlineSpans('[]', refs), '[]')
    assert.equal(renderInlineSpans('![[foo]]', refs), '![[foo]]')
  })
})

describe('safeLinkHref scheme validation', () => {
  it('allows relative destinations and allowlisted schemes', () => {
    assert.equal(safeLinkHref('/some/path.ts'), '/some/path.ts')
    assert.equal(safeLinkHref('#section'), '#section')
    assert.equal(safeLinkHref('foo/bar'), 'foo/bar')
    assert.equal(safeLinkHref('https://example.com'), 'https://example.com')
    assert.equal(safeLinkHref('HTTPS://example.com'), 'HTTPS://example.com')
    assert.equal(safeLinkHref('mailto:a@b.com'), 'mailto:a@b.com')
    assert.equal(safeLinkHref('tel:+15551234'), 'tel:+15551234')
  })

  it('rejects dangerous and unknown schemes (allowlist fails closed)', () => {
    assert.equal(safeLinkHref('javascript:alert(1)'), null)
    assert.equal(safeLinkHref('vbscript:msgbox(1)'), null)
    assert.equal(safeLinkHref('data:text/html,<script>'), null)
    assert.equal(safeLinkHref('file:///etc/passwd'), null)
    // An unknown scheme is blocked by default rather than allowed.
    assert.equal(safeLinkHref('made-up-scheme://x'), null)
  })

  it('decodes character references before validating the scheme (#SECURITY)', () => {
    // The scheme check must run on the decoded href, not the raw string: an
    // entity-encoded `j` would otherwise slip a live `javascript:` URL past it.
    assert.equal(safeLinkHref('&#x6a;avascript:alert(1)'), null)
    assert.equal(safeLinkHref('java&#x73;cript:alert(1)'), null)
    // ...including a double-encoded entity, since output re-decodes source escapes.
    assert.equal(safeLinkHref('&amp;#x6a;avascript:alert(1)'), null)
    assert.equal(safeLinkHref('&#100;ata:text/html,x'), null)
  })

  it('does not link an entity-encoded javascript: reference definition (#SECURITY)', () => {
    const refs = parseLinkReferenceDefinitions('[r]: &#x6a;avascript:alert(1)\n')
    assert.equal(renderInlineSpans('[click][r]', refs), '[click][r]')
  })
})

describe('setSafeHrefSchemes', () => {
  it('narrows the allowlist and restores it with null', () => {
    try {
      setSafeHrefSchemes(['https', 'mailto'])
      assert.equal(safeLinkHref('https://example.com'), 'https://example.com')
      assert.equal(safeLinkHref('mailto:a@b.com'), 'mailto:a@b.com')
      // Now outside the narrowed set:
      assert.equal(safeLinkHref('http://example.com'), null)
      assert.equal(safeLinkHref('tel:+15551234'), null)
      // Relative destinations remain allowed regardless of the scheme set.
      assert.equal(safeLinkHref('/some/path.ts'), '/some/path.ts')
    } finally {
      setSafeHrefSchemes(null)
    }
    assert.equal(safeLinkHref('http://example.com'), 'http://example.com')
    assert.equal(safeLinkHref('tel:+15551234'), 'tel:+15551234')
  })

  it('matches configured scheme names case-insensitively', () => {
    try {
      setSafeHrefSchemes(['HTTPS'])
      assert.equal(safeLinkHref('https://example.com'), 'https://example.com')
      assert.deepEqual(getSafeHrefSchemes(), ['https'])
    } finally {
      setSafeHrefSchemes(null)
    }
  })

  it('cannot be widened to smuggle a dangerous scheme past decoding (#SECURITY)', () => {
    try {
      // Even a caller that (unwisely) allows `javascript` only enables the
      // literal scheme; an entity-encoded destination still resolves and is
      // checked against the decoded scheme, so nothing bypasses validation.
      setSafeHrefSchemes(['https'])
      assert.equal(safeLinkHref('&#x6a;avascript:alert(1)'), null)
    } finally {
      setSafeHrefSchemes(null)
    }
  })
})
