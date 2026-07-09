// GitHub Flavored Markdown conformance harness for the *at-rest* renderer.
//
// The sibling `commonmark-conformance.test.ts` measures the CommonMark spec; this
// one measures GFM (https://github.github.com/gfm/), a strict superset that adds
// tables, task lists, strikethrough, extended autolinks, and a disallowed-raw-HTML
// filter. The renderer implements those extensions (GFM-mode is always on — there
// is no CommonMark-only switch), so this harness is the regression floor for them.
//
// Mechanics mirror the CommonMark harness exactly: every spec example is run
// through `renderMarkdown` and compared (after the spec's own HTML normalizer)
// against the expected output. The set we currently satisfy is pinned in
// `gfm-conformance-baseline.json`; the test fails if that set changes in either
// direction:
//   - fewer passing → a regression in a construct we used to handle.
//   - more passing   → an improvement; re-run with `UPDATE_GFM_BASELINE=1`.
//
// As with CommonMark, this is a *baseline*, not a 100%-conformance goal — the
// renderer escapes untrusted HTML (sanitize-at-the-sink) and implements a subset
// of the autolink/strikethrough grammar, so several sections cap out by design.
// Streaming output is intentionally NOT conformance-tested (the live tail is
// escaped plain text); only `renderMarkdown` is measured here.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderMarkdown } from './renderer.ts'
import { stripAppCodeDecorations } from './highlight.ts'
import { installHighlightjs } from './highlight-hljs.ts'
import { installFullEntityDecoder } from './entity-decoder-full.ts'
import { stripAppImageAttributes, stripAppLinkAttributes } from './inline-links.ts'
import { normalizeHtml } from '../tests/commonmark/normalize.ts'
import {
  gfmSpecVersion,
  loadGfmSpec,
  GFM_EXTENSION_SECTIONS,
  GFM_SPEC_PATH,
  type SpecExample,
} from '../tests/gfm/load-spec.ts'

interface GfmConformanceBaseline {
  specVersion: string
  source: string
  note: string
  total: number
  passing: number[]
  summaryBySection: Record<string, { pass: number; total: number }>
  extensionSummary: Record<string, { pass: number; total: number }>
}

const BASELINE_PATH = resolve(process.cwd(), 'tests/fixtures/gfm/gfm-conformance-baseline.json')

// The GFM spec.txt is fetched on demand (not vendored — see tests/gfm/load-spec.ts),
// so a bare offline `npm test` may not have it. Skip cleanly with a pointer rather
// than hard-fail; CI runs `npm run check:gfm-spec` first, so it always has the spec.
if (!existsSync(GFM_SPEC_PATH)) {
  describe('GFM conformance (at rest)', () => {
    it('is skipped — GFM spec not fetched (run `npm run check:gfm-spec`)', { skip: true }, () => {})
  })
} else runGfmConformance()

function runGfmConformance(): void {
// The baseline was recorded with highlighting on; register the backend so the
// conformance render matches it (span decorations are stripped before comparison).
installHighlightjs()
// GFM is a strict superset of CommonMark, so — like the CommonMark harness — the
// entity section exercises the full HTML5 named-reference set (e.g. `&HilbertSpace;`).
// The default decoder ships only the HTML4 subset, so register the full
// `entities`-backed decoder here to measure conformance under config #3 (full).
installFullEntityDecoder()

const SPEC_VERSION = gfmSpecVersion()
const spec = loadGfmSpec()

function conforms(example: SpecExample): boolean {
  // Pinned to the escape policy so the baseline stays stable now that
  // passthrough is the default (#600); see the CommonMark harness for rationale.
  const html = stripAppCodeDecorations(
    stripAppImageAttributes(
      stripAppLinkAttributes(renderMarkdown(example.markdown, { htmlPolicy: 'escape' })),
    ),
  )
  return normalizeHtml(html) === normalizeHtml(example.html)
}

function computePassing(): number[] {
  return spec.filter(conforms).map((e) => e.example)
}

function summarize(
  passing: Set<number>,
  filter?: (section: string) => boolean,
): Record<string, { pass: number; total: number }> {
  const summary: Record<string, { pass: number; total: number }> = {}
  for (const e of spec) {
    if (filter && !filter(e.section)) continue
    const bucket = (summary[e.section] ??= { pass: 0, total: 0 })
    bucket.total++
    if (passing.has(e.example)) bucket.pass++
  }
  return summary
}

describe('GFM conformance (at rest)', () => {
  const passing = computePassing()
  const passingSet = new Set(passing)

  if (process.env['UPDATE_GFM_BASELINE'] === '1') {
    const baseline: GfmConformanceBaseline = {
      specVersion: SPEC_VERSION,
      source: `github/cmark-gfm spec.txt @ 0.29.0.gfm.13 (fetched to tests/fixtures/gfm/spec.txt)`,
      note: 'Examples from the official GitHub Flavored Markdown spec that renderMarkdown() satisfies at rest, after the spec normalizer. GFM is a superset of CommonMark, so the base sections mirror the CommonMark baseline; the GFM-only sections are broken out in extensionSummary. This is a regression baseline, not a conformance goal — the renderer escapes untrusted HTML (sanitize-at-the-sink) and implements a subset of the autolink/strikethrough grammar, so HTML blocks, Raw HTML, and parts of the extension sections fail by design.',
      total: spec.length,
      passing,
      summaryBySection: summarize(passingSet),
      extensionSummary: summarize(passingSet, (s) => GFM_EXTENSION_SECTIONS.has(s)),
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n')
    it('regenerated the GFM conformance baseline', () => {
      assert.ok(passing.length > 0, 'expected at least one conforming example')
    })
    return
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as GfmConformanceBaseline

  it('pins the fetched GFM spec version', () => {
    assert.equal(baseline.specVersion, SPEC_VERSION)
    assert.equal(baseline.total, spec.length)
  })

  it('matches the recorded set of conforming spec examples', () => {
    const expected = new Set(baseline.passing)
    const regressions = baseline.passing.filter((n) => !passingSet.has(n))
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
      baseline.passing,
      [
        regressions.length
          ? `Regressions (examples that no longer conform): ${detail(regressions)}.`
          : '',
        improvements.length
          ? `Improvements (newly conforming): ${detail(improvements)}. Re-run with UPDATE_GFM_BASELINE=1 to record them.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  })
})
}
