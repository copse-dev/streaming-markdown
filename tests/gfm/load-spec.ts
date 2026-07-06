// Loads the official GitHub Flavored Markdown conformance examples. Unlike the
// CommonMark spec — which ships as the `commonmark-spec` npm devDependency — the
// GFM spec is not published to npm. Rather than vendoring its ~10k-line `spec.txt`,
// it is fetched on demand into `tests/fixtures/gfm/spec.txt` (gitignored) by
// `scripts/fetch-gfm-spec.mts`, which SHA-256-pins the pinned tag below — the same
// fetch-and-verify pattern the reference normalizer uses. The example format is
// identical to CommonMark (32-backtick fences), so parsing routes through the
// shared `parseSpecExamples`.
//
// Source: https://github.com/github/cmark-gfm (test/spec.txt)
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseSpecExamples, type SpecExample } from '../commonmark/load-spec.ts'

export type { SpecExample }

/** Pinned upstream provenance for the fetched GFM `spec.txt`. */
export const GFM_SPEC_SOURCE = {
  repo: 'github/cmark-gfm',
  ref: '0.29.0.gfm.13',
  path: 'test/spec.txt',
  url: 'https://raw.githubusercontent.com/github/cmark-gfm/0.29.0.gfm.13/test/spec.txt',
  /** SHA-256 of the fetched `spec.txt`; `fetch-gfm-spec.mts` fails on any drift. */
  sha256: '7d8e5814befec287ac116786d81ff14e0adc9b13295b4494649e995408fd871c',
} as const

/** Sections that exist only in GFM (the extensions over plain CommonMark). */
export const GFM_EXTENSION_SECTIONS = new Set([
  'Tables (extension)',
  'Task list items (extension)',
  'Strikethrough (extension)',
  'Autolinks (extension)',
  'Disallowed Raw HTML (extension)',
])

export const GFM_SPEC_PATH = resolve(process.cwd(), 'tests/fixtures/gfm/spec.txt')

function readGfmSpecText(): string {
  return readFileSync(GFM_SPEC_PATH, 'utf8')
}

/**
 * Version of the fetched GFM spec, read from its YAML front matter
 * (`version: 0.29`). Falls back to the pinned tag if the header is ever absent.
 */
export function gfmSpecVersion(): string {
  const match = readGfmSpecText().match(/^version:\s*(.+)$/m)
  return match?.[1]?.trim() ?? GFM_SPEC_SOURCE.ref
}

/** Parse every embedded conformance example from the fetched GFM spec text. */
export function loadGfmSpec(): SpecExample[] {
  return parseSpecExamples(readGfmSpecText())
}
