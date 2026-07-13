// Frozen-prefix + tail-group incremental commit rendering (#21, Layer 2).
//
// The committed prefix of a streaming message used to be fully re-rendered,
// re-sanitized and re-morphed on every block commit, making a whole stream
// O(n²) in the message length (the render/sanitize/morph layer dominated).
//
// This splits `completedEl` into two regions:
//
//   - a *frozen* region — DOM for top-level groups that can never change again.
//     Rendered and sanitized exactly once; after the freeze frame the nodes are
//     never touched again, so node identity is permanent.
//   - a *tail group* — the last still-mergeable group (open list, growing table,
//     open blockquote, or an unsettled trailing paragraph). Small and bounded;
//     the only thing re-rendered per commit.
//
// Per commit the render/sanitize/append work is O(newly-settled delta) + O(tail)
// instead of O(prefix) — this removes the render/sanitize/morph layer that
// dominated. `frozenTail.update` is constant-time per commit regardless of how
// long the committed prefix already is (with the streaming.ts pending queries
// scoped to the tail, whole-stream DOM cost grows ~2×/doubling in the bench,
// down from ~4×).
//
// Known bounds:
//   - The pure-string scans (issue #21 limitation K) are incremental since #30:
//     the DOM path's tokenize + link-ref scans resume from a safe boundary
//     (`IncrementalSourceScanner`), so per-update parse work is O(tail). What
//     remains O(prefix) per update is byte comparison (the append-only guards'
//     `startsWith` memcmps and the `includes('|')` gate) — hardware-speed, and
//     accepted. The stateless string path (`renderStreamingMarkdown`) still
//     scans fully per call by design.
//   - A long, still-open trailing LIST is handled by intra-list freezing (#29):
//     settled items freeze inside the shared <ul>/<ol> and per-commit work is
//     the unfrozen item slice. A long open trailing BLOCKQUOTE is not — its
//     grouping re-renders merged content, so it stays wholly in the tail and
//     degrades toward the old per-commit cost (rare shape; follow-up if seen).
//   - FOOTNOTES (#110) took the full-morph path on every commit (any `[^` in
//     the buffer tripped the guard), making footnote streaming O(n²). They now
//     have a dedicated incremental path (`commitWithFootnotes`): the body is
//     rendered as per-block parts and the section as per-<li> items, each with a
//     DOM handle, and a new definition re-morphs only the reference blocks whose
//     numbering changed plus the new/changed section items.
//
// Every uncertainty falls back to `morphInnerHtml(sanitize(render(complete)))` —
// today's exact, correct behaviour — so the fast path is a pure optimization: a
// mishandled case degrades to slower-but-correct output, never to wrong output.
import {
  collectFootnoteDefinitions,
  collectLinkReferenceDefinitions,
  type BlockKind,
  type BlockToken,
} from './block-tokenizer.ts'
import {
  listGroupCloseTag,
  listGroupOpenTag,
  listItemSliceIsMultiParagraph,
  listSliceContinuesGroup,
  renderBlocksToParts,
  renderFootnoteSectionItems,
  renderListItemsSlice,
  scanListGroup,
  type ListGroupSignature,
  type RenderedPart,
} from './render-blocks.ts'
import {
  createFootnoteContext,
  type FootnoteContext,
  type FootnoteDefinitionMap,
  footnoteRefLabelsIn,
  getActiveFootnoteContext,
  reseatFootnoteContext,
  setActiveFootnoteContext,
} from './footnotes.ts'
import { getHtmlPolicy } from './html-policy.ts'
import { normalizeReferenceLabel, type LinkReferenceMap } from './link-references.ts'
import { asSanitizedHtml, sanitizeRenderedMarkdown, type SanitizedHtml } from './sanitize.ts'
import { setPresanitizedHtml, setSanitizedHtml } from './html-sink.ts'
import { renderMarkdownUnsafe, TOP_LEVEL_RENDER_OPTS } from './renderer.ts'
import {
  morphElementChildrenFrom,
  morphInnerHtml,
  morphInnerHtmlFrom,
  morphInnerHtmlRangeFrom,
  syncAttributes,
} from './streaming-dom-morph.ts'

// Shared with renderMarkdown (the full-morph fallback) so a frozen/tail slice
// renders byte-identically to the whole-string render — the two must not drift
// (gap A: top-level indented raw HTML follows the raw-HTML policy, not <pre>).
const RENDER_OPTS = TOP_LEVEL_RENDER_OPTS

// Minimum items in an open trailing list before intra-list freezing engages
// (#29). Below this the generic whole-group tail is cheap and avoids per-item
// bookkeeping; above it, re-rendering the whole group per commit is the O(n²)
// this mode removes.
const INTRA_LIST_MIN_ITEMS = 4

// Maximum frozen parts a targeted link-ref patch may re-render before the
// commit falls back to one full morph instead (ADR 0004 Phase 2). Each
// patched part pays its own sanitize + parse; a handful is far cheaper than
// re-rendering the document, but past this the single whole-document
// sanitize wins on per-call overhead. Purely a cost trade — both paths are
// byte-identical.
const MAX_LINK_REF_PATCH_PARTS = 8

/**
 * How a block kind behaves at the settled/tail boundary:
 *
 *  - `immutable` — a complete token of this kind can never be changed by later
 *    input (closed fence, ATX/setext heading, thematic break).
 *  - `settled-after-blank` — complete and immutable only once a complete blank
 *    follows (a paragraph can retro-convert to a setext heading; a table can
 *    still grow body rows).
 *  - `grouping` — consecutive same-kind tokens (with interleaved blanks) render
 *    as ONE top-level group that later input can still extend or restructure
 *    (lists: loose/tight; blockquotes: blank-run continuation; indented code:
 *    blank-run merging), so a trailing run stays wholly in the tail.
 *  - `separator` — renders nothing itself; a *complete* token of this kind is a
 *    stable boundary between groups.
 *
 * The switch is exhaustive over `BlockKind` with no default: adding a new block
 * kind is a COMPILE ERROR here until it is classified, so the frozen/tail
 * boundary can never silently mis-handle a kind it has not met (#32). When
 * unsure, classify a new kind as `grouping` — the walk-back only ever *grows*
 * the tail, which is conservative (more re-render, never wrong output).
 */
type SettleClass = 'immutable' | 'settled-after-blank' | 'grouping' | 'separator'

function settleClassOf(kind: BlockKind): SettleClass {
  switch (kind) {
    case 'fence':
    case 'math_block':
    case 'atx_heading':
    case 'setext_heading':
    case 'thematic_break':
      return 'immutable'
    case 'paragraph':
    case 'table':
      return 'settled-after-blank'
    case 'list_item':
    case 'blockquote':
    case 'indented_code':
      return 'grouping'
    // A footnote definition can absorb later lines across a blank run (a
    // 4-column-indented continuation), so a trailing one is never settled. It
    // renders nothing in the body; the footnote-incremental path (#110) owns the
    // reference upgrades and the trailing section once a definition is committed.
    case 'footnote_def':
      return 'grouping'
    case 'blank':
    case 'link_ref_def':
      return 'separator'
  }
}

/**
 * Token index where the unsettled trailing group begins. Tokens before it form
 * complete, immutable top-level groups safe to freeze; tokens from it onward can
 * still be restructured by later input and must be re-rendered each commit.
 *
 * The boundary always lands on a top-level group boundary, and is conservative
 * by construction: when unsure it moves left (a larger tail, still correct
 * because the tail is re-rendered in full), never right.
 *
 * A trailing group is *settled* only when later input cannot change it:
 *   - fence / ATX / setext heading / thematic break — intrinsically immutable;
 *   - a paragraph or table *followed by a blank* — the blank blocks a setext
 *     retro-conversion and closes a table against further body rows.
 * Everything else trailing is unsettled: lists and blockquotes continue across
 * blanks, indented code merges across blanks, a paragraph/table with no blank
 * after it can still grow or retro-convert, and any open/ambiguous token is
 * unsettled by definition (reachable when re-tokenizing the committed prefix
 * yields a trailing open block, e.g. `"    a\n\n"` → open indented_code).
 */
export function settledTailStart(tokens: BlockToken[]): number {
  let i = tokens.length - 1
  let blankFollows = false
  while (i >= 0) {
    const token = tokens[i]
    if (!token) return tokens.length
    // Only *complete* separators are stable boundaries. An open trailing blank
    // (e.g. `" "` — spaces with no newline) can be re-absorbed into the next
    // block (`" " + "***"` → a leading-space thematic break), so it is unsettled
    // and must stay in the tail; never advance the frozen region past it.
    if (settleClassOf(token.kind) === 'separator' && token.status === 'complete') {
      blankFollows = true
      i--
      continue
    }
    break
  }
  if (i < 0) return tokens.length // nothing renders → freeze all, empty tail

  const last = tokens[i]
  if (!last) return tokens.length

  const cls = settleClassOf(last.kind)
  const settled =
    last.status === 'complete' &&
    (cls === 'immutable' || (cls === 'settled-after-blank' && blankFollows))
  if (settled) return i + 1

  // Unsettled last group. Non-grouping kinds (paragraph, table, open/ambiguous
  // singletons) start at `i`; grouping kinds can span an earlier run of
  // same-kind tokens and internal blanks.
  if (cls !== 'grouping') return i

  let s = i
  while (s - 1 >= 0) {
    const prev = tokens[s - 1]
    if (prev && (prev.kind === last.kind || prev.kind === 'blank')) {
      s--
      continue
    }
    break
  }
  // Push past leading blanks so the tail begins at the first rendering token of
  // the group; the blanks (rendering nothing) fall into the frozen delta.
  while (s < i && tokens[s]?.kind === 'blank') s++
  return s
}

/** Index of the first token with `start >= offset` (tokens sorted by `start`). */
function lowerBound(tokens: BlockToken[], offset: number): number {
  let lo = 0
  let hi = tokens.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const tok = tokens[mid]
    if (tok && tok.start < offset) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * True when a token straddles `offset` (start < offset < end), i.e. `offset` is
 * no longer a top-level block boundary. `complete` is not append-only: a later
 * chunk can extend an earlier paragraph via lazy continuation (`"Foo\n"` then
 * `"Foo\n    ***"` is one paragraph), absorbing a block the previous frame froze.
 * When that happens the frozen prefix cuts a block in half and must be rebuilt.
 * Tokens are sorted by `start` and contiguous, so the only candidate is the
 * rightmost token starting before `offset`.
 */
function tokenStraddles(tokens: BlockToken[], offset: number): boolean {
  const idx = lowerBound(tokens, offset)
  const prev = idx > 0 ? tokens[idx - 1] : undefined
  return prev !== undefined && prev.end > offset
}

/**
 * Stable serialization of the committed link-reference map (invalidation guard).
 * JSON-encoded entries keep field and entry boundaries unambiguous with only
 * printable characters (raw control-byte separators would make this source file
 * binary to git and diff tooling).
 */
function serializeLinkRefs(refs: LinkReferenceMap): string {
  if (refs.size === 0) return ''
  const entries: string[] = []
  for (const [label, ref] of refs) {
    entries.push(JSON.stringify([label, ref.href, ref.title ?? '']))
  }
  return entries.sort().join('\n')
}

// The attribute-less phrasing tags the renderer passes through unescaped (see
// BENIGN_RAW_INLINE_TAG_RE in escape.ts; `br` is void so it has no balance).
const BENIGN_BALANCED_TAGS = ['b', 'i', 'u', 's', 'del', 'ins', 'sub', 'sup', 'kbd', 'mark']

/**
 * True when `html` (unsanitized renderer output) contains an unbalanced benign
 * raw inline tag. Freezing such a fragment would diverge from the whole-string
 * render: the HTML parser's formatting-element reconstruction re-opens an
 * unclosed `<b>` into every later block when the string is parsed as one unit,
 * which per-fragment sanitization cannot reproduce. Conservative — a stray
 * close tag also trips it, which merely costs a fallback, never wrong output.
 */
function hasUnbalancedBenignRawInline(html: string): boolean {
  for (const tag of BENIGN_BALANCED_TAGS) {
    const opens = html.match(new RegExp(`<${tag}(?=[\\s/>])`, 'gi'))?.length ?? 0
    if (opens === 0) continue
    const closes = html.match(new RegExp(`</${tag}>`, 'gi'))?.length ?? 0
    if (opens !== closes) return true
  }
  return false
}

// HTML void elements — no end tag, so they never contribute to open/close
// balance (a self-closing `/>` is treated the same way).
const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

const HTML_TAG_SCAN_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*?)?(\/?)>/g

/**
 * Passthrough generalization of {@link hasUnbalancedBenignRawInline}: true when
 * ANY non-void tag in `html` is unbalanced (#600). Under passthrough a raw block
 * element (`<details>`, `<div>`, `<table>`…) can open in one committed block and
 * close in a later one; freezing the delta that cut through it would close it
 * early per-fragment (children spill OUT of the element), diverging from the
 * whole-string render where the parser keeps it open across blocks. Renderer-
 * generated tags are always balanced within a delta of complete blocks, so they
 * net to zero and never trip this — only a cross-block raw element does.
 */
function hasUnbalancedRawHtml(html: string): boolean {
  const balance = new Map<string, number>()
  for (let m = HTML_TAG_SCAN_RE.exec(html); m; m = HTML_TAG_SCAN_RE.exec(html)) {
    const name = (m[2] ?? '').toLowerCase()
    if (VOID_HTML_TAGS.has(name) || m[3] === '/') continue
    balance.set(name, (balance.get(name) ?? 0) + (m[1] === '/' ? -1 : 1))
  }
  for (const net of balance.values()) if (net !== 0) return true
  return false
}

/**
 * Whether freezing `html` as a per-fragment delta would diverge from the
 * whole-string render, so the commit must fall back to a full morph. Escape mode
 * only ever passes the benign inline allowlist through, so its (byte-identical,
 * cheaper) check is retained; passthrough must guard every raw tag. Under
 * `'escape-all'` no raw tag can survive except the void `<br>` (and the
 * renderer's own tags, balanced within complete blocks), so nothing is ever
 * unfreezable — the whole balance apparatus is skipped.
 */
function hasUnfreezableRawHtml(html: string): boolean {
  const policy = getHtmlPolicy()
  if (policy === 'escape-all') return false
  return policy === 'passthrough' ? hasUnbalancedRawHtml(html) : hasUnbalancedBenignRawInline(html)
}

// Container elements a re-rooted commit may append into (ADR 0004 Phase 2):
// transparent flow containers with no special parsing rules, so a fragment
// parsed in their context serializes exactly as it does at the top level.
// Formatting elements (b/i/…) are excluded on purpose — the whole-string
// parser RECONSTRUCTS those into every later block, which re-rooting cannot
// express — as are elements with parser-magic content models (p auto-closes,
// table/select foster-parent).
const SAFE_REROOT_TAGS = new Set(['DETAILS', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'FIGURE'])

const PROBE_TAG = 'sm-open-chain-probe'
const PROBE_HTML = `<${PROBE_TAG}>zz</${PROBE_TAG}>`

/**
 * How content appended after `rawHtml` would parse, probed empirically in an
 * INERT document (`DOMParser` — no scripts, no resource loading, not a Trusted
 * Types sink):
 *
 *  - `[]` — concatenation-safe: `parse(rawHtml + rest)` serializes as
 *    `parse(rawHtml)` then `parse(rest)`, whatever the tag-count balance scan
 *    said (an unclosed `<details>` inside a list item is healed by `</li>`),
 *    so the fragment is safe to freeze.
 *  - a non-empty tag chain (outermost first) — later content nests inside
 *    that still-open element chain, the shape re-rooting can express.
 *  - `null` — the divergence is NOT plain nesting (formatting-element
 *    reconstruction is reported as the reconstructed tag chain and rejected by
 *    the caller's safe-list; foster-parenting and CDATA swallowing land here),
 *    so the caller must fall back.
 *
 * The probe appends a canary ELEMENT (not a comment: only character/element
 * insertion triggers the parser's formatting-element reconstruction, which a
 * comment probe is blind to) and compares serializations: equality proves
 * concatenation-safety directly, and on divergence the canary's ancestor chain
 * IS the open-element chain later content would nest into. An attacker-typed
 * `<sm-open-chain-probe>` in the markdown sits earlier in document order and,
 * at worst, appears in the chain — where the safe-list rejects it.
 */
function openElementChainAtEof(rawHtml: string): string[] | null {
  const ParserCtor = document.defaultView?.DOMParser
  /* c8 ignore next 2 -- every supported host (browser, jsdom) exposes DOMParser */
  if (!ParserCtor) return null
  const parser = new ParserCtor()
  const alone = parser.parseFromString(`<body>${rawHtml}</body>`, 'text/html')
  const probed = parser.parseFromString(`<body>${rawHtml}${PROBE_HTML}</body>`, 'text/html')
  if (probed.body.innerHTML === alone.body.innerHTML + PROBE_HTML) return []
  const probes = probed.body.getElementsByTagName(PROBE_TAG)
  const canary = probes[probes.length - 1]
  if (!canary) return null // swallowed as CDATA (<script>/<style>/…) — unknown
  const chain: string[] = []
  for (let el = canary.parentElement; el && el !== probed.body; el = el.parentElement) {
    chain.unshift(el.tagName)
  }
  // Serialization diverged but the canary sits at the top level: the parser
  // relocated content (foster parenting) rather than nesting it — not a shape
  // re-rooting can express.
  return chain.length > 0 ? chain : null
}

/**
 * Whether any bracketed span in `source` normalizes to one of `labels` —
 * escape-aware and normalized exactly like
 * {@link FrozenTailRenderer.accumulateLabelCandidates}, so a span the
 * candidate set could have matched is matched here too (over-approximation:
 * a code-span bracket also matches, costing only a no-op re-render).
 */
function sourceMentionsLabel(source: string, labels: Set<string>): boolean {
  if (!source.includes('[')) return false
  const spanRe = /\[((?:\\[\s\S]|[^\[\]\\])*)\]/g
  for (let m = spanRe.exec(source); m; m = spanRe.exec(source)) {
    const span = m[1] ?? ''
    if (span.trim() === '') continue
    if (labels.has(normalizeReferenceLabel(span))) return true
    if (span.includes('\\') && labels.has(normalizeReferenceLabel(span.replace(/\\([\s\S])/g, '$1')))) {
      return true
    }
  }
  return false
}

const DETAILS_OPEN_RE = /<details(?=[\s>])/gi
const DETAILS_CLOSE_RE = /<\/details>/gi

/**
 * True when the committed render `html` leaves a `<details>` element open (more
 * opens than closes). `<details>` collapses its children by default, so while it
 * is still forming the streaming pending tail must be held rather than shown as a
 * sibling *after* the (auto-closed) element, where it would flash the collapsed
 * body (#600). Scans rendered HTML, so code spans/blocks — where the tag is
 * escaped, not a real element — never count.
 */
export function hasOpenDetailsElement(html: string): boolean {
  if (!html.includes('<details')) return false
  const opens = html.match(DETAILS_OPEN_RE)?.length ?? 0
  const closes = html.match(DETAILS_CLOSE_RE)?.length ?? 0
  return opens > closes
}

/** Signed net `<details>` opens minus closes in `html` (raw renderer output). */
function detailsBalance(html: string): number {
  if (!html.includes('<details') && !html.includes('</details')) return 0
  const opens = html.match(DETAILS_OPEN_RE)?.length ?? 0
  const closes = html.match(DETAILS_CLOSE_RE)?.length ?? 0
  return opens - closes
}

/**
 * Incremental committed-prefix renderer. Owns the frozen/tail split of a single
 * `completedEl`; call {@link reset} when that element is rebuilt (see gap D).
 */
export class FrozenTailRenderer {
  /** Source offset; DOM for `[0, frozenEnd)` is final and never re-rendered. */
  private frozenEnd = 0
  /** Exact source text of `[0, frozenEnd)` — guards non-append-only updates. */
  private frozenSource = ''
  /** Whether any frozen block rendered non-empty HTML (drives the `'\n'` seam). */
  private frozenHasHtml = false
  /** Counted number of `completedEl` children that are frozen. */
  private frozenNodeCount = 0
  /** Serialized committed link-ref map at the last commit (invalidation guard). */
  private lastLinkRefKey = ''
  /** The committed link-ref map behind {@link lastLinkRefKey} (delta diffing). */
  private lastLinkRefs: LinkReferenceMap = new Map()
  /**
   * Normalized bracketed spans seen in FROZEN source (accumulated per delta,
   * O(delta) each commit). Over-approximates the reference labels the frozen
   * region could contain; a new definition whose label is not in here cannot
   * change frozen output, so its arrival skips the limitation-J full morph.
   */
  private frozenLabelCandidates = new Set<string>()
  /**
   * Whether the committed render leaves a `<details>` open (#600). Read by the
   * streaming renderer to hold the pending tail so a collapsed body is not
   * flashed as a sibling after the element. Recomputed on every commit path: the
   * full-morph and footnote rebuilds compute it from the whole unsanitized
   * render, and the incremental fast path computes it from the unsettled tail
   * (the frozen prefix and delta are always balanced, so the tail carries any
   * lone-open `<details>` — #138).
   */
  committedHasOpenDetails = false
  /**
   * Diagnostic: cumulative count of HTML characters this renderer has produced
   * (delta + tail per commit, or the whole document on a full-morph fallback).
   * The invariant #21 protects is that this stays O(n) over a whole stream, not
   * O(n²); a deterministic, timing-free perf-regression test reads it. Never
   * consumed by production code.
   */
  renderedChars = 0
  /**
   * Diagnostic: cumulative count of sanitized-HTML characters the generic
   * commit path actually fed to a parse + DOM diff (the delta and tail range
   * morphs, and full-morph fallbacks). Rendering a string is cheap; sanitizing,
   * parsing, and diffing it is the per-commit DOM cost the tail memo removes —
   * so this staying well below {@link renderedChars} on a steady stream proves
   * the memo engages (ADR 0004 Phase 2). Never consumed by production code.
   */
  parsedChars = 0
  /**
   * Diagnostic: commits whose newly-settled delta was adopted in place whole —
   * its blocks were committed to the DOM last frame as the tail, from the same
   * rendered string at the same position, so the live nodes are already
   * byte-correct and the frozen boundary advanced over them without a
   * sanitize + parse + diff. Never consumed by production code.
   */
  deltaCommitsSkipped = 0
  /**
   * Diagnostic: commits whose delta EXTENDED the memoized tail — its first
   * top-level part rendered byte-identically to last frame's tail, so those
   * live nodes were adopted and only the remaining (genuinely new) parts were
   * sanitized + parsed + morphed. Never consumed by production code.
   */
  deltaPrefixesAdopted = 0
  /**
   * Diagnostic: commits whose tail rendered byte-identically to the previous
   * commit's (same root, boundary, and seam), so the live tail nodes were kept
   * verbatim without a sanitize + parse + diff. Never consumed by production
   * code.
   */
  tailMorphsSkipped = 0
  /**
   * Diagnostic: commits where a newly-arrived link-reference definition whose
   * label IS referenced by frozen content (limitation J) was absorbed as a
   * targeted per-part patch — re-rendering and morphing only the frozen
   * top-level parts whose source contains a matching bracketed span — instead
   * of a full-document morph. Never consumed by production code.
   */
  linkRefPatchCommits = 0

  /**
   * Ordered records of the frozen top-level parts — each part's source span
   * and raw rendered HTML (null for a part sealed out of intra-list mode,
   * whose exact whole-group render was never produced) — so a late link-ref
   * definition can re-render and morph ONLY the parts whose source contains a
   * matching bracketed span (limitation J, ADR 0004 Phase 2). The part→node
   * mapping is not stored: it is re-derived (and verified) at patch time from
   * the frozen region's layout, which the generic commit path guarantees is
   * strictly alternating — one element per part, one '\n' seam text node
   * between parts (and one before part 0 iff earlier frozen output existed).
   * Any commit that can break that layout (re-root frames, a delta whose
   * parts were unavailable) sets {@link frozenPartsReliable} false, and the
   * patch falls back to today's full morph.
   */
  private frozenParts: { start: number; end: number; rawHtml: string | null }[] = []
  /** False when the frozen region's node layout can't be trusted for patching. */
  private frozenPartsReliable = true

  /**
   * Memo of the last generic-path tail commit (ADR 0004 Phase 2). Records the
   * RAW rendered tail string, the exact position it was morphed at, and the
   * parse's top-level node count, establishing the invariant the skips rely
   * on: the live children `[atNodeCount, atNodeCount + nodeCount)` of `root`
   * serialize exactly as `parse(sanitize(lead + rawHtml))` until the next
   * commit. `partCount`/`balanced` gate the partial (extension) adoption: it
   * needs the memo to be a single top-level group whose raw tags are balanced,
   * so per-fragment sanitization composes across the adoption boundary —
   * exactly the existing frozen-boundary assumption, at the same granularity.
   * Anything that mutates the committed subtree outside the generic path
   * (full morph, re-root frames, intra-list mode, footnote mode, out-of-band
   * hydration via {@link invalidateDomMemo}) nulls it — a stale memo must
   * never be trusted, a missing one only costs a re-parse.
   */
  private tailMemo: {
    root: HTMLElement
    atNodeCount: number
    lead: '' | '\n'
    rawHtml: string
    nodeCount: number
    partCount: number
    balanced: boolean
  } | null = null

  /**
   * Drop the DOM-trust memo after out-of-band mutation of committed nodes —
   * math/diagram hydration rewrites scaffold elements in place, which the
   * morphs used to absorb as ordinary diff noise. Idempotent and cheap; when
   * unsure whether committed DOM was touched, call it.
   */
  invalidateDomMemo(): void {
    this.tailMemo = null
  }

  // ---- Re-rooted append frames (ADR 0004 Phase 2) ------------------------
  // While committed raw HTML leaves a safe container element open (an unclosed
  // `<details>`/`<div>`/… under the passthrough policy), the whole-string
  // parse nests ALL later content inside that element. This used to be
  // unfreezable — every subsequent commit fell back to a full-document morph,
  // the O(n²) cliff of docs/decisions/0004. Instead the commit path re-roots:
  // the open element becomes the append target, later blocks freeze INSIDE it
  // exactly as at the top level (`frozenNodeCount`/`frozenHasHtml` describe
  // the innermost frame while frames are open; each frame saves the outer
  // level's values). A matching close tag — or any structural surprise —
  // falls back to one full morph; the then-balanced region freezes wholesale
  // through the ordinary path afterwards.
  /** Innermost-last stack of live open container elements being appended into. */
  private openFrames: { el: HTMLElement; tag: string; outerFrozenNodeCount: number; outerFrozenHasHtml: boolean }[] = []
  /** Top-level child of `completedEl` containing every open frame (stale-trim anchor). */
  private frameAnchor: ChildNode | null = null
  /**
   * Net `<details>` opens minus closes across the frozen RAW render. The #138
   * pending-tail hold must track the *unsanitized* whole render (the string
   * emitter re-checks it every frame; the sink may unwrap the element), and
   * with frozen deltas never re-rendered this running balance is that check.
   */
  private frozenDetailsBalance = 0

  private resetFrames(): void {
    this.openFrames = []
    this.frameAnchor = null
    this.frozenDetailsBalance = 0
  }

  /** The element commits currently append into: the innermost open frame, else `completedEl`. */
  private commitRoot(completedEl: HTMLElement): HTMLElement {
    return this.openFrames[this.openFrames.length - 1]?.el ?? completedEl
  }

  /**
   * True when `deltaHtml`/`tailHtml` mention a close tag for any open frame.
   * Conservative by string scan: even a balanced same-tag pair trips it (the
   * cost is one full morph + re-derivation, never wrong output). A real close
   * means later content pops OUT of the frame — per-fragment parsing drops the
   * stray close instead, so the framed fast path must not run.
   */
  private frameCloseAppeared(deltaHtml: string, tailHtml: string): boolean {
    for (const frame of this.openFrames) {
      const close = `</${frame.tag.toLowerCase()}`
      if (deltaHtml.toLowerCase().includes(close) || tailHtml.toLowerCase().includes(close)) return true
    }
    return false
  }

  /**
   * Fold the bracketed spans of newly frozen `source` into the candidate set
   * (escape-aware, whitespace/case-normalized like reference labels, plus a
   * backslash-stripped variant — over-approximation only ever costs an
   * unnecessary full morph, never wrong output). O(newly frozen bytes), so it
   * totals O(n) over a stream.
   */
  private accumulateLabelCandidates(source: string): void {
    if (!source.includes('[')) return
    const spanRe = /\[((?:\\[\s\S]|[^\[\]\\])*)\]/g
    for (let m = spanRe.exec(source); m; m = spanRe.exec(source)) {
      const span = m[1] ?? ''
      if (span.trim() === '') continue
      this.frozenLabelCandidates.add(normalizeReferenceLabel(span))
      if (span.includes('\\')) {
        this.frozenLabelCandidates.add(normalizeReferenceLabel(span.replace(/\\([\s\S])/g, '$1')))
      }
    }
  }

  /**
   * True when the committed link-ref map changed purely by ADDING labels,
   * none of which matches a bracketed span ever frozen — so the frozen DOM
   * provably cannot change and the limitation-J full morph is unnecessary.
   * Removals and value changes are never inert.
   */
  private linkRefDeltaIsInert(linkRefs: LinkReferenceMap): boolean {
    if (linkRefs.size < this.lastLinkRefs.size) return false
    for (const [label, ref] of this.lastLinkRefs) {
      const next = linkRefs.get(label)
      if (!next || next.href !== ref.href || (next.title ?? '') !== (ref.title ?? '')) return false
    }
    for (const label of linkRefs.keys()) {
      if (!this.lastLinkRefs.has(label) && this.frozenLabelCandidates.has(label)) return false
    }
    return true
  }

  /**
   * Targeted limitation-J patch (ADR 0004 Phase 2): the committed link-ref
   * map changed in a way that may rewrite frozen content — a definition
   * arrived for a referenced label, or a still-streaming definition run
   * retreated out of `complete` (removals) or re-parsed with a new value.
   * A block's render depends on the map only through the labels of its own
   * bracketed spans, so re-render and morph in place ONLY the frozen
   * top-level parts whose source contains a span matching a CHANGED label,
   * leaving every other frozen node untouched — a definition-bearing document
   * (CHANGELOG-style: definitions at the bottom, referenced above) stops
   * paying a full-document morph per definition line.
   *
   * Returns false — the caller full-morphs, today's exact behaviour — on ANY
   * doubt: intra-list / re-root / unreliable-part state, a frozen region
   * whose live layout does not verify as strictly alternating (one element
   * per part, one '\n' seam between parts), a patched part that does not
   * re-render to exactly one element, or a citing set too large for per-part
   * work to beat one whole-document morph. On success the caller continues
   * the ordinary commit under the new map (the delta and tail render with it
   * anyway).
   */
  private patchFrozenLinkRefs(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    linkRefs: LinkReferenceMap,
  ): boolean {
    // States whose frozen DOM is not described by `frozenParts`: items frozen
    // inside a shared list, content committed inside re-root frames, or parts
    // recorded without a per-part split.
    if (!this.frozenPartsReliable || this.listSig !== null || this.openFrames.length > 0) {
      return false
    }
    // Labels whose entry differs between the committed maps, in either
    // direction (added, removed, or value changed).
    const changedLabels = new Set<string>()
    for (const [label, ref] of linkRefs) {
      const prev = this.lastLinkRefs.get(label)
      if (!prev || prev.href !== ref.href || (prev.title ?? '') !== (ref.title ?? '')) {
        changedLabels.add(label)
      }
    }
    for (const label of this.lastLinkRefs.keys()) {
      if (!linkRefs.has(label)) changedLabels.add(label)
    }

    const parts = this.frozenParts
    if (parts.length === 0) return this.frozenNodeCount === 0
    // Verify the live frozen layout is exactly the alternating shape the part
    // records assume: [optional lead '\n'] el ('\n' el)*. Any other shape
    // (multi-node raw part, sanitizer-dropped part) makes the part→node
    // mapping ambiguous — fall back.
    const leadOffset = this.frozenNodeCount - (2 * parts.length - 1)
    if (leadOffset !== 0 && leadOffset !== 1) return false
    const children = completedEl.childNodes
    for (let i = 0; i < this.frozenNodeCount; i++) {
      const node = children[i]
      if (!node) return false
      const isSeamSlot = (i - leadOffset) % 2 !== 0 || (leadOffset === 1 && i === 0)
      if (isSeamSlot) {
        if (node.nodeType !== 3 || node.textContent !== '\n') return false
      } else if (!(node instanceof HTMLElement)) {
        return false
      }
    }

    // Collect the citing parts first and patch only a SMALL set: each patched
    // part pays its own sanitize + parse, so beyond a handful the one big
    // full-morph sanitize is cheaper (and byte-identical). A whole-map flip
    // that touches most parts (a long definition run retreating out of
    // `complete` in a document where every section cites its version label)
    // therefore falls back, while the targeted case — one definition
    // upgrading its few citing blocks — stays O(citing parts).
    const affected: number[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part && sourceMentionsLabel(complete.slice(part.start, part.end), changedLabels)) {
        affected.push(i)
      }
    }
    if (affected.length > MAX_LINK_REF_PATCH_PARTS) return false

    for (const i of affected) {
      const part = parts[i]
      /* c8 ignore next -- `affected` indices come from the loop above */
      if (!part) return false
      const from = lowerBound(tokens, part.start)
      const to = lowerBound(tokens, part.end)
      const rendered = renderBlocksToParts(complete, tokens.slice(from, to), {
        linkRefs,
        ...RENDER_OPTS,
      })
      // The span covers exactly one top-level group by construction; anything
      // else means the record is stale — fall back.
      if (rendered.length !== 1) return false
      const newHtml = rendered[0]?.html ?? ''
      if (newHtml === part.rawHtml) continue // bracketed span, but not a reference (e.g. code)
      if (newHtml === '' || hasUnfreezableRawHtml(newHtml)) return false
      const host = completedEl.cloneNode(false) as HTMLElement
      const sanitized = sanitizeRenderedMarkdown(newHtml)
      this.renderedChars += newHtml.length
      this.parsedChars += sanitized.length
      setPresanitizedHtml(host, sanitized)
      const template = host.firstElementChild
      if (host.childNodes.length !== 1 || !(template instanceof HTMLElement)) return false
      const live = children[leadOffset + 2 * i]
      /* c8 ignore next -- the layout pass above proved every part slot is an element */
      if (!(live instanceof HTMLElement)) return false
      if (live.tagName === template.tagName) {
        // In-place upgrade keeps the block's node identity (a reference
        // resolving is an inline change within the block).
        syncAttributes(live, template)
        morphElementChildrenFrom(live, template, 0)
      } else {
        /* c8 ignore next 4 -- defensive: a reference upgrade is inline-only
           (block tokens don't depend on the ref map), so the part's element
           tag cannot change; kept so a future divergence degrades to a
           correct positional replace instead of wrong output. */
        completedEl.replaceChild(template, live)
      }
      part.rawHtml = newHtml
    }
    if (affected.length > 0) this.linkRefPatchCommits++
    return true
  }

  // ---- Intra-list freezing (#29) ----------------------------------------
  // When the trailing group is a long, still-open, signature-uniform list, the
  // whole group would otherwise stay in the tail and be re-rendered per commit
  // (O(n²) for list-shaped output). Instead, settled items freeze INSIDE the
  // shared <ul>/<ol>: `frozenEnd` then points at an item-token boundary within
  // the group, the list element itself stays live (its attributes may still
  // change), and per-commit work is the unfrozen item slice only.
  /** Signature of the active shared trailing list; null = intra-list inactive. */
  private listSig: ListGroupSignature | null = null
  /** Number of leading `<li>` children of the shared list that are frozen. */
  private listFrozenLis = 0
  /** Child index of the shared list element within `completedEl`. */
  private listElIndex = 0
  /** Source offset where the shared trailing list group begins (its part record on seal). */
  private listStart = 0
  /** Looseness baked into the frozen items (a flip forces a full morph). */
  private listLoose = false
  /** Task-list evidence seen so far (drives the `<ul>` class; monotonic). */
  private listHasTask = false

  private resetListState(): void {
    this.listSig = null
    this.listFrozenLis = 0
    this.listElIndex = 0
    this.listStart = 0
    this.listLoose = false
    this.listHasTask = false
  }

  // ---- Footnote incremental rendering (#110) ----------------------------
  // A footnote-bearing document used to force a full `morphInnerHtml(render(
  // complete))` on every commit (any `[^` in the buffer tripped the freeze
  // guard), making footnote streaming O(n²). That is wasteful: a new footnote
  // definition only upgrades the specific `[^label]` references it resolves
  // (inline, never restructuring their block) and grows the trailing footnotes
  // section. This mode renders the body as per-block parts and the section as
  // per-`<li>` items, keeping a DOM handle to each, and re-morphs ONLY the parts
  // whose reference numbering changed plus the new/changed section items.
  //
  // Active only once at least one footnote DEFINITION is committed (before that,
  // references are literal and the ordinary frozen-tail path is byte-identical).
  // Any structural surprise (new/removed body block, section first appearing,
  // reorder that can't map, raw-HTML imbalance) falls back to a full rebuild,
  // and a rebuild that can't re-capture the node mapping gives up to the plain
  // full-morph path — so output is always correct, only sometimes slower.
  /** Whether footnote-incremental bookkeeping currently mirrors `completedEl`. */
  private fnActive = false
  /** A mapping guard failed irrecoverably; always full-morph until `reset`. */
  private fnGaveUp = false
  /** Committed source at the last footnote commit (append-only prefix guard). */
  private fnSource = ''
  /** Serialized link-ref map at the last footnote commit. */
  private fnLinkRefKey = ''
  /** Rendered body parts with the live DOM element each occupies. */
  private fnBodyParts: (RenderedPart & { el: HTMLElement })[] = []
  /** The live `<ol>` inside the footnotes section (null = no section yet). */
  private fnSectionOl: HTMLElement | null = null
  /** Last-rendered footnote section `<li>` HTML strings (change-detection). */
  private fnSectionItems: string[] = []
  // Persisted state for the append-only fast path (#133): when definitions
  // stream in over a fixed body in first-use order, a commit re-renders only the
  // one newly-resolved reference block and appends only the new section item(s),
  // instead of re-rendering the whole document every commit (the O(n²) driver).
  /** The context carried across commits — its numbering/slugs stay authoritative. */
  private fnCtx: FootnoteContext | null = null
  /** Normalized `[^label]` refs per body part (raw-source scan, over-approximate). */
  private fnPartLabels: string[][] = []
  /** Distinct body labels in first-use (scan) order. */
  private fnBodyOrder: string[] = []
  /** How many times each body label is referenced (single-use gates the fast path). */
  private fnBodyCount = new Map<string, number>()
  /** Source offset where the body ends; new content past it disqualifies the fast path. */
  private fnBodyEnd = 0

  private resetFootnoteState(): void {
    this.fnActive = false
    this.fnGaveUp = false
    this.fnSource = ''
    this.fnLinkRefKey = ''
    this.fnBodyParts = []
    this.fnSectionOl = null
    this.fnSectionItems = []
    this.fnCtx = null
    this.fnPartLabels = []
    this.fnBodyOrder = []
    this.fnBodyCount = new Map()
    this.fnBodyEnd = 0
  }

  reset(): void {
    this.frozenEnd = 0
    this.frozenSource = ''
    this.frozenHasHtml = false
    this.frozenNodeCount = 0
    this.lastLinkRefKey = ''
    this.lastLinkRefs = new Map()
    this.frozenLabelCandidates.clear()
    this.committedHasOpenDetails = false
    this.tailMemo = null
    this.frozenParts = []
    this.frozenPartsReliable = true
    this.resetListState()
    this.resetFootnoteState()
    this.resetFrames()
  }

  /**
   * Reconcile `completedEl` so it serializes byte-identically to
   * `sanitizeRenderedMarkdown(renderMarkdownUnsafe(complete))`, freezing the settled
   * prefix and re-rendering only the tail group. `tokens` must be
   * `tokenizeBlocks(complete)` (threaded from the caller, Layer 1), and
   * `providedLinkRefs` / `providedFootnoteDefs`, when given, must equal
   * `collectLinkReferenceDefinitions(complete)` /
   * `collectFootnoteDefinitions(complete)` (threaded from the caller's
   * incremental scanner, #30 / ADR 0004 Phase 1 — saves the per-commit
   * O(prefix) definition scans).
   */
  update(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    providedLinkRefs?: LinkReferenceMap,
    providedFootnoteDefs?: FootnoteDefinitionMap,
  ): void {
    if (complete === '') {
      if (completedEl.childNodes.length > 0) completedEl.replaceChildren()
      this.reset()
      return
    }
    // Recomputed below (in fullMorph when a `<details>` is still open). The
    // default carries the frozen raw balance: a `<details>` left open by an
    // already-frozen delta (ADR 0004 Phase 2) stays held even on commit paths
    // that return early (e.g. the shared-list fast path); a commit that
    // resolved the tail's imbalance never persists stale.
    this.committedHasOpenDetails = this.frozenDetailsBalance > 0

    const linkRefs = providedLinkRefs ?? collectLinkReferenceDefinitions(complete, tokens)
    const linkRefKey = serializeLinkRefs(linkRefs)
    const tailStart = settledTailStart(tokens)
    const tailToken = tokens[tailStart]
    const settledOffset = tailToken ? tailToken.start : complete.length

    // Fall back to today's full-morph behaviour (then rebuild next commit) when
    // the fast path cannot safely reuse the frozen prefix:
    //  - the committed link-ref map changed, which can rewrite earlier blocks
    //    (limitation J);
    //  - the frozen source bytes are no longer a prefix of `complete` — the
    //    host rewrote or regenerated content in place, so the frozen DOM shows
    //    stale text (this also covers `complete` shrinking below `frozenEnd`);
    //  - `frozenEnd` no longer lands on a block boundary because a later chunk
    //    extended an earlier block over it (lazy paragraph continuation keeps
    //    the prefix bytes identical while merging blocks, so the byte check
    //    above cannot catch it).
    // A mere *backward jitter* of `settledOffset` is NOT a fallback: a new
    // unresolved inline in the trailing open paragraph retreats the split,
    // nudging the boundary back over a still-committed blank. The frozen prefix
    // stays valid there, so we keep it and never retreat `frozenEnd` (clamp the
    // advance below).
    // Footnotes (#110) are document-global: a definition arriving late upgrades
    // the specific literal `[^x]` references it resolves (inline, never
    // restructuring their block) and grows a trailing footnotes section. Once a
    // definition is committed, the dedicated incremental path re-morphs only the
    // changed reference blocks and section items instead of the whole prefix.
    // Before the first definition, references are literal and the document is
    // byte-identical to a footnote-free one, so the ordinary fast path is valid.
    const footnoteDefs = providedFootnoteDefs ?? collectFootnoteDefinitions(complete, tokens)
    if (footnoteDefs.size > 0) {
      this.commitWithFootnotes(completedEl, complete, tokens, linkRefs, linkRefKey, footnoteDefs)
      return
    }
    if (this.fnActive || this.fnGaveUp) this.resetFootnoteState()

    if (!complete.startsWith(this.frozenSource) || tokenStraddles(tokens, this.frozenEnd)) {
      this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs)
      return
    }
    // A committed link-ref map change can rewrite earlier blocks (limitation
    // J) — but only blocks that actually reference one of the labels the
    // change touched. When the change is purely additive (streams mostly only
    // ADD labels; first definition wins) and none of the new labels appears
    // among the bracketed spans of the frozen source, the frozen DOM provably
    // cannot change: adopt the new map and stay on the fast path. Any other
    // change — a possibly-referenced new label, a removal or value change
    // (the still-growing definition run the splitter holds retreats out of
    // `complete` and returns, flipping the whole map) — re-renders and morphs
    // only the frozen parts whose source contains a span matching a CHANGED
    // label (the targeted patch of ADR 0004 Phase 2), then continues the
    // ordinary commit under the new map. Any patch guard tripping keeps
    // today's full-morph fallback.
    if (linkRefKey !== this.lastLinkRefKey && !this.linkRefDeltaIsInert(linkRefs)) {
      if (!this.patchFrozenLinkRefs(completedEl, complete, tokens, linkRefs)) {
        this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs)
        return
      }
    }

    // Intra-list freezing (#29): while a long trailing list is still open,
    // reconcile only its unfrozen item slice inside the shared list element.
    // 'handled' means the commit is fully done; 'sealed' means the list just
    // ended and was promoted to a frozen top-level node — fall through so the
    // generic path processes the content after it; 'fallback' means an
    // intra-list guard tripped (loose flip, signature break, DOM mismatch).
    if (this.listSig) {
      const outcome = this.commitSharedList(completedEl, complete, tokens, linkRefs, linkRefKey)
      if (outcome === 'fallback') {
        this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs)
        return
      }
      if (outcome === 'handled') return
      // 'sealed' → continue below with the advanced frozen boundary.
    }
    // Never advance the frozen boundary past trailing SEPARATOR tokens
    // (blanks and link-ref definition lines). They render nothing, so
    // freezing them buys no per-commit work — and a still-growing blank-free
    // definition run EXTENDS its single block token as later definition lines
    // commit (the splitter releases a run's settled leading definitions while
    // holding only its last), so a frozen boundary placed after the token
    // would sit mid-token one commit later (`tokenStraddles`): a full morph
    // per definition line. Kept in the tail, the prefix stays valid as the
    // run grows and each newly settled definition lands on the inert-delta or
    // targeted-patch path above.
    // Never move the frozen boundary backward either (see above).
    let renderEnd = 0
    for (let i = lowerBound(tokens, Math.max(settledOffset, this.frozenEnd)) - 1; i >= 0; i--) {
      const token = tokens[i]
      if (!token) break
      if (settleClassOf(token.kind) !== 'separator') {
        renderEnd = token.end
        break
      }
    }
    const advanceTo = Math.max(Math.min(settledOffset, renderEnd), this.frozenEnd)

    // Newly-settled delta `[frozenEnd, advanceTo)` and tail `[advanceTo, end)`.
    // Tokens are sorted, so both are contiguous slices around two binary-searched
    // boundaries — never a full-array scan (the commit path must stay O(tail)).
    const deltaFrom = lowerBound(tokens, this.frozenEnd)
    const deltaTo = lowerBound(tokens, advanceTo)
    const deltaTokens = tokens.slice(deltaFrom, deltaTo)
    const tailTokens = tokens.slice(deltaTo)

    // Rendered as per-part units purely for the memo comparisons; the joined
    // strings are byte-identical to `renderBlocks` over the same tokens (the
    // renderBlocksToParts contract), so every guard below sees exactly what it
    // always saw.
    const deltaParts = deltaTokens.length
      ? renderBlocksToParts(complete, deltaTokens, { linkRefs, ...RENDER_OPTS })
      : []
    const tailParts = tailTokens.length
      ? renderBlocksToParts(complete, tailTokens, { linkRefs, ...RENDER_OPTS })
      : []
    const deltaHtml = deltaParts.map((p) => p.html).join('\n')
    const tailHtml = tailParts.map((p) => p.html).join('\n')

    // A close tag for an open frame means later content pops OUT of the frame
    // in the whole-string parse; per-fragment parsing drops the stray close, so
    // the framed fast path cannot express it. One full morph rebuilds — and the
    // now-balanced region then freezes wholesale through the ordinary path.
    if (this.openFrames.length > 0 && this.frameCloseAppeared(deltaHtml, tailHtml)) {
      this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs)
      return
    }

    // An unbalanced raw tag in the delta used to be terminally unfreezable:
    // whole-string sanitization keeps the element open across later blocks,
    // per-fragment sanitization closes it early, and the fallback repeated on
    // every commit (frozenEnd stuck) — the O(n²) cliff of docs/decisions/0004.
    // The tag-count scan is only an over-approximation though, so ask the
    // parser what actually stays open at the delta's EOF (Phase 2):
    //   - nothing (`[]`) — the imbalance self-healed (an unclosed `<details>`
    //     inside a `</li>`-closed list item): the delta is safe to freeze;
    //   - a chain of safe container elements — re-root: commit the delta, then
    //     append all later content INSIDE the open element(s), exactly where
    //     the whole-string parse puts it;
    //   - anything else (formatting tags, parser-magic elements, unknown) —
    //     today's full-morph fallback.
    let rerootChain: string[] | null = null
    if (deltaHtml !== '' && hasUnfreezableRawHtml(deltaHtml)) {
      const chain = getHtmlPolicy() === 'passthrough' ? openElementChainAtEof(deltaHtml) : null
      if (chain === null || (chain.length > 0 && !chain.every((tag) => SAFE_REROOT_TAGS.has(tag)))) {
        this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs)
        return
      }
      if (chain.length > 0) rerootChain = chain
    }
    this.renderedChars += deltaHtml.length + tailHtml.length

    const root = this.commitRoot(completedEl)
    // While frames are open the commit morphs inside the innermost frame, so
    // stale top-level leftovers (block-level pending elements appended after
    // the frame's anchor by the previous frame) must be trimmed explicitly —
    // at the top level they sit AFTER the anchor, which is always the last
    // committed top-level node.
    if (this.frameAnchor) {
      while (completedEl.lastChild && completedEl.lastChild !== this.frameAnchor) {
        completedEl.lastChild.remove()
      }
    }

    // Reconcile everything after the frozen prefix — newly-settled delta plus
    // tail — as two range morphs (or around a re-root push). Seam rule:
    // `renderBlocks` joins non-empty top-level RAW blocks with '\n' (gap B);
    // the seam text survives the sanitizer even when a fragment's elements do
    // not, so joins follow raw emptiness on the paths a sanitizer-unwrapped
    // container can reach.
    if (rerootChain) {
      const sanitizedDelta = deltaHtml !== '' ? sanitizeRenderedMarkdown(deltaHtml) : ''
      const sanitizedTail = tailHtml !== '' ? sanitizeRenderedMarkdown(tailHtml) : ''

      // Which of the raw open chain survives sanitization on the rightmost
      // path of the delta fragment. Unwrapped elements (both shipped backends
      // keep a dropped element's children in place) leave the whole-string
      // parse flattened the same way per-fragment rendering is — so with NO
      // survivors the delta freezes through the ordinary path; survivors
      // become frames.
      const survivors =
        sanitizedDelta !== '' ? this.survivingChain(root, sanitizedDelta, rerootChain) : []
      if (survivors.length > 0) {
        /* c8 ignore start -- defensive backstop: commitWithReroot's live walk
           mirrors the survivingChain probe over the same sanitized fragment, so
           it cannot report a mismatch; kept so a future divergence degrades to
           the correct full morph instead of wrong output. */
        if (!this.commitWithReroot(completedEl, root, survivors, sanitizedDelta, sanitizedTail, tailHtml !== '')) {
          this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs)
          return
        }
        /* c8 ignore stop */
      } else {
        // Fully-flattened re-root chain: the sanitizedDelta may be '' while
        // the RAW delta was not (its '\n' seam must still be emitted, hence
        // the raw-emptiness gating inside commitRanges). The delta carried
        // unbalanced raw tags, so the partial adoption (which splits it) is
        // off — `deltaParts: null`.
        this.commitRanges(root, deltaHtml, tailHtml, null, tailParts.length, sanitizedDelta, sanitizedTail)
      }
    } else {
      this.commitRanges(root, deltaHtml, tailHtml, deltaParts, tailParts.length)
    }
    // #138: hold the pending tail in the DOM emitter while a `<details>` is
    // open in the RAW whole render — matching the string emitter, which
    // re-checks its raw render every frame. Frozen deltas are never
    // re-rendered, so the frozen share is a running raw balance.
    this.frozenDetailsBalance += detailsBalance(deltaHtml)
    this.committedHasOpenDetails =
      this.frozenDetailsBalance > 0 || hasOpenDetailsElement(tailHtml)

    if (advanceTo > this.frozenEnd) {
      this.accumulateLabelCandidates(complete.slice(this.frozenEnd, advanceTo))
    }
    this.frozenEnd = advanceTo
    this.frozenSource = complete.slice(0, advanceTo)
    this.lastLinkRefKey = linkRefKey
    this.lastLinkRefs = linkRefs

    // Intra-list bookkeeping indexes top-level children of `completedEl`;
    // inside a frame the shared-list optimization simply stays off.
    if (this.openFrames.length === 0) {
      this.maybeActivateIntraList(completedEl, complete, tokens, tailStart)
    }
  }

  /**
   * The generic two-range commit: reconcile the newly-settled delta at
   * `[frozenNodeCount, …)` of `root`, advance the boundary over it, then
   * reconcile the tail after it. Two range morphs — delta, then tail — so the
   * delta parses exactly once: its morph template doubles as the frozen node
   * count (gap C), where the old joint morph needed a second, count-only parse
   * of the sanitized delta on every commit (~26% of the commit path). The
   * split parse yields the joint morph's exact node sequence: top-level parts
   * end in elements, so text cannot merge across the boundary, and each '\n'
   * seam stays its own text node. Blocks settling this commit keep their node
   * identity — the delta range morph reuses them in place and never trims —
   * and the tail morph's trailing trim preserves the sweep semantics (gaps
   * B/E).
   *
   * On top of that, the tail memo (ADR 0004 Phase 2) removes the remaining
   * redundant parses of a steady stream:
   *
   *  - **Delta adopt-in-place**: the blocks settling this commit usually ARE
   *    last frame's tail — rendered from the same string, morphed at the same
   *    position of the same root, with the same '\n' seam. When the memo
   *    proves that byte-exactly, the live nodes are already what the delta
   *    morph would produce, so the frozen boundary just advances over the
   *    memoized node count: no sanitize, no parse, no diff.
   *  - **Delta extension adoption**: more often the settling group grew
   *    before it settled, and the delta's FIRST top-level part alone equals
   *    the memoized tail (the group as last committed) while later parts are
   *    new. The memoized nodes are adopted the same way and only the
   *    remaining parts are sanitized + parsed + morphed — reproducing, byte
   *    for byte, the two commits today's path would have produced had the
   *    stream settled the tail first and the rest one commit later. That
   *    partition is only taken when both halves are independently freezable
   *    (the memo part is a single group with balanced raw tags — so the rest
   *    is balanced too, by additivity — under a delta that already passed the
   *    raw-HTML guard), the exact per-fragment-sanitize assumption the frozen
   *    boundary itself rests on, at the same top-level group granularity.
   *  - **Tail reuse**: a commit that re-renders the tail byte-identically
   *    (e.g. only blanks or inert definitions committed) keeps the live tail
   *    nodes verbatim; only the trailing trim (stale block-level pending
   *    elements from the previous frame) still runs.
   *
   * Every skip demands EXACT equality of the raw strings, root identity, node
   * position, and seam — any mismatch, and any commit path other than this
   * one, falls back to the full sanitize + parse + morph, so a missed skip is
   * only ever slower, never different. The memo's DOM-trust invariant (the
   * recorded region is untouched between commits) is upheld by the callers:
   * the streaming renderer sweeps its pending-tail artifacts before every
   * commit and invalidates on hydration ({@link invalidateDomMemo}).
   *
   * `deltaParts` must be the delta's per-part split (joining to `deltaHtml`)
   * from a delta that passed the raw-HTML guard, or null to disable the
   * partial adoption (the re-rooted flattened path, whose delta is known
   * unbalanced). `presanitizedDelta`/`presanitizedTail` forward sanitizations
   * the re-root probe already paid for; when null they are computed only on a
   * memo miss.
   */
  private commitRanges(
    root: HTMLElement,
    deltaHtml: string,
    tailHtml: string,
    deltaParts: RenderedPart[] | null,
    tailPartCount: number,
    presanitizedDelta: SanitizedHtml | '' | null = null,
    presanitizedTail: SanitizedHtml | '' | null = null,
  ): void {
    if (deltaHtml !== '') {
      const lead: '' | '\n' = this.frozenHasHtml ? '\n' : ''
      const memo = this.tailMemo
      const adoptable =
        memo !== null &&
        memo.root === root &&
        memo.atNodeCount === this.frozenNodeCount &&
        memo.lead === lead
      if (adoptable && memo.rawHtml === deltaHtml) {
        this.frozenNodeCount += memo.nodeCount
        this.deltaCommitsSkipped++
      } else if (
        adoptable &&
        memo.partCount === 1 &&
        memo.balanced &&
        deltaParts !== null &&
        deltaParts.length > 1 &&
        deltaParts[0]?.html === memo.rawHtml
      ) {
        this.frozenNodeCount += memo.nodeCount
        const rest = deltaParts
          .slice(1)
          .map((p) => p.html)
          .join('\n')
        const html = asSanitizedHtml('\n' + sanitizeRenderedMarkdown(rest))
        this.parsedChars += html.length
        this.frozenNodeCount += morphInnerHtmlRangeFrom(root, this.frozenNodeCount, html)
        this.deltaPrefixesAdopted++
      } else {
        const sanitized = presanitizedDelta ?? sanitizeRenderedMarkdown(deltaHtml)
        const html = asSanitizedHtml(lead + sanitized)
        this.parsedChars += html.length
        this.frozenNodeCount += morphInnerHtmlRangeFrom(root, this.frozenNodeCount, html)
      }
      this.frozenHasHtml = true
      // A non-empty delta either consumed the memoized nodes (adoption) or
      // overwrote the region they described; the memo never survives it.
      this.tailMemo = null
      // Track the newly frozen parts for targeted link-ref patches. Without
      // the per-part split (the flattened re-root path) the region's layout
      // is unknowable, so patching is off until the next full morph rebuilds.
      if (deltaParts !== null) {
        for (const part of deltaParts) {
          this.frozenParts.push({ start: part.start, end: part.end, rawHtml: part.html })
        }
      } else {
        this.frozenPartsReliable = false
      }
    }
    const tailLead: '' | '\n' = this.frozenHasHtml && tailHtml !== '' ? '\n' : ''
    const memo = this.tailMemo
    if (
      memo &&
      tailHtml !== '' &&
      memo.root === root &&
      memo.atNodeCount === this.frozenNodeCount &&
      memo.lead === tailLead &&
      memo.rawHtml === tailHtml
    ) {
      // Unchanged tail: keep the live nodes; only sweep stale trailing
      // children (block-level pending elements appended after the tail by the
      // previous frame) — exactly what the tail morph's trim would remove.
      while (root.childNodes.length > this.frozenNodeCount + memo.nodeCount) {
        root.lastChild?.remove()
      }
      this.tailMorphsSkipped++
    } else if (tailHtml !== '') {
      const sanitized = presanitizedTail ?? sanitizeRenderedMarkdown(tailHtml)
      const html = asSanitizedHtml(tailLead + sanitized)
      this.parsedChars += html.length
      const nodeCount = morphInnerHtmlFrom(root, this.frozenNodeCount, html)
      this.tailMemo = {
        root,
        atNodeCount: this.frozenNodeCount,
        lead: tailLead,
        rawHtml: tailHtml,
        nodeCount,
        partCount: tailPartCount,
        balanced: tailPartCount === 1 && !hasUnfreezableRawHtml(tailHtml),
      }
    } else {
      morphInnerHtmlFrom(root, this.frozenNodeCount, '')
      this.tailMemo = null
    }
  }

  /**
   * The subsequence of `chain` (raw open elements at the delta's EOF,
   * outermost first) that survives sanitization, walked along the rightmost
   * path of the sanitized delta fragment. Elements the sanitizer unwrapped are
   * skipped — their children sit in place at the enclosing level, exactly as
   * the whole-string sanitize leaves them.
   */
  private survivingChain(root: HTMLElement, sanitizedDelta: SanitizedHtml, chain: string[]): string[] {
    const probe = root.cloneNode(false) as HTMLElement
    setPresanitizedHtml(probe, sanitizedDelta)
    const survivors: string[] = []
    let cursor: Element = probe
    for (const tag of chain) {
      const nextEl = cursor.lastElementChild
      if (nextEl && nextEl.tagName === tag) {
        survivors.push(tag)
        cursor = nextEl
      }
    }
    return survivors
  }

  /**
   * Commit a delta that leaves `chain` (outermost first, all
   * {@link SAFE_REROOT_TAGS}, sanitizer-surviving) open at its EOF: morph the
   * delta into the current root, walk the freshly-appended DOM down the chain
   * pushing a frame per element, then morph the tail INSIDE the innermost
   * frame — where the whole-string parse puts it. Returns false when the live
   * DOM does not match the probed chain (caller full-morphs; correctness over
   * speed).
   */
  private commitWithReroot(
    completedEl: HTMLElement,
    root: HTMLElement,
    chain: string[],
    // Non-empty in practice (survivors require sanitized elements); typed
    // loosely so the call site needs no narrowing assertion.
    sanitizedDelta: SanitizedHtml | '',
    sanitizedTail: SanitizedHtml | '',
    rawTailNonEmpty: boolean,
  ): boolean {
    // The tail commits inside a freshly-pushed frame the memo does not model;
    // subsequent framed commits rebuild it against the frame's root. Framed
    // content also breaks the flat part↔node layout the link-ref patch needs.
    this.tailMemo = null
    this.frozenPartsReliable = false
    const lead = this.frozenHasHtml ? '\n' : ''
    this.parsedChars += lead.length + sanitizedDelta.length
    morphInnerHtmlFrom(root, this.frozenNodeCount, asSanitizedHtml(lead + sanitizedDelta))

    // The open elements sit on the rightmost path of the delta's DOM (they
    // contain the delta's EOF), so walk lastElementChild with tag assertions.
    let container: HTMLElement = root
    for (const tag of chain) {
      const nextEl = container.lastElementChild
      /* c8 ignore next -- defensive: the live morph mirrors the survivingChain
         probe, so the walk cannot diverge; kept as a correctness backstop. */
      if (!(nextEl instanceof HTMLElement) || nextEl.tagName !== tag) return false
      this.openFrames.push({
        el: nextEl,
        tag,
        outerFrozenNodeCount: this.frozenNodeCount,
        outerFrozenHasHtml: this.frozenHasHtml,
      })
      container = nextEl
    }
    // First (outermost) activation: the anchor is the last top-level child of
    // `completedEl`, which contains the whole chain.
    this.frameAnchor ??= completedEl.lastChild
    // The frame interior committed by the delta is frozen; the '\n' seam
    // between the delta's last (raw non-empty) block and any later block lands
    // INSIDE the open element in the whole-string parse, so the frame always
    // leads with one.
    this.frozenNodeCount = container.childNodes.length
    this.frozenHasHtml = true
    if (rawTailNonEmpty) this.parsedChars += 1 + sanitizedTail.length
    morphInnerHtmlFrom(
      container,
      this.frozenNodeCount,
      rawTailNonEmpty ? asSanitizedHtml('\n' + sanitizedTail) : '',
    )
    return true
  }

  /**
   * Arm intra-list freezing when the generic commit just rendered a trailing
   * group that qualifies: a signature-uniform list, starting at the frozen
   * boundary, still open (nothing after it but blanks), with enough items to be
   * worth per-item bookkeeping. Pure state initialization — no DOM work, and no
   * items are frozen yet: the next commit's shared-list pass freezes them
   * through the normal path (including the raw-inline balance check).
   */
  private maybeActivateIntraList(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    tailStart: number,
  ): void {
    const first = tokens[tailStart]
    if (!first || first.kind !== 'list_item' || first.start < this.frozenEnd) return
    const scan = scanListGroup(complete, tokens, tailStart)
    if (scan.itemTokens.length < INTRA_LIST_MIN_ITEMS) return
    // The group must run to the end of the committed content (trailing blanks
    // only after it) — a closed or signature-mixed run stays on the generic
    // path (it settles wholesale, or conservatively stays in the tail).
    for (let i = scan.next; i < tokens.length; i++) {
      if (tokens[i]?.kind !== 'blank') return
    }
    // The generic morph just rendered the tail, whose last node is the group's
    // list element (pending elements are appended only after this runs).
    const lastIdx = completedEl.childNodes.length - 1
    const el = completedEl.childNodes[lastIdx]
    if (!(el instanceof HTMLElement) || el.tagName !== (scan.sig.ordered ? 'OL' : 'UL')) return
    this.listSig = scan.sig
    this.listFrozenLis = 0
    this.listElIndex = lastIdx
    this.listStart = first.start
    this.listLoose = scan.loose
    this.listHasTask = false
    // Shared-list commits mutate the list element's interior outside the
    // generic path's bookkeeping; the memo must not survive into (or past)
    // intra-list mode.
    this.tailMemo = null
  }

  /**
   * Per-commit reconcile while intra-list freezing is active. Freezes every
   * settled unfrozen item (all but the last, or all when the group just ended)
   * into the shared list element, morphs the unfrozen item slice in place, and
   * syncs the element's own attributes. Returns:
   *  - 'handled' — the list is still the open trailing group; commit complete.
   *  - 'sealed'  — the group ended; the list is now a fully frozen top-level
   *    node and the caller's generic path must process what follows it.
   *  - 'fallback' — a guard tripped (tight→loose flip against frozen items,
   *    signature break the caller can't see, or a DOM shape mismatch); the
   *    caller full-morphs, which also resets all intra-list state.
   */
  private commitSharedList(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    linkRefs: LinkReferenceMap,
    linkRefKey: string,
  ): 'handled' | 'sealed' | 'fallback' {
    const sig = this.listSig
    if (!sig) return 'fallback'
    const wantTag = sig.ordered ? 'OL' : 'UL'
    const listEl = completedEl.childNodes[this.listElIndex]
    if (!(listEl instanceof HTMLElement) || listEl.tagName !== wantTag) return 'fallback'

    // Walk the unfrozen region: interleaved blanks plus items that continue the
    // signature. Loose evidence is exactly scanListGroup's rule, applied
    // incrementally — a blank run counts only when a continuing item follows,
    // and only BETWEEN items: with the frozen boundary capped before trailing
    // separators, the walk can start at a blank that precedes the group
    // (frozen boundary still outside the list), which is not loose evidence.
    // Evidence inside the frozen region was accumulated when those items froze.
    const unfrozenItems: BlockToken[] = []
    let looseEvidence = false
    let blankPending = false
    let seenItem = this.listFrozenLis > 0
    let ended = false
    for (let i = lowerBound(tokens, this.frozenEnd); i < tokens.length; i++) {
      const token = tokens[i]
      if (!token) break
      if (token.kind === 'blank') {
        if (seenItem) blankPending = true
        continue
      }
      if (
        token.kind === 'list_item' &&
        listSliceContinuesGroup(sig, complete.slice(token.start, token.end))
      ) {
        seenItem = true
        if (blankPending) looseEvidence = true
        blankPending = false
        if (listItemSliceIsMultiParagraph(complete.slice(token.start, token.end))) {
          looseEvidence = true
        }
        unfrozenItems.push(token)
        continue
      }
      // Any other token (or a non-continuing item) closes the group here.
      ended = true
      break
    }

    const currentLoose = this.listLoose || looseEvidence
    if (currentLoose !== this.listLoose) {
      // Tight→loose flip: frozen items were rendered tight and are now wrong —
      // one-time fallback per list (looseness never reverts, so the rebuilt
      // state freezes loose from then on). With nothing frozen yet, just adopt.
      if (this.listFrozenLis > 0) return 'fallback'
      this.listLoose = currentLoose
    }

    // Freeze every settled item: all but the last while the group can still
    // grow (the last item may still absorb continuation lines), all of them
    // once the group has ended.
    const freezeCount = ended ? unfrozenItems.length : Math.max(0, unfrozenItems.length - 1)
    const deltaItems = unfrozenItems.slice(0, freezeCount)
    const tailItems = unfrozenItems.slice(freezeCount)

    const delta = renderListItemsSlice(complete, deltaItems, this.listLoose, linkRefs)
    // Same hazard as the top-level delta (gap F): never freeze an item slice
    // whose raw tags (benign inline, or any element under passthrough) are unbalanced.
    if (delta.itemsHtml !== '' && hasUnfreezableRawHtml(delta.itemsHtml)) return 'fallback'
    const tail = renderListItemsSlice(complete, tailItems, this.listLoose, linkRefs)
    this.renderedChars += delta.itemsHtml.length + tail.itemsHtml.length

    const hasTask = this.listHasTask || delta.anyTask || tail.anyTask
    const open = listGroupOpenTag(sig, hasTask)
    const close = listGroupCloseTag(sig)

    // Reconcile the unfrozen item region in place. Parsing the wrapped list
    // keeps DOMPurify and the fragment parser in list context; the element's
    // own attributes are synced separately (the task class can appear later)
    // while its frozen <li> children are never touched.
    const templateHost = completedEl.cloneNode(false) as HTMLElement
    this.parsedChars += open.length + delta.itemsHtml.length + tail.itemsHtml.length + close.length
    setSanitizedHtml(templateHost, `${open}${delta.itemsHtml}${tail.itemsHtml}${close}`)
    const templateList = templateHost.firstElementChild
    /* c8 ignore start -- unreachable defensive guard: the sanitized
       `${open}…${close}` template always parses to the expected list element. */
    if (!(templateList instanceof HTMLElement) || templateList.tagName !== wantTag) {
      return 'fallback'
    }
    /* c8 ignore stop */
    syncAttributes(listEl, templateList)
    morphElementChildrenFrom(listEl, templateList, this.listFrozenLis)

    if (freezeCount > 0) {
      // Counted advance (gap C): parse the sanitized frozen slice alone.
      const countHost = completedEl.cloneNode(false) as HTMLElement
      setSanitizedHtml(countHost, `${open}${delta.itemsHtml}${close}`)
      this.listFrozenLis += countHost.firstElementChild?.childNodes.length ?? 0
      const lastFrozen = deltaItems[deltaItems.length - 1]
      if (lastFrozen) {
        this.accumulateLabelCandidates(complete.slice(this.frozenEnd, lastFrozen.end))
        this.frozenEnd = lastFrozen.end
        this.frozenSource = complete.slice(0, this.frozenEnd)
      }
    }
    this.listHasTask = hasTask
    this.lastLinkRefKey = linkRefKey
    this.lastLinkRefs = linkRefs

    if (ended) {
      // Promote the shared list to a fully frozen top-level node (the '\n'
      // seam before it, if any, is absorbed into the frozen count) and let the
      // generic path handle the content after the group in this same commit.
      // Record the whole group as one frozen part (span only — its exact
      // whole-group render was never produced, so a link-ref patch that hits
      // it re-renders unconditionally).
      this.frozenParts.push({ start: this.listStart, end: this.frozenEnd, rawHtml: null })
      this.frozenNodeCount = this.listElIndex + 1
      this.frozenHasHtml = true
      this.resetListState()
      return 'sealed'
    }

    // Still open: sweep stale top-level children after the list (block-level
    // pending elements appended by the previous frame).
    while (completedEl.childNodes.length > this.listElIndex + 1) {
      completedEl.lastChild?.remove()
    }
    return 'handled'
  }

  /**
   * Commit a footnote-bearing document (#110). Reuses the incremental body/
   * section mapping when it still mirrors `completedEl`; otherwise rebuilds it
   * from a full render (re-capturing node handles), and gives up to the plain
   * full-morph path only if that re-capture is impossible. A still-forming
   * `<details>` (exotic combined with footnotes) always full-morphs so its
   * open-element flag stays correct.
   */
  private commitWithFootnotes(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    linkRefs: LinkReferenceMap,
    linkRefKey: string,
    footnoteDefs: FootnoteDefinitionMap,
  ): void {
    // Every footnote path reconciles the whole subtree under its own per-part
    // bookkeeping; the generic tail memo cannot stay coherent with it.
    this.tailMemo = null
    // Footnotes + a live re-root frame is an exotic combination the per-part
    // bookkeeping does not model; full-morph keeps it correct (and clears the
    // frames, matching the whole-document morph).
    if (this.fnGaveUp || this.openFrames.length > 0 || complete.includes('<details')) {
      this.fullMorph(completedEl, complete, tokens, linkRefKey, linkRefs)
      return
    }
    const canReuse =
      this.fnActive && this.fnLinkRefKey === linkRefKey && complete.startsWith(this.fnSource)
    if (canReuse && this.fnIncremental(completedEl, complete, tokens, linkRefs, footnoteDefs)) {
      this.fnSource = complete
      this.fnLinkRefKey = linkRefKey
      return
    }
    this.fnRebuild(completedEl, complete, tokens, linkRefs, linkRefKey, footnoteDefs)
  }

  /** Render body parts + section items under a fresh footnote context. */
  private renderFootnoteFrame(
    complete: string,
    tokens: BlockToken[],
    linkRefs: LinkReferenceMap,
    footnoteDefs: FootnoteDefinitionMap,
  ): { parts: RenderedPart[]; items: string[]; ctx: FootnoteContext } {
    const ctx = createFootnoteContext(footnoteDefs)
    // Restore the prior context, not null, so a recursive render from a fence
    // handler / inline pass can't strand an outer document's footnotes (#144).
    const previous = getActiveFootnoteContext()
    setActiveFootnoteContext(ctx)
    try {
      // Body first (advances first-use numbering in document order), then the
      // section (reads ctx.order) — exactly renderMarkdownCore's sequence.
      const parts = renderBlocksToParts(complete, tokens, { linkRefs, ...RENDER_OPTS })
      const items = renderFootnoteSectionItems(ctx, linkRefs)
      return { parts, items, ctx }
    } finally {
      setActiveFootnoteContext(previous)
    }
  }

  /**
   * Capture the per-body-part reference scan and the persisted context after a
   * full frame render, arming the append-only fast path (#133). Called from both
   * `fnRebuild` and the full incremental path so the fast path can resume after
   * either.
   */
  private captureFootnoteFastState(
    complete: string,
    parts: RenderedPart[],
    ctx: FootnoteContext,
  ): void {
    this.fnCtx = ctx
    this.fnPartLabels = parts.map((p) => footnoteRefLabelsIn(complete.slice(p.start, p.end)))
    this.fnBodyOrder = []
    this.fnBodyCount = new Map()
    const seen = new Set<string>()
    for (const labels of this.fnPartLabels) {
      for (const label of labels) {
        this.fnBodyCount.set(label, (this.fnBodyCount.get(label) ?? 0) + 1)
        if (!seen.has(label)) {
          seen.add(label)
          this.fnBodyOrder.push(label)
        }
      }
    }
    this.fnBodyEnd = parts.length > 0 ? (parts[parts.length - 1]?.end ?? 0) : 0
  }

  /**
   * Full render + morph + re-capture of the per-block / per-item node mapping.
   * Byte-identical to `renderMarkdownCore` (body parts joined with '\n', then the
   * section). On success `fnActive` is armed for incremental commits; if the
   * captured element count doesn't match the rendered parts (raw-HTML stripping
   * changed the node shape), it gives up to plain full-morph for this stream.
   */
  private fnRebuild(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    linkRefs: LinkReferenceMap,
    linkRefKey: string,
    footnoteDefs: FootnoteDefinitionMap,
  ): void {
    const { parts, items, ctx } = this.renderFootnoteFrame(complete, tokens, linkRefs, footnoteDefs)
    const body = parts.map((p) => p.html).join('\n')
    const section =
      items.length > 0 ? `<section class="footnotes"><ol>${items.join('')}</ol></section>` : ''
    const rawHtml = section === '' ? body : body === '' ? section : `${body}\n${section}`
    this.committedHasOpenDetails = hasOpenDetailsElement(rawHtml)
    const html = sanitizeRenderedMarkdown(rawHtml)
    this.renderedChars += html.length
    this.parsedChars += html.length
    morphInnerHtml(completedEl, html)

    // Generic frozen bookkeeping is now stale (fn mode owns the subtree); clear
    // it so a later return to the generic path rebuilds from scratch.
    this.frozenEnd = 0
    this.frozenSource = ''
    this.frozenHasHtml = false
    this.frozenNodeCount = 0
    this.frozenParts = []
    this.frozenPartsReliable = true
    this.resetListState()
    this.lastLinkRefKey = linkRefKey
    this.lastLinkRefs = linkRefs
    this.frozenLabelCandidates.clear()

    // Re-capture node handles: element children are the body parts in order,
    // then the section element (if any). Whitespace seams are text nodes and do
    // not appear in `.children`.
    const els = Array.from(completedEl.children) as HTMLElement[]
    const expected = parts.length + (section === '' ? 0 : 1)
    const sectionOl = section === '' ? null : (els[els.length - 1]?.querySelector('ol') ?? null)
    if (els.length !== expected || (section !== '' && !sectionOl)) {
      // Node shape doesn't match the parts (e.g. passthrough stripped a raw
      // block): incremental mapping is unsafe — stay correct via full-morph.
      this.resetFootnoteState()
      this.fnGaveUp = true
      return
    }
    this.fnBodyParts = parts.map((p, i) => ({ ...p, el: els[i] as HTMLElement }))
    this.fnSectionItems = items
    this.fnSectionOl = sectionOl
    this.fnActive = true
    this.fnGaveUp = false
    this.fnSource = complete
    this.fnLinkRefKey = linkRefKey
    this.captureFootnoteFastState(complete, parts, ctx)
  }

  /**
   * Incremental footnote commit. Tries the append-only fast path first (#133);
   * otherwise falls back to a full frame render + per-part diff-morph (the path
   * that handles renumbering, repeated references, and nested footnotes). Returns
   * false — signalling a rebuild — on any structural change neither path can
   * express: a different body-part count or boundary, a raw-HTML imbalance, a tag
   * change, or the section appearing/disappearing/shrinking.
   */
  private fnIncremental(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    linkRefs: LinkReferenceMap,
    footnoteDefs: FootnoteDefinitionMap,
  ): boolean {
    const fast = this.fnFastCommit(completedEl, complete, tokens, linkRefs, footnoteDefs)
    if (fast !== 'skip') return fast === 'done'

    const { parts, items, ctx } = this.renderFootnoteFrame(complete, tokens, linkRefs, footnoteDefs)

    // Structural guard: body must have the same parts at the same source spans
    // (footnote definitions render nothing, so committing one leaves the body
    // shape untouched — only reference numbering inside a part can change).
    if (parts.length !== this.fnBodyParts.length) return false
    for (let i = 0; i < parts.length; i++) {
      const cached = this.fnBodyParts[i]
      const part = parts[i]
      if (!cached || !part || cached.start !== part.start || cached.end !== part.end) return false
    }

    // Body: re-morph in place only the parts whose rendered HTML changed.
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const cached = this.fnBodyParts[i]
      if (!part || !cached || part.html === cached.html) continue
      if (part.html !== '' && hasUnfreezableRawHtml(part.html)) return false
      if (!this.morphPartElement(completedEl, cached.el, part.html)) return false
      cached.html = part.html
      this.renderedChars += part.html.length
    }

    if (!this.syncFootnoteSection(completedEl, items)) return false
    // Re-arm the fast path with the fresh context (body is unchanged, so the
    // scan metadata is identical; only the numbering context advanced).
    this.captureFootnoteFastState(complete, parts, ctx)
    return true
  }

  /**
   * The append-only fast path (#133): when definitions stream in over a fixed
   * body in first-use order, each with a single, non-nested reference, re-render
   * only the newly-resolved reference block(s) and append only the new section
   * item(s) — turning the per-commit O(n) full re-render into O(delta). Returns
   * `'skip'` (defer to the full path) on anything it can't safely express, or
   * `'rebuild'` when a morph guard fails mid-commit.
   */
  private fnFastCommit(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    linkRefs: LinkReferenceMap,
    footnoteDefs: FootnoteDefinitionMap,
  ): 'done' | 'skip' | 'rebuild' {
    const persisted = this.fnCtx
    if (!persisted) return 'skip'

    // (1) Body unchanged: everything committed past the body is a definition,
    // blank, or link-ref line (no new body block appeared).
    for (const token of tokens) {
      if (token.end <= this.fnBodyEnd) continue
      if (
        token.kind !== 'footnote_def' &&
        token.kind !== 'blank' &&
        token.kind !== 'link_ref_def'
      ) {
        return 'skip'
      }
    }

    // (2) Resolved labels in scan order must extend the real rendered order as a
    // prefix — append-only, and the raw scan agrees with the actual numbering.
    const resolvedNow = this.fnBodyOrder.filter((label) => footnoteDefs.has(label))
    const prev = persisted.order
    if (resolvedNow.length < prev.length) return 'skip'
    for (let i = 0; i < prev.length; i++) if (resolvedNow[i] !== prev[i]) return 'skip'
    const newLabels = resolvedNow.slice(prev.length)

    // (3) Single-use references only (repeated refs need cross-part id dedup this
    // path doesn't reproduce), and (4) no footnote content cites another footnote
    // (a section-first-use reference grows numbering outside the body order — its
    // label may not even appear in the body scan).
    for (const label of resolvedNow) if ((this.fnBodyCount.get(label) ?? 0) !== 1) return 'skip'
    for (const def of footnoteDefs.values()) if (def.content.includes('[^')) return 'skip'

    if (newLabels.length === 0) return 'done' // e.g. an unreferenced definition committed

    // Reseat onto the current definition map (so new labels resolve) while
    // carrying existing numbers/slugs forward, then render the dirty parts (those
    // citing a new label) in document order and append the new section items.
    const ctx = reseatFootnoteContext(footnoteDefs, persisted)
    const newSet = new Set(newLabels)
    let appendedItems: string[]
    const previous = getActiveFootnoteContext()
    setActiveFootnoteContext(ctx)
    try {
      for (let i = 0; i < this.fnPartLabels.length; i++) {
        const labels = this.fnPartLabels[i]
        const cached = this.fnBodyParts[i]
        if (!labels || !cached || !labels.some((label) => newSet.has(label))) continue
        const partTokens = tokens.filter((t) => t.start >= cached.start && t.end <= cached.end)
        const html = renderBlocksToParts(complete, partTokens, { linkRefs, ...RENDER_OPTS })
          .map((p) => p.html)
          .join('\n')
        if (html !== '' && hasUnfreezableRawHtml(html)) return 'rebuild'
        if (!this.morphPartElement(completedEl, cached.el, html)) return 'rebuild'
        cached.html = html
        this.renderedChars += html.length
      }
      appendedItems = renderFootnoteSectionItems(ctx, linkRefs, this.fnSectionItems.length)
    } finally {
      setActiveFootnoteContext(previous)
    }

    if (!this.syncFootnoteSection(completedEl, [...this.fnSectionItems, ...appendedItems])) {
      return 'rebuild'
    }
    this.fnCtx = ctx
    return 'done'
  }

  /**
   * Reconcile one body part's element in place against freshly rendered HTML,
   * preserving the element's identity (a footnote reference upgrade is an inline
   * change within the block). Returns false — signalling a rebuild — if the part
   * no longer sanitizes to a single element of the same tag.
   */
  private morphPartElement(completedEl: HTMLElement, el: HTMLElement, partHtml: string): boolean {
    const host = completedEl.cloneNode(false) as HTMLElement
    this.parsedChars += partHtml.length
    setPresanitizedHtml(host, sanitizeRenderedMarkdown(partHtml))
    const template = host.firstElementChild
    if (
      host.childNodes.length !== 1 ||
      !(template instanceof HTMLElement) ||
      template.tagName !== el.tagName
    ) {
      /* c8 ignore start -- unreachable defensive guard: the incremental path only
         re-morphs parts whose source span is unchanged, so a footnote-reference
         upgrade never changes the block's element count or tag here. */
      return false
    }
    /* c8 ignore stop */
    syncAttributes(el, template)
    morphElementChildrenFrom(el, template, 0)
    return true
  }

  /**
   * Reconcile the footnotes section incrementally: morph the `<ol>` children
   * from the first changed item onward, freezing the identical leading items
   * (the common append-only case parses just the one new/last item). Returns
   * false — signalling a rebuild — when the section must appear, disappear, or
   * its item shape can't be mapped.
   */
  private syncFootnoteSection(completedEl: HTMLElement, items: string[]): boolean {
    const prev = this.fnSectionItems
    if (items.length === 0) return this.fnSectionOl === null
    // The section first appears (or a dropped section must reappear) via rebuild.
    if (!this.fnSectionOl) return false

    let firstChanged = 0
    const min = Math.min(prev.length, items.length)
    while (firstChanged < min && prev[firstChanged] === items[firstChanged]) firstChanged++
    if (firstChanged === prev.length && prev.length === items.length) return true

    const host = completedEl.cloneNode(false) as HTMLElement
    this.parsedChars += items.slice(firstChanged).join('').length
    setSanitizedHtml(host, `<ol>${items.slice(firstChanged).join('')}</ol>`)
    const templateOl = host.firstElementChild
    if (!(templateOl instanceof HTMLElement) || templateOl.tagName !== 'OL') return false
    morphElementChildrenFrom(this.fnSectionOl, templateOl, firstChanged)
    this.fnSectionItems = items
    this.renderedChars += items.slice(firstChanged).join('').length
    return true
  }

  private fullMorph(
    completedEl: HTMLElement,
    complete: string,
    tokens: BlockToken[],
    linkRefKey: string,
    linkRefs: LinkReferenceMap,
  ): void {
    const rawHtml = renderMarkdownUnsafe(complete, { tokens })
    // A still-forming `<details>` reaches here every commit (its unbalanced tag
    // trips the freeze guard); flag it off the unsanitized render, before the
    // sink balances the tree.
    this.committedHasOpenDetails = hasOpenDetailsElement(rawHtml)
    const html = sanitizeRenderedMarkdown(rawHtml)
    this.renderedChars += html.length
    this.parsedChars += html.length
    this.tailMemo = null
    this.frozenParts = []
    this.frozenPartsReliable = true
    morphInnerHtml(completedEl, html)
    this.frozenEnd = 0
    this.frozenSource = ''
    this.frozenHasHtml = false
    this.frozenNodeCount = 0
    this.lastLinkRefKey = linkRefKey
    this.lastLinkRefs = new Map(linkRefs)
    this.frozenLabelCandidates.clear()
    this.resetListState()
    this.resetFootnoteState()
    this.resetFrames()
  }
}
