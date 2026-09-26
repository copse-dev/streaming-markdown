import { applyUrlPolicy, hasUrlPolicy, type UrlSink, type UrlSource } from './url-policy.ts'

// PROTOTYPE (#url-policy): the {@link UrlPolicy} pass over markup that bypasses
// the sink sanitizer — mermaid SVG and KaTeX HTML, which their libraries produce
// *after* `sanitizeRenderedMarkdown` and which the origin policy in
// `link-image-policy.ts` therefore never sees (docs/SECURITY.md, "Trust
// boundaries"). Real mermaid 11 at its default `securityLevel: 'strict'` emits
// `<img src>` inside `<foreignObject>` for an HTML label, and an injected
// `themeCSS` reaches the SVG's `<style>` as a live `url()` — both fetched with no
// user interaction. Neither `flowchart.htmlLabels: false` nor mermaid's own
// `dompurifyConfig` stops them, so the filtering has to happen on the way out.
//
// LIMITATION, measured (real mermaid 11 in Chromium, nothing injected into the
// page): `mermaid.render()` fetches the label `<img>` and the themeCSS `url()`
// ITSELF, because it renders into a temporary live node to measure labels. The
// first beacon is therefore already gone before a host ever sees the SVG string.
// This pass stops everything after that — the repeat load, the persistent
// subresource, the click-through destination, the CSS fetch in the injected
// document — but it is NOT a defence against the initial exfiltration. That one
// can only be stopped on the way IN, by controlling the source handed to the
// backend (`mermaidSourceCandidates`) or by rendering in a sandbox.
//
// Two properties this pass has to hold, in order:
//
//  1. **Filter before injection, never after.** The moment an off-origin `src`
//     is in a live document the fetch has already started; removing it after is
//     theatre. Parsing happens in a `DOMParser` document, which has no browsing
//     context and therefore loads nothing, and the nodes are only imported into
//     the live tree once every URL has been decided.
//  2. **Same-document fragment references must survive.** Every mermaid diagram
//     carries `url(#…-pointEnd)` marker refs and `<use href="#…">`; a blanket
//     `url()` block deletes the arrowheads from every graph. `applyUrlPolicy`
//     passes bare fragments through untouched, so one rule covers both.
//
// The node path keeps the markup out of `innerHTML`, but it is NOT yet a
// Trusted Types story: `DOMParser.parseFromString` is itself a TT sink (the same
// reason DOMPurify ships its own `dompurify` policy — see docs/EXTENDING.md), so
// under `require-trusted-types-for 'script'` this parse needs a policy of its
// own. PROTOTYPE GAP: a real implementation should route it through the
// html-sink.ts chokepoint, which already owns policy resolution — and unlike
// mermaid's raw SVG, blessing markup *in order to sanitize it* is exactly what
// that chokepoint is for.

const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi
// Fallback-path only. The CSSOM pass normalizes every one of these into `url()`,
// so this list exists for environments with no CSSOM (jsdom, SSR shims) where the
// raw author syntax is all we get: `@import "…"` (the string form — the
// `@import url(…)` form is already covered), and the bare strings `image-set()`
// and its -webkit- alias accept.
const CSS_IMPORT_STRING_RE = /@import\s+(['"])([^'"]*)\1/gi
const CSS_IMAGE_SET_RE = /(-webkit-)?image-set\(([^)]*)\)/gi
const CSS_BARE_STRING_RE = /(['"])([^'"]*)\1/g

// A blocked `url()` cannot simply be emptied: `url("")` resolves to the current
// document and fetches the page itself. `about:blank` is inert and requests
// nothing.
const INERT_CSS_URL = 'url("about:blank")'

/** Elements whose URL attributes are fetched automatically rather than followed. */
const SUBRESOURCE_TAGS = new Set(['img', 'image', 'use', 'feimage', 'video', 'audio', 'source'])

/**
 * Attributes carrying a single URL, by lowercased local name. Deliberately
 * attribute-driven rather than element-driven: classifying the attribute once
 * covers `<iframe src>`, `<object data>`, `<track src>`, `<input type=image src>`
 * and `<video poster>` without any of them being enumerated, and means a host
 * widening `sanitizeExtension` cannot open an unpoliced sink by adding an
 * element. The element-driven version of the sink gate missed exactly those.
 */
export const URL_ATTR_NAMES: ReadonlySet<string> = new Set(['href', 'src', 'poster', 'data'])

/** Attributes carrying a comma-separated candidate list rather than one URL. */
export const URL_LIST_ATTR_NAMES: ReadonlySet<string> = new Set(['srcset'])

/**
 * Which sink an attribute represents. `href` is the ambiguous one: on an `<a>`
 * it is a destination the reader chooses to follow, on `<image>`/`<use>` it is a
 * subresource the browser fetches on sight.
 */
export function sinkForAttribute(tagName: string, attrLocalName: string): UrlSink {
  if (attrLocalName === 'src' || attrLocalName === 'srcset') return 'image'
  if (attrLocalName === 'poster' || attrLocalName === 'data') return 'image'
  return SUBRESOURCE_TAGS.has(tagName) ? 'image' : 'navigation'
}

/** Rewrite every `url()` in a CSS string through the policy. */
function filterCssUrls(css: string, source: UrlSource, element: string): string {
  return css.replace(CSS_URL_RE, (match, _quote: string, raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') return match
    const decided = applyUrlPolicy(trimmed, 'style', source, element, 'style')
    if (decided === null) return INERT_CSS_URL
    return decided === trimmed ? match : `url("${decided.replace(/"/g, '%22')}")`
  })
}

/**
 * `srcset` is a comma-separated list of `url descriptor` pairs; police each
 * candidate and drop the ones the policy rejects. Returns `null` when nothing
 * survives, so the caller removes the attribute entirely.
 */
function filterSrcset(value: string, source: UrlSource, element: string): string | null {
  const kept: string[] = []
  for (const candidate of value.split(',')) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    const space = trimmed.search(/\s/)
    const url = space === -1 ? trimmed : trimmed.slice(0, space)
    const descriptor = space === -1 ? '' : trimmed.slice(space)
    const decided = applyUrlPolicy(url, 'image', source, element, 'srcset')
    if (decided !== null) kept.push(decided + descriptor)
  }
  return kept.length === 0 ? null : kept.join(', ')
}

/**
 * Filter a `<style>` element's URLs, preferring the CSSOM over pattern matching.
 *
 * CSS has many ways to name a URL — `url()`, `@import "…"`, `@import url(…)`,
 * `image-set("…")`, `-webkit-image-set`, a custom property holding any of them —
 * and a regex over them is a losing game; two of those forms slipped past the
 * pattern-matching version of this function and fetched. The CSS parser already
 * knows all of them, so let it do the work ({@link parseCssInert}): `@import`
 * surfaces structurally as `CSSImportRule.href` in BOTH syntaxes, and every
 * other form is normalized into `url()` on serialization (`image-set("x")`
 * comes back as `image-set(url("x"))`). That collapses the whole family down to
 * one shape to scan for.
 *
 * Round-tripping through the CSSOM also drops any rule the parser cannot
 * understand, which is the posture this package takes everywhere else: what we
 * cannot inspect does not ship. It does mean exotic-but-harmless CSS can be
 * dropped from a diagram's theme — acceptable for machine-generated styling,
 * and the reason this only runs when a policy is installed.
 *
 * Environments with no `CSSStyleSheet` at all fall back to scanning the raw text
 * for each author syntax. Nothing fetches in such an environment anyway; the
 * fallback matters because its output may later be served to a browser.
 */
function filterStyleElement(el: Element, source: UrlSource): void {
  const css = el.textContent
  if (css === null || css === '') return
  const sheet = parseCssInert(css)
  if (sheet === null) {
    el.textContent = filterCssTextFallback(css, source)
    return
  }
  // `@import` carries its URL as a property rather than a token, and in whichever
  // syntax it was written. Walk backwards so deleting cannot shift a pending index.
  for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
    const href: unknown = (sheet.cssRules[i] as CSSImportRule | undefined)?.href
    if (typeof href !== 'string' || href === '') continue
    const decided = applyUrlPolicy(href, 'style', source, 'style', '@import')
    if (decided === href) continue
    sheet.deleteRule(i)
    if (decided === null) continue
    try {
      // Honour a rewrite at the original index, so `@import`-comes-first holds.
      sheet.insertRule(`@import url("${decided.replace(/"/g, '%22')}");`, i)
    } catch {
      // A rewrite the parser rejects is dropped, never smuggled through.
    }
  }
  // Serialization has normalized every remaining URL form into `url()`, so one
  // scan finishes the job.
  el.textContent = filterCssUrls(
    Array.from(sheet.cssRules, (rule) => rule.cssText).join(''),
    source,
    'style',
  )
}

/**
 * Parse CSS with the engine's own parser, without a document.
 *
 * A constructible stylesheet is the right primitive here. Browsers do build
 * CSSOM for a `DOMParser` document — Chromium populates `style.sheet` on the
 * inert parse — but jsdom only does so for a window-backed document, so relying
 * on `style.sheet` would make this a browser-only branch that the Node suite
 * could never execute. `new CSSStyleSheet()` needs no document at all and exists
 * in both, so the same code path runs everywhere.
 *
 * The two engines shed the dangerous forms differently and both end up safe:
 * Chromium drops `@import` outright (per the CSSOM spec, `replaceSync` ignores
 * it) so it can never resolve; jsdom keeps it as a `CSSImportRule`, where the
 * caller's rule walk decides it. Conversely jsdom drops an `image-set()` it
 * cannot parse, while Chromium normalizes it into `url()`. Either way no URL
 * survives unexamined — which is the property that matters, and is asserted
 * end-to-end in url-policy-coverage.test.ts.
 */
function parseCssInert(css: string): CSSStyleSheet | null {
  if (typeof CSSStyleSheet !== 'function') return null
  try {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    return sheet
  } catch {
    // No constructible-stylesheet support, or CSS the engine refuses wholesale.
    return null
  }
}

/** No-CSSOM path: scan each author syntax directly. See {@link filterStyleElement}. */
function filterCssTextFallback(css: string, source: UrlSource): string {
  const withImports = css.replace(CSS_IMPORT_STRING_RE, (match, quote: string, raw: string) => {
    const decided = applyUrlPolicy(raw.trim(), 'style', source, 'style', '@import')
    if (decided === null) return '@import ""'
    return decided === raw ? match : `@import ${quote}${decided}${quote}`
  })
  const withImageSets = withImports.replace(
    CSS_IMAGE_SET_RE,
    (match: string, prefix: string | undefined, args: string) => {
      const filtered = args.replace(CSS_BARE_STRING_RE, (m, quote: string, raw: string) => {
        const decided = applyUrlPolicy(raw.trim(), 'style', source, 'style', 'image-set')
        if (decided === null) return `${quote}about:blank${quote}`
        return decided === raw ? m : `${quote}${decided}${quote}`
      })
      return filtered === args ? match : `${prefix ?? ''}image-set(${filtered})`
    },
  )
  return filterCssUrls(withImageSets, source, 'style')
}

/**
 * Apply the active {@link UrlPolicy} to every URL under `root` — attribute URLs
 * (`href`, `xlink:href`, `src`, `srcset`, `poster`), `url()` inside `style`
 * attributes, and `url()` inside `<style>` element text.
 *
 * A blocked URL is *removed* rather than rewritten to a placeholder: a dead
 * `<a>` still shows its label, and a stripped `src` still shows its `alt`, which
 * is the same neutralization `link-image-policy.ts` performs at the sink.
 */
export function filterMarkupUrls(root: ParentNode, source: UrlSource): void {
  for (const el of root.querySelectorAll('*')) {
    const tagName = el.tagName.toLowerCase()

    if (tagName === 'style') {
      filterStyleElement(el, source)
      continue
    }

    // Snapshot: the loop removes attributes as it goes.
    for (const attr of Array.from(el.attributes)) {
      // `xlink:href` arrives from the HTML parser as a namespaced attribute
      // whose local name is plain `href`, so match on the local name and use
      // the qualified name only for reporting and removal.
      const local = (attr.localName || attr.name).toLowerCase()
      const value = attr.value

      if (local === 'style') {
        if (value !== '') el.setAttribute(attr.name, filterCssUrls(value, source, tagName))
        continue
      }
      if (URL_LIST_ATTR_NAMES.has(local)) {
        const filtered = filterSrcset(value, source, tagName)
        if (filtered === null) el.removeAttribute(attr.name)
        else el.setAttribute(attr.name, filtered)
        continue
      }
      if (!URL_ATTR_NAMES.has(local)) continue
      if (value === '') continue

      const decided = applyUrlPolicy(value, sinkForAttribute(tagName, local), source, tagName, attr.name)
      if (decided === null) el.removeAttribute(attr.name)
      else if (decided !== value) el.setAttribute(attr.name, decided)
    }
  }
}

/**
 * Parse `html` in a document with no browsing context, apply
 * {@link filterMarkupUrls}, and return the filtered nodes ready to be imported
 * into a live tree. Nothing in the parsed document loads, so an off-origin
 * subresource never gets the chance to fire before the policy sees it.
 *
 * Returns `null` when the environment has no `DOMParser` (the caller falls back
 * to the unfiltered string path).
 */
export function parseAndFilterMarkup(html: string, source: UrlSource): Element | null {
  const parsed = parseInert(html)
  if (parsed === null) return null
  filterMarkupUrls(parsed, source)
  return parsed
}

/**
 * Parse into a document with no browsing context — the property the whole pass
 * rests on, since such a document fetches nothing while we decide what to keep.
 * Returns `null` where there is no `DOMParser` (a DOM-free SSR host), and the
 * caller falls back to its ordinary unfiltered path.
 */
function parseInert(html: string): Element | null {
  if (typeof DOMParser === 'undefined') return null
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  return doc.body.firstElementChild
}

/**
 * String-in/string-out variant for a host wiring the policy up through
 * `transformSvg` / `transformHtml` by hand, or serializing outside a DOM sink.
 * Prefer the node path ({@link parseAndFilterMarkup}) where the markup is going
 * straight into an element — it avoids the re-parse and the injection sink.
 *
 * Note this path re-serializes: even with nothing filtered the output is not
 * byte-identical to the input (`<image/>` comes back as `<image></image>`, and
 * attribute quoting is normalized). Semantics are preserved; exact bytes are not.
 */
export function filterMarkupUrlsString(html: string, source: UrlSource): string {
  const holder = parseAndFilterMarkup(html, source)
  return holder === null ? html : holder.innerHTML
}

/**
 * Filter `html` and place it into `target` via the node path, returning `true`
 * when it handled the injection. Returns `false` when no {@link UrlPolicy} is
 * installed or the environment has no `DOMParser`, leaving the caller to use its
 * ordinary string sink — so behaviour with the feature off is unchanged.
 *
 * Because the nodes are imported rather than assigned through `innerHTML`, this
 * path touches no injection sink and needs no Trusted Types blessing for markup
 * the package did not sanitize.
 */
export function injectFilteredMarkup(
  target: Element,
  html: string | { toString(): string },
  source: UrlSource,
): boolean {
  if (!hasUrlPolicy()) return false
  const holder = parseAndFilterMarkup(String(html), source)
  if (holder === null) return false
  const doc = target.ownerDocument
  target.replaceChildren(...Array.from(holder.childNodes, (node) => doc.importNode(node, true)))
  return true
}
