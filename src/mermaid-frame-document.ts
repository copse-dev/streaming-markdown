import { createHash } from 'node:crypto'

/** Build-time API only. Inputs must be trusted build assets, never diagram/user content. */
export function buildMermaidFrameHtml(script: string, styles = ''): string {
  if (/<\/script/i.test(script))
    throw new Error('Unsafe inline-script terminator in Mermaid bundle')
  if (/<\/style/i.test(styles)) throw new Error('Unsafe inline-style terminator in Mermaid styles')
  const hash = createHash('sha256').update(script).digest('base64')
  const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';`
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Mermaid diagram</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, .mermaid-diagram, pre { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
svg { display: block; }
${styles}
</style><script>${script}</script></head><body></body></html>`
}
