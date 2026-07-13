// Generate the conformance report from the pinned baseline JSONs.
//
// The four `*-conformance-baseline*.json` fixtures are the single source of
// truth for how many spec examples the renderer satisfies. Prose that hand-copies
// those numbers drifts out of sync, so this script derives the whole report from
// the JSONs instead — run it and paste, never re-type the figures.
//
//   npm run report:conformance     # print the Markdown report to stdout
//
// Pure and read-only: it reads the four baselines and writes nothing (no network,
// no filesystem writes). It never regenerates the baselines — that is the job of
// the `UPDATE_*_BASELINE=1 npm test` re-baseline flows.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Sections that fail by design under the pinned `htmlPolicy: 'escape'` harness
// (sanitize-at-the-sink escapes untrusted HTML rather than passing it through).
// The in-scope ceiling excludes them; keys must match `summaryBySection`.
const EXCLUDED_SECTIONS = ['HTML blocks', 'Raw HTML'] as const

interface SectionSummary {
  pass: number
  total: number
}

interface Baseline {
  specVersion?: string
  total: number
  passing: string[]
  summaryBySection: Record<string, SectionSummary>
  extensionSummary?: Record<string, SectionSummary>
}

interface BaselineRef {
  spec: 'CommonMark' | 'GFM'
  policy: 'escape' | 'passthrough'
  path: string
}

const BASELINES: BaselineRef[] = [
  {
    spec: 'CommonMark',
    policy: 'escape',
    path: 'tests/fixtures/commonmark/conformance-baseline.json',
  },
  {
    spec: 'CommonMark',
    policy: 'passthrough',
    path: 'tests/fixtures/commonmark/conformance-baseline-passthrough.json',
  },
  {
    spec: 'GFM',
    policy: 'escape',
    path: 'tests/fixtures/gfm/gfm-conformance-baseline.json',
  },
  {
    spec: 'GFM',
    policy: 'passthrough',
    path: 'tests/fixtures/gfm/gfm-conformance-baseline-passthrough.json',
  },
]

const pct = (pass: number, total: number): string =>
  total === 0 ? '—' : `${((pass / total) * 100).toFixed(1)}%`

async function readBaseline(ref: BaselineRef): Promise<Baseline> {
  const path = resolve(ref.path)
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Baseline
  } catch (err) {
    console.error(
      `conformance-report: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }
}

interface Loaded extends BaselineRef {
  data: Baseline
}

/** Passing / total after removing the by-design HTML-block + Raw-HTML sections. */
function inScope(data: Baseline): SectionSummary {
  let pass = data.passing.length
  let total = data.total
  for (const key of EXCLUDED_SECTIONS) {
    const section = data.summaryBySection[key]
    if (!section) continue
    pass -= section.pass
    total -= section.total
  }
  return { pass, total }
}

function headlineTable(loaded: Loaded[]): string {
  const rows = loaded.map((entry) => {
    const passing = entry.data.passing.length
    const total = entry.data.total
    return `| ${entry.spec} | ${entry.policy} | ${passing} / ${total} | ${pct(passing, total)} |`
  })
  return [
    '| Spec | Policy | Passing / total | % |',
    '| ---- | ------ | --------------- | -- |',
    ...rows,
  ].join('\n')
}

function inScopeTable(loaded: Loaded[]): string {
  const rows = loaded.map((entry) => {
    const scope = inScope(entry.data)
    return `| ${entry.spec} | ${entry.policy} | ${scope.pass} / ${scope.total} | ${pct(scope.pass, scope.total)} |`
  })
  return [
    '| Spec | Policy | In-scope passing / total | % |',
    '| ---- | ------ | ------------------------ | -- |',
    ...rows,
  ].join('\n')
}

function breakdownTable(data: Baseline): string {
  const rows = Object.entries(data.summaryBySection).map(([name, s]) => {
    const excluded = (EXCLUDED_SECTIONS as readonly string[]).includes(name)
    const label = excluded ? `${name} *(out of scope)*` : name
    return `| ${label} | ${s.pass} / ${s.total} | ${pct(s.pass, s.total)} |`
  })
  return [
    '| Section | Pass / total | % |',
    '| ------- | ------------ | -- |',
    ...rows,
  ].join('\n')
}

/**
 * Set delta between the escape and passthrough passing SETS — not a per-section
 * count diff. A section can gain and lose examples yet still net positive, so
 * counts alone never prove membership; this compares the `passing` id arrays.
 */
function setDelta(
  escape: Baseline,
  passthrough: Baseline,
): { gained: string[]; dropped: string[] } {
  const esc = new Set(escape.passing.map(String))
  const pass = new Set(passthrough.passing.map(String))
  const numeric = (a: string, b: string): number => {
    const na = Number(a)
    const nb = Number(b)
    if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b)
    return na - nb
  }
  const dropped = [...esc].filter((id) => !pass.has(id)).sort(numeric)
  const gained = [...pass].filter((id) => !esc.has(id)).sort(numeric)
  return { gained, dropped }
}

function deltaTable(loaded: Loaded[]): string {
  const bySpec = new Map<string, Partial<Record<'escape' | 'passthrough', Baseline>>>()
  for (const entry of loaded) {
    const slot = bySpec.get(entry.spec) ?? {}
    slot[entry.policy] = entry.data
    bySpec.set(entry.spec, slot)
  }
  const rows: string[] = []
  for (const [spec, slot] of bySpec) {
    if (!slot.escape || !slot.passthrough) continue
    const { gained, dropped } = setDelta(slot.escape, slot.passthrough)
    const net = gained.length - dropped.length
    const droppedList = dropped.length ? `#${dropped.join(', #')}` : '—'
    rows.push(
      `| ${spec} | +${gained.length} | −${dropped.length} | ${net >= 0 ? '+' : ''}${net} | ${droppedList} |`,
    )
  }
  return [
    '| Spec | Gained (passthrough-only) | Dropped (escape-only) | Net | Dropped examples |',
    '| ---- | ------------------------- | --------------------- | --- | ---------------- |',
    ...rows,
  ].join('\n')
}

function extensionTable(data: Baseline): string {
  if (!data.extensionSummary) return ''
  const rows = Object.entries(data.extensionSummary).map(
    ([name, s]) => `| ${name} | ${s.pass} / ${s.total} | ${pct(s.pass, s.total)} |`,
  )
  return [
    '| GFM extension | Pass / total | % |',
    '| ------------- | ------------ | -- |',
    ...rows,
  ].join('\n')
}

async function main(): Promise<void> {
  const loaded: Loaded[] = await Promise.all(
    BASELINES.map(async (ref) => ({ ...ref, data: await readBaseline(ref) })),
  )

  const out: string[] = []
  out.push('# Conformance report')
  out.push('')
  out.push(
    'Generated from the pinned baseline JSONs by `npm run report:conformance`. ' +
      'Do not hand-edit these numbers — re-run the script.',
  )
  out.push('')

  out.push('## Headline')
  out.push('')
  out.push('Every spec example, both raw-HTML policies:')
  out.push('')
  out.push(headlineTable(loaded))
  out.push('')

  out.push('## In-scope ceiling')
  out.push('')
  out.push(
    `Excludes the by-design failures in the ${EXCLUDED_SECTIONS.map((s) => `**${s}**`).join(' + ')} ` +
      'sections (sanitize-at-the-sink escapes untrusted HTML rather than passing it through):',
  )
  out.push('')
  out.push(inScopeTable(loaded))
  out.push('')

  out.push('## Escape ↔ passthrough set delta')
  out.push('')
  out.push(
    'Passthrough is **not** a strict superset of escape: a handful of inline raw-HTML ' +
      'examples pass under escape (their escaped output happens to match the spec) but ' +
      'not under passthrough, while more pass under passthrough. Compares the passing ' +
      '`id` SETS, not per-section counts:',
  )
  out.push('')
  out.push(deltaTable(loaded))
  out.push('')

  out.push('## Per-section breakdown')
  for (const entry of loaded) {
    out.push('')
    out.push(`### ${entry.spec} — ${entry.policy}`)
    out.push('')
    out.push(breakdownTable(entry.data))
    const ext = extensionTable(entry.data)
    if (ext) {
      out.push('')
      out.push(`#### ${entry.spec} extensions — ${entry.policy}`)
      out.push('')
      out.push(ext)
    }
  }
  out.push('')

  process.stdout.write(out.join('\n') + '\n')
}

await main()
