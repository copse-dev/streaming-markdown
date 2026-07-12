import { parseOpenFenceContent } from './block-patterns.ts'
import { FORMING_FENCE_PRE_CLASS, getFenceHandler } from './fence-handlers.ts'
import { fenceCodeClass, highlightFenceCode } from './highlight.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { setSanitizedHtml } from './html-sink.ts'

function renderFormingFenceInner(lang: string, code: string): string {
  const handler = getFenceHandler(lang)
  if (handler) {
    return handler.forming ? handler.forming.html(code, lang) : handler.render(code, lang)
  }
  const body = highlightFenceCode(code, lang)
  return `<pre class="${FORMING_FENCE_PRE_CLASS}"><code class="${fenceCodeClass(lang)}">${body}</code></pre>`
}

/** Build forming-fence HTML for the string streaming API. */
export function buildFormingFenceHtml(source: string): string {
  const parsed = parseOpenFenceContent(source)
  if (!parsed) return ''
  return sanitizeRenderedMarkdown(renderFormingFenceInner(parsed.lang, parsed.code))
}

/** Forward-pass DOM updates for a fenced code block still streaming. */
export function syncFormingFenceDom(container: HTMLElement, source: string): void {
  const parsed = parseOpenFenceContent(source)
  if (!parsed) {
    container.replaceChildren()
    return
  }

  const { lang, code } = parsed
  const handler = getFenceHandler(lang)
  if (handler) {
    if (handler.forming?.sync) {
      handler.forming.sync(container, code, lang)
      return
    }
    // No incremental sync from the handler: fall back to replacing the
    // container's HTML with the (sanitized) forming markup each update.
    setSanitizedHtml(container, renderFormingFenceInner(lang, code))
    return
  }

  // The forming <pre> is only ever created as a direct child (below), and its
  // <code> as the <pre>'s first child — direct scans, no selector engine (the
  // fence path runs per update while a code block streams).
  let pre: HTMLPreElement | null = null
  for (let el = container.firstElementChild; el; el = el.nextElementSibling) {
    if (el.tagName === 'PRE' && el.classList.contains(FORMING_FENCE_PRE_CLASS)) {
      pre = el as HTMLPreElement
      break
    }
  }
  if (!pre) {
    container.replaceChildren()
    pre = document.createElement('pre')
    pre.className = FORMING_FENCE_PRE_CLASS
    const codeEl = document.createElement('code')
    pre.append(codeEl)
    container.append(pre)
  }
  const first = pre.firstElementChild
  const codeEl = first && first.tagName === 'CODE' ? first : null
  if (codeEl) {
    codeEl.className = fenceCodeClass(lang)
    setSanitizedHtml(codeEl, highlightFenceCode(code, lang))
  }
}

export function clearFormingFenceDom(container: HTMLElement): void {
  container.replaceChildren()
}
