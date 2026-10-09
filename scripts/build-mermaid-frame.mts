/**
 * Builds the prebuilt isolated Mermaid frame shipped as `diagrams/mermaid/frame.html`.
 *
 * Bundles Mermaid (the version pinned in devDependencies) with the frame runtime into one
 * self-contained IIFE and wraps it with `buildMermaidFrameHtml`, which pins that exact script by
 * SHA-256 in a deny-by-default CSP. Theme, font family, font bytes and title are per-render options
 * (see `createMermaidFrame`), so this single document serves every host. Hosts that need another
 * Mermaid version or extra bootstrap code still build their own with `diagrams/mermaid/build`.
 *
 * Writes `dist/mermaid-frame.html` and `dist/mermaid-frame.json` (Mermaid version, script hash and
 * document hash, for hosts that want a content-hashed file name or an integrity check). Run by
 * `npm run build` after `tsc`.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildMermaidFrameHtml } from '../src/mermaid-frame-document.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export interface PrebuiltMermaidFrame {
  html: string
  script: string
  mermaidVersion: string
}

export async function buildPrebuiltMermaidFrame(): Promise<PrebuiltMermaidFrame> {
  const result = await build({
    stdin: {
      contents:
        "import mermaid from 'mermaid'; import { startMermaidFrame } from './src/mermaid-frame-runtime.ts'; startMermaidFrame({ mermaid });",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  })
  const script = result.outputFiles[0]!.text
  const { version: mermaidVersion } = JSON.parse(
    readFileSync(join(root, 'node_modules/mermaid/package.json'), 'utf8'),
  ) as { version: string }
  return { html: buildMermaidFrameHtml(script), script, mermaidVersion }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { html, script, mermaidVersion } = await buildPrebuiltMermaidFrame()
  const dist = join(root, 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'mermaid-frame.html'), html)
  const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
  writeFileSync(
    join(dist, 'mermaid-frame.json'),
    `${JSON.stringify({ mermaidVersion, scriptSha256: sha256(script), documentSha256: sha256(html) }, null, 2)}\n`,
  )
  console.log(`mermaid-frame.html: Mermaid ${mermaidVersion}, ${(html.length / 1024).toFixed(0)} KB`)
}
