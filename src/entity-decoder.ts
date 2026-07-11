/**
 * HTML character-reference decoding (#594), as a pluggable backend.
 *
 * CommonMark decodes the full HTML5 named + numeric character-reference set, but
 * the full named table is ~2,100 entries — as a bundled trie it is ~23 KB gzip,
 * roughly half the core's transfer size, and models overwhelmingly emit only the
 * Latin-1 / typographic / math tail of it. So the default decoder here carries
 * the **252 classic HTML4 named references** (Latin-1 letters, punctuation,
 * currency, fractions, Greek, common math/arrows) plus *all* numeric references
 * (which need no table — they are algorithmic). That covers essentially every
 * entity real markdown contains at ~1 KB instead of ~23 KB.
 *
 * Hosts that need the full HTML5 set register a decoder with {@link setEntityDecoder}:
 *   - `@copse/streaming-markdown/entities/full` — one call, backed by `entities`
 *     (adds the full table to the bundle; opt in when you want it).
 *   - {@link browserEntityDecoder} — borrows the browser's own parser table via a
 *     detached `<textarea>`, so full coverage costs zero bundle bytes in the DOM.
 * Hosts that just need a few extra names extend the built-in map with
 * {@link addNamedEntities} — no full decoder required.
 *
 * The named map values are the HTML5 code points (so `&lang;`/`&rang;` decode to
 * the mathematical angle brackets the full table produces, not their HTML4
 * predecessors); any name present in the built-in map therefore decodes
 * byte-identically to the full decoder.
 *
 * This module is a dependency-free leaf so the inline pipeline, the block
 * tokenizer, and the link/fence helpers can all share one decoder without import
 * cycles or pulling `entities` into the default bundle.
 */

/** Decodes HTML character references in `text` (strict: a trailing `;` is required). */
export type EntityDecoder = (text: string) => string

/**
 * The 252 classic HTML4 named references, mapped to their HTML5 code points.
 * This is the default decoder's named set — a spec-defined boundary that covers
 * Latin-1, Greek, and the common typographic/math/currency symbols.
 *
 * @experimental Internal data table, exported from the main entry but not part of
 * the stable v1 surface (#147). Its shape/contents may change; extend the decoder
 * with `addNamedEntities` / `setNamedEntities` rather than reading this directly.
 */
export const BUILTIN_NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  aacute: "á",
  Aacute: "Á",
  acirc: "â",
  Acirc: "Â",
  acute: "´",
  aelig: "æ",
  AElig: "Æ",
  agrave: "à",
  Agrave: "À",
  alefsym: "ℵ",
  alpha: "α",
  Alpha: "Α",
  amp: "&",
  and: "∧",
  ang: "∠",
  aring: "å",
  Aring: "Å",
  asymp: "≈",
  atilde: "ã",
  Atilde: "Ã",
  auml: "ä",
  Auml: "Ä",
  bdquo: "„",
  beta: "β",
  Beta: "Β",
  brvbar: "¦",
  bull: "•",
  cap: "∩",
  ccedil: "ç",
  Ccedil: "Ç",
  cedil: "¸",
  cent: "¢",
  chi: "χ",
  Chi: "Χ",
  circ: "ˆ",
  clubs: "♣",
  cong: "≅",
  copy: "©",
  crarr: "↵",
  cup: "∪",
  curren: "¤",
  dagger: "†",
  Dagger: "‡",
  darr: "↓",
  dArr: "⇓",
  deg: "°",
  delta: "δ",
  Delta: "Δ",
  diams: "♦",
  divide: "÷",
  eacute: "é",
  Eacute: "É",
  ecirc: "ê",
  Ecirc: "Ê",
  egrave: "è",
  Egrave: "È",
  empty: "∅",
  emsp: " ",
  ensp: " ",
  epsilon: "ε",
  Epsilon: "Ε",
  equiv: "≡",
  eta: "η",
  Eta: "Η",
  eth: "ð",
  ETH: "Ð",
  euml: "ë",
  Euml: "Ë",
  euro: "€",
  exist: "∃",
  fnof: "ƒ",
  forall: "∀",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  frasl: "⁄",
  gamma: "γ",
  Gamma: "Γ",
  ge: "≥",
  gt: ">",
  harr: "↔",
  hArr: "⇔",
  hearts: "♥",
  hellip: "…",
  iacute: "í",
  Iacute: "Í",
  icirc: "î",
  Icirc: "Î",
  iexcl: "¡",
  igrave: "ì",
  Igrave: "Ì",
  image: "ℑ",
  infin: "∞",
  int: "∫",
  iota: "ι",
  Iota: "Ι",
  iquest: "¿",
  isin: "∈",
  iuml: "ï",
  Iuml: "Ï",
  kappa: "κ",
  Kappa: "Κ",
  lambda: "λ",
  Lambda: "Λ",
  lang: "⟨",
  laquo: "«",
  larr: "←",
  lArr: "⇐",
  lceil: "⌈",
  ldquo: "“",
  le: "≤",
  lfloor: "⌊",
  lowast: "∗",
  loz: "◊",
  lrm: "‎",
  lsaquo: "‹",
  lsquo: "‘",
  lt: "<",
  macr: "¯",
  mdash: "—",
  micro: "µ",
  middot: "·",
  minus: "−",
  mu: "μ",
  Mu: "Μ",
  nabla: "∇",
  nbsp: " ",
  ndash: "–",
  ne: "≠",
  ni: "∋",
  not: "¬",
  notin: "∉",
  nsub: "⊄",
  ntilde: "ñ",
  Ntilde: "Ñ",
  nu: "ν",
  Nu: "Ν",
  oacute: "ó",
  Oacute: "Ó",
  ocirc: "ô",
  Ocirc: "Ô",
  oelig: "œ",
  OElig: "Œ",
  ograve: "ò",
  Ograve: "Ò",
  oline: "‾",
  omega: "ω",
  Omega: "Ω",
  omicron: "ο",
  Omicron: "Ο",
  oplus: "⊕",
  or: "∨",
  ordf: "ª",
  ordm: "º",
  oslash: "ø",
  Oslash: "Ø",
  otilde: "õ",
  Otilde: "Õ",
  otimes: "⊗",
  ouml: "ö",
  Ouml: "Ö",
  para: "¶",
  part: "∂",
  permil: "‰",
  perp: "⊥",
  phi: "φ",
  Phi: "Φ",
  pi: "π",
  Pi: "Π",
  piv: "ϖ",
  plusmn: "±",
  pound: "£",
  prime: "′",
  Prime: "″",
  prod: "∏",
  prop: "∝",
  psi: "ψ",
  Psi: "Ψ",
  quot: "\"",
  radic: "√",
  rang: "⟩",
  raquo: "»",
  rarr: "→",
  rArr: "⇒",
  rceil: "⌉",
  rdquo: "”",
  real: "ℜ",
  reg: "®",
  rfloor: "⌋",
  rho: "ρ",
  Rho: "Ρ",
  rlm: "‏",
  rsaquo: "›",
  rsquo: "’",
  sbquo: "‚",
  scaron: "š",
  Scaron: "Š",
  sdot: "⋅",
  sect: "§",
  shy: "­",
  sigma: "σ",
  Sigma: "Σ",
  sigmaf: "ς",
  sim: "∼",
  spades: "♠",
  sub: "⊂",
  sube: "⊆",
  sum: "∑",
  sup: "⊃",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  supe: "⊇",
  szlig: "ß",
  tau: "τ",
  Tau: "Τ",
  there4: "∴",
  theta: "θ",
  Theta: "Θ",
  thetasym: "ϑ",
  thinsp: " ",
  thorn: "þ",
  THORN: "Þ",
  tilde: "˜",
  times: "×",
  trade: "™",
  uacute: "ú",
  Uacute: "Ú",
  uarr: "↑",
  uArr: "⇑",
  ucirc: "û",
  Ucirc: "Û",
  ugrave: "ù",
  Ugrave: "Ù",
  uml: "¨",
  upsih: "ϒ",
  upsilon: "υ",
  Upsilon: "Υ",
  uuml: "ü",
  Uuml: "Ü",
  weierp: "℘",
  xi: "ξ",
  Xi: "Ξ",
  yacute: "ý",
  Yacute: "Ý",
  yen: "¥",
  yuml: "ÿ",
  Yuml: "Ÿ",
  zeta: "ζ",
  Zeta: "Ζ",
  zwj: "‍",
  zwnj: "‌",
})

/**
 * HTML5 numeric-reference code-point sanitization: NUL and the C1 range remap to
 * their Windows-1252 replacements, surrogates and out-of-range values become
 * U+FFFD. Mirrors the algorithm in `entities`/`he` so numeric refs decode
 * identically to the full decoder (CommonMark spec #4, #25, #26).
 */
const C1_REMAP = new Map<number, number>([
  [0x00, 0xfffd],
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
])

function replaceCodePoint(codePoint: number): number {
  if ((codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) return 0xfffd
  return C1_REMAP.get(codePoint) ?? codePoint
}

/** A complete numeric or named reference (semicolon required, mirrors the parser's candidate grammar). */
const ENTITY_TOKEN_RE = /&(?:#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{0,31};)/g

/** Decode a numeric reference token (`&#123;` / `&#xAb;`) already known to match the grammar. */
function decodeNumeric(token: string): string {
  const isHex = token[2] === 'x' || token[2] === 'X'
  const digits = token.slice(isHex ? 3 : 2, -1)
  const codePoint = parseInt(digits, isHex ? 16 : 10)
  return String.fromCodePoint(replaceCodePoint(codePoint))
}

/**
 * Strict reference decoder parameterized by a named-reference resolver. Only
 * complete `&…;` tokens reach the resolver, so a named resolver never sees a
 * semicolon-less legacy reference — the shared guarantee that lets both the
 * built-in map and the lenient browser parser decode strictly (CommonMark).
 */
function decodeStrictWith(text: string, resolveNamed: (name: string) => string | undefined): string {
  if (text.indexOf('&') === -1) return text
  return text.replace(ENTITY_TOKEN_RE, (token) => {
    if (token[1] === '#') return decodeNumeric(token)
    return resolveNamed(token.slice(1, -1)) ?? token
  })
}

let userNamed: Record<string, string> = {}
let effectiveNamed: Record<string, string> = { ...BUILTIN_NAMED_ENTITIES }
let customDecoder: EntityDecoder | null = null

function rebuildEffective(): void {
  effectiveNamed = { ...BUILTIN_NAMED_ENTITIES, ...userNamed }
}

function builtinDecode(text: string): string {
  return decodeStrictWith(text, (name) => effectiveNamed[name])
}

/**
 * Decode HTML character references in `text`, strictly (a trailing `;` is
 * required, per CommonMark). Routes through a decoder registered with
 * {@link setEntityDecoder}, else uses the built-in numeric + HTML4-named decoder.
 * This is the entry point the parser's link, fence, and escape passes call.
 */
export function decodeHtmlEntities(text: string): string {
  return (customDecoder ?? builtinDecode)(text)
}

/**
 * Replace the reference decoder wholesale — e.g. the full `entities` table or
 * {@link browserEntityDecoder}. Pass `null` to restore the built-in decoder.
 * A custom decoder is responsible for its own strictness; the built-in one and
 * {@link browserEntityDecoder} both require the trailing `;`.
 */
export function setEntityDecoder(decoder: EntityDecoder | null): void {
  customDecoder = decoder
}

/** The decoder registered with {@link setEntityDecoder}, or `null` when using the built-in. */
export function getEntityDecoder(): EntityDecoder | null {
  return customDecoder
}

/**
 * Replace the user-defined named references layered over the built-in HTML4 set.
 * Keys are bare names (no `&`/`;`); values are the literal replacement strings.
 * User entries win over built-ins on collision. Only affects the built-in
 * decoder — a custom {@link setEntityDecoder} decoder owns its own set.
 */
export function setNamedEntities(named: Record<string, string>): void {
  userNamed = { ...named }
  rebuildEffective()
}

/** Merge additional named references into the user layer (see {@link setNamedEntities}). */
export function addNamedEntities(named: Record<string, string>): void {
  userNamed = { ...userNamed, ...named }
  rebuildEffective()
}

/** The effective named set the built-in decoder uses (built-in ⊕ user entries). */
export function getNamedEntities(): Readonly<Record<string, string>> {
  return { ...effectiveNamed }
}

/**
 * Restore the default decoder and clear user-added names (test/host reset).
 *
 * @experimental Test/reset helper, exported from the main entry but not part of
 * the stable v1 surface (#147). May move behind a test-utilities subpath or be
 * removed in a minor release.
 */
export function resetEntityDecoder(): void {
  userNamed = {}
  customDecoder = null
  rebuildEffective()
}

let sharedTextarea: { innerHTML: string; value: string } | null = null

/** Decode `&name;` via the browser's own parser table, or `undefined` if unknown. */
function decodeNamedViaDom(name: string): string | undefined {
  const doc = (globalThis as { document?: Document }).document
  if (!doc) {
    throw new Error(
      'browserEntityDecoder requires a DOM document; use the `entities/full` decoder outside the browser.',
    )
  }
  const ta = (sharedTextarea ??= doc.createElement('textarea'))
  const token = `&${name};`
  // Detached <textarea>, decode-only: `token` is a strict `&name;` reference
  // (regex-bounded letters/digits) that cannot contain markup, and `.value` below
  // is read as text, never re-injected as HTML.
  ta.innerHTML = token // html-sink-exempt: detached textarea, decode-only (see above)
  const decoded = ta.value
  // The browser also decodes semicolon-less *legacy* prefixes (`&notaname;` →
  // `¬aname;`), so an unchanged result is not the only failure mode. A genuine
  // complete named reference is consumed whole and never leaves the trailing
  // `;`; a partial legacy decode always does. Reject anything still bearing it.
  return decoded.endsWith(';') ? undefined : decoded
}

/**
 * A full-HTML5 decoder that borrows the browser's built-in character-reference
 * table through a detached `<textarea>` — full named coverage at zero bundle
 * cost, for DOM hosts. Register it with `setEntityDecoder(browserEntityDecoder)`.
 * It stays strict because only complete `&name;` tokens are handed to the parser,
 * so the browser's semicolon-less legacy decoding never triggers. Throws if
 * called without a `document`.
 */
export function browserEntityDecoder(text: string): string {
  return decodeStrictWith(text, decodeNamedViaDom)
}
