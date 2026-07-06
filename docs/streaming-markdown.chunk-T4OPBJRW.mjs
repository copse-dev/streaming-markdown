// dist/escape.js
var HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
var SAFE_OUTER_TAG_RE = /^(?:<a(?:\s+href="[^"]*")(?:\s+(?:title|target|rel|data-browser-link|data-workspace-link|class)="[^"]*")*\s*>|<\/(?:a|code|em|strong)>|<(?:code|em|strong)\b[^>]*>|<img\b[^>]*\bdata-md-rendered="1"[^>]*\/?>)$/i;
var BENIGN_RAW_INLINE_TAG_RE = /^<\/?(?:b|i|u|s|del|ins|sub|sup|kbd|mark|br)\s*\/?>$/i;
function escapeHtmlOutsideSafeTags(html) {
  return html.split(/(<[^>]+>)/g).map((part) => part.startsWith("<") && (SAFE_OUTER_TAG_RE.test(part) || BENIGN_RAW_INLINE_TAG_RE.test(part)) ? part : escapeHtml(part)).join("");
}
function escapeHtmlTextNodes(html) {
  return html.split(/(<code>[\s\S]*?<\/code>)/g).map((segment, index) => {
    if (index % 2 === 1) {
      const match = segment.match(/^(<code>)([\s\S]*?)(<\/code>)$/);
      if (!match)
        return segment;
      return `${match[1] ?? ""}${escapeHtml(match[2] ?? "")}${match[3] ?? ""}`;
    }
    return escapeHtmlOutsideSafeTags(segment);
  }).join("");
}
function escapeMermaidHtml(text) {
  return text.replace(/[&<"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
function decodeEscapedHref(raw) {
  return raw.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
var SAFE_MARKDOWN_ENTITY_RE = /&(?:amp;)?(?:nbsp|#160|#x0*a);/gi;
var KNOWN_SAFE_ENTITIES = [
  "&nbsp;",
  "&#160;",
  "&#xa0;",
  "&amp;nbsp;",
  "&amp;#160;",
  "&amp;#xa0;"
];
function stripIncompleteSafeEntities(text) {
  const amp = text.lastIndexOf("&");
  if (amp === -1)
    return text;
  const suffix = text.slice(amp);
  if (/^&(?:amp;)?(?:nbsp|#160|#x0*a);$/i.test(suffix))
    return text;
  const lower = suffix.toLowerCase();
  if (KNOWN_SAFE_ENTITIES.some((entity) => entity.startsWith(lower) && lower.length < entity.length)) {
    return text.slice(0, amp);
  }
  return text;
}
function decodeSafeMarkdownEntities(text) {
  const stripped = stripIncompleteSafeEntities(text);
  return stripped.replace(SAFE_MARKDOWN_ENTITY_RE, (entity) => {
    const lower = entity.toLowerCase();
    if (lower === "&nbsp;" || lower === "&#160;" || lower === "&#xa0;" || lower === "&amp;nbsp;" || lower === "&amp;#160;" || lower === "&amp;#xa0;") {
      return "\xA0";
    }
    return entity;
  });
}

// dist/highlight.js
var KNOWN_LANGUAGES = /* @__PURE__ */ new Set([
  "typescript",
  "javascript",
  "bash",
  "shell",
  "json",
  "python",
  "css",
  "xml",
  "markdown",
  "yaml",
  "rust",
  "go",
  "sql"
]);
var LANG_ALIASES = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  sh: "bash",
  zsh: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
  html: "xml",
  htm: "xml",
  rs: "rust",
  text: "plaintext",
  plaintext: "plaintext"
};
function resolveLanguage(lang) {
  const key = lang.trim().toLowerCase();
  if (!key)
    return null;
  const resolved = LANG_ALIASES[key] ?? key;
  if (resolved === "plaintext")
    return null;
  return KNOWN_LANGUAGES.has(resolved) ? resolved : null;
}
var codeHighlighter = null;
function setCodeHighlighter(highlighter) {
  codeHighlighter = highlighter;
}
function highlightFenceCode(code, lang) {
  if (code === "")
    return "";
  if (code.trim() === "")
    return escapeHtml(code);
  const highlighter = codeHighlighter;
  const language = resolveLanguage(lang);
  if (!highlighter)
    return escapeHtml(code);
  if (language)
    return highlighter.highlight(code, language);
  if (!lang.trim())
    return highlighter.highlightAuto(code);
  return escapeHtml(code);
}
function fenceCodeClass(lang) {
  const language = resolveLanguage(lang);
  const label = language ?? (lang.trim() ? lang.trim().toLowerCase() : "text");
  return `hljs lang-${escapeHtml(label)}`;
}

export {
  escapeHtml,
  escapeHtmlTextNodes,
  escapeMermaidHtml,
  decodeEscapedHref,
  decodeSafeMarkdownEntities,
  setCodeHighlighter,
  highlightFenceCode,
  fenceCodeClass
};
