import {
  setDiagramRenderer
} from "./streaming-markdown.chunk-TXP7OKL4.mjs";
import "./streaming-markdown.chunk-H5LJGXOH.mjs";

// dist/mermaid-mermaidjs.js
var __rewriteRelativeImportExtension = function(path, preserveJsx) {
  if (typeof path === "string" && /^\.\.?\//.test(path)) {
    return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
      return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
    });
  }
  return path;
};
var mermaidLib = null;
var diagramSeq = 0;
var MERMAID_SPECIFIER = "mermaid";
var importMermaid = () => import(__rewriteRelativeImportExtension(MERMAID_SPECIFIER));
function __setMermaidImporterForTests(fn) {
  importMermaid = fn ?? (() => import(__rewriteRelativeImportExtension(MERMAID_SPECIFIER)));
  mermaidLib = null;
}
async function loadMermaidLib() {
  if (mermaidLib)
    return mermaidLib;
  const mod = await importMermaid();
  const lib = mod.default ?? mod;
  lib.initialize({ startOnLoad: false });
  mermaidLib = lib;
  return lib;
}
var mermaidDiagramRenderer = {
  async render(source) {
    const lib = await loadMermaidLib();
    diagramSeq += 1;
    const { svg } = await lib.render(`smd-mermaid-${String(diagramSeq)}`, source);
    return { svg };
  }
};
function installMermaid() {
  setDiagramRenderer(mermaidDiagramRenderer);
  return mermaidDiagramRenderer;
}
function loadMermaid() {
  return Promise.resolve(installMermaid());
}
export {
  __setMermaidImporterForTests,
  installMermaid,
  loadMermaid,
  mermaidDiagramRenderer
};
