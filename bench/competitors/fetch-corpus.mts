// Fetch (or verify) the shared cross-library benchmark corpus (#157).
//
// Incremark's published head-to-head numbers cite "38 real markdown files",
// but its repository only commits two of them under
// `benchmark-compare/test-data/` — so those two are fetched here at a pinned
// commit (MIT-licensed, kingshuaishuai/incremark) for directly comparable
// fixtures, and the rest of the corpus is this repo's own real documents
// (README, docs/, CHANGELOG, the terms-of-service streaming fixture) plus the
// synthetic code-block-heavy case from #155. Fetched files land in
// `bench/competitors/corpus/` (gitignored) and are SHA-256 verified, exactly
// like scripts/fetch-gfm-spec.mts.
//
// If the network is unavailable and the files are already present + verified,
// this succeeds offline. `--refresh` re-downloads.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Pinned to the commit that introduced benchmark-compare/ upstream.
const INCREMARK_COMMIT = '765e77b135eb48082060ac58919811d9599136a5'
const RAW_BASE = `https://raw.githubusercontent.com/kingshuaishuai/incremark/${INCREMARK_COMMIT}/benchmark-compare/test-data`

export interface CorpusFile {
  name: string
  sha256: string
}

// The complete committed upstream test-data set (2 files as of the pinned
// commit — not 38; see docs/BENCHMARKS.md for why that matters).
export const INCREMARK_CORPUS: CorpusFile[] = [
  {
    name: 'P1.5_COLOR_SYSTEM_REPORT.md',
    sha256: '8997695bfc927584e13ce0277db63619d032a5e30e8c57bf51a2cfcd34b91cdc',
  },
  {
    name: 'test-md.md',
    sha256: 'f4df932b59110be8fad68a7fae04154a852842cf3e52de80a88c11fa873020fb',
  },
]

export const CORPUS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'corpus')

const sha256 = (buf: Buffer | Uint8Array): string => createHash('sha256').update(buf).digest('hex')

function die(message: string): never {
  console.error(`fetch-corpus: ${message}`)
  process.exit(1)
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url).catch((e: unknown) =>
    die(`download failed: ${e instanceof Error ? e.message : String(e)}\n  ${url}`),
  )
  if (!res.ok) die(`download failed: ${String(res.status)} ${res.statusText} for ${url}`)
  return new Uint8Array(await res.arrayBuffer())
}

const refresh = process.argv.includes('--refresh')
mkdirSync(CORPUS_DIR, { recursive: true })

for (const file of INCREMARK_CORPUS) {
  const path = resolve(CORPUS_DIR, file.name)
  if (!refresh && existsSync(path)) {
    const actual = sha256(readFileSync(path))
    if (actual === file.sha256) {
      console.log(`fetch-corpus: ${file.name} matches the pinned SHA-256.`)
      continue
    }
    die(`${file.name} SHA-256 mismatch\n  expected ${file.sha256}\n  actual   ${actual}\nRun with --refresh to re-download.`)
  }
  const bytes = await download(`${RAW_BASE}/${file.name}`)
  const actual = sha256(bytes)
  if (actual !== file.sha256) {
    die(`SHA-256 mismatch for ${file.name}\n  expected ${file.sha256}\n  actual   ${actual}`)
  }
  writeFileSync(path, bytes)
  console.log(`fetch-corpus: wrote corpus/${file.name} (verified sha256 ${file.sha256.slice(0, 12)}…).`)
}
