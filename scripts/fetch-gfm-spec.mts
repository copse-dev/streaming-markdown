// Fetch (or verify) the GitHub Flavored Markdown `spec.txt`.
//
// Unlike CommonMark — whose spec ships as the `commonmark-spec` npm
// devDependency — GFM's spec is not published to npm. Rather than vendoring its
// ~10k-line `spec.txt`, this script fetches it on demand into
// `tests/fixtures/gfm/spec.txt` (gitignored) from a pinned upstream tag and
// verifies the SHA-256, exactly like `fetch-reference-normalizer.mts` does for
// normalize.py.
//
// Default: if the file is present, assert it matches the pinned SHA-256; if it is
// missing (fresh checkout / CI), download and verify it. Pass `--refresh` to
// re-download and overwrite (used when bumping the pinned tag: update
// `GFM_SPEC_SOURCE` in tests/gfm/load-spec.ts, run with --refresh, then re-baseline
// with `UPDATE_GFM_BASELINE=1 npm test`).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { GFM_SPEC_PATH, GFM_SPEC_SOURCE } from '../tests/gfm/load-spec.ts'

const refresh = process.argv.includes('--refresh')
const sha256 = (buf: Buffer | Uint8Array): string => createHash('sha256').update(buf).digest('hex')

function die(message: string): never {
  console.error(`fetch-gfm-spec: ${message}`)
  process.exit(1)
}

async function download(): Promise<Uint8Array> {
  const res = await fetch(GFM_SPEC_SOURCE.url).catch((e: unknown) =>
    die(`download failed: ${e instanceof Error ? e.message : String(e)}`),
  )
  if (!res.ok) die(`download failed: ${String(res.status)} ${res.statusText} for ${GFM_SPEC_SOURCE.url}`)
  return new Uint8Array(await res.arrayBuffer())
}

if (!refresh && existsSync(GFM_SPEC_PATH)) {
  const actual = sha256(readFileSync(GFM_SPEC_PATH))
  if (actual === GFM_SPEC_SOURCE.sha256) {
    console.log('fetch-gfm-spec: spec.txt matches the pinned SHA-256.')
    process.exit(0)
  }
  die(
    `spec.txt SHA-256 mismatch\n  expected ${GFM_SPEC_SOURCE.sha256}\n  actual   ${actual}\n` +
      `Run with --refresh to re-download, or restore the file.`,
  )
}

const bytes = await download()
const actual = sha256(bytes)
if (!refresh && actual !== GFM_SPEC_SOURCE.sha256) {
  die(`SHA-256 mismatch for ${GFM_SPEC_SOURCE.url}\n  expected ${GFM_SPEC_SOURCE.sha256}\n  actual   ${actual}`)
}
writeFileSync(GFM_SPEC_PATH, bytes)
if (refresh && actual !== GFM_SPEC_SOURCE.sha256) {
  console.log(
    `fetch-gfm-spec: wrote ${GFM_SPEC_PATH} with NEW sha256 ${actual}.\n` +
      `Update GFM_SPEC_SOURCE.sha256 in tests/gfm/load-spec.ts to this value.`,
  )
} else {
  console.log(`fetch-gfm-spec: wrote ${GFM_SPEC_PATH} (verified sha256 ${GFM_SPEC_SOURCE.sha256.slice(0, 12)}…).`)
}
