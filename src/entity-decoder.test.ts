import '../tests/setup-dom-jsdom.ts'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  addNamedEntities,
  BUILTIN_NAMED_ENTITIES,
  browserEntityDecoder,
  decodeHtmlEntities,
  getEntityDecoder,
  getNamedEntities,
  resetEntityDecoder,
  setEntityDecoder,
  setNamedEntities,
} from './entity-decoder.ts'
import { fullEntityDecoder } from './entity-decoder-full.ts'
import { renderMarkdown } from './renderer.ts'
import { stripAppCodeDecorations } from './highlight.ts'
import { stripAppImageAttributes, stripAppLinkAttributes } from './inline-links.ts'
import { normalizeHtml } from '../tests/commonmark/normalize.ts'
import { loadCommonMarkSpec, type SpecExample } from '../tests/commonmark/load-spec.ts'

afterEach(() => resetEntityDecoder())

describe('built-in entity decoder (default)', () => {
  it('decodes decimal and hex numeric references', () => {
    assert.equal(decodeHtmlEntities('&#35;'), '#')
    assert.equal(decodeHtmlEntities('&#X22;'), '"')
    assert.equal(decodeHtmlEntities('&#x1F600;'), '\u{1F600}')
  })

  it('maps NUL, C1, surrogate, and out-of-range code points to their HTML5 replacements', () => {
    assert.equal(decodeHtmlEntities('&#0;'), '�')
    assert.equal(decodeHtmlEntities('&#128;'), '€') // Windows-1252 remap → €
    assert.equal(decodeHtmlEntities('&#xD800;'), '�') // lone surrogate
    assert.equal(decodeHtmlEntities('&#x110000;'), '�') // above U+10FFFF
  })

  it('decodes the HTML4 named set', () => {
    assert.equal(decodeHtmlEntities('&copy; &AElig; &frac34; &mdash; &alpha;'), '© Æ ¾ — α')
  })

  it('leaves references outside the built-in set literal', () => {
    // HTML5-only names are not in the HTML4 built-in set.
    assert.equal(decodeHtmlEntities('&HilbertSpace;'), '&HilbertSpace;')
    assert.equal(decodeHtmlEntities('&Dcaron;'), '&Dcaron;')
  })

  it('is strict: a reference without a trailing semicolon stays literal', () => {
    assert.equal(decodeHtmlEntities('&copy no semicolon'), '&copy no semicolon')
    assert.equal(decodeHtmlEntities('&amp'), '&amp')
  })

  it('leaves unknown references literal', () => {
    assert.equal(decodeHtmlEntities('&nonExistent;'), '&nonExistent;')
  })

  it('every built-in name decodes byte-identically to the full HTML5 decoder', () => {
    for (const name of Object.keys(BUILTIN_NAMED_ENTITIES)) {
      const token = `&${name};`
      assert.equal(
        decodeHtmlEntities(token),
        fullEntityDecoder(token),
        `built-in ${token} must match the full decoder`,
      )
    }
  })
})

describe('named-entity configuration (user lists)', () => {
  it('addNamedEntities extends the built-in set', () => {
    assert.equal(decodeHtmlEntities('&checkmark;'), '&checkmark;')
    addNamedEntities({ checkmark: '✓' })
    assert.equal(decodeHtmlEntities('&checkmark;'), '✓')
    assert.deepEqual(getNamedEntities()['checkmark'], '✓')
  })

  it('user entries win over built-ins on collision', () => {
    assert.equal(decodeHtmlEntities('&copy;'), '©')
    addNamedEntities({ copy: 'COPYRIGHT' })
    assert.equal(decodeHtmlEntities('&copy;'), 'COPYRIGHT')
  })

  it('setNamedEntities replaces the user layer but keeps built-ins', () => {
    addNamedEntities({ foo: 'FOO' })
    setNamedEntities({ bar: 'BAR' })
    assert.equal(decodeHtmlEntities('&foo;'), '&foo;') // replaced away
    assert.equal(decodeHtmlEntities('&bar;'), 'BAR')
    assert.equal(decodeHtmlEntities('&copy;'), '©') // built-in intact
  })
})

describe('pluggable decoder (setEntityDecoder)', () => {
  it('routes decoding through a registered decoder', () => {
    setEntityDecoder((text) => text.replace(/&custom;/g, 'X'))
    assert.equal(getEntityDecoder() !== null, true)
    assert.equal(decodeHtmlEntities('&custom; &copy;'), 'X &copy;') // built-in bypassed
  })

  it('the full entities-backed decoder covers the HTML5 long tail', () => {
    setEntityDecoder(fullEntityDecoder)
    assert.equal(decodeHtmlEntities('&HilbertSpace; &Dcaron;'), 'ℋ Ď')
  })

  it('reset restores the built-in decoder and clears user names', () => {
    addNamedEntities({ foo: 'FOO' })
    setEntityDecoder(fullEntityDecoder)
    resetEntityDecoder()
    assert.equal(getEntityDecoder(), null)
    assert.equal(decodeHtmlEntities('&foo;'), '&foo;')
    assert.equal(decodeHtmlEntities('&HilbertSpace;'), '&HilbertSpace;')
  })
})

describe('browserEntityDecoder (native DOM, zero bundle cost)', () => {
  it('covers the full HTML5 named set via the browser parser table', () => {
    assert.equal(browserEntityDecoder('&HilbertSpace; &Dcaron; &ngE;'), 'ℋ Ď ≧̸')
  })

  it('stays strict: semicolon-less legacy references are not decoded', () => {
    // The browser would decode `&copy` (no semicolon) on its own, but only whole
    // `&name;` tokens are handed to it, so mid-string legacy refs stay literal.
    assert.equal(browserEntityDecoder('&copy no semicolon'), '&copy no semicolon')
    assert.equal(browserEntityDecoder('a &copy; b &notaname; c'), 'a © b &notaname; c')
  })

  it('decodes numeric references identically to the built-in decoder', () => {
    assert.equal(browserEntityDecoder('&#0; &#128; &#x1F600;'), '� € \u{1F600}')
  })

  it('throws a clear error when no DOM document is available', () => {
    const holder = globalThis as { document?: Document }
    const saved = holder.document
    delete holder.document
    try {
      assert.throws(() => browserEntityDecoder('&copy;'), /requires a DOM document/)
    } finally {
      if (saved) holder.document = saved
    }
  })
})

// The measurable cost of shipping only the HTML4 named subset by default: run the
// entire CommonMark spec under each decoder config and pin the difference. The
// three configs correspond to the README/docs guidance.
describe('CommonMark conformance across decoder configs', () => {
  const spec = loadCommonMarkSpec()
  const conforms = (ex: SpecExample): boolean => {
    const html = stripAppCodeDecorations(
      stripAppImageAttributes(stripAppLinkAttributes(renderMarkdown(ex.markdown))),
    )
    return normalizeHtml(html) === normalizeHtml(ex.html)
  }
  const passing = (): Set<number> => new Set(spec.filter(conforms).map((e) => e.example))

  it('the default decoder trails the full decoder by exactly one example (#25)', () => {
    resetEntityDecoder()
    const dflt = passing()
    setEntityDecoder(fullEntityDecoder)
    const full = passing()
    const dropped = [...full].filter((n) => !dflt.has(n)).sort((a, b) => a - b)
    // #25 is the spec example that packs HTML5-only names (&Dcaron;, &HilbertSpace;,
    // &DifferentialD;, &ClockwiseContourIntegral;, &ngE;) the HTML4 subset omits.
    assert.deepEqual(dropped, [25])
  })

  it('the browser decoder matches the full decoder exactly (zero conformance cost)', () => {
    setEntityDecoder(fullEntityDecoder)
    const full = passing()
    setEntityDecoder(browserEntityDecoder)
    const browser = passing()
    assert.deepEqual([...browser].sort((a, b) => a - b), [...full].sort((a, b) => a - b))
  })
})
