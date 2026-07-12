/**
 * Shared corpus loading + chunking for the cross-library benchmark tiers: the
 * jsdom harness (`bench-compare.mts`) and the real-browser Chromium tier
 * (`bench-browser-live.mts`) replay exactly the same fixtures the same way, so
 * their numbers describe the same workload (only the engine differs).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORPUS_DIR, INCREMARK_CORPUS } from './fetch-corpus.mts'

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)))
const repoRoot = resolve(benchDir, '../..')

/** Code-block-heavy case (#155): fences dominate, streamed token-by-token. */
export function codeHeavyFixture(): string {
  const tsFence = Array.from(
    { length: 70 },
    (_, i) => `export const value${String(i)} = compute(${String(i)}) && registry.get('key-${String(i)}') // trailing note ${String(i)}`,
  ).join('\n')
  const pyFence = Array.from(
    { length: 60 },
    (_, i) => `def handler_${String(i)}(payload):\n    return transform(payload, retries=${String(i % 5)})`,
  ).join('\n\n')
  const jsonFence = JSON.stringify(
    Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`option_${String(i)}`, { enabled: i % 2 === 0, weight: i }])),
    null,
    2,
  )
  return [
    '# Code review notes\n\nThe TypeScript entry point:\n',
    '```ts\n' + tsFence + '\n```\n',
    'And the equivalent Python handlers:\n',
    '```python\n' + pyFence + '\n```\n',
    'With the generated configuration:\n',
    '```json\n' + jsonFence + '\n```\n',
    'Closing prose with **emphasis**, `inline code` and a [link](https://example.com).\n',
  ].join('\n')
}

export interface Fixture {
  name: string
  text: string
}

export function loadFixtures(filter: RegExp | null): Fixture[] {
  const fixtures: Fixture[] = []
  for (const { name } of INCREMARK_CORPUS) {
    const path = resolve(CORPUS_DIR, name)
    if (existsSync(path)) fixtures.push({ name: `incremark/${name}`, text: readFileSync(path, 'utf8') })
    else console.error(`warning: corpus/${name} missing (run fetch-corpus) — fixture skipped`)
  }
  const repoDocs = ['README.md', 'CHANGELOG.md', 'docs/ARCHITECTURE.md', 'tests/fixtures/terms-of-service-streaming.md']
  for (const rel of repoDocs) {
    fixtures.push({ name: rel, text: readFileSync(resolve(repoRoot, rel), 'utf8') })
  }
  fixtures.push({ name: 'synthetic/code-heavy (#155)', text: codeHeavyFixture() })
  fixtures.push({
    name: 'synthetic/long-transcript',
    text: fixtures.map((f) => f.text).join('\n\n---\n\n'),
  })
  return filter ? fixtures.filter((f) => filter.test(f.name)) : fixtures
}

export interface ChunkOptions {
  /** Fixed chunk size in characters. */
  chunk: number
  /** With `parity` false, grow the chunk so a fixture never exceeds this many updates. */
  maxUpdates: number
  /** Exact-methodology mode: always `chunk` characters, uncapped update count. */
  parity: boolean
}

export function chunksOf(text: string, opts: ChunkOptions): string[] {
  const size = opts.parity ? opts.chunk : Math.max(opts.chunk, Math.ceil(text.length / opts.maxUpdates))
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}
