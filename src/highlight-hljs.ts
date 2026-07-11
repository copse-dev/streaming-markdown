import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import type { CodeHighlighter } from './highlight.ts'

// PROTOTYPE (#lazy-load): the highlight.js backend. This is the ONLY module that
// imports `highlight.js`, so it — and its dozen language grammars — stays out of
// any bundle that doesn't reference this entry point. It lives behind the
// `@copse/streaming-markdown/highlighters/highlightjs` subpath (mirroring
// `@copse/streaming-markdown/sanitizers/dompurify`), and is reachable two ways:
//
//   • statically, when a host wants highlighting from the first paint:
//       import { highlightjsHighlighter } from '@copse/streaming-markdown/highlighters/highlightjs'
//       renderMarkdown(md, { codeHighlighter: highlightjsHighlighter })
//
//   • lazily, so the grammar payload is fetched as a separate chunk only when the
//     host first needs it (e.g. on the first code fence, or at idle):
//       const { loadHighlightjs } = await import('@copse/streaming-markdown/highlighters/highlightjs')
//       const hl = await loadHighlightjs()  // then pass via config.codeHighlighter
//
// The grammar list MUST stay in sync with `KNOWN_LANGUAGES` in `highlight.ts`, so
// the core resolves the same set of ids it hands back to this backend.

hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', shell)
hljs.registerLanguage('json', json)
hljs.registerLanguage('python', python)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('go', go)
hljs.registerLanguage('sql', sql)

/** highlight.js-backed {@link CodeHighlighter}. Pass it via `MarkdownConfig.codeHighlighter`. */
export const highlightjsHighlighter: CodeHighlighter = {
  highlight(code: string, language: string): string {
    // The core only passes ids it resolved against KNOWN_LANGUAGES, but guard
    // against a drift between the two lists rather than letting hljs throw.
    if (!hljs.getLanguage(language)) return hljs.highlightAuto(code).value
    return hljs.highlight(code, { language }).value
  },
  highlightAuto(code: string): string {
    return hljs.highlightAuto(code).value
  },
}

/**
 * Resolve the highlight.js {@link CodeHighlighter}. When called through a dynamic
 * `import('.../highlighters/highlightjs')`, the grammar payload is a code-split
 * chunk fetched only at this point — the "lazy load" the prototype demonstrates.
 * Pass the result via `MarkdownConfig.codeHighlighter`; equivalent to importing
 * {@link highlightjsHighlighter} directly.
 */
export function loadHighlightjs(): Promise<CodeHighlighter> {
  return Promise.resolve(highlightjsHighlighter)
}
