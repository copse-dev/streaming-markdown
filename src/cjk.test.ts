import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isCjkPunctuation, setCjkFriendly } from './cjk.ts'
import { renderInlineSpans } from './inline-spans.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

// The extension flips shared module-level registries; always restore the stock
// CommonMark flanking so a leaked flag can't bleed into other suites.
afterEach(() => setCjkFriendly(false))

const anchor = (href: string, label: string) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer" data-browser-link="true">${label}</a>`

describe('isCjkPunctuation classifier', () => {
  it('matches full-width / ideographic punctuation', () => {
    for (const ch of ['。', '、', '「', '」', '『', '』', '（', '）', '【', '】', '！', '？', '：', '；', '，', '．', '・', '｡', '｢', '･']) {
      assert.equal(isCjkPunctuation(ch), true, `expected CJK punctuation: ${ch}`)
    }
  })

  it('rejects ASCII punctuation, CJK letters, and the empty string', () => {
    for (const ch of ['.', ',', '!', '?', '(', ')', '*', '_', '-', ':', '中', '文', 'あ', 'ア', '한', 'A', '１', ' ', '']) {
      assert.equal(isCjkPunctuation(ch), false, `expected non-CJK-punctuation: ${JSON.stringify(ch)}`)
    }
  })
})

describe('setCjkFriendly — emphasis around full-width punctuation', () => {
  it('is off by default: emphasis wrapping CJK punctuation stays literal (CommonMark)', () => {
    assert.equal(renderInlineSpans('これは**「強調」**です'), 'これは**「強調」**です')
  })

  it('pairs emphasis around CJK bracket punctuation when enabled', () => {
    setCjkFriendly(true)
    assert.equal(renderInlineSpans('これは**「強調」**です'), 'これは<strong>「強調」</strong>です')
    assert.equal(renderInlineSpans('「**注意**」'), '「<strong>注意</strong>」')
  })

  it('pairs emphasis whose inner edge is a full-width period or bang', () => {
    setCjkFriendly(true)
    assert.equal(renderInlineSpans('**強調。**です'), '<strong>強調。</strong>です')
    assert.equal(renderInlineSpans('テスト*太字！*続き'), 'テスト<em>太字！</em>続き')
  })

  it('handles a delimiter opening right after ideographic punctuation', () => {
    setCjkFriendly(true)
    assert.equal(renderInlineSpans('句読点。**強調**'), '句読点。<strong>強調</strong>')
  })

  it('renders mixed CJK + Latin emphasis correctly', () => {
    setCjkFriendly(true)
    assert.equal(renderInlineSpans('中文**bold**测试'), '中文<strong>bold</strong>测试')
    assert.equal(renderInlineSpans('日本語と *English* の混在。'), '日本語と <em>English</em> の混在。')
  })

  it('restores stock CommonMark flanking when disabled', () => {
    setCjkFriendly(true)
    assert.equal(renderInlineSpans('これは**「強調」**です'), 'これは<strong>「強調」</strong>です')
    setCjkFriendly(false)
    assert.equal(renderInlineSpans('これは**「強調」**です'), 'これは**「強調」**です')
  })
})

describe('setCjkFriendly — bare autolink boundaries', () => {
  it('is off by default: a run-together CJK tail is swallowed into the href', () => {
    assert.equal(
      renderMarkdownUnsafe('参照 https://example.com。次'),
      `<p>参照 ${anchor('https://example.com%E3%80%82%E6%AC%A1', 'https://example.com。次')}</p>`,
    )
  })

  it('stops a bare URL at the first CJK punctuation mark when enabled', () => {
    setCjkFriendly(true)
    assert.equal(
      renderMarkdownUnsafe('参照 https://example.com。次を見て'),
      `<p>参照 ${anchor('https://example.com', 'https://example.com')}。次を見て</p>`,
    )
  })

  it('keeps query strings and trims ASCII trailing punctuation before the CJK boundary', () => {
    setCjkFriendly(true)
    assert.equal(
      renderMarkdownUnsafe('見る https://a.com/p?x=1，そして'),
      `<p>見る ${anchor('https://a.com/p?x=1', 'https://a.com/p?x=1')}，そして</p>`,
    )
    assert.equal(
      renderMarkdownUnsafe('(https://a.com/p).、'),
      `<p>(${anchor('https://a.com/p', 'https://a.com/p')}).、</p>`,
    )
  })

  it('leaves a URL that starts at a CJK mark untouched', () => {
    // The captured run begins with the boundary char, so there is no URL to link.
    setCjkFriendly(true)
    assert.equal(renderMarkdownUnsafe('（https://a.com）'), '<p>（https://a.com）</p>')
  })
})

describe('setCjkFriendly — no regression to Latin-script output', () => {
  // Every non-CJK case must render byte-identically with the extension ON.
  const latinFixtures = [
    'a **b** c.',
    'foo *bar* (baz).',
    'text with `code` and *emphasis*, then more.',
    'a [link](https://example.com) and https://plain.example.com/path, done.',
    '__strong__ and _em_ and ~~strike~~ intraword_snake_case.',
    'trailing punctuation: https://example.com/path!',
    '**bold _nested em_ tail** and normal.',
    'no markup at all, just prose — with an em-dash.',
  ]

  it('is byte-identical for Latin fixtures whether the extension is on or off', () => {
    const off = latinFixtures.map((s) => renderMarkdownUnsafe(s))
    setCjkFriendly(true)
    const on = latinFixtures.map((s) => renderMarkdownUnsafe(s))
    for (let i = 0; i < latinFixtures.length; i++) {
      assert.equal(on[i], off[i], `Latin output changed for: ${latinFixtures[i]}`)
    }
  })
})
