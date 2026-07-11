/**
 * Shared harness for real-browser (Chromium) checks: the Trusted Types e2e
 * suite (`npm run test:e2e`) and the browser sink benchmark
 * (`npm run bench:browser`).
 *
 * jsdom cannot enforce a CSP, so anything asserting behavior under
 * `require-trusted-types-for 'script'` has to run in a real engine. The
 * harness bundles the library (plus the internal sink/sanitizer symbols the
 * checks exercise) with esbuild and injects it as a parser-inserted inline
 * <script> — deliberately NOT via page.addScriptTag or eval, both of which
 * are themselves Trusted Types sinks and would be blocked on the enforced
 * pages under test.
 *
 * Chromium discovery (first match wins): the CHROMIUM_BIN env var, the
 * Playwright browsers dir (PLAYWRIGHT_BROWSERS_PATH or /opt/pw-browsers),
 * playwright-core's own registry, then chromium/google-chrome on PATH.
 * Callers should skip (not fail) when this returns null — CI images without
 * a browser still run the jsdom suite.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireModule = createRequire(import.meta.url)

/** Locate a runnable Chromium binary, or return null when none is available. */
export function findChromium(): string | null {
  const envBin = process.env['CHROMIUM_BIN']
  if (envBin && existsSync(envBin)) return envBin
  const pwDir = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? '/opt/pw-browsers'
  const pwLink = join(pwDir, 'chromium')
  if (existsSync(pwLink)) return pwLink
  try {
    // Late require so the harness is importable without playwright-core.
    const { chromium } = requirePlaywright()
    const registered = chromium.executablePath()
    if (registered && existsSync(registered)) return registered
  } catch {
    // fall through to PATH lookup
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    try {
      const found = execFileSync('which', [name], { encoding: 'utf8' }).trim()
      if (found) return found
    } catch {
      // not on PATH; try the next name
    }
  }
  return null
}

// Typed view of the bits of playwright-core the harness uses, so the repo
// typechecks without depending on playwright's ambient types.
export interface PwPage {
  setContent(html: string, options?: { waitUntil?: string }): Promise<void>
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>
  close(): Promise<void>
}
interface PwBrowser {
  newPage(): Promise<PwPage>
  close(): Promise<void>
}
interface PwChromium {
  launch(options?: { executablePath?: string }): Promise<PwBrowser>
  executablePath(): string
}

function requirePlaywright(): { chromium: PwChromium } {
  // Lazy load so the main jsdom suite never touches playwright-core.
  return requireModule('playwright-core') as { chromium: PwChromium }
}

/** Whether playwright-core is installed (it is optional for the main suite). */
export function hasPlaywright(): boolean {
  try {
    requirePlaywright()
    return true
  } catch {
    return false
  }
}

let bundleCache: string | null = null

/**
 * Bundle the library for the browser as an IIFE exposing the `SM` global:
 * the public entry plus the internal symbols the e2e/bench pages exercise
 * (node-path sanitizer, presanitized sink, DOMPurify backend, mermaid hooks).
 */
export async function buildBrowserBundle(): Promise<string> {
  if (bundleCache) return bundleCache
  const { build } = (await import('esbuild')) as typeof import('esbuild')
  const result = await build({
    stdin: {
      contents: [
        "export * from './src/index.ts'",
        "export { sanitizeRenderedMarkdownInto } from './src/sanitize.ts'",
        "export { setPresanitizedHtml } from './src/html-sink.ts'",
        "export { dompurifyBackend } from './src/sanitize-dompurify.ts'",
        // The TT e2e installs the DOMPurify backend process-wide via the public
        // `setDefaultConfig` (the sink helper `setSanitizedHtml` reads the ambient
        // config). Already re-exported by index.ts, but named here for clarity.
      ].join('\n'),
      resolveDir: pkgRoot,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'SM',
    platform: 'browser',
  })
  const text = result.outputFiles?.[0]?.text
  if (!text) throw new Error('esbuild produced no output for the browser bundle')
  bundleCache = text
  return bundleCache
}

export interface TTBrowser {
  /** Open a page whose document carries `cspMeta` (or none) and the SM bundle. */
  newBundlePage(cspMeta: string | null): Promise<PwPage>
  close(): Promise<void>
}

/** CSP meta tag enforcing Trusted Types with the given policy allowlist. */
export function ttCspMeta(policies: string): string {
  return (
    `<meta http-equiv="Content-Security-Policy" ` +
    `content="require-trusted-types-for 'script'; trusted-types ${policies}">`
  )
}

/** Launch Chromium and return a factory for bundle-preloaded pages. */
export async function launchTTBrowser(executablePath: string): Promise<TTBrowser> {
  const bundle = await buildBrowserBundle()
  const { chromium } = requirePlaywright()
  const browser = await chromium.launch({ executablePath })
  return {
    async newBundlePage(cspMeta: string | null): Promise<PwPage> {
      const page = await browser.newPage()
      // The `__name` shim: tsx/esbuild's keepNames transform wraps functions
      // in `__name(...)` helper calls; page.evaluate serializes callbacks
      // AFTER that transform, so the helper must exist in the page.
      await page.setContent(
        `<!doctype html><html><head>${cspMeta ?? ''}</head><body>` +
          `<script>globalThis.__name = (fn) => fn</script>` +
          `<script>${bundle}</script></body></html>`,
        { waitUntil: 'load' },
      )
      return page
    },
    close: () => browser.close(),
  }
}
