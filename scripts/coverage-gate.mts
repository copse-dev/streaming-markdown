// Coverage ratchet: fail CI when a change lowers line coverage below the
// committed baseline, and make it easy to raise the bar when coverage improves.
//
// Why line coverage only: line totals are the trustworthy, stable number to
// gate on. Per-file branch/function data still lives in the HTML/lcov report
// for humans, but the aggregate rollup is gated on lines to avoid flapping the
// bar on unrelated changes.
//
//   npm run coverage          # run tests under c8, write coverage/ reports
//   npm run coverage:check    # compare against baseline, fail on regression
//   npm run coverage:update   # raise the baseline to the current coverage
//
import { readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const SUMMARY = resolve('coverage/coverage-summary.json')
const LCOV = resolve('coverage/lcov.info')
const BASELINE = resolve('coverage-baseline.json')
// Tolerance absorbs sub-0.01% float jitter so an unrelated change is never
// failed by rounding noise. A real regression is far larger than this.
const TOLERANCE = 0.01

const update = process.argv.includes('--update')

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch (err) {
    console.error(
      `coverage-gate: could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  }
}

const summary = await readJson(SUMMARY)
const total = (summary['total'] as { lines?: { pct?: number } } | undefined)?.lines
if (typeof total?.pct !== 'number') {
  console.error(
    `coverage-gate: ${SUMMARY} has no total.lines.pct — run \`npm run coverage\` first.`,
  )
  process.exit(1)
}
const current = total.pct

if (update) {
  await writeFile(BASELINE, JSON.stringify({ lines: current }, null, 2) + '\n')
  console.log(`coverage-gate: baseline updated to ${String(current)}% lines.`)
  process.exit(0)
}

const baseline = await readJson(BASELINE)
const required = typeof baseline['lines'] === 'number' ? baseline['lines'] : 0
const delta = current - required

const summaryLine =
  `Line coverage: ${String(current)}% (baseline ${String(required)}%, ` +
  `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%)`
console.log(summaryLine)

// Surface the result on the GitHub Actions run summary when available.
const stepSummary = process.env['GITHUB_STEP_SUMMARY']
if (stepSummary) {
  await writeFile(stepSummary, `### Coverage\n\n${summaryLine}\n`, { flag: 'a' })
}

/**
 * The uncovered line numbers per file, collapsed into ranges, from the lcov
 * report's authoritative per-line records (`DA:<line>,<hits>`). On a
 * regression this is the fastest clue to WHAT didn't run — a conditionally-
 * skipped suite, a missing fetched fixture — not just that something didn't.
 * (The v1.0.0-rc.1 release gate failed at 99.9% and the culprit — the GFM
 * spec fetch missing from release.yml, silently skipping the GFM conformance
 * suite — had to be reverse-engineered; with this printout the log names the
 * orphaned lines directly.)
 */
async function uncoveredLines(): Promise<string[]> {
  let lcov: string
  try {
    lcov = await readFile(LCOV, 'utf8')
  } catch {
    return []
  }
  const rows: string[] = []
  let file = ''
  let lines: number[] = []
  const flush = (): void => {
    if (!file || lines.length === 0) {
      lines = []
      return
    }
    const sorted = [...lines].sort((a, b) => a - b)
    const ranges: string[] = []
    let start = sorted[0] ?? 0
    let prev = start
    for (const l of sorted.slice(1)) {
      if (l === prev + 1) {
        prev = l
        continue
      }
      ranges.push(start === prev ? String(start) : `${String(start)}-${String(prev)}`)
      start = prev = l
    }
    ranges.push(start === prev ? String(start) : `${String(start)}-${String(prev)}`)
    rows.push(`  ${relative(process.cwd(), resolve(file))}: ${ranges.join(', ')}`)
    lines = []
  }
  for (const raw of lcov.split('\n')) {
    if (raw.startsWith('SF:')) {
      flush()
      file = raw.slice(3).trim()
    } else if (raw.startsWith('DA:')) {
      const [line, hits] = raw.slice(3).split(',')
      if (hits?.trim() === '0') lines.push(Number(line))
    } else if (raw.startsWith('end_of_record')) {
      flush()
      file = ''
    }
  }
  flush()
  return rows.sort()
}

if (current + TOLERANCE < required) {
  const rows = await uncoveredLines()
  const detail = rows.length
    ? `\nUncovered lines (what didn't run):\n${rows.join('\n')}`
    : ''
  console.error(
    `coverage-gate: line coverage regressed to ${String(current)}% (below baseline ${String(required)}%).\n` +
      `Add tests to restore coverage, or — if this drop is intentional — lower the\n` +
      `baseline in coverage-baseline.json.${detail}`,
  )
  if (stepSummary && rows.length) {
    await writeFile(
      stepSummary,
      `\n#### Uncovered lines\n\n\`\`\`\n${rows.join('\n')}\n\`\`\`\n`,
      { flag: 'a' },
    )
  }
  process.exit(1)
}

if (delta > TOLERANCE) {
  console.log(
    `coverage-gate: coverage improved by ${delta.toFixed(2)}%. ` +
      `Run \`npm run coverage:update\` and commit coverage-baseline.json to ratchet the bar up.`,
  )
}
