import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cjkFriendlyConfig, isCjkPunctuation } from './cjk.ts'
import { withConfig } from './config.ts'
import { renderInlineSpans } from './inline-spans.ts'
import { renderMarkdownUnsafe } from './renderer.ts'

// CJK-friendly is now a config fragment, not a global setter: spread
// `cjkFriendlyConfig` into a render config. `cjkInline` scopes the low-level
// `renderInlineSpans` (which reads the shared flanking registries) through the
// same `withConfig` seam the render entry points use — no global to leak, no
// teardown needed.
const anchor = (href: string, label: string) => `<a href="${href}">${label}</a>`
const cjk = (md: string): string => renderMarkdownUnsafe(md, cjkFriendlyConfig)
const cjkInline = (md: string): string => withConfig(cjkFriendlyConfig, () => renderInlineSpans(md))

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

describe('cjkFriendlyConfig — emphasis around full-width punctuation', () => {
  it('is off by default: emphasis wrapping CJK punctuation stays literal (CommonMark)', () => {
    assert.equal(renderInlineSpans('これは**「強調」**です'), 'これは**「強調」**です')
  })

  it('pairs emphasis around CJK bracket punctuation when enabled', () => {
    assert.equal(cjkInline('これは**「強調」**です'), 'これは<strong>「強調」</strong>です')
    assert.equal(cjkInline('「**注意**」'), '「<strong>注意</strong>」')
  })

  it('pairs emphasis whose inner edge is a full-width period or bang', () => {
    assert.equal(cjkInline('**強調。**です'), '<strong>強調。</strong>です')
    assert.equal(cjkInline('テスト*太字！*続き'), 'テスト<em>太字！</em>続き')
  })

  it('handles a delimiter opening right after ideographic punctuation', () => {
    assert.equal(cjkInline('句読点。**強調**'), '句読点。<strong>強調</strong>')
  })

  it('renders mixed CJK + Latin emphasis correctly', () => {
    assert.equal(cjkInline('中文**bold**测试'), '中文<strong>bold</strong>测试')
    assert.equal(cjkInline('日本語と *English* の混在。'), '日本語と <em>English</em> の混在。')
  })

  it('the config scope does not leak: a plain render after is stock CommonMark', () => {
    assert.equal(cjkInline('これは**「強調」**です'), 'これは<strong>「強調」</strong>です')
    assert.equal(renderInlineSpans('これは**「強調」**です'), 'これは**「強調」**です')
  })
})

describe('cjkFriendlyConfig — bare autolink boundaries', () => {
  it('is off by default: a run-together CJK tail is swallowed into the href', () => {
    assert.equal(
      renderMarkdownUnsafe('参照 https://example.com。次'),
      `<p>参照 ${anchor('https://example.com%E3%80%82%E6%AC%A1', 'https://example.com。次')}</p>`,
    )
  })

  it('stops a bare URL at the first CJK punctuation mark when enabled', () => {
    assert.equal(
      cjk('参照 https://example.com。次を見て'),
      `<p>参照 ${anchor('https://example.com', 'https://example.com')}。次を見て</p>`,
    )
  })

  it('keeps query strings and trims ASCII trailing punctuation before the CJK boundary', () => {
    assert.equal(
      cjk('見る https://a.com/p?x=1，そして'),
      `<p>見る ${anchor('https://a.com/p?x=1', 'https://a.com/p?x=1')}，そして</p>`,
    )
    assert.equal(
      cjk('(https://a.com/p).、'),
      `<p>(${anchor('https://a.com/p', 'https://a.com/p')}).、</p>`,
    )
  })

  it('leaves a URL that starts at a CJK mark untouched', () => {
    // The captured run begins with the boundary char, so there is no URL to link.
    assert.equal(cjk('（https://a.com）'), '<p>（https://a.com）</p>')
  })
})

describe('cjkFriendlyConfig — no regression to Latin-script output', () => {
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
    const on = latinFixtures.map((s) => cjk(s))
    for (let i = 0; i < latinFixtures.length; i++) {
      assert.equal(on[i], off[i], `Latin output changed for: ${latinFixtures[i]}`)
    }
  })
})
