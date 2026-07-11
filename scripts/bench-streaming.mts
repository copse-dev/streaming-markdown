/**
 * Streaming-markdown performance benchmark (#618).
 *
 * Replays representative documents token-by-token through both streaming
 * emitters — the incremental DOM path (`StreamingMarkdownRenderer.update`) and
 * the full-re-render string path (`renderStreamingMarkdown`) — and reports the
 * median wall-clock time to stream each fixture to completion.
 *
 * Run: `npm run bench` (optionally `-- --iters 9 --chunk 4`).
 *
 * The absolute numbers are machine-dependent; treat them as a relative baseline.
 * The incremental DOM path should stay at or below the string path, and neither
 * should scale super-linearly with input size — a large jump for a modest input
 * growth is the O(n²) regression this harness exists to catch.
 */
import '../tests/setup-dom-jsdom.ts'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { renderStreamingMarkdown, StreamingMarkdownRenderer } from '../src/streaming.ts'
import { IncrementalSourceScanner } from '../src/incremental-scan.ts'
import { tokenizeBlocks } from '../src/block-tokenizer.ts'
import { setDefaultConfig } from '../src/config.ts'
import { highlightjsHighlighter } from '../src/highlight-hljs.ts'
import { loadBaselinePassingExamples } from '../tests/commonmark/baseline-examples.ts'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Cap replay steps per fixture so a large document can't explode the string
// path's O(n²) re-render (and jsdom sanitize memory) — the chunk size grows to
// keep every fixture at or below this many streamed updates.
const MAX_UPDATES = 160

interface Args {
  iters: number
  warmup: number
  chunk: number
}

function parseArgs(argv: string[]): Args {
  const args: Args = { iters: 5, warmup: 2, chunk: 8 }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = Number(argv[i + 1])
    if (flag === '--iters' && Number.isFinite(value)) args.iters = value
    if (flag === '--warmup' && Number.isFinite(value)) args.warmup = value
    if (flag === '--chunk' && Number.isFinite(value)) args.chunk = Math.max(1, value)
  }
  return args
}

/** A representative CommonMark document: medium-length passing baseline examples joined. */
function commonMarkMixed(): string {
  return loadBaselinePassingExamples()
    .filter((e) => e.markdown.length >= 20 && e.markdown.length <= 400)
    .slice(0, 60)
    .map((e) => e.markdown.trimEnd())
    .join('\n\n')
}

/** Effective chunk size: at least the requested chunk, but coarse enough to stay ≤ MAX_UPDATES. */
function effectiveChunk(length: number, chunk: number): number {
  return Math.max(chunk, Math.ceil(length / MAX_UPDATES))
}

/** Synthetic worst-case: a wide table plus a long inline-rich list. */
function syntheticTableAndList(rows = 30, items = 45): string {
  const header = '| Name | Status | Owner | Notes |\n| --- | --- | --- | --- |'
  const body = Array.from(
    { length: rows },
    (_, i) =>
      `| item-${String(i)} | ${i % 2 ? 'done' : 'pending'} | \`user_${String(i)}\` | see [#${String(i)}](https://example.com/${String(i)}) |`,
  ).join('\n')
  const list = Array.from(
    { length: items },
    (_, i) =>
      `- **item ${String(i)}**: some \`code_${String(i)}\` and *emphasis* and a [link](path/to/file_${String(i)}.ts)`,
  ).join('\n')
  return `## Report\n\n${header}\n${body}\n\n## Checklist\n\n${list}\n`
}

function termsOfService(): string {
  return readFileSync(resolve(pkgRoot, 'tests/fixtures/terms-of-service-streaming.md'), 'utf8')
}

// Real-document corpus (#154): hand-collected markdown that mirrors the content
// this library actually streams — an LLM technical answer, a README section, and
// a changelog (mixed prose, code, tables, task lists, footnotes, blockquotes).
// Used by the real-document scaling guard below (DOM path only) so the growth
// guard is representative of real content, not only synthetic shapes. Deliberately
// NOT run through the informational string+DOM table: the string path's O(n²)
// re-render over several fixtures back-to-back is what dominates the CI bench heap.
const CORPUS_FILES = ['llm-answer.md', 'readme-section.md', 'changelog.md'] as const

function corpusDoc(file: string): string {
  return readFileSync(resolve(pkgRoot, 'tests/fixtures/bench-corpus', file), 'utf8')
}

/**
 * Footnote-heavy fixture (#110): `paras` cited paragraphs followed by their
 * definitions — the shape LLM citations stream in. References are literal until
 * their definition arrives, then upgrade to numbered `<sup>` links and grow the
 * trailing footnotes section. This used to force a full re-morph on every commit
 * (the whole stream O(n²)); the guard below asserts it no longer does.
 */
function footnoteDoc(paras: number): string {
  const body = Array.from(
    { length: paras },
    (_, i) => `Paragraph ${String(i)} makes a claim.[^${String(i)}]`,
  ).join('\n\n')
  const defs = Array.from(
    { length: paras },
    (_, i) => `[^${String(i)}]: Source number ${String(i)}.`,
  ).join('\n')
  return `${body}\n\n${defs}\n`
}

/**
 * Code-block-heavy fixture (#155): `blocks` fenced code blocks, each `linesPer`
 * lines, streamed token-by-token. Once a fence closes it becomes a committed
 * block the frozen-tail path freezes, so it is highlighted (or escaped) exactly
 * once; re-highlighting the growing set of *closed* blocks on every update is the
 * super-linear cost a naive re-render incurs, and the case competitors benchmark
 * on code-heavy LLM traces. Language `js` so a registered highlighter does real work.
 */
function codeBlocksDoc(blocks: number, linesPer = 8): string {
  return (
    Array.from(
      { length: blocks },
      (_, i) =>
        '```js\n' +
        Array.from(
          { length: linesPer },
          (_, j) => `const x_${String(i)}_${String(j)} = compute(${String(j)}) + ${String(i)};`,
        ).join('\n') +
        '\n```',
    ).join('\n\n') + '\n'
  )
}

function chunkBoundaries(length: number, chunk: number): number[] {
  const cuts: number[] = []
  for (let i = chunk; i < length; i += chunk) cuts.push(i)
  cuts.push(length)
  return cuts
}

function benchStringPath(text: string, chunk: number): number {
  const cuts = chunkBoundaries(text.length, chunk)
  const start = performance.now()
  for (const cut of cuts) renderStreamingMarkdown(text.slice(0, cut))
  return performance.now() - start
}

function benchDomPath(text: string, chunk: number): number {
  const host = document.createElement('div')
  const renderer = new StreamingMarkdownRenderer(host)
  const cuts = chunkBoundaries(text.length, chunk)
  const start = performance.now()
  for (const cut of cuts) renderer.update(text.slice(0, cut))
  return performance.now() - start
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function measure(run: () => number, iters: number, warmup: number): number {
  for (let i = 0; i < warmup; i++) run()
  const times: number[] = []
  for (let i = 0; i < iters; i++) times.push(run())
  return median(times)
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

const args = parseArgs(process.argv.slice(2))
const fixtures: { name: string; text: string }[] = [
  { name: 'commonmark-mixed', text: commonMarkMixed() },
  { name: 'terms-of-service', text: termsOfService() },
  { name: 'synthetic-table+list', text: syntheticTableAndList() },
  { name: 'footnotes-heavy', text: footnoteDoc(80) },
]

console.log(
  `streaming-markdown bench — iters=${String(args.iters)} warmup=${String(args.warmup)} chunk=${String(args.chunk)} (node ${process.version})\n`,
)
const cols = [
  pad('fixture', 22),
  padLeft('bytes', 8),
  padLeft('updates', 9),
  padLeft('string ms', 11),
  padLeft('dom ms', 9),
  padLeft('dom/str', 9),
]
console.log(cols.join('  '))
console.log('-'.repeat(cols.join('  ').length))

for (const { name, text } of fixtures) {
  const chunk = effectiveChunk(text.length, args.chunk)
  const updates = chunkBoundaries(text.length, chunk).length
  const stringMs = measure(() => benchStringPath(text, chunk), args.iters, args.warmup)
  const domMs = measure(() => benchDomPath(text, chunk), args.iters, args.warmup)
  const ratio = stringMs > 0 ? domMs / stringMs : 0
  console.log(
    [
      pad(name, 22),
      padLeft(String(text.length), 8),
      padLeft(String(updates), 9),
      padLeft(stringMs.toFixed(2), 11),
      padLeft(domMs.toFixed(2), 9),
      padLeft(ratio.toFixed(2) + '×', 9),
    ].join('  '),
  )
}

// Scaling section (#21): stream a plain-prose document at a FIXED chunk size so
// the number of updates grows with the input. Doubling the paragraph count shows
// how the DOM path scales. With the frozen/tail split (Layer 2) plus tail-scoped
// pending queries, per-commit work is O(tail) and per-frame DOM work is O(1), so
// this grows ~1.7×/doubling across the range (down from ~4× for the unoptimized
// full-re-render path). The residual super-linearity is the per-update tokenize
// + link-ref string scans (limitation K), ~1% of wall-clock here.
function prose(paras: number): string {
  return (
    Array.from(
      { length: paras },
      (_, i) =>
        `Paragraph ${String(i)} has some **bold**, \`code\`, *emphasis* and a [link](https://example.com/${String(i)}) plus a few trailing words.`,
    ).join('\n\n') + '\n'
  )
}

console.log('\nscaling — DOM path, fixed 32-byte chunk (updates grow with size)\n')
const scaleCols = [pad('paras', 8), padLeft('bytes', 8), padLeft('updates', 9), padLeft('dom ms', 10), padLeft('vs prev', 9)]
console.log(scaleCols.join('  '))
console.log('-'.repeat(scaleCols.join('  ').length))
let prevScaleMs = 0
const growthFactors: number[] = []
for (const paras of [25, 50, 100]) {
  const text = prose(paras)
  const updates = chunkBoundaries(text.length, 32).length
  const domMs = measure(() => benchDomPath(text, 32), args.iters, args.warmup)
  const factor = prevScaleMs > 0 ? domMs / prevScaleMs : 0
  if (factor > 0) growthFactors.push(factor)
  console.log(
    [
      pad(String(paras), 8),
      padLeft(String(text.length), 8),
      padLeft(String(updates), 9),
      padLeft(domMs.toFixed(2), 10),
      padLeft(factor > 0 ? `${factor.toFixed(2)}×` : '—', 9),
    ].join('  '),
  )
  prevScaleMs = domMs
}

// Regression guard (#21 acceptance criterion). Doubling the input roughly
// doubles the DOM streaming time once the committed prefix is frozen; the
// unoptimized full-re-render path grew ~4×/doubling. Assert the mean stays well
// under that. Generous (< 3×) so ordinary jsdom timing noise never trips it; a
// return to O(prefix)-per-commit committed rendering would push it back toward
// 4× and fail here. Bench is a manual script, so this gates local regressions,
// not CI.
const meanGrowth = growthFactors.reduce((a, x) => a + x, 0) / growthFactors.length
console.log(`\nmean growth per doubling: ${meanGrowth.toFixed(2)}× (regression guard: < 3.0×)`)
if (meanGrowth >= 3.0) {
  throw new Error(
    `DOM streaming scaled ${meanGrowth.toFixed(2)}×/doubling — expected sub-quadratic (< 3×). ` +
      `A committed-prefix re-render regression (#21) is the likely cause.`,
  )
}

// Footnote scaling (#110): stream a footnote-heavy document at a FIXED chunk so
// updates grow with size. The old path full-re-morphed on every commit once `[^`
// was present, so this grew ~4×/doubling (100 paras ≈ 3.5s, 200 ≈ 15s). With the
// incremental footnote path — re-morphing only the reference blocks a definition
// changed plus the new section items — it grows sub-quadratically.
console.log('\nfootnote scaling — DOM path, fixed 48-byte chunk (updates grow with size)\n')
console.log(scaleCols.join('  '))
console.log('-'.repeat(scaleCols.join('  ').length))
let prevFnMs = 0
const fnGrowthFactors: number[] = []
for (const paras of [50, 100, 200]) {
  const text = footnoteDoc(paras)
  const updates = chunkBoundaries(text.length, 48).length
  const domMs = measure(() => benchDomPath(text, 48), args.iters, args.warmup)
  const factor = prevFnMs > 0 ? domMs / prevFnMs : 0
  if (factor > 0) fnGrowthFactors.push(factor)
  console.log(
    [
      pad(String(paras), 8),
      padLeft(String(text.length), 8),
      padLeft(String(updates), 9),
      padLeft(domMs.toFixed(2), 10),
      padLeft(factor > 0 ? `${factor.toFixed(2)}×` : '—', 9),
    ].join('  '),
  )
  prevFnMs = domMs
}

const meanFnGrowth = fnGrowthFactors.reduce((a, x) => a + x, 0) / fnGrowthFactors.length
// The incremental footnote path (#110) now re-renders only the newly-resolved
// reference block and appends only the new section item per commit, and skips the
// O(items) pending-sweep over the committed footnotes section (#133) — so it
// scales ~O(n) (~2.2×/doubling here, flat across the range), down from the rising
// ~2.6–3.3× curve before #133 and far from the pre-#110 full-re-morph (~4.3×).
// The guard (re-tightened from the interim < 3.8× once #133 landed) catches a
// regression back toward per-commit full re-render.
console.log(`\nfootnote mean growth per doubling: ${meanFnGrowth.toFixed(2)}× (regression guard: < 3.0×)`)
if (meanFnGrowth >= 3.0) {
  throw new Error(
    `Footnote DOM streaming scaled ${meanFnGrowth.toFixed(2)}×/doubling — expected ~O(n) ` +
      `(< 3.0×; see #133). A regression to per-commit full re-render on '[^' (#110) is the likely cause.`,
  )
}

// Incremental-scan section (#111): the string scan (`tokenizeBlocks` over the
// stream) is the residual super-linear cost (limitation K). `scannedChars` is
// the deterministic, timing-free count of characters actually re-tokenized over
// a whole append-only stream. The #30 resume keeps it O(n) for prose, but before
// #111 a loose LIST or a BLOCKQUOTE re-tokenized from its container top on every
// update — ~40-140× the prose baseline — because no safe boundary was ever
// established inside the container. These fixtures guard both shapes: the list-
// and quote-shaped `scan/prose` ratios should stay a small multiple of 1×, not
// balloon back toward two orders of magnitude.
function scannedChars(text: string): number {
  const scanner = new IncrementalSourceScanner()
  const cuts = chunkBoundaries(text.length, 1)
  for (const cut of cuts) scanner.tokenize(text.slice(0, cut))
  return scanner.scannedChars
}

/** N items joined by blank lines — the loose-list / blockquote LLM answer shape. */
function shaped(kind: 'prose' | 'ordered' | 'unordered' | 'quote', items: number): string {
  const body = (i: number): string =>
    `Point ${String(i)} with **bold**, \`code_${String(i)}\`, *emphasis* and a [link](https://example.com/${String(i)}) of prose.`
  const line = (i: number): string => {
    if (kind === 'ordered') return `${String(i + 1)}. ${body(i)}`
    if (kind === 'unordered') return `- ${body(i)}`
    if (kind === 'quote') return `> ${body(i)}`
    return body(i)
  }
  return Array.from({ length: items }, (_, i) => line(i)).join('\n\n') + '\n'
}

/** A single blockquote continued by many unmarked lazy lines (the O(n³) shape). */
function lazyQuote(lines: number): string {
  return (
    '> quote start of a long lazily-continued blockquote paragraph\n' +
    Array.from({ length: lines }, (_, i) => `lazy continuation line ${String(i)} of the same quote paragraph`).join('\n') +
    '\n'
  )
}

console.log('\nincremental scan — scannedChars over an append-only stream (char-by-char)\n')
const scanCols = [pad('shape', 22), padLeft('bytes', 8), padLeft('scanned', 12), padLeft('scan/prose', 12)]
console.log(scanCols.join('  '))
console.log('-'.repeat(scanCols.join('  ').length))
const SCAN_ITEMS = 40
const proseScanned = scannedChars(shaped('prose', SCAN_ITEMS))
const scanShapes: { name: string; text: string }[] = [
  { name: 'prose (baseline)', text: shaped('prose', SCAN_ITEMS) },
  { name: 'list-loose-ordered', text: shaped('ordered', SCAN_ITEMS) },
  { name: 'list-loose-unordered', text: shaped('unordered', SCAN_ITEMS) },
  { name: 'blockquote-paras', text: shaped('quote', SCAN_ITEMS) },
  { name: 'blockquote-lazy', text: lazyQuote(SCAN_ITEMS) },
]
let worstScanRatio = 0
for (const { name, text } of scanShapes) {
  const chars = scannedChars(text)
  const ratio = proseScanned > 0 ? chars / proseScanned : 0
  if (name !== 'prose (baseline)') worstScanRatio = Math.max(worstScanRatio, ratio)
  console.log(
    [pad(name, 22), padLeft(String(text.length), 8), padLeft(String(chars), 12), padLeft(ratio.toFixed(1) + '×', 12)].join(
      '  ',
    ),
  )
}
console.log(
  `\nworst list-/quote-shaped scan ratio: ${worstScanRatio.toFixed(1)}× prose (regression guard: < 20×; pre-#111 was ~40-140×)`,
)
if (worstScanRatio >= 20) {
  throw new Error(
    `A list-/blockquote-shaped stream re-tokenized ${worstScanRatio.toFixed(1)}× the prose baseline — expected a small ` +
      `multiple. The incremental-scan safe boundary stopped advancing inside an extendable container (#111).`,
  )
}

// A single lazily-continued blockquote has no interior boundary, so it re-scans
// per update either way — but each `tokenizeBlocks` used to be O(lines²) because
// `endsInOpenParagraph` re-tokenized the whole stripped prefix per candidate
// line, making the stream O(n³). #111 memoises that to O(1)/line, so one full
// tokenize is now O(lines). Measure the per-tokenize growth per doubling: it
// should be ~linear (~2×), not quadratic (~4×).
console.log('\nblockquote lazy continuation — tokenizeBlocks growth per doubling (endsInOpenParagraph, #111)\n')
const lazyCols = [pad('lines', 8), padLeft('bytes', 8), padLeft('tokenize ms', 13), padLeft('vs prev', 9)]
console.log(lazyCols.join('  '))
console.log('-'.repeat(lazyCols.join('  ').length))
let prevLazyMs = 0
const lazyGrowth: number[] = []
for (const lines of [200, 400, 800]) {
  const text = lazyQuote(lines)
  const ms = measure(
    () => {
      const start = performance.now()
      tokenizeBlocks(text)
      return performance.now() - start
    },
    Math.max(3, args.iters),
    args.warmup,
  )
  const factor = prevLazyMs > 0 ? ms / prevLazyMs : 0
  if (factor > 0) lazyGrowth.push(factor)
  console.log(
    [pad(String(lines), 8), padLeft(String(text.length), 8), padLeft(ms.toFixed(3), 13), padLeft(factor > 0 ? `${factor.toFixed(2)}×` : '—', 9)].join('  '),
  )
  prevLazyMs = ms
}
const meanLazyGrowth = lazyGrowth.reduce((a, x) => a + x, 0) / lazyGrowth.length
console.log(`\nmean tokenize growth per doubling: ${meanLazyGrowth.toFixed(2)}× (regression guard: < 3.0×; quadratic ≈ 4×)`)
if (meanLazyGrowth >= 3.0) {
  throw new Error(
    `Lazy-blockquote tokenize scaled ${meanLazyGrowth.toFixed(2)}×/doubling — expected ~linear (< 3×). ` +
      `A per-candidate re-tokenize of the stripped quote prefix (#111) is the likely cause.`,
  )
}

// Code-block scaling (#155): stream a document of many fenced code blocks at a
// FIXED chunk so the number of *closed* (frozen) blocks grows with the input.
// Each closed fence is frozen once, so it is highlighted a single time — doubling
// the block count should ~double the work, not square it. A regression that stops
// freezing closed code blocks (re-highlighting the whole growing prefix on every
// update) is the super-linear cost this guards. Measured WITH a highlighter
// registered because re-highlight cost is what dominates real code-heavy traces,
// and it produces the number the eventual published benchmark reports for
// code-heavy content. Kept deliberately light (few blocks, coarse chunk, DOM path
// only) since it runs last in an already memory-heavy process — the string-path
// O(n²) re-render over code blocks is intentionally NOT measured here (it
// dominates peak heap and isn't what the frozen-tail guard is about).
console.log('\ncode-block scaling — DOM path + highlight.js, fixed 64-byte chunk (closed blocks grow with size)\n')
const codeScaleCols = [pad('blocks', 8), padLeft('bytes', 8), padLeft('updates', 9), padLeft('dom ms', 10), padLeft('vs prev', 9)]
console.log(codeScaleCols.join('  '))
console.log('-'.repeat(codeScaleCols.join('  ').length))
setDefaultConfig({ codeHighlighter: highlightjsHighlighter })
const codeIters = Math.min(args.iters, 3)
let prevCodeMs = 0
const codeGrowth: number[] = []
for (const blocks of [10, 20, 40]) {
  const text = codeBlocksDoc(blocks)
  const updates = chunkBoundaries(text.length, 64).length
  const domMs = measure(() => benchDomPath(text, 64), codeIters, args.warmup)
  const factor = prevCodeMs > 0 ? domMs / prevCodeMs : 0
  if (factor > 0) codeGrowth.push(factor)
  console.log(
    [
      pad(String(blocks), 8),
      padLeft(String(text.length), 8),
      padLeft(String(updates), 9),
      padLeft(domMs.toFixed(2), 10),
      padLeft(factor > 0 ? `${factor.toFixed(2)}×` : '—', 9),
    ].join('  '),
  )
  prevCodeMs = domMs
}
setDefaultConfig({ codeHighlighter: null })

const meanCodeGrowth = codeGrowth.reduce((a, x) => a + x, 0) / codeGrowth.length
console.log(
  `\ncode-block mean growth per doubling (highlighter on): ${meanCodeGrowth.toFixed(2)}× (regression guard: < 3.0×; re-highlight-all ≈ 4×)`,
)
if (meanCodeGrowth >= 3.0) {
  throw new Error(
    `Code-block DOM streaming scaled ${meanCodeGrowth.toFixed(2)}×/doubling with a highlighter — expected ~O(n) ` +
      `(< 3×; see #155). A regression to re-highlighting closed/frozen code blocks per update is the likely cause.`,
  )
}

// Real-document scaling (#154): make the per-doubling growth guard representative
// of REAL content, not only synthetic prose. Concatenate the hand-collected
// corpus (mixed prose/code/tables/task-lists/footnotes/blockquotes) and stream it
// at growing repetitions through the DOM path at a fixed chunk, so the update
// count grows with size. Frozen-tail commit is O(tail), so doubling the document
// should ~double the work; a regression to O(prefix)-per-commit re-render pushes
// this toward 4×. DOM path only (the string path's O(n²) is guarded elsewhere and
// would dominate the CI bench heap on a large concatenation).
const corpusUnit = CORPUS_FILES.map(corpusDoc).join('\n\n')
console.log('\nreal-document scaling — DOM path, fixed 64-byte chunk (corpus repeated, updates grow with size)\n')
const realScaleCols = [pad('×corpus', 8), padLeft('bytes', 8), padLeft('updates', 9), padLeft('dom ms', 10), padLeft('vs prev', 9)]
console.log(realScaleCols.join('  '))
console.log('-'.repeat(realScaleCols.join('  ').length))
let prevRealMs = 0
const realGrowth: number[] = []
for (const reps of [1, 2, 4]) {
  const text = Array.from({ length: reps }, () => corpusUnit).join('\n\n')
  const updates = chunkBoundaries(text.length, 64).length
  const domMs = measure(() => benchDomPath(text, 64), Math.min(args.iters, 3), args.warmup)
  const factor = prevRealMs > 0 ? domMs / prevRealMs : 0
  if (factor > 0) realGrowth.push(factor)
  console.log(
    [
      pad(`${String(reps)}×`, 8),
      padLeft(String(text.length), 8),
      padLeft(String(updates), 9),
      padLeft(domMs.toFixed(2), 10),
      padLeft(factor > 0 ? `${factor.toFixed(2)}×` : '—', 9),
    ].join('  '),
  )
  prevRealMs = domMs
}
const meanRealGrowth = realGrowth.reduce((a, x) => a + x, 0) / realGrowth.length
console.log(`\nreal-document mean growth per doubling: ${meanRealGrowth.toFixed(2)}× (regression guard: < 3.0×)`)
if (meanRealGrowth >= 3.0) {
  throw new Error(
    `Real-document DOM streaming scaled ${meanRealGrowth.toFixed(2)}×/doubling — expected ~O(n) (< 3×; see #154). ` +
      `An O(prefix)-per-commit committed-re-render regression is the likely cause.`,
  )
}
