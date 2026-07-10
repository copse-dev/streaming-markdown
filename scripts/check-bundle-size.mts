/**
 * Bundle-size gate (#113).
 *
 * The core value prop is a small main entry: ~28–30 KB gzipped+minified with
 * the heavy backends kept behind lazy subpaths. Nothing guarded that number, so
 * a static import that pulled a grammar payload (or the emoji data table) back
 * into the core bundle would ship unnoticed. This script measures the package's
 * OWN contribution to a consumer's bundle for the main entry and each key
 * subpath, and fails when a measured size exceeds its committed budget.
 *
 * How the measurement mirrors a real consumer: each entry is bundled from
 * `dist/` with esbuild (`--bundle --minify --format=esm --platform=browser`),
 * the optional peer dependencies are marked EXTERNAL (dompurify, highlight.js,
 * katex, mermaid, shiki, entities — the host installs and bundles those), and
 * the minified output is gzipped. Deterministic given the locked esbuild + zlib,
 * so the same dist always yields the same number in CI.
 *
 * Usage:
 *   node --import tsx scripts/check-bundle-size.mts           # check (CI)
 *   node --import tsx scripts/check-bundle-size.mts --update  # rewrite budgets
 *
 * Run `npm run build` first — this measures the committed `dist/`.
 */
import { build } from 'esbuild'
import { gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const budgetPath = resolve(pkgRoot, 'scripts/bundle-size-budget.json')

interface Entry {
  file: string
  gzipBudget: number
}
interface Budget {
  note: string
  externals: string[]
  entries: Record<string, Entry>
}

const budget = JSON.parse(readFileSync(budgetPath, 'utf8')) as Budget
const update = process.argv.includes('--update')

/** Bundle one entry from dist as a consumer would, and return gzipped bytes. */
async function measure(file: string): Promise<number> {
  const abs = resolve(pkgRoot, file)
  if (!existsSync(abs)) {
    throw new Error(`missing ${file} — run \`npm run build\` before the size check`)
  }
  const result = await build({
    entryPoints: [abs],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external: budget.externals,
    logLevel: 'silent',
  })
  const out = result.outputFiles?.[0]?.contents
  if (!out) throw new Error(`esbuild produced no output for ${file}`)
  return gzipSync(out).length
}

/** Budget = measured + ~5% headroom, rounded up to the next 10 bytes. */
function withHeadroom(measured: number): number {
  return Math.ceil((measured * 1.05) / 10) * 10
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}
function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

const cols = [pad('entry', 30), padLeft('gzip B', 9), padLeft('budget B', 10), padLeft('used', 7), '']
console.log(`bundle-size gate — gzipped+minified, peers external (node ${process.version})\n`)
console.log(cols.join('  '))
console.log('-'.repeat(cols.join('  ').length))

let failed = false
const measured: Record<string, number> = {}

for (const [name, entry] of Object.entries(budget.entries)) {
  const gz = await measure(entry.file)
  measured[name] = gz
  const pct = (gz / entry.gzipBudget) * 100
  const over = gz > entry.gzipBudget
  if (over && !update) failed = true
  console.log(
    [
      pad(name, 30),
      padLeft(String(gz), 9),
      padLeft(String(entry.gzipBudget), 10),
      padLeft(`${pct.toFixed(0)}%`, 7),
      over ? '  OVER BUDGET' : '',
    ].join('  '),
  )
}

if (update) {
  for (const [name, gz] of Object.entries(measured)) {
    budget.entries[name]!.gzipBudget = withHeadroom(gz)
  }
  writeFileSync(budgetPath, JSON.stringify(budget, null, 2) + '\n')
  console.log('\nBudgets updated (measured + ~5% headroom).')
} else if (failed) {
  console.error(
    '\nA bundle entry exceeded its committed budget. If the growth is intentional, ' +
      'run `npm run size:update` and commit scripts/bundle-size-budget.json; otherwise ' +
      'a dependency likely leaked into the core bundle (see docs/LAZY-LOADING.md).',
  )
  process.exit(1)
} else {
  console.log('\nAll entries within budget.')
}
