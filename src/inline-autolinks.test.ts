import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderInlineSpans } from './inline-spans.ts'
import { setSafeHrefSchemes } from './inline-links.ts'

describe('renderAngleAutolinks', () => {
  it('renders bare scheme and email autolinks', () => {
    assert.equal(
      renderInlineSpans('<https://foo.bar>'),
      '<a href="https://foo.bar">https://foo.bar</a>',
    )
    assert.equal(
      renderInlineSpans('<foo@bar.example>'),
      '<a href="mailto:foo@bar.example">foo@bar.example</a>',
    )
  })

  it('escapes & in autolink text exactly once (spec 595)', () => {
    assert.equal(
      renderInlineSpans('<https://foo.bar/test?q=hello&id=22&boolean>'),
      '<a href="https://foo.bar/test?q=hello&amp;id=22&amp;boolean">https://foo.bar/test?q=hello&amp;id=22&amp;boolean</a>',
    )
  })

  it('prefers a URI autolink over an email interpretation (spec 597)', () => {
    assert.equal(
      renderInlineSpans('<MAILTO:FOO@BAR.BAZ>'),
      '<a href="MAILTO:FOO@BAR.BAZ">MAILTO:FOO@BAR.BAZ</a>',
    )
  })

  it('does not treat backslashes inside autolinks as escapes (spec 603)', () => {
    assert.equal(
      renderInlineSpans('<https://example.com/\\[\\>'),
      '<a href="https://example.com/%5C%5B%5C">https://example.com/\\[\\</a>',
    )
  })

  it('rejects email autolinks with a backslash in the local part (spec 606)', () => {
    // Not an autolink, so the text is ordinary prose and the `\+` escape applies.
    assert.equal(renderInlineSpans('<foo\\+@bar.example.com>'), '&lt;foo+@bar.example.com&gt;')
  })
})

describe('angle autolinks route through the scheme allowlist (#139)', () => {
  afterEach(() => setSafeHrefSchemes(null))

  it('links allowlisted schemes', () => {
    assert.match(renderInlineSpans('<https://ex.com>'), /<a href="https:\/\/ex\.com">/)
    assert.match(renderInlineSpans('<ftp://ex.com>'), /<a href="ftp:\/\/ex\.com">/)
    assert.match(renderInlineSpans('<mailto:a@b.com>'), /<a href="mailto:a@b\.com">/)
  })

  it('leaves a non-allowlisted scheme literal — fails closed, not a live link', () => {
    for (const raw of [
      '<file:///etc/passwd>',
      '<irc://foo.bar/baz>',
      '<chrome://settings>',
      '<made-up-scheme://x>',
    ]) {
      assert.doesNotMatch(renderInlineSpans(raw), /<a /, raw)
    }
  })

  it('narrowing setSafeHrefSchemes narrows autolinks too', () => {
    setSafeHrefSchemes(['https'])
    assert.match(renderInlineSpans('<https://ex.com>'), /<a /)
    assert.doesNotMatch(renderInlineSpans('<mailto:a@b.com>'), /<a /) // mailto no longer allowed
  })
})
