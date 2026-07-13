// CommonMark conformance harness for the *at-rest* renderer.
//
// `renderMarkdownUnsafe()` is app-specific in places (decorated links, highlighted code,
// mermaid, etc.), but CommonMark is the structural reference we grow toward.
// Every spec example is run through `renderMarkdownUnsafe` and compared (after the
// spec's own HTML normalizer) against the expected output. The set of examples
// we currently satisfy is pinned in `conformance-baseline.json`. The test fails
// if that set changes in either direction:
//   - fewer passing examples  → a regression in a construct we used to handle.
//   - more passing examples    → an improvement; re-run with
//     `UPDATE_COMMONMARK_BASELINE=1` to record it.
//
// Full spec conformance is not required today, but new renderer work should not
// regress the baseline and should land improvements when the change is focused.
//
// Streaming is intentionally NOT conformance-tested: partial-line output is
// expected to differ from the final at-rest render (the live tail is escaped
// plain text), so only `renderMarkdownUnsafe` is measured here.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderMarkdownUnsafe } from './renderer.ts'
import { setDefaultConfig } from './config.ts'
import { stripAppCodeDecorations } from './highlight.ts'
import { highlightjsHighlighter } from './highlight-hljs.ts'
import { fullEntityDecoder } from './entity-decoder-full.ts'
import { stripAppImageAttributes, stripAppLinkAttributes } from './inline-links.ts'
import { stripTaskListDecorations } from './render-blocks.ts'
import { normalizeHtml } from '../tests/commonmark/normalize.ts'
import {
  loadConformanceBaseline,
  loadPassthroughConformanceBaseline,
  type ConformanceBaseline,
} from '../tests/commonmark/baseline-examples.ts'
import {
  commonMarkSpecVersion,
  loadCommonMarkSpec,
  type SpecExample,
} from '../tests/commonmark/load-spec.ts'

// Suite-wide config for every spec case, installed once into the process defaults
// (Node runs each test file in its own process, so this does not leak to other
// suites). This keeps the per-case `renderMarkdownUnsafe` calls unchanged.
//   - highlighting: the baseline was recorded with highlighting on; register the
//     backend so the conformance render matches it (span decorations are stripped
//     before comparison).
//   - full entity decoder: full CommonMark conformance requires the complete HTML5
//     named-reference set (the spec's entity section exercises the long tail, e.g.
//     `&Dcaron;`, `&HilbertSpace;`). The default decoder ships only the HTML4
//     subset, so register the full `entities`-backed decoder — this measures
//     config #3 (full).
//   - emailAutolinks off: bare email autolinking is a GFM autolink-extension
//     feature (#115), not part of CommonMark, so disable it here so a bare
//     `user@host` stays plain text as the base spec expects. The GFM extension
//     conformance suite measures the enabled path (Autolinks (extension) 11/11).
setDefaultConfig({
  codeHighlighter: highlightjsHighlighter,
  entityDecoder: fullEntityDecoder,
  emailAutolinks: false,
})

const SPEC_VERSION = commonMarkSpecVersion()
const spec = loadCommonMarkSpec()

// Both htmlPolicies are measured: the `escape` baseline is the stable historical
// reference (and the source of the streaming/bench passing-example corpus); the
// `passthrough` baseline measures the shipping runtime default (#600 / #141), so
// v1's advertised conformance also reflects v1's actual behavior. Escape mode is
// guaranteed to reproduce the pre-#600 output byte-for-byte, so its baseline does
// not churn; passthrough emits raw HTML rather than escaping it, which is why a
// handful of Raw-HTML / HTML-block examples pass (or fail) differently.
type HtmlPolicy = 'escape' | 'passthrough'

function conforms(example: SpecExample, policy: HtmlPolicy): boolean {
  const html = stripTaskListDecorations(
    stripAppCodeDecorations(
      stripAppImageAttributes(
        stripAppLinkAttributes(renderMarkdownUnsafe(example.markdown, { htmlPolicy: policy })),
      ),
    ),
  )
  return normalizeHtml(html) === normalizeHtml(example.html)
}

function computePassing(policy: HtmlPolicy): number[] {
  return spec.filter((e) => conforms(e, policy)).map((e) => e.example)
}

function assertMatchesBaseline(
  passing: number[],
  baselinePassing: number[],
  updateEnv: string,
): void {
  const expected = new Set(baselinePassing)
  const passingSet = new Set(passing)
  const regressions = baselinePassing.filter((n) => !passingSet.has(n))
  const improvements = passing.filter((n) => !expected.has(n))
  const detail = (nums: number[]): string =>
    nums
      .map((n) => {
        const ex = spec.find((e) => e.example === n)
        return `#${String(n)} (${ex?.section ?? '?'})`
      })
      .join(', ')
  assert.deepEqual(
    passing,
    baselinePassing,
    [
      regressions.length
        ? `Regressions (examples that no longer conform): ${detail(regressions)}.`
        : '',
      improvements.length
        ? `Improvements (newly conforming): ${detail(improvements)}. Re-run with ${updateEnv}=1 to record them.`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  )
}

function summarize(passing: Set<number>): Record<string, { pass: number; total: number }> {
  const summary: Record<string, { pass: number; total: number }> = {}
  for (const e of spec) {
    const bucket = (summary[e.section] ??= { pass: 0, total: 0 })
    bucket.total++
    if (passing.has(e.example)) bucket.pass++
  }
  return summary
}

describe('CommonMark conformance (at rest, htmlPolicy: escape)', () => {
  const passing = computePassing('escape')
  const passingSet = new Set(passing)

  if (process.env['UPDATE_COMMONMARK_BASELINE'] === '1') {
    const baseline: ConformanceBaseline = {
      specVersion: SPEC_VERSION,
      source: `commonmark-spec@${SPEC_VERSION} (devDependency)`,
      note: 'Examples from the official CommonMark spec that renderMarkdownUnsafe({ htmlPolicy: "escape" }) satisfies at rest, after the spec normalizer. This is a regression baseline, not a conformance goal — the renderer is intentionally app-specific and, in escape mode, escapes untrusted HTML rather than passing it through (sanitize-at-the-sink; see sanitize.ts and #600). The HTML blocks (44 examples) and Raw HTML (20 examples) sections fail by design, so 652/652 is not the target; excluding those 64 HTML examples the in-scope conformance ceiling is 588. Per-section current pass counts are in summaryBySection. The shipping default is passthrough — see conformance-baseline-passthrough.json (#141).',
      total: spec.length,
      passing,
      summaryBySection: summarize(passingSet),
    }
    writeFileSync(
      resolve(
        process.cwd(),
        'tests/fixtures/commonmark/conformance-baseline.json',
      ),
      JSON.stringify(baseline, null, 2) + '\n',
    )
    it('regenerated the conformance baseline', () => {
      assert.ok(passing.length > 0, 'expected at least one conforming example')
    })
    return
  }

  const baseline = loadConformanceBaseline()

  it('pins the spec fixture version', () => {
    assert.equal(baseline.specVersion, SPEC_VERSION)
    assert.equal(baseline.total, spec.length)
  })

  it('matches the recorded set of conforming spec examples', () => {
    assertMatchesBaseline(passing, baseline.passing, 'UPDATE_COMMONMARK_BASELINE')
  })
})

// The shipping runtime default is `passthrough` (#600). Pin a second baseline
// measuring the spec ceiling under that policy so v1's conformance numbers cover
// v1's actual behavior, not just the escape-mode reference (#141).
describe('CommonMark conformance (at rest, htmlPolicy: passthrough — shipping default)', () => {
  const passing = computePassing('passthrough')
  const passingSet = new Set(passing)

  if (process.env['UPDATE_COMMONMARK_PASSTHROUGH_BASELINE'] === '1') {
    const baseline: ConformanceBaseline = {
      specVersion: SPEC_VERSION,
      source: `commonmark-spec@${SPEC_VERSION} (devDependency)`,
      note: 'Examples from the official CommonMark spec that renderMarkdownUnsafe() satisfies at rest under the SHIPPING DEFAULT htmlPolicy: "passthrough" (#600 / #141), after the spec normalizer. Unlike the escape baseline, raw HTML is passed through (still sanitized at the host sink), so several Raw-HTML / HTML-block examples pass or fail differently. Regression baseline, not a conformance goal. Per-section pass counts in summaryBySection.',
      total: spec.length,
      passing,
      summaryBySection: summarize(passingSet),
    }
    writeFileSync(
      resolve(process.cwd(), 'tests/fixtures/commonmark/conformance-baseline-passthrough.json'),
      JSON.stringify(baseline, null, 2) + '\n',
    )
    it('regenerated the passthrough conformance baseline', () => {
      assert.ok(passing.length > 0, 'expected at least one conforming example')
    })
    return
  }

  const baseline = loadPassthroughConformanceBaseline()

  it('pins the spec fixture version', () => {
    assert.equal(baseline.specVersion, SPEC_VERSION)
    assert.equal(baseline.total, spec.length)
  })

  it('matches the recorded set of conforming spec examples', () => {
    assertMatchesBaseline(passing, baseline.passing, 'UPDATE_COMMONMARK_PASSTHROUGH_BASELINE')
  })
})
