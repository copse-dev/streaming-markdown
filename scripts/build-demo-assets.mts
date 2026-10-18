/**
 * Keep the demo's math assets on the same origin. Copse's static preview blocks
 * third-party resources; copying the locked peer also keeps JS, CSS and fonts
 * on the same KaTeX version. This does not bundle KaTeX into the package core.
 */
import { cpSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const katexRoot = dirname(require.resolve('katex/package.json'))
const output = fileURLToPath(new URL('../docs/vendor/katex/', import.meta.url))
mkdirSync(output, { recursive: true })
for (const asset of ['katex.mjs', 'katex.min.css', 'fonts']) {
  cpSync(join(katexRoot, 'dist', asset), join(output, asset), { recursive: true })
}
cpSync(join(katexRoot, 'LICENSE'), join(output, 'LICENSE'))
console.log('Copied local KaTeX JavaScript, CSS, fonts and license for the demo.')
