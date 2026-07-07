import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GFM_EXTENSION_SECTIONS,
  GFM_SPEC_PATH,
  loadGfmSpec,
  type SpecExample,
} from './load-spec.ts'

// Anchored on this module's directory (not `process.cwd()`) so the baseline
// loads regardless of the directory tests are launched from.
const BASELINE_PATH = resolve(import.meta.dirname, '../fixtures/gfm/gfm-conformance-baseline.json')

/** Whether the on-demand-fetched GFM spec.txt is present (see load-spec.ts). */
export function gfmSpecAvailable(): boolean {
  return existsSync(GFM_SPEC_PATH)
}

/**
 * GFM spec examples that currently pass the at-rest conformance baseline.
 * Returns [] when spec.txt has not been fetched (bare offline `npm test`), so
 * callers degrade to the CommonMark-only corpus; CI runs `check:gfm-spec` first.
 */
export function loadGfmBaselinePassingExamples(): SpecExample[] {
  if (!gfmSpecAvailable()) return []
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as { passing: number[] }
  const spec = loadGfmSpec()
  const byExample = new Map(spec.map((e) => [e.example, e]))
  return baseline.passing.map((n) => {
    const ex = byExample.get(n)
    if (!ex) throw new Error(`GFM baseline example #${String(n)} missing from spec`)
    return ex
  })
}

/**
 * The GFM-only slice of the passing baseline (tables, task lists, strikethrough,
 * extended autolinks). The base sections mirror CommonMark examples the streaming
 * suites already fuzz, so extension-focused corpora use this to avoid doubling
 * runtime on near-duplicates.
 */
export function loadGfmExtensionBaselineExamples(): SpecExample[] {
  return loadGfmBaselinePassingExamples().filter((e) => GFM_EXTENSION_SECTIONS.has(e.section))
}
