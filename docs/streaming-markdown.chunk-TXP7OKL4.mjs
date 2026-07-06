// dist/mermaid-source.js
function decodeMermaidHtmlEntities(text) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
function normalizeMermaidTypography(source) {
  return source.replace(/\u201c|\u201d/g, '"').replace(/\u2018|\u2019/g, "'").replace(/\r\n/g, "\n");
}
function labelNeedsQuotes(label) {
  if (/[()]/.test(label))
    return true;
  if (/[+/:,&#|]/.test(label))
    return true;
  if (/[^\w \t.-]/.test(label))
    return true;
  return false;
}
function stabilizeMermaidSource(source) {
  return source.replace(/^(\s*(?:subgraph\s+)?[\w-]+)\[([^\]"(][^\]]*)\]/gm, (match, prefix, label) => {
    if (label.startsWith("("))
      return match;
    if (!labelNeedsQuotes(label))
      return match;
    const safe = label.replace(/"/g, "'");
    return `${prefix}["${safe}"]`;
  });
}
function stabilizeMermaidSourceAggressive(source) {
  return source.replace(/^(\s*(?:subgraph\s+)?[\w-]+)\[([^\]"(][^\]]*)\]/gm, (match, prefix, label) => {
    if (label.startsWith("("))
      return match;
    const safe = label.replace(/"/g, "'");
    return `${prefix}["${safe}"]`;
  });
}
function mermaidSourceCandidates(raw) {
  const normalized = normalizeMermaidTypography(decodeMermaidHtmlEntities(raw).trimEnd());
  const gentle = stabilizeMermaidSource(normalized);
  const aggressive = stabilizeMermaidSourceAggressive(stabilizeMermaidSource(normalized));
  return [...new Set([gentle, aggressive].filter(Boolean))];
}

// dist/mermaid.js
var PENDING_DIAGRAM_SELECTOR = ".mermaid-diagram.mermaid-diagram--pending";
var diagramRenderer = null;
function setDiagramRenderer(renderer) {
  diagramRenderer = renderer;
}
function readDiagramSource(container) {
  return container.querySelector("pre.mermaid")?.textContent ?? "";
}
function markRendered(container, svg) {
  container.classList.remove("mermaid-diagram--pending");
  container.classList.add("mermaid-diagram--rendered");
  container.innerHTML = svg;
}
function markError(container) {
  container.classList.remove("mermaid-diagram--pending");
  container.classList.add("mermaid-diagram--error");
}
async function hydratePendingDiagrams(root, options = {}) {
  const renderer = diagramRenderer;
  if (!renderer)
    return 0;
  const containers = [];
  if (root.matches(PENDING_DIAGRAM_SELECTOR))
    containers.push(root);
  containers.push(...root.querySelectorAll(PENDING_DIAGRAM_SELECTOR));
  let rendered = 0;
  for (const container of containers) {
    const rawSource = readDiagramSource(container);
    if (rawSource.trim() === "")
      continue;
    let ok = false;
    for (const candidate of mermaidSourceCandidates(rawSource)) {
      try {
        const { svg } = await renderer.render(candidate);
        markRendered(container, options.transformSvg ? options.transformSvg(svg) : svg);
        ok = true;
        rendered++;
        break;
      } catch {
      }
    }
    if (!ok)
      markError(container);
  }
  return rendered;
}

export {
  setDiagramRenderer,
  hydratePendingDiagrams
};
