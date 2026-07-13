// Generate the conformance report from the pinned baseline JSONs.
//
// The four `*-conformance-baseline*.json` fixtures are the single source of
// truth for how many spec examples the renderer satisfies. Prose that hand-copies
// those numbers drifts out of sync, so this script derives the whole report from
// the JSONs instead — run it and paste, never re-type the figures.
//
//   npm run report:conformance          # print the Markdown report to stdout
//   npm run report:conformance:check    # CI gate — fail if the docs drifted
//
// `--check` reads the living docs (see `CHECKED_DOCS`) and verifies that every
// conformance fraction they cite (`N/652`, `N/672`, `N/588`, `N/609`) matches a
// value the baselines actually produce — so the prose can never silently drift
// from the fixtures again. It is the reason the numbers keep needing correction:
// a generator alone only helps if you remember to run it; this makes CI remember.
//
// Pure and read-only: it reads the four baselines (and, in `--check`, the docs)
// and writes nothing (no network, no filesystem writes). It never regenerates the
// baselines — that is the job of the `UPDATE_*_BASELINE=1 npm test` re-baseline flows.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

// Living docs whose cited conformance numbers `--check` keeps honest. Point-in-time
// ADRs that record a snapshot are intentionally excluded — only docs meant to stay
// current are gated. Extend this list to gate more.
const CHECKED_DOCS = ['docs/ARCHITECTURE.md'] as const

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

/**
 * Map each conformance denominator the docs may cite (a spec total, or an
 * in-scope total after excluding the HTML sections) to the set of numerators the
 * baselines actually produce for it. Any `N/denominator` in the docs whose N is
 * not in this set is stale.
 */
function validNumeratorsByDenominator(loaded: Loaded[]): Map<number, Set<number>> {
  const valid = new Map<number, Set<number>>()
  const add = (denominator: number, numerator: number): void => {
    const set = valid.get(denominator) ?? new Set<number>()
    set.add(numerator)
    valid.set(denominator, set)
  }
  for (const entry of loaded) {
    add(entry.data.total, entry.data.passing.length) // e.g. 652 -> {579, 583}
    const scope = inScope(entry.data)
    add(scope.total, scope.pass) // e.g. 588 -> {569, 572}
  }
  return valid
}

interface Drift {
  doc: string
  line: number
  fraction: string
  numerator: number
  denominator: number
  expected: number[]
}

/**
 * `--check`: fail if any conformance fraction cited in the living docs disagrees
 * with the baselines. Data-driven (denominator → valid numerators), so it is
 * robust to rewording — only the numbers are asserted, not the surrounding prose.
 * Markdown emphasis is stripped first, so a bolded numerator still reads as a number.
 */
async function runCheck(loaded: Loaded[]): Promise<void> {
  const valid = validNumeratorsByDenominator(loaded)
  const fraction = /(\d+)\s*\/\s*(\d+)/g
  const drifts: Drift[] = []

  for (const doc of CHECKED_DOCS) {
    let raw: string
    try {
      raw = await readFile(resolve(doc), 'utf8')
    } catch (err) {
      console.error(
        `conformance-report --check: could not read ${doc}: ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    }
    raw.split('\n').forEach((rawLine, index) => {
      const line = rawLine.replace(/\*/g, '') // drop markdown emphasis around numbers
      for (const match of line.matchAll(fraction)) {
        const numerator = Number(match[1])
        const denominator = Number(match[2])
        const expected = valid.get(denominator)
        if (!expected) continue // not a conformance denominator — ignore
        if (!expected.has(numerator)) {
          drifts.push({
            doc,
            line: index + 1,
            fraction: `${numerator}/${denominator}`,
            numerator,
            denominator,
            expected: [...expected].sort((a, b) => a - b),
          })
        }
      }
    })
  }

  if (drifts.length === 0) {
    const denoms = [...valid.keys()].sort((a, b) => a - b).join(', ')
    console.log(
      `conformance-report --check: OK — every cited fraction (denominators ${denoms}) matches the baselines.`,
    )
    return
  }

  console.error('conformance-report --check: FAILED — docs cite conformance numbers that no longer match the baselines:\n')
  for (const d of drifts) {
    console.error(
      `  ${d.doc}:${d.line}  ${d.fraction} — expected ${d.expected.map((n) => `${n}/${d.denominator}`).join(' or ')}`,
    )
  }
  console.error(
    '\nFix the prose to match, or if the baselines legitimately changed run the' +
      ' `UPDATE_*_BASELINE=1 npm test` flows first. `npm run report:conformance` prints the current numbers.',
  )
  process.exit(1)
}

async function main(): Promise<void> {
  const loaded: Loaded[] = await Promise.all(
    BASELINES.map(async (ref) => ({ ...ref, data: await readBaseline(ref) })),
  )

  if (process.argv.slice(2).includes('--check')) {
    await runCheck(loaded)
    return
  }

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
