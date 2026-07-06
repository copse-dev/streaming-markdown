import {
  RAW_TAG_LIKE_RE,
  decodeEscapedHref,
  decodeEscapedPunctuation,
  decodeEscapedPunctuationRaw,
  decodeEscapes,
  decodeHTMLStrict,
  decodeHtmlCharRefs,
  decodeSafeMarkdownEntities,
  encodeBackslashEscapes,
  encodeHrefForOutput,
  escapeHtml,
  escapeHtmlTextNodes,
  escapeMermaidHtml,
  fenceCodeClass,
  highlightFenceCode,
  isValidReferenceLabel,
  lookupLinkReference,
  normalizeReferenceLabel,
  parseInlineLinkDestination,
  parseLinkReferenceDefinitionAt,
  parseLinkReferenceDefinitions,
  parseReferenceLabel,
  percentEncodeHref,
  renderInlineCode,
  scanCodeSpans,
  trailingEntityHoldStart
} from "./streaming-markdown.chunk-6GE7FBY2.mjs";
import {
  hydratePendingDiagrams
} from "./streaming-markdown.chunk-TXP7OKL4.mjs";
import "./streaming-markdown.chunk-H5LJGXOH.mjs";

// dist/block-patterns.js
function leadingIndentWidth(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === " ")
      col++;
    else if (ch === "	")
      col += 4 - col % 4;
    else
      break;
  }
  return col;
}
function stripFourColumnIndent(line) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < 4) {
    const ch = line[i];
    if (ch === " ") {
      col++;
      i++;
      continue;
    }
    if (ch === "	") {
      const advance = 4 - col % 4;
      if (col + advance > 4)
        return " ".repeat(col + advance - 4) + line.slice(i + 1);
      col += advance;
      i++;
      continue;
    }
    break;
  }
  return line.slice(i);
}
var FENCE_OPEN_RE = /^ {0,3}(?:(`{3,})([^\n`]*)|(~{3,})([^\n]*?))\s*$/;
var FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;
var ATX_HEADING_DETECT_RE = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
var ATX_HEADING_CAPTURE_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/;
var BLOCKQUOTE_DETECT_RE = /^ {0,3}> ?/;
function expandWhitespaceRun(text2, i, col) {
  let out = "";
  while (i < text2.length) {
    const ch = text2[i];
    if (ch === " ") {
      out += " ";
      col++;
      i++;
    } else if (ch === "	") {
      const advance = 4 - col % 4;
      out += " ".repeat(advance);
      col += advance;
      i++;
    } else
      break;
  }
  return { out, i, col };
}
function expandLeadingTabs(line) {
  const lead = expandWhitespaceRun(line, 0, 0);
  return lead.out + line.slice(lead.i);
}
function expandListPrefixTabs(line) {
  const lead = expandWhitespaceRun(line, 0, 0);
  const marker = /^(?:\d{1,9}[.)]|[-*+])/.exec(line.slice(lead.i))?.[0];
  if (!marker)
    return lead.out + line.slice(lead.i);
  const after = expandWhitespaceRun(line, lead.i + marker.length, lead.col + marker.length);
  return lead.out + marker + after.out + line.slice(after.i);
}
function stripBlockquoteMarker(line) {
  const m = /^ {0,3}>/.exec(line);
  if (!m)
    return line;
  const rest = line.slice(m[0].length);
  if (!/^[\t ]/.test(rest))
    return rest;
  const expanded = expandWhitespaceRun(rest, 0, m[0].length);
  return expanded.out.slice(1) + rest.slice(expanded.i);
}
function dropTrailingNewline(slice) {
  return slice.endsWith("\n") ? slice.slice(0, -1) : slice;
}
function stripAtxClosingHashes(title) {
  if (/^#+\s*$/.test(title))
    return "";
  return title.replace(/(?<!\\)\s+#+\s*$/, "").trimEnd();
}
function fenceMarker(line) {
  const m = line.match(FENCE_OPEN_RE);
  const marker = m?.[1] ?? m?.[3];
  if (!marker)
    return null;
  return { marker, len: marker.length, info: ((m?.[1] ? m[2] : m?.[4]) ?? "").trim() };
}
function fenceOpenIndent(open) {
  return open.match(/^ {0,3}/)?.[0].length ?? 0;
}
function stripLeadingSpaces(line, max) {
  let i = 0;
  while (i < max && line[i] === " ")
    i++;
  return line.slice(i);
}
var FENCE_INFO_BACKSLASH_RE = /\\([!-/:-@[-`{-~])/g;
function fenceInfoLanguage(info) {
  const firstWord = info.trim().split(/\s+/)[0] ?? "";
  if (!firstWord)
    return "";
  return decodeHTMLStrict(firstWord.replace(FENCE_INFO_BACKSLASH_RE, "$1"));
}
function fenceCloses(marker, len, line) {
  const m = line.match(FENCE_CLOSE_RE);
  if (!m?.[1] || m[1][0] !== marker[0])
    return false;
  return m[1].length >= len;
}
function parseFenceSlice(slice) {
  const lines = dropTrailingNewline(slice).split("\n");
  const open = lines[0] ?? "";
  const openFence = fenceMarker(open);
  const marker = openFence?.marker ?? "```";
  const lang = fenceInfoLanguage(openFence?.info ?? "");
  const indent = fenceOpenIndent(open);
  let closeIndex = lines.length - 1;
  while (closeIndex > 0) {
    const line = lines[closeIndex] ?? "";
    if (fenceCloses(marker, marker.length, line)) {
      break;
    }
    closeIndex--;
  }
  const contentEnd = closeIndex > 0 ? closeIndex : lines.length;
  const contentLines = lines.slice(1, contentEnd);
  const code = contentLines.map((line) => stripLeadingSpaces(line, indent)).join("\n");
  return { lang, code: contentLines.length > 0 ? `${code}
` : code };
}
function parseOpenFenceContent(source) {
  const lines = source.split("\n");
  const open = lines[0] ?? "";
  const openFence = fenceMarker(open);
  if (!openFence)
    return null;
  const lang = fenceInfoLanguage(openFence.info);
  const indent = fenceOpenIndent(open);
  let bodyLines = lines.slice(1);
  const last = bodyLines.at(-1) ?? "";
  if (bodyLines.length > 0 && fenceCloses(openFence.marker, openFence.len, last)) {
    bodyLines = bodyLines.slice(0, -1);
  }
  return { lang, code: bodyLines.map((line) => stripLeadingSpaces(line, indent)).join("\n") };
}

// dist/block-tokenizer.js
var THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
var UNORDERED_LIST_ITEM_RE = /^ {0,3}[-*+](?:[ \t]|$)/;
var ORDERED_LIST_MARKER_RE = /^ {0,3}(\d{1,9})([.)])(?:[ \t]|$)/;
var LIST_ITEM_RE = /^ {0,3}(?:(?:[-*+])(?:[ \t]|$)|(?:\d{1,9}[.)](?:[ \t]|$)))/;
var EMPTY_LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
var BLOCKQUOTE_RE = /^ {0,3}> ?/;
var SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
var TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
function parseOrderedListMarker(line) {
  const m = line.match(ORDERED_LIST_MARKER_RE);
  if (!m?.[1])
    return null;
  return parseInt(m[1], 10);
}
function orderedListMarkerDelimiter(line) {
  const m = line.match(ORDERED_LIST_MARKER_RE);
  const d = m?.[2];
  if (d === "." || d === ")")
    return d;
  return null;
}
function isUnorderedListItemLine(line) {
  return UNORDERED_LIST_ITEM_RE.test(line);
}
function isListItemLine(line) {
  return isUnorderedListItemLine(line) || parseOrderedListMarker(line) !== null;
}
function unorderedListMarkerChar(line) {
  const m = line.match(/^ {0,3}([-*+])(?:\s|$)/);
  const ch = m?.[1];
  if (ch === "-" || ch === "*" || ch === "+")
    return ch;
  return null;
}
function isEmptyListItemLine(line) {
  const m = line.match(EMPTY_LIST_ITEM_RE);
  if (!m)
    return false;
  return line.slice(m[0].length).trim() === "";
}
function listItemContentColumn(line) {
  const m = expandListPrefixTabs(line).match(/^( {0,3})(\d{1,9}[.)]|[-*+])( *)(.*)$/);
  if (!m)
    return Infinity;
  const indent = m[1]?.length ?? 0;
  const markerWidth = m[2]?.length ?? 0;
  const spaces = m[3]?.length ?? 0;
  const hasContent = (m[4]?.length ?? 0) > 0;
  const n = hasContent && spaces >= 1 && spaces <= 4 ? spaces : 1;
  return indent + markerWidth + n;
}
function lazyContinuationIndent(line) {
  return leadingIndentWidth(line);
}
function orderedMarkerContinuesParagraph(prevLine, line) {
  const num = parseOrderedListMarker(line);
  if (num === null)
    return false;
  if (num === 1)
    return false;
  return prevLine.trimEnd().length > 0;
}
function isLazyUnorderedContinuation(itemStartLine, line) {
  if (isListItemLine(line))
    return false;
  return lazyContinuationIndent(line) >= listItemContentColumn(itemStartLine);
}
function isLazyListContinuation(itemStartLine, line) {
  return isLazyUnorderedContinuation(itemStartLine, line);
}
function lineContainsPipeCellDelimiter(line) {
  return line.includes("|") && line.trim() !== "";
}
function isProseMetadataPipeLine(line) {
  if (!lineContainsPipeCellDelimiter(line))
    return false;
  const trimmed = line.trimStart();
  if (/\*\*[^*\n]+:\*\*/.test(trimmed))
    return true;
  if (/&nbsp;/i.test(trimmed))
    return true;
  return false;
}
function isGfmTableRowLine(line) {
  if (!lineContainsPipeCellDelimiter(line))
    return false;
  if (isProseMetadataPipeLine(line))
    return false;
  const trimmed = line.trimStart();
  if (trimmed.startsWith("|"))
    return true;
  return splitTableRow(trimmed).length >= 2;
}
function isTableRow(line) {
  return isGfmTableRowLine(line);
}
function isPartialTableSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("-"))
    return false;
  return /^\|?\s*:?-{1,}/.test(trimmed);
}
function isPotentialTableStart(lines, i) {
  const line = lines[i];
  if (!line || !isTableRow(line.text))
    return false;
  const next = lines[i + 1];
  if (next && TABLE_SEP_RE.test(next.text))
    return true;
  if (next && isPartialTableSeparatorLine(next.text))
    return true;
  if (next && isTableRow(next.text))
    return true;
  return line.text.trimStart().startsWith("|");
}
function scanLines(source) {
  const lines = [];
  let i = 0;
  while (i <= source.length) {
    const start = i;
    const end = source.indexOf("\n", i);
    if (end === -1) {
      if (start < source.length) {
        lines.push({ text: source.slice(start), start, end: source.length, terminated: false });
      }
      break;
    }
    lines.push({ text: source.slice(start, end), start, end: end + 1, terminated: true });
    i = end + 1;
  }
  return lines;
}
function pushBlock(blocks, kind, status, start, end) {
  if (end <= start)
    return;
  blocks.push({ kind, status, start, end });
}
function tryLinkRefDefBlock(lines, i) {
  const startLine = lines[i];
  if (!startLine || !/^ {0,3}\[/.test(startLine.text))
    return null;
  let buf = "";
  let runLines = 0;
  for (let j = i; j < lines.length; j++) {
    const line = lines[j];
    if (!line || line.text.trim() === "")
      break;
    if (j > i && (ATX_HEADING_DETECT_RE.test(line.text) || LIST_ITEM_RE.test(line.text) || BLOCKQUOTE_RE.test(line.text) || fenceMarker(line.text) || THEMATIC_BREAK_RE.test(line.text))) {
      break;
    }
    buf += line.text;
    if (line.terminated)
      buf += "\n";
    runLines++;
  }
  let offset = 0;
  let consumedLines = 0;
  while (offset < buf.length && consumedLines < runLines) {
    let k = offset;
    let indent = 0;
    while (buf[k] === " " && indent < 4) {
      k++;
      indent++;
    }
    if (indent > 3 || buf[k] !== "[")
      break;
    const def = parseLinkReferenceDefinitionAt(buf, k);
    if (!def || !isValidReferenceLabel(def.label))
      break;
    const segment = buf.slice(offset, def.end);
    consumedLines += (segment.match(/\n/g)?.length ?? 0) + (segment.endsWith("\n") ? 0 : 1);
    offset = def.end;
  }
  if (consumedLines === 0)
    return null;
  return i + consumedLines;
}
function endsInOpenParagraph(fragment) {
  const last = tokenizeBlocks(fragment).at(-1);
  if (!last)
    return false;
  if (last.kind === "paragraph")
    return true;
  if (last.kind === "blockquote") {
    const inner = fragment.slice(last.start, last.end).split("\n").map((l) => stripBlockquoteMarker(l)).join("\n");
    return endsInOpenParagraph(inner);
  }
  if (last.kind === "list_item") {
    const lines = fragment.slice(last.start, last.end).split("\n");
    const col = listItemContentColumn(lines[0] ?? "");
    const inner = lines.map((l, idx) => {
      if (idx === 0)
        return l.slice(Math.min(col, l.length));
      const indent = /^ */.exec(l)?.[0].length ?? 0;
      return l.slice(Math.min(col, indent));
    }).join("\n");
    return endsInOpenParagraph(inner);
  }
  return false;
}
function breaksUnorderedListItem(lines, itemStart, j) {
  const itemStartLine = lines[itemStart]?.text ?? "";
  const col = listItemContentColumn(itemStartLine);
  const next = lines[j];
  if (!next)
    return true;
  if (next.text.trim() === "" && j === itemStart + 1 && isEmptyListItemLine(itemStartLine)) {
    return true;
  }
  if (next.text.trim() === "") {
    let k = j + 1;
    while (k < lines.length && lines[k]?.text.trim() === "")
      k++;
    const after = lines[k];
    if (!after)
      return true;
    if (lazyContinuationIndent(after.text) >= col)
      return false;
    if (isListItemLine(after.text))
      return true;
    return !isLazyUnorderedContinuation(itemStartLine, after.text);
  }
  if (lazyContinuationIndent(next.text) >= col && next.text.trim() !== "")
    return false;
  if (isListItemLine(next.text))
    return true;
  if (ATX_HEADING_DETECT_RE.test(next.text) || THEMATIC_BREAK_RE.test(next.text) || fenceMarker(next.text) || BLOCKQUOTE_RE.test(next.text) || tryLinkRefDefBlock(lines, j) !== null || isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? "")) {
    return true;
  }
  return false;
}
function tokenizeBlocks(source) {
  const lines = scanLines(source);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line)
      break;
    if (line.text.trim() === "") {
      pushBlock(blocks, "blank", line.terminated ? "complete" : "open", line.start, line.end);
      i++;
      continue;
    }
    if (leadingIndentWidth(line.text) >= 4 && line.text.trim() !== "") {
      let j2 = i + 1;
      let lastContent = i;
      while (j2 < lines.length) {
        const next = lines[j2];
        if (!next)
          break;
        if (next.text.trim() === "") {
          j2++;
          continue;
        }
        if (leadingIndentWidth(next.text) >= 4) {
          lastContent = j2;
          j2++;
          continue;
        }
        break;
      }
      const last2 = lines[lastContent] ?? line;
      const terminatorSeen = j2 < lines.length && lines[j2] !== void 0;
      const status2 = !last2.terminated ? "open" : terminatorSeen ? "complete" : "open";
      pushBlock(blocks, "indented_code", status2, line.start, last2.end);
      i = lastContent + 1;
      continue;
    }
    const fence = fenceMarker(line.text);
    if (fence) {
      const fenceStart = line.start;
      let j2 = i + 1;
      let closed = false;
      while (j2 < lines.length) {
        const next = lines[j2];
        if (next && fenceCloses(fence.marker, fence.len, next.text)) {
          closed = true;
          pushBlock(blocks, "fence", "complete", fenceStart, next.end);
          i = j2 + 1;
          break;
        }
        j2++;
      }
      if (!closed) {
        const end = lines.at(-1)?.end ?? source.length;
        pushBlock(blocks, "fence", "open", fenceStart, end);
        break;
      }
      continue;
    }
    if (ATX_HEADING_DETECT_RE.test(line.text)) {
      const status2 = line.terminated ? "complete" : "ambiguous";
      pushBlock(blocks, "atx_heading", status2, line.start, line.end);
      i++;
      continue;
    }
    if (THEMATIC_BREAK_RE.test(line.text)) {
      const status2 = line.terminated ? "complete" : "ambiguous";
      pushBlock(blocks, "thematic_break", status2, line.start, line.end);
      i++;
      continue;
    }
    const linkRefEnd = tryLinkRefDefBlock(lines, i);
    if (linkRefEnd !== null) {
      const last2 = lines[linkRefEnd - 1] ?? line;
      const status2 = last2.terminated ? "complete" : "open";
      pushBlock(blocks, "link_ref_def", status2, line.start, last2.end);
      i = linkRefEnd;
      continue;
    }
    if (isListItemLine(line.text)) {
      const isOrdered = parseOrderedListMarker(line.text) !== null;
      const itemStart = line.start;
      let j2 = i + 1;
      while (j2 < lines.length) {
        if (isOrdered) {
          const next = lines[j2];
          if (!next)
            break;
          if (next.text.trim() !== "" && lazyContinuationIndent(next.text) >= listItemContentColumn(line.text)) {
            j2++;
            continue;
          }
          if (isListItemLine(next.text))
            break;
          if (next.text.trim() === "") {
            j2++;
            continue;
          }
          if ((lines[j2 - 1]?.text.trim() ?? "") === "" && leadingIndentWidth(next.text) >= 4) {
            break;
          }
          if (ATX_HEADING_DETECT_RE.test(next.text) || THEMATIC_BREAK_RE.test(next.text) || fenceMarker(next.text) || BLOCKQUOTE_RE.test(next.text) || tryLinkRefDefBlock(lines, j2) !== null || isTableRow(next.text) && lines[j2 + 1] && TABLE_SEP_RE.test(lines[j2 + 1]?.text ?? "")) {
            break;
          }
          j2++;
          continue;
        }
        if (breaksUnorderedListItem(lines, i, j2))
          break;
        j2++;
      }
      const last2 = lines[j2 - 1] ?? line;
      const status2 = last2.terminated ? "complete" : "open";
      pushBlock(blocks, "list_item", status2, itemStart, last2.end);
      i = j2;
      continue;
    }
    if (BLOCKQUOTE_RE.test(line.text)) {
      const bqStart = line.start;
      let j2 = i + 1;
      while (j2 < lines.length) {
        const next = lines[j2];
        if (!next)
          break;
        if (next.text.trim() === "")
          break;
        if (!BLOCKQUOTE_RE.test(next.text)) {
          if (ATX_HEADING_DETECT_RE.test(next.text) || LIST_ITEM_RE.test(next.text) || fenceMarker(next.text) || THEMATIC_BREAK_RE.test(next.text)) {
            break;
          }
          const stripped = lines.slice(i, j2).map((l) => stripBlockquoteMarker(l.text)).join("\n") + "\n";
          if (!endsInOpenParagraph(stripped))
            break;
        }
        j2++;
      }
      const last2 = lines[j2 - 1] ?? line;
      const status2 = last2.terminated ? "complete" : "open";
      pushBlock(blocks, "blockquote", status2, bqStart, last2.end);
      i = j2;
      continue;
    }
    if (isTableRow(line.text)) {
      const nextLine2 = lines[i + 1];
      if (nextLine2 && TABLE_SEP_RE.test(nextLine2.text)) {
        const tableStart = line.start;
        let j2 = i + 2;
        while (j2 < lines.length) {
          const row = lines[j2];
          if (!row || !isTableRow(row.text))
            break;
          j2++;
        }
        const last2 = lines[j2 - 1] ?? lines[i + 1] ?? line;
        const lastRow = lines[j2 - 1];
        const status2 = lastRow && !lastRow.terminated && j2 === lines.length ? "open" : "complete";
        pushBlock(blocks, "table", status2, tableStart, last2.end);
        i = j2;
        continue;
      }
      if (isPotentialTableStart(lines, i)) {
        const tableStart = line.start;
        let j2 = i + 1;
        while (j2 < lines.length) {
          const nl = lines[j2];
          if (!nl)
            break;
          if (TABLE_SEP_RE.test(nl.text))
            break;
          if (!isTableRow(nl.text) && !isPartialTableSeparatorLine(nl.text) && nl.text.trim() !== "") {
            break;
          }
          j2++;
        }
        const last2 = lines[j2 - 1] ?? line;
        const status2 = last2.terminated && j2 > i + 1 ? "open" : last2.terminated ? "ambiguous" : "open";
        pushBlock(blocks, "table", status2, tableStart, last2.end);
        i = j2;
        continue;
      }
    }
    const nextLine = lines[i + 1];
    if (nextLine && SETEXT_UNDERLINE_RE.test(nextLine.text)) {
      if (!nextLine.terminated) {
        pushBlock(blocks, "paragraph", line.terminated ? "complete" : "open", line.start, line.end);
        pushBlock(blocks, "thematic_break", "ambiguous", nextLine.start, nextLine.end);
        i += 2;
        continue;
      }
      pushBlock(blocks, "setext_heading", "complete", line.start, nextLine.end);
      i += 2;
      continue;
    }
    if (!line.terminated && i === lines.length - 1) {
      if (isPotentialTableStart(lines, i)) {
        pushBlock(blocks, "table", "ambiguous", line.start, line.end);
      } else {
        pushBlock(blocks, "paragraph", "open", line.start, line.end);
      }
      break;
    }
    const paraStart = line.start;
    let j = i + 1;
    let setextUnderline = null;
    while (j < lines.length) {
      const next = lines[j];
      if (!next || next.text.trim() === "")
        break;
      if (next.terminated && SETEXT_UNDERLINE_RE.test(next.text)) {
        setextUnderline = next;
        break;
      }
      if (ATX_HEADING_DETECT_RE.test(next.text) || THEMATIC_BREAK_RE.test(next.text) || LIST_ITEM_RE.test(next.text) && // An empty list item cannot interrupt a paragraph (#285).
      !isEmptyListItemLine(next.text) && !orderedMarkerContinuesParagraph(lines[j - 1]?.text ?? "", next.text) || BLOCKQUOTE_RE.test(next.text) || fenceMarker(next.text) || // NOTE: a link reference definition cannot interrupt a paragraph
      // (spec 213) — a `[label]: dest` line here is a lazy continuation.
      isTableRow(next.text) && lines[j + 1] && TABLE_SEP_RE.test(lines[j + 1]?.text ?? "")) {
        break;
      }
      j++;
    }
    if (setextUnderline) {
      pushBlock(blocks, "setext_heading", "complete", paraStart, setextUnderline.end);
      i = j + 1;
      continue;
    }
    const last = lines[j - 1] ?? line;
    const status = last.terminated ? "complete" : "open";
    pushBlock(blocks, "paragraph", status, paraStart, last.end);
    i = j;
  }
  return blocks;
}
function collectLinkReferenceDefinitions(source, tokens) {
  const blocks = tokens ?? tokenizeBlocks(source);
  const refs = /* @__PURE__ */ new Map();
  const merge = (found) => {
    for (const [key, ref] of found) {
      if (!refs.has(key))
        refs.set(key, ref);
    }
  };
  for (const token of blocks) {
    if (token.kind === "link_ref_def") {
      merge(parseLinkReferenceDefinitions(source.slice(token.start, token.end)));
    } else if (token.kind === "blockquote") {
      const inner = source.slice(token.start, token.end).split("\n").map((line) => stripBlockquoteMarker(line.trim())).join("\n");
      merge(collectLinkReferenceDefinitions(inner));
    }
  }
  return refs;
}
function streamingHoldStart(blocks) {
  let commitEnd = 0;
  for (const block of blocks) {
    if (block.status !== "complete")
      return block.start;
    commitEnd = block.end;
  }
  return commitEnd;
}
function completeEndsInOpenTable(complete, tokens) {
  const blocks = tokens ?? tokenizeBlocks(complete);
  const last = blocks.at(-1);
  return last?.kind === "table" && last.status === "complete";
}
function pendingLineBelongsInTable(complete, pending, completeTokens) {
  return pending.includes("|") && completeEndsInOpenTable(complete, completeTokens);
}
function getIncompleteTableSource(content, tokens) {
  const blocks = tokens ?? tokenizeBlocks(content);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === "table" && block.status !== "complete") {
      return content.slice(block.start, block.end);
    }
  }
  return null;
}
function getIncompleteFenceSource(content, tokens) {
  const blocks = tokens ?? tokenizeBlocks(content);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.kind === "fence" && block.status !== "complete") {
      return content.slice(block.start, block.end);
    }
  }
  return null;
}
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|"))
    s = s.slice(1);
  if (s.endsWith("|"))
    s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
function isAmbiguousBlockLine(line) {
  const trimmed = line.trimStart();
  if (trimmed === "")
    return false;
  if (/^ {4}/.test(line))
    return true;
  if (ATX_HEADING_DETECT_RE.test(line))
    return true;
  if (THEMATIC_BREAK_RE.test(line))
    return true;
  if (FENCE_OPEN_RE.test(line))
    return true;
  if (LIST_ITEM_RE.test(line))
    return true;
  if (BLOCKQUOTE_RE.test(line))
    return true;
  if (isGfmTableRowLine(line))
    return true;
  return false;
}

// dist/indented-html.js
var HTML_BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
var HTML_BLOCK_START_RE = new RegExp(`^</?(?:${HTML_BLOCK_TAGS})(?:[\\s/>]|$)`, "i");
function leadingSpaces(line) {
  return line.match(/^ */)?.[0].length ?? 0;
}
function dedentBlock(content) {
  const lines = content.split("\n");
  let min = Infinity;
  for (const line of lines) {
    if (line.trim() === "")
      continue;
    min = Math.min(min, leadingSpaces(line));
  }
  if (!Number.isFinite(min) || min === 0)
    return content;
  return lines.map((line) => line.slice(Math.min(min, leadingSpaces(line)))).join("\n");
}
function isIndentedHtmlBlock(content) {
  const first = dedentBlock(content).split("\n").find((line) => line.trim() !== "");
  return first !== void 0 && HTML_BLOCK_START_RE.test(first);
}

// dist/raw-images.js
var activeRawImageRenderer = null;
function parseHtmlAttributes(tag) {
  const attrs = {};
  const decodedTag = decodeEscapedHref(tag);
  for (const match of decodedTag.matchAll(/\b([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const name = match[1];
    if (name === void 0)
      continue;
    attrs[name.toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return attrs;
}
var RAW_IMAGE_RE = /(?:<img\b[\s\S]*?\/?>|&lt;img\b[\s\S]*?\/?&gt;)/gi;
var PLACEHOLDER_OPEN = "\uFFF9";
var PLACEHOLDER_CLOSE = "\uFFFB";
var PLACEHOLDER_RE = /￹(\d+)￻/g;
function extractRawImages(text2) {
  const renderer = activeRawImageRenderer;
  if (!renderer)
    return { text: text2, images: [] };
  const images = [];
  const out = text2.replace(RAW_IMAGE_RE, (tag) => {
    const replacement = renderer({ tag, attrs: parseHtmlAttributes(tag) });
    if (replacement == null)
      return tag;
    const index = images.push(replacement) - 1;
    return `${PLACEHOLDER_OPEN}${index}${PLACEHOLDER_CLOSE}`;
  });
  return { text: out, images };
}
function restoreRawImages(text2, images) {
  if (images.length === 0)
    return text2;
  return text2.replace(PLACEHOLDER_RE, (_match, index) => images[Number(index)] ?? "");
}

// dist/workspace-link-href.js
var URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
function workspaceLinkTargetFromHref(raw) {
  let pathPart = raw.trim();
  if (pathPart === "" || pathPart.startsWith("#") || pathPart.startsWith("//"))
    return null;
  if (URL_SCHEME_RE.test(pathPart))
    return null;
  const hashIdx = pathPart.indexOf("#");
  if (hashIdx >= 0)
    pathPart = pathPart.slice(0, hashIdx);
  if (pathPart === "")
    return null;
  let line;
  let column;
  const lineMatch = pathPart.match(/:(\d{1,9})(?::(\d{1,9}))?$/);
  if (lineMatch?.[1] && pathPart.includes("/")) {
    const suffix = lineMatch[0];
    const pathOnly = pathPart.slice(0, pathPart.length - suffix.length);
    if (pathOnly !== "" && !pathOnly.endsWith(":")) {
      pathPart = pathOnly;
      line = Number(lineMatch[1]);
      if (lineMatch[2] !== void 0)
        column = Number(lineMatch[2]);
    }
  }
  let normalized = pathPart;
  if (normalized.startsWith("./"))
    normalized = normalized.slice(2);
  if (normalized.startsWith("/"))
    normalized = normalized.slice(1);
  if (normalized === "" || normalized.includes("\\"))
    return null;
  if (normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return {
    candidate: normalized,
    ...line !== void 0 ? { line } : {},
    ...column !== void 0 ? { column } : {}
  };
}
var COMMONMARK_FIXTURE_SINGLE_SEGMENTS = /* @__PURE__ */ new Set(["uri", "url"]);
function isWorkspaceMarkdownLinkHref(raw) {
  const target = workspaceLinkTargetFromHref(raw);
  if (!target)
    return false;
  const segments = target.candidate.split("/");
  if (segments.length === 1 && COMMONMARK_FIXTURE_SINGLE_SEGMENTS.has(segments[0] ?? "")) {
    return false;
  }
  return true;
}

// dist/inline-links.js
var renderedLabelIndexCache = /* @__PURE__ */ new WeakMap();
function lookupWithRenderedLabels(refs, label, renderForMatch) {
  const direct = lookupLinkReference(refs, label);
  if (direct || !renderForMatch || !label.includes("<") || !isValidReferenceLabel(label)) {
    return direct;
  }
  let index = renderedLabelIndexCache.get(refs);
  if (!index) {
    index = /* @__PURE__ */ new Map();
    for (const [key, ref] of refs) {
      const renderedKey = normalizeReferenceLabel(decodeEscapes(renderForMatch(key)));
      if (!index.has(renderedKey))
        index.set(renderedKey, ref);
    }
    renderedLabelIndexCache.set(refs, index);
  }
  return index.get(normalizeReferenceLabel(decodeEscapes(label)));
}
var DEFAULT_SAFE_HREF_SCHEMES = [
  "http",
  "https",
  "mailto",
  "tel",
  "sms",
  "ftp",
  "ftps"
];
var HREF_SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
var activeSafeHrefSchemes = new Set(DEFAULT_SAFE_HREF_SCHEMES);
function isAllowedHref(href) {
  const scheme = HREF_SCHEME_RE.exec(href)?.[1];
  return scheme === void 0 || activeSafeHrefSchemes.has(scheme.toLowerCase());
}
function safeLinkHref(raw) {
  const href = decodeHtmlCharRefs(decodeEscapedPunctuationRaw(decodeEscapedHref(raw))).trim();
  if (!isAllowedHref(href))
    return null;
  return percentEncodeHref(href);
}
var appLinkDecorator = ({ isWorkspace, title }) => {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return isWorkspace ? ` class="workspace-markdown-link" data-workspace-link="true"${titleAttr}` : ` target="_blank" rel="noopener noreferrer" data-browser-link="true"${titleAttr}`;
};
var activeLinkDecorator = appLinkDecorator;
function renderAnchor(label, href, title) {
  const isWorkspace = isWorkspaceMarkdownLinkHref(href);
  const decoration = title === void 0 ? { href, isWorkspace } : { href, isWorkspace, title };
  const attrs = activeLinkDecorator(decoration);
  return `<a href="${escapeHtml(href)}"${attrs}>${label}</a>`;
}
function renderedLink(label, href, title) {
  return renderAnchor(label, href, title);
}
function imageAltText(renderedLabel) {
  return renderedLabel.replace(/<img\b[^>]*?\salt="([^"]*)"[^>]*>/gi, (_match, nested) => decodeEscapedHref(nested)).replace(/<[^>]*>/g, "");
}
function renderedImage(alt, src, title) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageAltText(alt))}"${titleAttr} data-md-rendered="1" />`;
}
function renderLinkLabel(label, refs, renderLabel) {
  return renderLabel(label, refs);
}
var RENDERED_ANCHOR_RE = /<a\b[\s\S]*?<\/a>/i;
function labelContainsNestedLink(label, refs) {
  if (RENDERED_ANCHOR_RE.test(label))
    return true;
  let i = 0;
  while (i < label.length) {
    if (label[i] === "!" && label[i + 1] === "[") {
      const image = tryParseLinkOrImage(label, i, refs, (inner) => inner);
      if (image) {
        i = image.end;
        continue;
      }
    }
    if (label[i] === "[") {
      const parsed = tryParseLinkOrImage(label, i, refs, (inner) => inner, { linksOnly: true });
      if (parsed)
        return true;
    }
    i++;
  }
  return false;
}
function linkOrImageStartsAt(text2, start, refs = /* @__PURE__ */ new Map()) {
  return tryParseLinkOrImage(text2, start, refs, (label) => label) !== null;
}
function linkOrImageEndAt(text2, start, refs = /* @__PURE__ */ new Map()) {
  return tryParseLinkOrImage(text2, start, refs, (label) => label)?.end ?? null;
}
function parseBracketedLabelOutsideInlineCode(text2, start) {
  if (text2[start] !== "[")
    return null;
  const shieldRanges = inlineShieldRanges(text2);
  let i = start + 1;
  let depth = 1;
  while (i < text2.length && depth > 0) {
    const shieldRange = rangeAt(i, shieldRanges);
    if (shieldRange) {
      i = shieldRange.end;
      continue;
    }
    const ch = text2[i];
    if (ch === "\\" && i + 1 < text2.length) {
      i += 2;
      continue;
    }
    if (ch === "[")
      depth++;
    else if (ch === "]")
      depth--;
    i++;
  }
  if (depth !== 0)
    return null;
  return { label: text2.slice(start + 1, i - 1), end: i };
}
function tryParseLinkOrImage(text2, start, refs, renderLabel, options = {}) {
  const image = !options.linksOnly && text2[start] === "!" && text2[start + 1] === "[";
  const bracketStart = image ? start + 1 : start;
  if (text2[bracketStart] !== "[")
    return null;
  const labelPart = parseBracketedLabelOutsideInlineCode(text2, bracketStart);
  if (!labelPart)
    return null;
  const j = labelPart.end;
  if (text2[j] === "(") {
    const dest = parseInlineLinkDestination(text2, j);
    if (dest) {
      const href2 = safeLinkHref(dest.href);
      if (href2 === null)
        return null;
      if (!image && labelContainsNestedLink(labelPart.label, refs))
        return null;
      const label2 = renderLinkLabel(labelPart.label, refs, renderLabel);
      const html3 = image ? renderedImage(label2, href2, dest.title) : renderedLink(label2, href2, dest.title);
      return { html: html3, end: dest.end };
    }
  }
  if (text2[j] === "[") {
    const refLabel = parseReferenceLabel(text2, j, labelPart.label);
    if (!refLabel)
      return null;
    const ref2 = lookupWithRenderedLabels(refs, refLabel.label, options.renderForMatch);
    if (!ref2)
      return null;
    const href2 = safeLinkHref(ref2.href);
    if (href2 === null)
      return null;
    if (!image && labelContainsNestedLink(labelPart.label, refs))
      return null;
    const label2 = renderLinkLabel(labelPart.label, refs, renderLabel);
    const html3 = image ? renderedImage(label2, href2, ref2.title) : renderedLink(label2, href2, ref2.title);
    return { html: html3, end: refLabel.end };
  }
  const ref = lookupWithRenderedLabels(refs, labelPart.label, options.renderForMatch);
  if (!ref)
    return null;
  const href = safeLinkHref(ref.href);
  if (href === null)
    return null;
  if (!image && labelContainsNestedLink(labelPart.label, refs))
    return null;
  const label = renderLinkLabel(labelPart.label, refs, renderLabel);
  const html2 = image ? renderedImage(label, href, ref.title) : renderedLink(label, href, ref.title);
  return { html: html2, end: labelPart.end };
}
function renderInlineLinks(text2, refs, renderLabel, renderForMatch) {
  const shieldRanges = inlineShieldRanges(text2);
  let out = "";
  let i = 0;
  while (i < text2.length) {
    const shieldRange = rangeAt(i, shieldRanges);
    if (shieldRange) {
      out += text2.slice(i, shieldRange.end);
      i = shieldRange.end;
      continue;
    }
    const imageAt = text2[i] === "!" && text2[i + 1] === "[";
    const linkAt = text2[i] === "[";
    if (imageAt || linkAt) {
      const parsed = tryParseLinkOrImage(text2, i, refs, renderLabel, { renderForMatch });
      if (parsed) {
        out += parsed.html;
        i = parsed.end;
        continue;
      }
    }
    out += text2[i] ?? "";
    i++;
  }
  return out;
}
var INLINE_SHIELD_RE = /<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>/g;
function inlineShieldRanges(text2) {
  const ranges = [];
  for (const match of text2.matchAll(INLINE_SHIELD_RE)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}
function rangeAt(index, ranges) {
  return ranges.find((range) => index >= range.start && index < range.end);
}

// dist/inline-strikethrough.js
function inlineHtmlMask(text2) {
  const mask = new Array(text2.length).fill(false);
  for (const match of text2.matchAll(INLINE_HTML_SHIELD_RE)) {
    for (let i = match.index; i < match.index + match[0].length; i++)
      mask[i] = true;
  }
  return mask;
}
function readTildeRuns(s, mask) {
  const runs = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "~" || mask[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] === "~" && !mask[j])
      j++;
    const len = j - i;
    if (len === 2) {
      const prev = i > 0 ? s[i - 1] ?? "" : "";
      const next = j < s.length ? s[j] ?? "" : "";
      runs.push({
        start: i,
        end: j,
        canOpen: isLeftFlanking(prev, next),
        canClose: isRightFlanking(prev, next)
      });
    }
    i = j;
  }
  return runs;
}
function pairTildeRuns(runs) {
  const stack = [];
  const matches = [];
  for (const run of runs) {
    if (run.canClose && stack.length > 0) {
      const opener = stack.pop();
      if (opener)
        matches.push({ open: opener.start, close: run.start });
      continue;
    }
    if (run.canOpen)
      stack.push(run);
  }
  return { matches, open: stack };
}
function renderStrikethrough(text2) {
  if (!text2.includes("~~"))
    return text2;
  const mask = inlineHtmlMask(text2);
  const { matches } = pairTildeRuns(readTildeRuns(text2, mask));
  if (matches.length === 0)
    return text2;
  const openAt = new Set(matches.map((m) => m.open));
  const closeAt = new Set(matches.map((m) => m.close));
  let out = "";
  let i = 0;
  while (i < text2.length) {
    if (openAt.has(i)) {
      out += "<del>";
      i += 2;
      continue;
    }
    if (closeAt.has(i)) {
      out += "</del>";
      i += 2;
      continue;
    }
    out += text2[i] ?? "";
    i++;
  }
  return out;
}
function strikethroughHoldStart(s, mask) {
  const { open } = pairTildeRuns(readTildeRuns(s, mask));
  let cut = s.length;
  const firstOpen = open[0];
  if (firstOpen)
    cut = Math.min(cut, firstOpen.start);
  if (s.length > 0 && s[s.length - 1] === "~" && !mask[s.length - 1]) {
    let t = s.length;
    while (t > 0 && s[t - 1] === "~" && !mask[t - 1])
      t--;
    if (s.length - t === 1)
      cut = Math.min(cut, t);
  }
  return cut;
}

// dist/inline-emphasis.js
var UNICODE_PUNCTUATION_RE = /[\p{P}\p{S}]/u;
function isFlankingWhitespace(ch) {
  return ch === "" || /\s/.test(ch);
}
function isFlankingPunctuation(ch) {
  return ch !== "" && UNICODE_PUNCTUATION_RE.test(ch);
}
function isLeftFlanking(prev, next) {
  return !isFlankingWhitespace(next) && (!isFlankingPunctuation(next) || isFlankingWhitespace(prev) || isFlankingPunctuation(prev));
}
function isRightFlanking(prev, next) {
  return !isFlankingWhitespace(prev) && (!isFlankingPunctuation(prev) || isFlankingWhitespace(next) || isFlankingPunctuation(next));
}
function readDelimiterRun(s, i, limit, mask, linkRefs, mode) {
  const ch = s[i];
  if (ch === void 0 || ch !== "*" && ch !== "_" || mask[i])
    return null;
  let j = i;
  while (j < limit && s[j] === ch && !mask[j])
    j++;
  const len = j - i;
  const prev = i > 0 ? s[i - 1] ?? "" : "";
  const next = j < s.length ? s[j] ?? "" : "";
  const lf = isLeftFlanking(prev, next);
  const rf = isRightFlanking(prev, next);
  const linkBeatsEmphasis = mode === "hold" && ch === "*" && lf && next === "[" && linkOrImageStartsAt(s, j, linkRefs);
  const canOpen = ch === "*" ? lf && !linkBeatsEmphasis : lf && (!rf || isFlankingPunctuation(prev));
  const canClose = ch === "*" ? rf : rf && (!lf || isFlankingPunctuation(next));
  return { char: ch, start: i, end: j, len, canOpen, canClose };
}
function findMatchingOpener(stack, ch, allowed) {
  for (let t = stack.length - 1; t >= 0; t--) {
    const open = stack[t];
    if (open?.char === ch && (!allowed || allowed(open)))
      return t;
  }
  return -1;
}
function emphasisSpansNewline(s) {
  const { mask } = scanCodeSpans(s);
  const matches = scanDelimiterMatches(s, mask, /* @__PURE__ */ new Map());
  return matches.some((m) => s.slice(m.openIndex, m.closeIndex + m.closeLen).includes("\n"));
}
function emphasisMatchAllowed(open, closeLen, canOpen, canClose) {
  if (!(canOpen || canClose))
    return true;
  if (closeLen % 3 === 0)
    return true;
  return (open.len + closeLen) % 3 !== 0;
}
function handleCloseRemainder(s, stack, matches, ch, closeStart, used, closeLen) {
  const remainder = closeLen - used;
  if (remainder <= 0)
    return;
  const remIndex = closeStart + used;
  const remPrev = remIndex > 0 ? s[remIndex - 1] ?? "" : "";
  const remNext = remIndex + remainder < s.length ? s[remIndex + remainder] ?? "" : "";
  const remLf = isLeftFlanking(remPrev, remNext);
  const remRf = isRightFlanking(remPrev, remNext);
  const remCanOpen = ch === "*" ? remLf : remLf && (!remRf || isFlankingPunctuation(remPrev));
  const remCanClose = ch === "*" ? remRf : remRf && (!remLf || isFlankingPunctuation(remNext));
  const remMatched = remCanClose ? findMatchingOpener(stack, ch, (open) => emphasisMatchAllowed(open, remainder, remCanOpen, open.canClose)) : -1;
  const remOpen = remMatched >= 0 ? stack[remMatched] : void 0;
  if (remOpen) {
    const remOpenRunLen = remOpen.len;
    const remUsed = Math.min(remOpen.len, remainder);
    const remPrefix = remOpenRunLen - remUsed;
    if (emphasisMatchAllowed(remOpen, remainder, remCanOpen, remOpen.canClose)) {
      matches.push({
        openIndex: remOpen.index + remPrefix,
        closeIndex: remIndex,
        openLen: remUsed,
        closeLen: remUsed,
        openRunLen: remOpenRunLen,
        char: ch
      });
      stack.length = remMatched;
      if (remPrefix > 0) {
        stack.push({
          index: remOpen.index,
          char: ch,
          len: remPrefix,
          canClose: remOpen.canClose
        });
      }
      const remRemainder = remainder - remUsed;
      if (remRemainder > 0 && remCanOpen) {
        stack.push({
          index: remIndex + remUsed,
          char: ch,
          len: remRemainder,
          canClose: remRf
        });
      }
    } else if (remCanOpen) {
      stack.push({ index: remIndex, char: ch, len: remainder, canClose: remRf });
    }
  } else if (remCanOpen) {
    stack.push({ index: remIndex, char: ch, len: remainder, canClose: remRf });
  }
}
function walkEmphasisDelimiters(s, limit, mask, mode, linkRefs) {
  const matches = [];
  const stack = [];
  let trailingConsumed = false;
  let i = 0;
  while (i < limit) {
    const run = readDelimiterRun(s, i, limit, mask, linkRefs, mode);
    if (!run) {
      i++;
      continue;
    }
    const { char: ch, start, end: j, len, canOpen, canClose } = run;
    const matched = canClose ? findMatchingOpener(stack, ch, mode === "render" ? (open2) => emphasisMatchAllowed(open2, len, canOpen, open2.canClose) : void 0) : -1;
    const open = matched >= 0 ? stack[matched] : void 0;
    if (open) {
      const openRunLen = open.len;
      const used = Math.min(open.len, len);
      const remainingPrefixLen = openRunLen - used;
      if (mode === "render") {
        matches.push({
          openIndex: open.index + remainingPrefixLen,
          closeIndex: start,
          openLen: used,
          closeLen: used,
          openRunLen,
          char: ch
        });
      }
      stack.length = matched;
      if (remainingPrefixLen > 0) {
        stack.push({
          index: open.index,
          char: ch,
          len: remainingPrefixLen,
          canClose: open.canClose
        });
      }
      if (mode === "render") {
        handleCloseRemainder(s, stack, matches, ch, start, used, len);
      } else if (j === s.length) {
        trailingConsumed = true;
      }
    } else if (canOpen) {
      stack.push({ index: start, char: ch, len, canClose });
    }
    i = j;
  }
  return { matches, stack, trailingConsumed };
}
function scanDelimiterMatches(s, mask, linkRefs) {
  return walkEmphasisDelimiters(s, s.length, mask, "render", linkRefs).matches;
}
function trailingDelimiterStart(s, mask) {
  let tStart = s.length;
  while (tStart > 0 && (s[tStart - 1] === "*" || s[tStart - 1] === "_") && !mask[tStart - 1]) {
    tStart--;
  }
  return tStart;
}
function wrapEmphasis(inner, openLen, closeLen) {
  const used = Math.min(openLen, closeLen);
  if (used === 0)
    return inner;
  let out = inner;
  let remaining = used;
  while (remaining >= 2) {
    out = `<strong>${out}</strong>`;
    remaining -= 2;
  }
  if (remaining >= 1) {
    out = `<em>${out}</em>`;
  }
  return out;
}
function matchEnd(m) {
  return m.closeIndex + m.closeLen;
}
function isNestedIn(child, parent) {
  const childEnd = matchEnd(child);
  const parentEnd = matchEnd(parent);
  if (childEnd > parentEnd)
    return false;
  if (child.openIndex >= parent.openIndex && childEnd <= parentEnd)
    return true;
  return child.openIndex < parent.openIndex && childEnd > parent.openIndex;
}
function findRootMatches(matches) {
  const sorted = [...matches].sort((a, b) => matchEnd(b) - matchEnd(a) || a.openIndex - b.openIndex);
  const roots = [];
  for (const m of sorted) {
    if (!roots.some((root) => isNestedIn(m, root)))
      roots.push(m);
  }
  return roots.sort((a, b) => a.openIndex - b.openIndex);
}
function assembleMatch(s, m, allMatches) {
  const contentStart = m.openIndex + m.openLen;
  const contentEnd = m.closeIndex;
  const descendants = allMatches.filter((c) => c !== m && isNestedIn(c, m));
  const children = findRootMatches(descendants);
  let out = "";
  let cursor = contentStart;
  for (const child of children) {
    out += s.slice(cursor, child.openIndex);
    out += assembleMatch(s, child, allMatches);
    cursor = matchEnd(child);
  }
  out += s.slice(cursor, contentEnd);
  return wrapEmphasis(out.replace(/\n/g, " "), m.openLen, m.closeLen);
}
function delimitersToSkip(s, matches) {
  const skip = new Array(s.length).fill(false);
  for (const m of matches) {
    for (let i = m.openIndex; i < m.openIndex + m.openLen; i++)
      skip[i] = true;
    for (let i = m.closeIndex; i < matchEnd(m); i++)
      skip[i] = true;
  }
  return skip;
}
function maskLinkSpans(s, mask, linkRefs) {
  let extended = null;
  let i = 0;
  while (i < s.length) {
    if (mask[i]) {
      i++;
      continue;
    }
    if (s[i] === "[" || s[i] === "!" && s[i + 1] === "[") {
      const end = linkOrImageEndAt(s, i, linkRefs);
      if (end !== null) {
        extended ??= [...mask];
        for (let k = i; k < end; k++)
          extended[k] = true;
        i = end;
        continue;
      }
    }
    i++;
  }
  return extended ?? mask;
}
function renderEmphasisSegment(s, mask, linkRefs) {
  const matches = scanDelimiterMatches(s, maskLinkSpans(s, mask, linkRefs), linkRefs);
  if (matches.length === 0)
    return s;
  const roots = findRootMatches(matches);
  const skip = delimitersToSkip(s, matches);
  let out = "";
  let i = 0;
  let rootIdx = 0;
  while (i < s.length) {
    const root = roots[rootIdx];
    if (root && i === root.openIndex) {
      out += assembleMatch(s, root, matches);
      i = matchEnd(root);
      rootIdx++;
      continue;
    }
    if (skip[i]) {
      i++;
      continue;
    }
    let next = s.length;
    if (root)
      next = Math.min(next, root.openIndex);
    for (let j = i + 1; j < next; j++) {
      if (skip[j]) {
        next = j;
        break;
      }
    }
    out += s.slice(i, next);
    i = next;
  }
  return out;
}
function pendingHoldIndex(s) {
  const { mask, unresolvedAt } = scanCodeSpans(s);
  const limit = unresolvedAt ?? s.length;
  const { stack, trailingConsumed } = walkEmphasisDelimiters(s, limit, mask, "hold", /* @__PURE__ */ new Map());
  let cut = s.length;
  if (unresolvedAt !== null)
    cut = Math.min(cut, unresolvedAt);
  const firstOpen = stack[0];
  if (firstOpen)
    cut = Math.min(cut, firstOpen.index);
  if (!trailingConsumed) {
    cut = Math.min(cut, trailingDelimiterStart(s, mask));
  }
  const entityStart = trailingEntityHoldStart(s);
  if (entityStart < cut && !mask[entityStart])
    cut = entityStart;
  cut = Math.min(cut, strikethroughHoldStart(s, mask));
  return cut;
}
var INLINE_HTML_SHIELD_RE = /(<code>[\s\S]*?<\/code>|<a\b[\s\S]*?<\/a>|<img\b[^>]*>)/g;
function inlineHtmlMask2(text2) {
  const mask = new Array(text2.length).fill(false);
  for (const match of text2.matchAll(INLINE_HTML_SHIELD_RE)) {
    for (let i = match.index; i < match.index + match[0].length; i++)
      mask[i] = true;
  }
  return mask;
}
function renderEmphasisOutsideInlineHtml(text2, linkRefs = /* @__PURE__ */ new Map()) {
  return renderEmphasisSegment(text2, inlineHtmlMask2(text2), linkRefs);
}

// dist/inline-autolinks.js
var URI_AUTOLINK_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
var EMAIL_AUTOLINK_RE = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
function autolinkHref(raw) {
  if (/^(?:javascript|data|vbscript):/i.test(raw))
    return null;
  return encodeHrefForOutput(raw);
}
function renderedAutolink(label, href) {
  return `<a href="${escapeHtml(href)}">${label}</a>`;
}
function tryAngleAutolink(text2, start) {
  if (text2[start] !== "<")
    return null;
  const slice = text2.slice(start);
  const uri = URI_AUTOLINK_RE.exec(slice);
  if (uri?.[1] !== void 0) {
    const href = autolinkHref(uri[1]);
    if (href === null)
      return null;
    return { html: renderedAutolink(uri[1], href), end: start + uri[0].length };
  }
  const email = EMAIL_AUTOLINK_RE.exec(slice);
  if (email?.[1] !== void 0) {
    const href = autolinkHref(`mailto:${email[1]}`);
    if (href === null)
      return null;
    return { html: renderedAutolink(email[1], href), end: start + email[0].length };
  }
  return null;
}
function renderAngleAutolinks(text2) {
  return text2.split(INLINE_HTML_SHIELD_RE).map((segment, index) => {
    if (index % 2 === 1)
      return segment;
    let out = "";
    let i = 0;
    while (i < segment.length) {
      const parsed = tryAngleAutolink(segment, i);
      if (parsed) {
        out += parsed.html;
        i = parsed.end;
        continue;
      }
      out += segment[i] ?? "";
      i++;
    }
    return out;
  }).join("");
}

// dist/inline-spans.js
function renderInlineSpansBeforeLinks(t, linkRefs) {
  t = encodeBackslashEscapes(t);
  t = renderInlineCode(t);
  t = renderAngleAutolinks(t);
  t = renderEmphasisOutsideInlineHtml(t, linkRefs);
  t = renderStrikethrough(t);
  return t;
}
function renderNestedInlineSpans(t, linkRefs) {
  t = renderInlineSpansBeforeLinks(t, linkRefs);
  t = renderInlineLinks(t, linkRefs, renderNestedInlineSpans, (label) => renderInlineSpansBeforeLinks(label, linkRefs));
  t = renderStrongAroundCode(t);
  t = renderStrongWithInlineHtml(t);
  t = renderBareHttpLinks(t);
  return t;
}
function renderInlineSpans(t, linkRefs = /* @__PURE__ */ new Map()) {
  return decodeEscapedPunctuation(escapeHtmlTextNodes(renderNestedInlineSpans(t, linkRefs)));
}
function renderStrongAroundCode(text2) {
  return text2.replace(/\*\*(<code>[\s\S]*?<\/code>)\*\*/g, "<strong>$1</strong>");
}
function renderStrongWithInlineHtml(text2) {
  return text2.replace(/\*\*(?=\S)([^*\n]*<(?:code|a|img)\b[\s\S]*?(?:<\/(?:code|a)>|<img\b[^>]*>)[^*\n]*)\*\*/g, "<strong>$1</strong>");
}
function renderedBareLink(label, href) {
  return renderAnchor(label, href);
}
var BARE_HTTP_URL_RE = /(^|[\s(])((?:https?:\/\/)[^\s<]+)/gi;
var TRAILING_URL_PUNCTUATION_RE = /[),.;:!?_]+$/;
function renderBareHttpLinks(text2) {
  return text2.split(INLINE_HTML_SHIELD_RE).map((segment, index) => {
    if (index % 2 === 1)
      return segment;
    return segment.replace(BARE_HTTP_URL_RE, (_match, prefix, rawUrl) => {
      const trailing = rawUrl.match(TRAILING_URL_PUNCTUATION_RE)?.[0] ?? "";
      const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
      const href = safeLinkHref(url);
      if (!href)
        return `${prefix}${rawUrl}`;
      return `${prefix}${renderedBareLink(url, href)}${trailing}`;
    });
  }).join("");
}

// dist/render-prose-inline.js
function stripHtmlComments(text2) {
  return text2.replace(/<!--[\s\S]*?-->/g, "");
}
var HARD_BREAK = "\uFFFE";
function markHardBreaks(text2) {
  const { mask } = scanCodeSpans(text2);
  let out = "";
  let i = 0;
  while (i < text2.length) {
    const ch = text2[i] ?? "";
    if (ch === "<" && !mask[i]) {
      const tag = RAW_TAG_LIKE_RE.exec(text2.slice(i))?.[0];
      if (tag) {
        out += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch !== "\n" || mask[i] || i === text2.length - 1) {
      out += ch;
      i++;
      continue;
    }
    let runStart = i;
    while (runStart > 0 && text2[runStart - 1] === " " && !mask[runStart - 1])
      runStart--;
    const spaces = i - runStart;
    let breaks = spaces >= 2;
    if (spaces === 0) {
      while (runStart > 0 && text2[runStart - 1] === "\\" && !mask[runStart - 1])
        runStart--;
      const backslashes = i - runStart;
      if (backslashes > 0 && backslashes % 2 === 1) {
        breaks = true;
        runStart = i - 1;
      } else {
        runStart = i;
      }
    }
    if (!breaks) {
      out += ch;
      i++;
      continue;
    }
    out = out.slice(0, out.length - (i - runStart)) + HARD_BREAK;
    i++;
    while (i < text2.length && (text2[i] === " " || text2[i] === "	"))
      i++;
  }
  return out;
}
function mapTextOutsideHtmlTags(text2, mapSegment) {
  const parts = [];
  let i = 0;
  while (i < text2.length) {
    const lt = text2.indexOf("<", i);
    if (lt === -1) {
      parts.push(mapSegment(text2.slice(i)));
      break;
    }
    if (lt > i)
      parts.push(mapSegment(text2.slice(i, lt)));
    const gt = text2.indexOf(">", lt);
    if (gt === -1) {
      parts.push(text2.slice(lt));
      break;
    }
    parts.push(text2.slice(lt, gt + 1));
    i = gt + 1;
  }
  return parts.join("");
}
function applyLineBreaks(text2, softBreak) {
  return mapTextOutsideHtmlTags(text2, (segment) => {
    let body = segment;
    if (softBreak === "space")
      body = body.replace(/\n/g, " ");
    else if (softBreak === "br")
      body = body.replace(/\n/g, "<br>");
    return body.replaceAll(HARD_BREAK, "<br>");
  });
}
function renderProseInline(text2, options = {}) {
  const { softBreak = "newline", linkRefs = /* @__PURE__ */ new Map() } = options;
  const body = markHardBreaks(decodeSafeMarkdownEntities(stripHtmlComments(text2)));
  const { text: withoutImages, images } = extractRawImages(body);
  const rendered = renderInlineSpans(withoutImages, linkRefs);
  return restoreRawImages(applyLineBreaks(rendered, softBreak), images);
}
function renderProseBlock(text2, linkRefs, softBreak = "newline") {
  if (stripHtmlComments(text2).trim() === "")
    return "";
  return renderProseInline(text2, { softBreak, linkRefs });
}

// dist/render-blocks.js
function renderFencedBlock(lang, code) {
  if (lang === "mermaid") {
    const body2 = escapeMermaidHtml(code.trimEnd());
    return `<div class="mermaid-diagram mermaid-diagram--pending"><pre class="mermaid">${body2}</pre></div>`;
  }
  const body = highlightFenceCode(code, lang);
  return `<pre><code class="${fenceCodeClass(lang)}">${body}</code></pre>`;
}
function renderIndentedCode(slice) {
  const lines = dropTrailingNewline(slice).split("\n");
  while (lines.length && (lines.at(-1) ?? "").trim() === "")
    lines.pop();
  const code = lines.map((l) => stripFourColumnIndent(l)).join("\n");
  if (code.trim() === "")
    return "";
  return `<pre><code>${escapeHtml(code)}
</code></pre>`;
}
function stripParagraphIndent(text2) {
  return text2.split("\n").map((line) => line.replace(/^ {0,3}(?=\S)/, "")).join("\n");
}
var stripBlockquoteLine = stripBlockquoteMarker;
var TASK_LIST_MARKER_RE = /^\[([ xX])\](?=\s|$)/;
function parseTaskListMarker(inner) {
  const m = TASK_LIST_MARKER_RE.exec(inner);
  if (!m)
    return null;
  const checked = (m[1] ?? "") !== " ";
  let rest = inner.slice(m[0].length);
  if (rest.startsWith(" "))
    rest = rest.slice(1);
  return { checked, rest };
}
function taskCheckboxHtml(checked) {
  return `<input type="checkbox" disabled${checked ? " checked" : ""}>`;
}
function dedentListItemContent(slice) {
  const lines = dropTrailingNewline(slice).split("\n");
  const first = lines.find((l) => l.trim() !== "") ?? "";
  const col = listItemContentColumn(first);
  const dedented = [];
  lines.forEach((rawLine, index) => {
    const line = index === 0 ? expandListPrefixTabs(rawLine) : expandLeadingTabs(rawLine);
    if (index === 0) {
      dedented.push(line.slice(Math.min(col, line.length)));
      return;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent >= col) {
      dedented.push(line.slice(col));
      return;
    }
    const stripped = line.slice(indent);
    const prev = dedented.at(-1);
    if (stripped.trim() !== "" && prev !== void 0 && prev.trim() !== "" && isAmbiguousBlockLine(stripped)) {
      dedented[dedented.length - 1] = `${prev} ${stripped}`;
      return;
    }
    dedented.push(stripped);
  });
  return dedented.join("\n");
}
function renderListItemContent(slice, listLoose, linkRefs) {
  let inner = dedentListItemContent(slice);
  if (inner.trim() === "")
    return { html: "", task: null };
  const task = parseTaskListMarker(inner);
  if (task)
    inner = task.rest;
  const html2 = renderBlocks(inner, tokenizeBlocks(inner), {
    linkRefs,
    tightParagraphs: !listLoose
  });
  return { html: html2, task };
}
function renderListItem(item) {
  if (item.task) {
    const box = taskCheckboxHtml(item.task.checked);
    const gap = item.html === "" ? "" : " ";
    return `<li class="task-list-item">${box}${gap}${item.html}</li>`;
  }
  return `<li>${item.html}</li>`;
}
function renderParagraph(slice, linkRefs, tight = false) {
  const body = stripParagraphIndent(dropTrailingNewline(slice));
  const rendered = renderProseBlock(body, linkRefs, tight ? "space" : "newline");
  if (rendered === "")
    return "";
  return tight ? rendered : `<p>${rendered}</p>`;
}
function renderAtxHeading(slice, linkRefs) {
  const line = dropTrailingNewline(slice).split("\n")[0] ?? "";
  const m = line.match(ATX_HEADING_CAPTURE_RE);
  if (!m?.[1])
    return renderParagraph(slice, linkRefs);
  const level = m[1].length;
  const text2 = stripAtxClosingHashes((m[2] ?? "").trimEnd());
  return `<h${String(level)}>${renderProseBlock(text2, linkRefs)}</h${String(level)}>`;
}
function renderSetextHeading(slice, linkRefs) {
  const lines = dropTrailingNewline(slice).split("\n");
  const text2 = lines.slice(0, -1).map((l) => l.trim()).join("\n");
  const underline = lines.at(-1) ?? "";
  const level = underline.trim().startsWith("=") ? 1 : 2;
  return `<h${String(level)}>${renderProseBlock(text2, linkRefs)}</h${String(level)}>`;
}
function renderTable(slice, linkRefs) {
  const lines = dropTrailingNewline(slice).split("\n").filter((l) => l.trim() !== "");
  const header = lines[0];
  if (!header)
    return "";
  const headerCells = splitTableRow(header);
  const body = lines.slice(2).map((row) => splitTableRow(row));
  const thead = `<thead><tr>${headerCells.map((c) => `<th>${renderProseBlock(c, linkRefs)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${renderProseBlock(c, linkRefs)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<table>${thead}${tbody}</table>`;
}
function stripBlockquoteSource(slice) {
  const out = [];
  for (const line of slice.split("\n")) {
    if (BLOCKQUOTE_DETECT_RE.test(line)) {
      out.push(stripBlockquoteLine(line));
      continue;
    }
    const prev = out.at(-1);
    if (line.trim() !== "" && prev !== void 0 && prev.trim() !== "") {
      out[out.length - 1] = `${prev} ${line.trim()}`;
      continue;
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}
function renderBlockquote(slice, linkRefs) {
  const innerSource = stripBlockquoteSource(slice);
  if (innerSource.trim() === "")
    return "<blockquote></blockquote>";
  return `<blockquote>${renderBlocksFromSource(innerSource, linkRefs)}</blockquote>`;
}
function isOrderedListSlice(slice) {
  const first = slice.split("\n").find((l) => l.trim() !== "") ?? "";
  return parseOrderedListMarker(first) !== null;
}
function sliceUnorderedMarkerChar(slice) {
  const first = slice.split("\n").find((l) => l.trim() !== "") ?? "";
  return unorderedListMarkerChar(first);
}
function orderedListStart(slice) {
  const first = slice.split("\n").find((l) => l.trim() !== "") ?? "";
  return parseOrderedListMarker(first) ?? 1;
}
function orderedListDelimiter(slice) {
  const first = slice.split("\n").find((l) => l.trim() !== "") ?? "";
  return orderedListMarkerDelimiter(first);
}
function listGroupSignature(firstSlice) {
  const ordered = isOrderedListSlice(firstSlice);
  return {
    ordered,
    markerChar: ordered ? null : sliceUnorderedMarkerChar(firstSlice),
    delimiter: ordered ? orderedListDelimiter(firstSlice) : null,
    start: ordered ? orderedListStart(firstSlice) : 1
  };
}
function listSliceContinuesGroup(sig, slice) {
  if (isOrderedListSlice(slice) !== sig.ordered)
    return false;
  if (sig.ordered)
    return orderedListDelimiter(slice) === sig.delimiter;
  return sliceUnorderedMarkerChar(slice) === sig.markerChar;
}
function listItemSliceIsMultiParagraph(slice) {
  const tokens = tokenizeBlocks(dedentListItemContent(slice));
  let seenBlock = false;
  let blankSince = false;
  for (const token of tokens) {
    if (token.kind === "blank") {
      if (seenBlock)
        blankSince = true;
      continue;
    }
    if (seenBlock && blankSince)
      return true;
    seenBlock = true;
  }
  return false;
}
function scanListGroup(source, tokens, start) {
  const firstToken = tokens[start];
  const firstSlice = firstToken ? source.slice(firstToken.start, firstToken.end) : "";
  const sig = listGroupSignature(firstSlice);
  const itemTokens = [];
  let loose = false;
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token)
      break;
    if (token.kind === "blank") {
      let k = i + 1;
      while (tokens[k]?.kind === "blank")
        k++;
      const next = tokens[k];
      if (next?.kind === "list_item" && listSliceContinuesGroup(sig, source.slice(next.start, next.end))) {
        loose = true;
        i = k;
        continue;
      }
      break;
    }
    if (token.kind !== "list_item")
      break;
    const slice = source.slice(token.start, token.end);
    if (!listSliceContinuesGroup(sig, slice))
      break;
    if (listItemSliceIsMultiParagraph(slice))
      loose = true;
    if (/\n[ \t]*\n$/.test(slice)) {
      const after = tokens[i + 1];
      if (after?.kind === "list_item" && listSliceContinuesGroup(sig, source.slice(after.start, after.end))) {
        loose = true;
      }
    }
    itemTokens.push(token);
    i++;
  }
  return { sig, itemTokens, loose, next: i };
}
function renderListItemsSlice(source, itemTokens, loose, linkRefs) {
  const items = itemTokens.map((t) => renderListItemContent(source.slice(t.start, t.end), loose, linkRefs));
  return {
    itemsHtml: items.map(renderListItem).join(""),
    anyTask: items.some((it) => it.task !== null)
  };
}
function listGroupOpenTag(sig, anyTask) {
  if (sig.ordered) {
    return `<ol${sig.start === 1 ? "" : ` start="${String(sig.start)}"`}>`;
  }
  return `<ul${anyTask ? ' class="contains-task-list"' : ""}>`;
}
function listGroupCloseTag(sig) {
  return sig.ordered ? "</ol>" : "</ul>";
}
function collectListGroup(source, tokens, start, linkRefs) {
  const scan = scanListGroup(source, tokens, start);
  const { itemsHtml, anyTask } = renderListItemsSlice(source, scan.itemTokens, scan.loose, linkRefs);
  return {
    html: `${listGroupOpenTag(scan.sig, anyTask)}${itemsHtml}${listGroupCloseTag(scan.sig)}`,
    next: scan.next
  };
}
function collectBlockquoteGroup(source, tokens, start, linkRefs) {
  const token = tokens[start];
  if (!token || token.kind !== "blockquote")
    return { html: "", next: start + 1 };
  return {
    html: renderBlockquote(source.slice(token.start, token.end), linkRefs),
    next: start + 1
  };
}
function renderSingleBlock(source, token, linkRefs, tightParagraphs, htmlFromIndent, indentedCode) {
  const slice = source.slice(token.start, token.end);
  switch (token.kind) {
    case "indented_code":
      if (!indentedCode) {
        return renderParagraph(dedentBlock(dropTrailingNewline(slice)), linkRefs, false);
      }
      if (htmlFromIndent && isIndentedHtmlBlock(dropTrailingNewline(slice))) {
        return renderParagraph(dedentBlock(dropTrailingNewline(slice)), linkRefs, false);
      }
      return renderIndentedCode(slice);
    case "fence": {
      const { lang, code } = parseFenceSlice(slice);
      return renderFencedBlock(lang, code);
    }
    case "atx_heading":
      return renderAtxHeading(slice, linkRefs);
    case "setext_heading":
      return renderSetextHeading(slice, linkRefs);
    case "thematic_break":
      return "<hr>";
    case "table":
      return renderTable(slice, linkRefs);
    /* c8 ignore start -- unreachable in practice: renderBlocks routes
       blockquote / list_item groups and skips blank / link_ref_def tokens before
       ever calling renderSingleBlock, and every BlockToken kind is enumerated
       above, so `default` never runs. Kept so the dispatch is total. */
    case "blockquote":
      return renderBlockquote(slice, linkRefs);
    case "list_item":
      return renderListItem(renderListItemContent(slice, false, linkRefs));
    case "link_ref_def":
    case "blank":
      return "";
    /* c8 ignore stop */
    case "paragraph":
      return renderParagraph(slice, linkRefs, tightParagraphs);
    /* c8 ignore next 2 -- unreachable: all kinds are enumerated above */
    default:
      return renderParagraph(slice, linkRefs, tightParagraphs);
  }
}
function renderBlocks(source, tokens, options = {}) {
  const linkRefs = options.linkRefs ?? /* @__PURE__ */ new Map();
  const tightParagraphs = options.tightParagraphs ?? false;
  const htmlFromIndent = options.htmlFromIndent ?? false;
  const indentedCode = options.indentedCode ?? true;
  const parts = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token)
      break;
    if (token.kind === "blank" || token.kind === "link_ref_def") {
      i++;
      continue;
    }
    if (token.kind === "list_item") {
      const group = collectListGroup(source, tokens, i, linkRefs);
      if (group.html)
        parts.push(group.html);
      i = group.next;
      continue;
    }
    if (token.kind === "blockquote") {
      const group = collectBlockquoteGroup(source, tokens, i, linkRefs);
      if (group.html)
        parts.push(group.html);
      i = group.next;
      continue;
    }
    const html2 = renderSingleBlock(source, token, linkRefs, tightParagraphs, htmlFromIndent, indentedCode);
    if (html2)
      parts.push(html2);
    i++;
  }
  return parts.join("\n");
}
function renderBlocksFromSource(source, linkRefs = /* @__PURE__ */ new Map()) {
  return renderBlocks(source, tokenizeBlocks(source), { linkRefs });
}

// dist/renderer.js
var TOP_LEVEL_RENDER_OPTS = { htmlFromIndent: true, indentedCode: true };
function renderMarkdown(raw, options = {}) {
  const tokens = options.tokens ?? tokenizeBlocks(raw);
  const linkRefs = collectLinkReferenceDefinitions(raw, tokens);
  return renderBlocks(raw, tokens, {
    linkRefs,
    htmlFromIndent: TOP_LEVEL_RENDER_OPTS.htmlFromIndent,
    indentedCode: options.indentedCode ?? TOP_LEVEL_RENDER_OPTS.indentedCode
  });
}

// dist/render-pending-line.js
var COMPLETE_LINK_AT_START_RE = /^!?\[[^\]]*\]\([^)]*\)/;
function revealFormingLink(text2) {
  if (!text2.includes("["))
    return text2;
  const { mask } = scanCodeSpans(text2);
  let open = -1;
  for (let i = text2.length - 1; i >= 0; i--) {
    if (text2[i] !== "[" || mask[i])
      continue;
    let backslashes = 0;
    for (let k = i - 1; k >= 0 && text2[k] === "\\"; k--)
      backslashes++;
    if (backslashes % 2 === 1)
      continue;
    open = i;
    break;
  }
  if (open === -1)
    return text2;
  const isImage = open > 0 && text2[open - 1] === "!";
  const startIdx = isImage ? open - 1 : open;
  if (COMPLETE_LINK_AT_START_RE.test(text2.slice(startIdx)))
    return text2;
  const afterBracket = text2.slice(open + 1);
  const closeRel = afterBracket.indexOf("]");
  if (closeRel === -1) {
    return text2.slice(0, startIdx) + afterBracket;
  }
  const label = afterBracket.slice(0, closeRel);
  const afterClose = afterBracket.slice(closeRel + 1);
  if (afterClose.startsWith("(")) {
    return text2.slice(0, startIdx) + label;
  }
  return text2;
}
var TOP_LEVEL_LIST_MARKER_RE = /^ {0,3}(?:(?:[-*+])(?:\s|$)|(?:\d{1,9}[.)]\s))/;
function isIncompleteListMarkerPrefix(pending) {
  return /^ {0,3}-(?=[^\s-\n])/.test(pending) || /^ {0,3}\*(?!\*)(?=[^\s\n])/.test(pending) || /^ {0,3}\+(?=[^\s\n])/.test(pending);
}
function matchPendingListMarker(pending) {
  return pending.match(TOP_LEVEL_LIST_MARKER_RE);
}
function dedentLazyContinuation(text2, itemFirstLine) {
  const col = listItemContentColumn(itemFirstLine);
  return text2.split("\n").map((line) => {
    const indent = line.match(/^ */)?.[0].length ?? 0;
    return line.slice(Math.min(indent, col));
  }).join("\n");
}
function stripParagraphIndent2(text2) {
  return text2.split("\n").map((line) => line.replace(/^ {0,3}(?=\S)/, "")).join("\n");
}
function pendingListMarkerLength(pending) {
  const match = matchPendingListMarker(pending);
  return match ? match[0].length : null;
}
function pendingListOrderedMarker(pending) {
  const match = pending.match(/^ {0,3}(\d{1,9})[.)]\s/);
  return match?.[1] ?? null;
}
function listPendingIndent(pending) {
  return pending.match(/^ */)?.[0].length ?? 0;
}
function pendingAtxHeadingLevel(pending) {
  const match = pending.match(ATX_HEADING_CAPTURE_RE);
  return match?.[1] ? match[1].length : null;
}
function pendingAtxHeadingTitle(pending) {
  const match = pending.match(ATX_HEADING_CAPTURE_RE);
  if (!match?.[1])
    return "";
  return stripAtxClosingHashes((match[2] ?? "").trimEnd());
}
function isPendingBlockquoteLine(pending) {
  return BLOCKQUOTE_DETECT_RE.test(pending);
}
function pendingBlockquoteBody(pending) {
  return stripBlockquoteMarker(pending);
}
function isListContinuationPending(pending, openListItemFirstLine2) {
  return openListItemFirstLine2 !== void 0 && openListItemFirstLine2 !== "" && isLazyListContinuation(openListItemFirstLine2, pending);
}
function renderStreamingInline(text2) {
  return renderProseInline(revealFormingLink(text2));
}
function renderPendingLine(pending, options = {}) {
  if (!pending)
    return "";
  const { openListItemFirstLine: openListItemFirstLine2 } = options;
  if (isListContinuationPending(pending, openListItemFirstLine2)) {
    const hold2 = pendingHoldIndex(pending);
    const visible2 = pending.slice(0, hold2);
    if (!visible2)
      return "";
    const dedented = dedentLazyContinuation(visible2, openListItemFirstLine2 ?? "");
    return renderStreamingInline(dedented);
  }
  const listMatch = matchPendingListMarker(pending);
  if (listMatch) {
    const hold2 = pendingHoldIndex(pending);
    const visible2 = pending.slice(0, hold2);
    if (!visible2)
      return "";
    const markerLen = listMatch[0].length;
    if (visible2.length <= markerLen)
      return "";
    return renderStreamingInline(visible2.slice(markerLen));
  }
  if (isIncompleteListMarkerPrefix(pending)) {
    return "";
  }
  if (pendingAtxHeadingLevel(pending) !== null) {
    const title = pendingAtxHeadingTitle(pending);
    if (!title)
      return "";
    const hold2 = pendingHoldIndex(title);
    const visible2 = title.slice(0, hold2);
    if (!visible2)
      return "";
    return renderStreamingInline(visible2);
  }
  if (isPendingBlockquoteLine(pending)) {
    const body = pendingBlockquoteBody(pending);
    if (!body.trim())
      return "";
    const hold2 = pendingHoldIndex(body);
    const visible2 = body.slice(0, hold2);
    if (!visible2)
      return "";
    return renderStreamingInline(visible2);
  }
  if (isAmbiguousBlockLine(pending)) {
    const hold2 = pendingHoldIndex(pending);
    const visible2 = pending.slice(0, hold2);
    if (!visible2)
      return "";
    return escapeHtml(decodeSafeMarkdownEntities(visible2));
  }
  const hold = pendingHoldIndex(pending);
  const visible = pending.slice(0, hold);
  if (!visible)
    return "";
  return renderStreamingInline(stripParagraphIndent2(visible));
}

// dist/streaming-split.js
function splitAtLastNewline(content) {
  const lastNl = content.lastIndexOf("\n");
  if (lastNl === -1)
    return { complete: "", pending: content };
  return {
    complete: content.slice(0, lastNl + 1),
    pending: content.slice(lastNl + 1)
  };
}
function splitOpenBlockAtLastNewline(block, content, extras = {}) {
  const openText = content.slice(block.start);
  const { complete: lineComplete, pending } = splitAtLastNewline(openText);
  return {
    complete: content.slice(0, block.start) + lineComplete,
    pending,
    ...extras
  };
}
function splitOpenParagraph(block, content) {
  const openText = content.slice(block.start);
  const inlineHold = pendingHoldIndex(openText);
  if (emphasisSpansNewline(openText) && inlineHold >= openText.length) {
    return {
      complete: content.slice(0, block.start),
      pending: content.slice(block.start)
    };
  }
  if (inlineHold < openText.length) {
    const cut = block.start + inlineHold;
    return { complete: content.slice(0, cut), pending: content.slice(cut) };
  }
  const split = splitOpenBlockAtLastNewline(block, content);
  if (split.pending !== "" && split.complete.length > block.start) {
    split.paragraphContinuation = true;
  }
  return split;
}
function openListItemFirstLine(block, content) {
  const slice = content.slice(block.start);
  const nl = slice.indexOf("\n");
  return nl === -1 ? slice : slice.slice(0, nl);
}
function splitOpenListItem(block, content) {
  return splitOpenBlockAtLastNewline(block, content, {
    openListItemFirstLine: openListItemFirstLine(block, content)
  });
}
function splitOpenTable(block, content) {
  const openText = content.slice(block.start);
  const lines = openText.split("\n");
  const sepLine = lines[1];
  if (!sepLine || !TABLE_SEP_RE.test(sepLine)) {
    return {
      complete: content.slice(0, block.start),
      pending: openText
    };
  }
  const headerSepEnd = (lines[0]?.length ?? 0) + 1 + sepLine.length;
  const afterSep = openText.slice(headerSepEnd);
  if (!afterSep.startsWith("\n") && lines.length <= 2) {
    return {
      complete: content.slice(0, block.start),
      pending: openText
    };
  }
  return splitOpenBlockAtLastNewline(block, content);
}
function splitForStreaming(content) {
  return splitForStreamingFrom(content, tokenizeBlocks(content));
}
function splitForStreamingFrom(content, blocks) {
  return { ...splitForStreamingCore(content, blocks), blocks };
}
function splitForStreamingCore(content, blocks) {
  const firstOpen = blocks.find((b) => b.status !== "complete");
  if (!firstOpen) {
    return splitAtLastNewline(content);
  }
  if (firstOpen.kind === "paragraph") {
    return splitOpenParagraph(firstOpen, content);
  }
  if (firstOpen.kind === "list_item") {
    return splitOpenListItem(firstOpen, content);
  }
  if (firstOpen.kind === "table") {
    return splitOpenTable(firstOpen, content);
  }
  const holdStart = streamingHoldStart(blocks);
  return {
    complete: content.slice(0, holdStart),
    pending: content.slice(holdStart)
  };
}

// dist/incremental-scan.js
function canExtendAcrossBlank(kind) {
  return kind === "list_item" || kind === "indented_code" || kind === "blockquote";
}
function advanceSafeBoundary(tokens, fromIdx, fromOffset, lastNonBlankKind) {
  let tokenCount = fromIdx;
  let offset = fromOffset;
  let lastKind = lastNonBlankKind;
  for (let i = fromIdx; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token)
      break;
    if (token.kind === "blank") {
      if (token.status === "complete" && (lastKind === null || !canExtendAcrossBlank(lastKind))) {
        tokenCount = i + 1;
        offset = token.end;
      }
      continue;
    }
    lastKind = token.kind;
  }
  return { tokenCount, offset, lastNonBlankKind: lastKind };
}
var IncrementalSourceScanner = class {
  tokens = [];
  /** Cached tokens `[0, safeTokenCount)` are final for any future suffix. */
  safeTokenCount = 0;
  /** Source offset of the safe boundary; scans resume here. */
  safeOffset = 0;
  /** The exact source bytes of `[0, safeOffset)` — the rewrite guard. */
  safePrefix = "";
  /** Nearest non-blank kind before the safe boundary (boundary-rule input). */
  lastNonBlankKind = null;
  /** Link-reference definitions found in `[0, safeOffset)` (first-wins). */
  refs = /* @__PURE__ */ new Map();
  /**
   * Diagnostic: total characters actually re-tokenized across all calls. The
   * #30 invariant is that this stays O(n) over a whole append-only stream —
   * a deterministic, timing-free regression test reads it.
   */
  scannedChars = 0;
  resetCache() {
    this.tokens = [];
    this.safeTokenCount = 0;
    this.safeOffset = 0;
    this.safePrefix = "";
    this.lastNonBlankKind = null;
    this.refs = /* @__PURE__ */ new Map();
  }
  /**
   * Tokenize `source`, reusing every token before the safe boundary. The
   * result is byte-identical to `tokenizeBlocks(source)`.
   */
  tokenize(source) {
    if (!source.startsWith(this.safePrefix))
      this.resetCache();
    const suffix = source.slice(this.safeOffset);
    this.scannedChars += suffix.length;
    const suffixTokens = tokenizeBlocks(suffix);
    const shifted = this.safeOffset === 0 ? suffixTokens : suffixTokens.map((t) => ({
      kind: t.kind,
      status: t.status,
      start: t.start + this.safeOffset,
      end: t.end + this.safeOffset
    }));
    const tokens = this.safeTokenCount === 0 ? shifted : this.tokens.slice(0, this.safeTokenCount).concat(shifted);
    const advanced = advanceSafeBoundary(tokens, this.safeTokenCount, this.safeOffset, this.lastNonBlankKind);
    if (advanced.offset > this.safeOffset) {
      const newlySafe = collectLinkReferenceDefinitions(source.slice(this.safeOffset, advanced.offset));
      for (const [label, ref] of newlySafe) {
        if (!this.refs.has(label))
          this.refs.set(label, ref);
      }
    }
    this.safeTokenCount = advanced.tokenCount;
    this.safeOffset = advanced.offset;
    this.lastNonBlankKind = advanced.lastNonBlankKind;
    this.safePrefix = source.slice(0, this.safeOffset);
    this.tokens = tokens;
    return tokens;
  }
  /**
   * Link-reference definitions of `source`, equal to
   * `collectLinkReferenceDefinitions(source)`. Must be called with the same
   * string as the latest {@link tokenize} call (the cache is keyed to it);
   * anything else falls back to a full scan.
   */
  linkRefs(source) {
    if (!source.startsWith(this.safePrefix)) {
      return collectLinkReferenceDefinitions(source);
    }
    const merged = new Map(this.refs);
    const suffixRefs = collectLinkReferenceDefinitions(source.slice(this.safeOffset));
    for (const [label, ref] of suffixRefs) {
      if (!merged.has(label))
        merged.set(label, ref);
    }
    return merged;
  }
};

// dist/sanitize-browser.js
function isBrowserSanitizerSupported() {
  return typeof document !== "undefined" && typeof Element.prototype.setHTML === "function";
}
var DROP_CONTENT_TAGS = /* @__PURE__ */ new Set(["script", "style", "noscript", "template", "title"]);
function unwrap(el) {
  const parent = el.parentNode;
  if (parent) {
    while (el.firstChild)
      parent.insertBefore(el.firstChild, el);
  }
  el.remove();
}
function enforceSanitizerAllowlist(root, config) {
  const allowedTags = new Set(config.allowedTags.map((t) => t.toLowerCase()));
  const allowedAttr = new Set(config.allowedAttr.map((a) => a.toLowerCase()));
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (!root.contains(el))
      continue;
    const tag = el.tagName.toLowerCase();
    if (!allowedTags.has(tag)) {
      if (DROP_CONTENT_TAGS.has(tag))
        el.remove();
      else
        unwrap(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      if (!allowedAttr.has(attr.name.toLowerCase()))
        el.removeAttribute(attr.name);
    }
    config.onElement?.(el, tag);
  }
}
var browserSanitizerBackend = {
  sanitize(html2, config) {
    const host = document.createElement("div");
    const el = host;
    try {
      el.setHTML(html2, {
        sanitizer: { elements: config.allowedTags, attributes: config.allowedAttr }
      });
    } catch {
      el.setHTML(html2);
    }
    enforceSanitizerAllowlist(host, config);
    return host.innerHTML;
  }
};

// dist/sanitize.js
var ALLOWED_TAGS = [
  "a",
  "p",
  "br",
  "hr",
  "strong",
  "em",
  "code",
  "pre",
  "span",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "blockquote",
  // Benign raw inline HTML the renderer passes through unescaped (see
  // BENIGN_RAW_INLINE_TAG_RE in escape.ts) — attribute-less phrasing tags only.
  "b",
  "i",
  "u",
  "s",
  "del",
  "ins",
  "sub",
  "sup",
  "kbd",
  "mark",
  // GFM task-list checkboxes (#614). The renderer only ever emits the fixed,
  // read-only form `<input type="checkbox" disabled [checked]>` inside an
  // `<li class="task-list-item">`. Only `type`/`checked`/`disabled` are allowed
  // below, and the core element gate drops any non-checkbox `<input>`, so no
  // interactive/form payload can survive.
  "input"
];
var ALLOWED_ATTR = [
  "href",
  "target",
  "rel",
  "class",
  "data-browser-link",
  "data-workspace-link",
  "data-ordered-marker",
  // Task-list checkbox attributes (#614) — read-only booleans, no XSS surface.
  "type",
  "checked",
  "disabled"
];
var sanitizerBackend = null;
function setSanitizerBackend(backend) {
  sanitizerBackend = backend;
}
var sanitizeExtension = null;
function gateElement(node, tagName) {
  if (tagName === "input") {
    if (node.getAttribute("type") !== "checkbox") {
      node.remove();
      return;
    }
    node.setAttribute("disabled", "");
    return;
  }
  sanitizeExtension?.onElement?.(node, tagName);
}
function resolveBackend() {
  if (sanitizerBackend)
    return sanitizerBackend;
  if (isBrowserSanitizerSupported())
    return browserSanitizerBackend;
  throw new Error('No HTML sanitizer backend is available. Call setSanitizerBackend() before rendering \u2014 e.g. `import { dompurifyBackend } from "@copse/streaming-markdown/sanitizers/dompurify"` in Node/jsdom or older browsers \u2014 or run where the native Sanitizer API (Element.setHTML) exists.');
}
var DOUBLE_ENCODED_NBSP_RE = /&amp;(?:nbsp|#160|#x0*a);/gi;
function sanitizeRenderedMarkdown(html2) {
  const extension = sanitizeExtension;
  const allowedTags = extension?.allowedTags ? [...ALLOWED_TAGS, ...extension.allowedTags] : ALLOWED_TAGS;
  const allowedAttr = extension?.allowedAttr ? [...ALLOWED_ATTR, ...extension.allowedAttr] : ALLOWED_ATTR;
  const sanitized = resolveBackend().sanitize(html2, {
    allowedTags,
    allowedAttr,
    onElement: gateElement
  });
  return sanitized.replace(DOUBLE_ENCODED_NBSP_RE, "\xA0");
}

// dist/streaming-table-dom.js
var FORMING_TABLE_CLASS = "stream-table-forming";
var PENDING_ROW_CLASS = "stream-pending-row";
var SEPARATOR_ROW_CLASS = "stream-table-separator-pending";
function tableLines(source) {
  const trimmed = dropTrailingNewline(source);
  if (trimmed === "")
    return [];
  return trimmed.split("\n");
}
function visibleCellSource(raw) {
  return raw.slice(0, pendingHoldIndex(raw));
}
function renderStreamingTableCell(raw) {
  const visible = visibleCellSource(raw);
  return visible ? sanitizeRenderedMarkdown(renderStreamingInline(visible)) : "";
}
function setStreamingCellContent(cell, raw) {
  cell.innerHTML = renderStreamingTableCell(raw);
}
function ensureRow(parent, index) {
  return parent.rows[index] ?? parent.insertRow();
}
function syncRowCells(row, cells, tag) {
  while (row.cells.length < cells.length) {
    row.appendChild(document.createElement(tag));
  }
  while (row.cells.length > cells.length) {
    row.lastElementChild?.remove();
  }
  cells.forEach((raw, i) => {
    const cell = row.cells[i];
    if (cell)
      setStreamingCellContent(cell, raw);
  });
}
function syncFormingTableDom(container, source) {
  const lines = tableLines(source);
  if (lines.length === 0) {
    container.replaceChildren();
    return;
  }
  const existing = container.querySelector(`table.${FORMING_TABLE_CLASS}`);
  let table;
  if (existing instanceof Element && existing.tagName === "TABLE") {
    table = existing;
  } else {
    container.replaceChildren();
    table = document.createElement("table");
    table.className = FORMING_TABLE_CLASS;
    table.append(document.createElement("thead"), document.createElement("tbody"));
    container.appendChild(table);
  }
  const thead = table.tHead ?? table.createTHead();
  const tbody = table.tBodies[0] ?? table.createTBody();
  tbody.replaceChildren();
  const headerLine = lines[0];
  if (!headerLine)
    return;
  syncRowCells(ensureRow(thead, 0), splitTableRow(headerLine), "th");
  const sepLine = lines[1];
  if (!sepLine)
    return;
  if (!TABLE_SEP_RE.test(sepLine)) {
    const sepRow = tbody.insertRow();
    sepRow.className = SEPARATOR_ROW_CLASS;
    const colCount = Math.max(thead.rows[0]?.cells.length ?? 1, splitTableRow(sepLine).length, 1);
    syncRowCells(sepRow, Array.from({ length: colCount }, () => sepLine.trim()), "td");
    return;
  }
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes("|"))
      continue;
    const row = tbody.insertRow();
    if (i === lines.length - 1 && !source.endsWith("\n")) {
      row.className = PENDING_ROW_CLASS;
    }
    syncRowCells(row, splitTableRow(line), "td");
  }
}
function syncPendingTableRowDom(table, pendingRow) {
  const cells = splitTableRow(pendingRow);
  const headerCols = table.tHead?.rows[0]?.cells.length;
  const colCount = headerCols ?? Math.max(cells.length, 1);
  let tbody = table.tBodies[0];
  if (!tbody) {
    tbody = table.createTBody();
  }
  let row = tbody.querySelector(`tr.${PENDING_ROW_CLASS}`);
  if (!(row instanceof Element) || row.tagName !== "TR") {
    tbody.querySelectorAll(`tr.${PENDING_ROW_CLASS}`).forEach((r) => {
      r.remove();
    });
    row = tbody.insertRow();
    row.className = PENDING_ROW_CLASS;
  }
  syncRowCells(row, Array.from({ length: colCount }, (_, i) => cells[i] ?? ""), "td");
}
function clearFormingTableDom(container) {
  container.replaceChildren();
}
function removePendingTableRow(table) {
  table.querySelector(`tr.${PENDING_ROW_CLASS}`)?.remove();
}
function appendPendingTableRowHtml(rendered, pendingRow) {
  const cells = splitTableRow(pendingRow);
  const headerMatch = rendered.match(/<thead>[\s\S]*?<\/thead>/g);
  const lastHeader = headerMatch?.at(-1) ?? "";
  const headerCols = (lastHeader.match(/<th[\s>]/g) ?? []).length;
  const colCount = headerCols > 0 ? headerCols : Math.max(cells.length, 1);
  const rowHtml = Array.from({ length: colCount }, (_, i) => {
    const inner = renderStreamingTableCell(cells[i] ?? "");
    return `<td>${inner}</td>`;
  }).join("");
  const pendingRowHtml = `<tr class="${PENDING_ROW_CLASS}">${rowHtml}</tr>`;
  const closeTbody = "</tbody>";
  const closeIndex = rendered.lastIndexOf(closeTbody);
  if (closeIndex === -1)
    return `${rendered}${pendingRowHtml}`;
  return `${rendered.slice(0, closeIndex)}${pendingRowHtml}${rendered.slice(closeIndex)}`;
}
function buildFormingTableHtml(source) {
  const lines = tableLines(source);
  if (lines.length === 0)
    return "";
  const headerLine = lines[0];
  if (!headerLine)
    return "";
  const headerCells = splitTableRow(headerLine).map((c) => `<th>${renderStreamingTableCell(c)}</th>`).join("");
  const parts = [
    `<table class="${FORMING_TABLE_CLASS}"><thead><tr>${headerCells}</tr></thead><tbody>`
  ];
  const sepLine = lines[1];
  if (sepLine && !TABLE_SEP_RE.test(sepLine)) {
    parts.push(`<tr class="${SEPARATOR_ROW_CLASS}"><td>${escapeHtml(sepLine.trim())}</td></tr>`);
  } else if (sepLine && TABLE_SEP_RE.test(sepLine)) {
    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line?.includes("|"))
        continue;
      const cells = splitTableRow(line).map((c) => `<td>${renderStreamingTableCell(c)}</td>`).join("");
      const rowClass = i === lines.length - 1 && !source.endsWith("\n") ? ` class="${PENDING_ROW_CLASS}"` : "";
      parts.push(`<tr${rowClass}>${cells}</tr>`);
    }
  }
  parts.push("</tbody></table>");
  return parts.join("");
}

// dist/streaming-fence-dom.js
var FORMING_FENCE_PRE_CLASS = "stream-fence-forming";
function renderFormingFenceInner(lang, code) {
  if (lang === "mermaid") {
    const body2 = escapeMermaidHtml(code);
    return `<div class="mermaid-diagram mermaid-diagram--pending ${FORMING_FENCE_PRE_CLASS}"><pre class="mermaid">${body2}</pre></div>`;
  }
  const body = highlightFenceCode(code, lang);
  return `<pre class="${FORMING_FENCE_PRE_CLASS}"><code class="${fenceCodeClass(lang)}">${body}</code></pre>`;
}
function buildFormingFenceHtml(source) {
  const parsed = parseOpenFenceContent(source);
  if (!parsed)
    return "";
  return sanitizeRenderedMarkdown(renderFormingFenceInner(parsed.lang, parsed.code));
}
function syncFormingFenceDom(container, source) {
  const parsed = parseOpenFenceContent(source);
  if (!parsed) {
    container.replaceChildren();
    return;
  }
  const { lang, code } = parsed;
  if (lang === "mermaid") {
    let diagram = container.querySelector(`.mermaid-diagram.${FORMING_FENCE_PRE_CLASS}`);
    if (!diagram) {
      container.replaceChildren();
      diagram = document.createElement("div");
      diagram.className = `mermaid-diagram mermaid-diagram--pending ${FORMING_FENCE_PRE_CLASS}`;
      const pre3 = document.createElement("pre");
      pre3.className = "mermaid";
      diagram.append(pre3);
      container.append(diagram);
    }
    const pre2 = diagram.querySelector("pre.mermaid");
    if (pre2)
      pre2.textContent = code;
    return;
  }
  let pre = container.querySelector(`pre.${FORMING_FENCE_PRE_CLASS}`);
  if (!pre) {
    container.replaceChildren();
    pre = document.createElement("pre");
    pre.className = FORMING_FENCE_PRE_CLASS;
    const codeEl2 = document.createElement("code");
    pre.append(codeEl2);
    container.append(pre);
  }
  const codeEl = pre.querySelector("code");
  if (codeEl) {
    codeEl.className = fenceCodeClass(lang);
    codeEl.innerHTML = sanitizeRenderedMarkdown(highlightFenceCode(code, lang));
  }
}
function clearFormingFenceDom(container) {
  container.replaceChildren();
}

// dist/streaming-dom-morph.js
var TEXT_NODE = 3;
var ELEMENT_NODE = 1;
var COMMENT_NODE = 8;
function attributesEqual(a, b) {
  const aAttrs = a.attributes;
  const bAttrs = b.attributes;
  if (aAttrs.length !== bAttrs.length)
    return false;
  for (let i = 0; i < aAttrs.length; i++) {
    const aAttr = aAttrs[i];
    const bAttr = bAttrs[i];
    if (!aAttr || !bAttr)
      return false;
    if (aAttr.name !== bAttr.name || aAttr.value !== bAttr.value)
      return false;
  }
  return true;
}
function canReuse(node, next) {
  if (node.nodeType !== next.nodeType)
    return false;
  if (node.nodeType === ELEMENT_NODE) {
    return node.tagName === next.tagName && attributesEqual(node, next);
  }
  if (node.nodeType === TEXT_NODE)
    return true;
  if (node.nodeType === COMMENT_NODE)
    return true;
  return false;
}
function morphChildren(parent, template, offset = 0) {
  const nextChildren = Array.from(template.childNodes);
  for (let i = 0; i < nextChildren.length; i++) {
    const next = nextChildren[i];
    if (!next)
      continue;
    const current = parent.childNodes[offset + i];
    if (!current) {
      parent.appendChild(next);
      continue;
    }
    if (canReuse(current, next)) {
      if (current.nodeType === ELEMENT_NODE) {
        morphChildren(current, next);
      } else if (current.nodeType === TEXT_NODE || current.nodeType === COMMENT_NODE) {
        if (current.data !== next.data) {
          ;
          current.data = next.data;
        }
      }
    } else {
      parent.replaceChild(next, current);
    }
  }
  while (parent.childNodes.length > offset + nextChildren.length) {
    parent.lastChild?.remove();
  }
}
function morphInnerHtml(container, html2) {
  morphInnerHtmlFrom(container, 0, html2);
}
function morphInnerHtmlFrom(container, startIndex, html2) {
  if (html2 === "") {
    while (container.childNodes.length > startIndex)
      container.lastChild?.remove();
    return;
  }
  const template = container.cloneNode(false);
  template.innerHTML = html2;
  morphChildren(container, template, startIndex);
}
function morphElementChildrenFrom(el, template, offset) {
  morphChildren(el, template, offset);
}
function syncAttributes(el, template) {
  if (attributesEqual(el, template))
    return;
  while (el.attributes.length > 0) {
    const attr = el.attributes[0];
    if (!attr)
      break;
    el.removeAttribute(attr.name);
  }
  for (let i = 0; i < template.attributes.length; i++) {
    const attr = template.attributes[i];
    if (attr)
      el.setAttribute(attr.name, attr.value);
  }
}

// dist/streaming-frozen-tail.js
var RENDER_OPTS = TOP_LEVEL_RENDER_OPTS;
var INTRA_LIST_MIN_ITEMS = 4;
function settleClassOf(kind) {
  switch (kind) {
    case "fence":
    case "atx_heading":
    case "setext_heading":
    case "thematic_break":
      return "immutable";
    case "paragraph":
    case "table":
      return "settled-after-blank";
    case "list_item":
    case "blockquote":
    case "indented_code":
      return "grouping";
    case "blank":
    case "link_ref_def":
      return "separator";
  }
}
function settledTailStart(tokens) {
  let i = tokens.length - 1;
  let blankFollows = false;
  while (i >= 0) {
    const token = tokens[i];
    if (!token)
      return tokens.length;
    if (settleClassOf(token.kind) === "separator" && token.status === "complete") {
      blankFollows = true;
      i--;
      continue;
    }
    break;
  }
  if (i < 0)
    return tokens.length;
  const last = tokens[i];
  if (!last)
    return tokens.length;
  const cls = settleClassOf(last.kind);
  const settled = last.status === "complete" && (cls === "immutable" || cls === "settled-after-blank" && blankFollows);
  if (settled)
    return i + 1;
  if (cls !== "grouping")
    return i;
  let s = i;
  while (s - 1 >= 0) {
    const prev = tokens[s - 1];
    if (prev && (prev.kind === last.kind || prev.kind === "blank")) {
      s--;
      continue;
    }
    break;
  }
  while (s < i && tokens[s]?.kind === "blank")
    s++;
  return s;
}
function lowerBound(tokens, offset) {
  let lo = 0;
  let hi = tokens.length;
  while (lo < hi) {
    const mid = lo + hi >> 1;
    const tok = tokens[mid];
    if (tok && tok.start < offset)
      lo = mid + 1;
    else
      hi = mid;
  }
  return lo;
}
function tokenStraddles(tokens, offset) {
  const idx = lowerBound(tokens, offset);
  const prev = idx > 0 ? tokens[idx - 1] : void 0;
  return prev !== void 0 && prev.end > offset;
}
function serializeLinkRefs(refs) {
  if (refs.size === 0)
    return "";
  const entries2 = [];
  for (const [label, ref] of refs) {
    entries2.push(JSON.stringify([label, ref.href, ref.title ?? ""]));
  }
  return entries2.sort().join("\n");
}
var BENIGN_BALANCED_TAGS = ["b", "i", "u", "s", "del", "ins", "sub", "sup", "kbd", "mark"];
function hasUnbalancedBenignRawInline(html2) {
  for (const tag of BENIGN_BALANCED_TAGS) {
    const opens = html2.match(new RegExp(`<${tag}(?=[\\s/>])`, "gi"))?.length ?? 0;
    if (opens === 0)
      continue;
    const closes = html2.match(new RegExp(`</${tag}>`, "gi"))?.length ?? 0;
    if (opens !== closes)
      return true;
  }
  return false;
}
var FrozenTailRenderer = class {
  /** Source offset; DOM for `[0, frozenEnd)` is final and never re-rendered. */
  frozenEnd = 0;
  /** Exact source text of `[0, frozenEnd)` — guards non-append-only updates. */
  frozenSource = "";
  /** Whether any frozen block rendered non-empty HTML (drives the `'\n'` seam). */
  frozenHasHtml = false;
  /** Counted number of `completedEl` children that are frozen. */
  frozenNodeCount = 0;
  /** Serialized committed link-ref map at the last commit (invalidation guard). */
  lastLinkRefKey = "";
  /**
   * Diagnostic: cumulative count of HTML characters this renderer has produced
   * (delta + tail per commit, or the whole document on a full-morph fallback).
   * The invariant #21 protects is that this stays O(n) over a whole stream, not
   * O(n²); a deterministic, timing-free perf-regression test reads it. Never
   * consumed by production code.
   */
  renderedChars = 0;
  // ---- Intra-list freezing (#29) ----------------------------------------
  // When the trailing group is a long, still-open, signature-uniform list, the
  // whole group would otherwise stay in the tail and be re-rendered per commit
  // (O(n²) for list-shaped output). Instead, settled items freeze INSIDE the
  // shared <ul>/<ol>: `frozenEnd` then points at an item-token boundary within
  // the group, the list element itself stays live (its attributes may still
  // change), and per-commit work is the unfrozen item slice only.
  /** Signature of the active shared trailing list; null = intra-list inactive. */
  listSig = null;
  /** Number of leading `<li>` children of the shared list that are frozen. */
  listFrozenLis = 0;
  /** Child index of the shared list element within `completedEl`. */
  listElIndex = 0;
  /** Looseness baked into the frozen items (a flip forces a full morph). */
  listLoose = false;
  /** Task-list evidence seen so far (drives the `<ul>` class; monotonic). */
  listHasTask = false;
  resetListState() {
    this.listSig = null;
    this.listFrozenLis = 0;
    this.listElIndex = 0;
    this.listLoose = false;
    this.listHasTask = false;
  }
  reset() {
    this.frozenEnd = 0;
    this.frozenSource = "";
    this.frozenHasHtml = false;
    this.frozenNodeCount = 0;
    this.lastLinkRefKey = "";
    this.resetListState();
  }
  /**
   * Reconcile `completedEl` so it serializes byte-identically to
   * `sanitizeRenderedMarkdown(renderMarkdown(complete))`, freezing the settled
   * prefix and re-rendering only the tail group. `tokens` must be
   * `tokenizeBlocks(complete)` (threaded from the caller, Layer 1), and
   * `providedLinkRefs`, when given, must equal
   * `collectLinkReferenceDefinitions(complete)` (threaded from the caller's
   * incremental scanner, #30 — saves the per-commit O(prefix) ref scan).
   */
  update(completedEl, complete, tokens, providedLinkRefs) {
    if (complete === "") {
      if (completedEl.childNodes.length > 0)
        completedEl.replaceChildren();
      this.reset();
      return;
    }
    const linkRefs = providedLinkRefs ?? collectLinkReferenceDefinitions(complete, tokens);
    const linkRefKey = serializeLinkRefs(linkRefs);
    const tailStart = settledTailStart(tokens);
    const tailToken = tokens[tailStart];
    const settledOffset = tailToken ? tailToken.start : complete.length;
    if (linkRefKey !== this.lastLinkRefKey || !complete.startsWith(this.frozenSource) || tokenStraddles(tokens, this.frozenEnd)) {
      this.fullMorph(completedEl, complete, tokens, linkRefKey);
      return;
    }
    if (this.listSig) {
      const outcome = this.commitSharedList(completedEl, complete, tokens, linkRefs, linkRefKey);
      if (outcome === "fallback") {
        this.fullMorph(completedEl, complete, tokens, linkRefKey);
        return;
      }
      if (outcome === "handled")
        return;
    }
    const advanceTo = Math.max(settledOffset, this.frozenEnd);
    const deltaFrom = lowerBound(tokens, this.frozenEnd);
    const deltaTo = lowerBound(tokens, advanceTo);
    const deltaTokens = tokens.slice(deltaFrom, deltaTo);
    const tailTokens = tokens.slice(deltaTo);
    const deltaHtml = deltaTokens.length ? renderBlocks(complete, deltaTokens, { linkRefs, ...RENDER_OPTS }) : "";
    if (deltaHtml !== "" && hasUnbalancedBenignRawInline(deltaHtml)) {
      this.fullMorph(completedEl, complete, tokens, linkRefKey);
      return;
    }
    const tailHtml = tailTokens.length ? renderBlocks(complete, tailTokens, { linkRefs, ...RENDER_OPTS }) : "";
    this.renderedChars += deltaHtml.length + tailHtml.length;
    const parts = [];
    if (deltaHtml !== "")
      parts.push(sanitizeRenderedMarkdown(deltaHtml));
    if (tailHtml !== "")
      parts.push(sanitizeRenderedMarkdown(tailHtml));
    const lead = this.frozenHasHtml && parts.length > 0 ? "\n" : "";
    morphInnerHtmlFrom(completedEl, this.frozenNodeCount, parts.length > 0 ? lead + parts.join("\n") : "");
    if (deltaHtml !== "") {
      const probe = completedEl.cloneNode(false);
      probe.innerHTML = lead + (parts[0] ?? "");
      this.frozenNodeCount += probe.childNodes.length;
      this.frozenHasHtml = true;
    }
    this.frozenEnd = advanceTo;
    this.frozenSource = complete.slice(0, advanceTo);
    this.lastLinkRefKey = linkRefKey;
    this.maybeActivateIntraList(completedEl, complete, tokens, tailStart);
  }
  /**
   * Arm intra-list freezing when the generic commit just rendered a trailing
   * group that qualifies: a signature-uniform list, starting at the frozen
   * boundary, still open (nothing after it but blanks), with enough items to be
   * worth per-item bookkeeping. Pure state initialization — no DOM work, and no
   * items are frozen yet: the next commit's shared-list pass freezes them
   * through the normal path (including the raw-inline balance check).
   */
  maybeActivateIntraList(completedEl, complete, tokens, tailStart) {
    const first = tokens[tailStart];
    if (!first || first.kind !== "list_item" || first.start < this.frozenEnd)
      return;
    const scan = scanListGroup(complete, tokens, tailStart);
    if (scan.itemTokens.length < INTRA_LIST_MIN_ITEMS)
      return;
    for (let i = scan.next; i < tokens.length; i++) {
      if (tokens[i]?.kind !== "blank")
        return;
    }
    const lastIdx = completedEl.childNodes.length - 1;
    const el = completedEl.childNodes[lastIdx];
    if (!(el instanceof HTMLElement) || el.tagName !== (scan.sig.ordered ? "OL" : "UL"))
      return;
    this.listSig = scan.sig;
    this.listFrozenLis = 0;
    this.listElIndex = lastIdx;
    this.listLoose = scan.loose;
    this.listHasTask = false;
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
  commitSharedList(completedEl, complete, tokens, linkRefs, linkRefKey) {
    const sig = this.listSig;
    if (!sig)
      return "fallback";
    const wantTag = sig.ordered ? "OL" : "UL";
    const listEl = completedEl.childNodes[this.listElIndex];
    if (!(listEl instanceof HTMLElement) || listEl.tagName !== wantTag)
      return "fallback";
    const unfrozenItems = [];
    let looseEvidence = false;
    let blankPending = false;
    let ended = false;
    for (let i = lowerBound(tokens, this.frozenEnd); i < tokens.length; i++) {
      const token = tokens[i];
      if (!token)
        break;
      if (token.kind === "blank") {
        blankPending = true;
        continue;
      }
      if (token.kind === "list_item" && listSliceContinuesGroup(sig, complete.slice(token.start, token.end))) {
        if (blankPending)
          looseEvidence = true;
        blankPending = false;
        if (listItemSliceIsMultiParagraph(complete.slice(token.start, token.end))) {
          looseEvidence = true;
        }
        unfrozenItems.push(token);
        continue;
      }
      ended = true;
      break;
    }
    const currentLoose = this.listLoose || looseEvidence;
    if (currentLoose !== this.listLoose) {
      if (this.listFrozenLis > 0)
        return "fallback";
      this.listLoose = currentLoose;
    }
    const freezeCount = ended ? unfrozenItems.length : Math.max(0, unfrozenItems.length - 1);
    const deltaItems = unfrozenItems.slice(0, freezeCount);
    const tailItems = unfrozenItems.slice(freezeCount);
    const delta = renderListItemsSlice(complete, deltaItems, this.listLoose, linkRefs);
    if (delta.itemsHtml !== "" && hasUnbalancedBenignRawInline(delta.itemsHtml))
      return "fallback";
    const tail = renderListItemsSlice(complete, tailItems, this.listLoose, linkRefs);
    this.renderedChars += delta.itemsHtml.length + tail.itemsHtml.length;
    const hasTask = this.listHasTask || delta.anyTask || tail.anyTask;
    const open = listGroupOpenTag(sig, hasTask);
    const close = listGroupCloseTag(sig);
    const templateHost = completedEl.cloneNode(false);
    templateHost.innerHTML = sanitizeRenderedMarkdown(`${open}${delta.itemsHtml}${tail.itemsHtml}${close}`);
    const templateList = templateHost.firstElementChild;
    if (!(templateList instanceof HTMLElement) || templateList.tagName !== wantTag) {
      return "fallback";
    }
    syncAttributes(listEl, templateList);
    morphElementChildrenFrom(listEl, templateList, this.listFrozenLis);
    if (freezeCount > 0) {
      const countHost = completedEl.cloneNode(false);
      countHost.innerHTML = sanitizeRenderedMarkdown(`${open}${delta.itemsHtml}${close}`);
      this.listFrozenLis += countHost.firstElementChild?.childNodes.length ?? 0;
      const lastFrozen = deltaItems[deltaItems.length - 1];
      if (lastFrozen) {
        this.frozenEnd = lastFrozen.end;
        this.frozenSource = complete.slice(0, this.frozenEnd);
      }
    }
    this.listHasTask = hasTask;
    this.lastLinkRefKey = linkRefKey;
    if (ended) {
      this.frozenNodeCount = this.listElIndex + 1;
      this.frozenHasHtml = true;
      this.resetListState();
      return "sealed";
    }
    while (completedEl.childNodes.length > this.listElIndex + 1) {
      completedEl.lastChild?.remove();
    }
    return "handled";
  }
  fullMorph(completedEl, complete, tokens, linkRefKey) {
    const html2 = sanitizeRenderedMarkdown(renderMarkdown(complete, { tokens }));
    this.renderedChars += html2.length;
    morphInnerHtml(completedEl, html2);
    this.frozenEnd = 0;
    this.frozenSource = "";
    this.frozenHasHtml = false;
    this.frozenNodeCount = 0;
    this.lastLinkRefKey = linkRefKey;
    this.resetListState();
  }
};

// dist/streaming.js
var BLOCK_PENDING_CLASS = "stream-pending-block";
var LIST_CONTINUATION_CLASS = "stream-pending-list-continuation";
var PARAGRAPH_CONTINUATION_CLASS = "stream-pending-paragraph-continuation";
var TRAILING_OPEN_LI_CLOSE_RE = /(<li(?:\s[^>]*)?>)([\s\S]*?)(<\/li>\s*<\/(?:ul|ol)>)\s*$/;
function tailPendingDescendant(completedEl, selector) {
  return completedEl.lastElementChild?.querySelector(selector) ?? null;
}
function tailDirectPendingBlock(completedEl, excludeLi) {
  const last = completedEl.lastElementChild;
  if (!last || !last.classList.contains(BLOCK_PENDING_CLASS))
    return null;
  if (excludeLi && last.tagName === "LI")
    return null;
  return last;
}
function insertBeforeTrailingListClose(rendered, insertHtml) {
  const liClose = rendered.match(TRAILING_OPEN_LI_CLOSE_RE)?.[3];
  if (!liClose)
    return null;
  return `${rendered.slice(0, -liClose.length)}${insertHtml}${liClose}`;
}
function clearBlockPendingDom(completedEl, parts) {
  if (parts.includes("continuation"))
    clearListContinuationDom(completedEl);
  if (parts.includes("paragraph-continuation"))
    clearParagraphContinuationDom(completedEl);
  if (parts.includes("list-items")) {
    tailPendingDescendant(completedEl, `li.${BLOCK_PENDING_CLASS}`)?.remove();
  }
  if (parts.includes("direct-blocks")) {
    tailDirectPendingBlock(completedEl, false)?.remove();
  }
  if (parts.includes("non-list-direct")) {
    tailDirectPendingBlock(completedEl, true)?.remove();
  }
}
function renderPendingInlineMarkdown(pending, openListItemFirstLine2) {
  if (openListItemFirstLine2 === void 0)
    return renderPendingLine(pending);
  return renderPendingLine(pending, { openListItemFirstLine: openListItemFirstLine2 });
}
function isBlockLevelPending(pending, openListItemFirstLine2) {
  if (!pending.trim() || pending.includes("\n"))
    return false;
  if (pendingListMarkerLength(pending) !== null)
    return true;
  if (pendingAtxHeadingLevel(pending) !== null)
    return true;
  if (isPendingBlockquoteLine(pending))
    return true;
  if (isListContinuationPending(pending, openListItemFirstLine2))
    return true;
  return !isAmbiguousBlockLine(pending);
}
function blockPendingTag(pending, openListItemFirstLine2) {
  if (isListContinuationPending(pending, openListItemFirstLine2))
    return "span";
  if (pendingListMarkerLength(pending) !== null)
    return "li";
  if (pendingAtxHeadingLevel(pending) !== null)
    return "div";
  if (isPendingBlockquoteLine(pending))
    return "blockquote";
  return "p";
}
function pendingListTag(pending) {
  return pendingListOrderedMarker(pending) !== null ? "ol" : "ul";
}
function blockPendingLiHtml(pending, pendingInner, openListItemFirstLine2) {
  const inner = wrapBlockPendingInner(pending, pendingInner);
  return `<li class="${blockPendingClassName(pending, openListItemFirstLine2)}"${blockPendingAttrs(pending)}>${inner}</li>`;
}
function appendListPendingHtml(rendered, pending, pendingInner, openListItemFirstLine2) {
  const listTag = pendingListTag(pending);
  const liHtml = blockPendingLiHtml(pending, pendingInner, openListItemFirstLine2);
  const indent = listPendingIndent(pending);
  if (indent > 0) {
    const nested = insertBeforeTrailingListClose(rendered, `<${listTag}>${liHtml}</${listTag}>`);
    if (nested)
      return nested;
  }
  const close = `</${listTag}>`;
  const closeIndex = rendered.lastIndexOf(close);
  if (closeIndex !== -1) {
    const openNeedle = `<${listTag}`;
    const beforeClose = rendered.slice(0, closeIndex);
    if (beforeClose.lastIndexOf(openNeedle) !== -1) {
      return `${beforeClose}${liHtml}${rendered.slice(closeIndex)}`;
    }
  }
  const ordered = pendingListOrderedMarker(pending);
  const startAttr = ordered !== null && listTag === "ol" ? ` start="${escapeHtml(ordered)}"` : "";
  return `${rendered}<${listTag}${startAttr}>${liHtml}</${listTag}>`;
}
function findTrailingListHost(completedEl, listTag) {
  const last = completedEl.lastElementChild;
  if (last instanceof Element && last.tagName === listTag.toUpperCase()) {
    return last;
  }
  return null;
}
function syncListPendingDom(completedEl, pending, pendingInner, active, openListItemFirstLine2) {
  clearBlockPendingDom(completedEl, ["continuation", "paragraph-continuation", "non-list-direct"]);
  const listTag = pendingListTag(pending);
  const indent = listPendingIndent(pending);
  const existingPendingLi = tailPendingDescendant(completedEl, `li.${BLOCK_PENDING_CLASS}`);
  if (!active || !pendingInner) {
    existingPendingLi?.remove();
    const last = completedEl.lastElementChild;
    if (last && last.tagName === listTag.toUpperCase() && last.childNodes.length === 0) {
      last.remove();
    }
    return;
  }
  let list = null;
  if (indent > 0) {
    const hostLi = findOpenListItemHost(completedEl);
    if (hostLi) {
      const existingNested = hostLi.querySelector(`:scope > ${listTag}:last-of-type`);
      if (existingNested instanceof Element && existingNested.tagName === listTag.toUpperCase()) {
        list = existingNested;
      } else {
        list = document.createElement(listTag);
        hostLi.append(list);
      }
    }
  }
  if (!list) {
    const trailing = findTrailingListHost(completedEl, listTag);
    list = trailing ?? (() => {
      const created = document.createElement(listTag);
      const ordered2 = pendingListOrderedMarker(pending);
      if (ordered2 !== null && listTag === "ol")
        created.setAttribute("start", ordered2);
      completedEl.append(created);
      return created;
    })();
  }
  let li;
  if (existingPendingLi instanceof HTMLElement && existingPendingLi.parentElement === list) {
    li = existingPendingLi;
  } else {
    existingPendingLi?.remove();
    li = document.createElement("li");
    list.append(li);
  }
  li.className = blockPendingClassName(pending, openListItemFirstLine2);
  const ordered = pendingListOrderedMarker(pending);
  const headingLevel = pendingAtxHeadingLevel(pending);
  if (ordered !== null)
    li.setAttribute("data-ordered-marker", ordered);
  else
    li.removeAttribute("data-ordered-marker");
  if (headingLevel !== null)
    li.setAttribute("data-heading-level", String(headingLevel));
  else
    li.removeAttribute("data-heading-level");
  li.innerHTML = wrapBlockPendingInner(pending, pendingInner);
}
function blockPendingClassName(pending, openListItemFirstLine2) {
  if (isListContinuationPending(pending, openListItemFirstLine2)) {
    return `stream-pending ${LIST_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`;
  }
  if (pendingListMarkerLength(pending) !== null) {
    const ordered = pendingListOrderedMarker(pending);
    return ordered ? `stream-pending stream-pending-list-item stream-pending-ordered-item ${BLOCK_PENDING_CLASS}` : `stream-pending stream-pending-list-item ${BLOCK_PENDING_CLASS}`;
  }
  const headingLevel = pendingAtxHeadingLevel(pending);
  if (headingLevel !== null) {
    return `stream-pending stream-pending-heading stream-pending-h${String(headingLevel)} ${BLOCK_PENDING_CLASS}`;
  }
  if (isPendingBlockquoteLine(pending)) {
    return `stream-pending stream-pending-blockquote ${BLOCK_PENDING_CLASS}`;
  }
  return `stream-pending stream-pending-paragraph ${BLOCK_PENDING_CLASS}`;
}
function blockPendingAttrs(pending) {
  const ordered = pendingListOrderedMarker(pending);
  const headingLevel = pendingAtxHeadingLevel(pending);
  let attrs = "";
  if (ordered)
    attrs += ` data-ordered-marker="${escapeHtml(ordered)}"`;
  if (headingLevel !== null)
    attrs += ` data-heading-level="${String(headingLevel)}"`;
  return attrs;
}
function wrapBlockPendingInner(pending, pendingInner) {
  if (isPendingBlockquoteLine(pending)) {
    return pendingInner ? `<p>${pendingInner}</p>` : "";
  }
  return pendingInner;
}
function blockPendingHtml(pending, pendingInner, openListItemFirstLine2) {
  const tag = blockPendingTag(pending, openListItemFirstLine2);
  const innerRaw = wrapBlockPendingInner(pending, pendingInner);
  const inner = tag === "span" && innerRaw !== "" && !innerRaw.startsWith(" ") ? ` ${innerRaw}` : innerRaw;
  return `<${tag} class="${blockPendingClassName(pending, openListItemFirstLine2)}"${blockPendingAttrs(pending)}>${inner}</${tag}>`;
}
function inlinePendingSpanHtml(pendingInner) {
  return `<span class="stream-pending">${pendingInner}</span>`;
}
function findOpenListItemHost(completedEl) {
  const last = completedEl.lastElementChild;
  if (!(last instanceof HTMLElement) || last.tagName !== "UL" && last.tagName !== "OL") {
    return null;
  }
  let li = last.lastElementChild;
  if (li instanceof HTMLElement && li.classList.contains(BLOCK_PENDING_CLASS)) {
    li = li.previousElementSibling;
  }
  return li instanceof HTMLElement && li.tagName === "LI" ? li : null;
}
function clearListContinuationDom(completedEl) {
  tailPendingDescendant(completedEl, `li .${LIST_CONTINUATION_CLASS}`)?.remove();
}
function isParagraphContinuationPending(split) {
  const { pending, openListItemFirstLine: openListItemFirstLine2 } = split;
  return split.paragraphContinuation === true && blockPendingTag(pending, openListItemFirstLine2) === "p" && isBlockLevelPending(pending, openListItemFirstLine2);
}
function paragraphContinuationSpanHtml(pendingInner) {
  return `<span class="stream-pending ${PARAGRAPH_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}">${pendingInner}</span>`;
}
function appendParagraphContinuationHtml(rendered, pendingInner) {
  if (!rendered.endsWith("</p>"))
    return null;
  return `${rendered.slice(0, -"</p>".length)}
${paragraphContinuationSpanHtml(pendingInner)}</p>`;
}
function findTrailingParagraphHost(completedEl) {
  const last = completedEl.lastElementChild;
  if (!(last instanceof HTMLElement) || last.tagName !== "P")
    return null;
  if (last.classList.contains(BLOCK_PENDING_CLASS))
    return null;
  return last;
}
function removeParagraphContinuationNode(el) {
  if (!el)
    return;
  const prev = el.previousSibling;
  if (prev !== null && prev.nodeType === 3 && prev.textContent === "\n") {
    prev.remove();
  }
  el.remove();
}
function clearParagraphContinuationDom(completedEl) {
  removeParagraphContinuationNode(tailPendingDescendant(completedEl, `.${PARAGRAPH_CONTINUATION_CLASS}`));
}
function syncParagraphContinuationDom(completedEl, pendingInner, active) {
  const host = findTrailingParagraphHost(completedEl);
  if (!host)
    return false;
  const existing = host.querySelector(`:scope > .${PARAGRAPH_CONTINUATION_CLASS}`);
  if (!active || !pendingInner) {
    removeParagraphContinuationNode(existing);
    return true;
  }
  let el = existing;
  if (!el) {
    host.append(document.createTextNode("\n"));
    el = document.createElement("span");
    host.append(el);
  }
  el.className = `stream-pending ${PARAGRAPH_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`;
  el.innerHTML = pendingInner;
  return true;
}
function syncListContinuationDom(completedEl, pendingInner, active) {
  const li = findOpenListItemHost(completedEl);
  if (!li)
    return false;
  const existing = li.querySelector(`:scope > .${LIST_CONTINUATION_CLASS}`);
  if (!active || !pendingInner) {
    existing?.remove();
    return true;
  }
  let el = existing;
  if (!el) {
    el = document.createElement("span");
    li.append(el);
  }
  el.className = `stream-pending ${LIST_CONTINUATION_CLASS} ${BLOCK_PENDING_CLASS}`;
  el.innerHTML = pendingInner.startsWith(" ") ? pendingInner : ` ${pendingInner}`;
  return true;
}
function syncBlockPendingDom(completedEl, split, pendingInner, active) {
  const { pending, openListItemFirstLine: openListItemFirstLine2 } = split;
  if (isParagraphContinuationPending(split)) {
    clearBlockPendingDom(completedEl, ["continuation", "list-items", "non-list-direct"]);
    if (syncParagraphContinuationDom(completedEl, pendingInner, active))
      return;
  }
  if (isListContinuationPending(pending, openListItemFirstLine2)) {
    clearBlockPendingDom(completedEl, [
      "continuation",
      "paragraph-continuation",
      "list-items",
      "non-list-direct"
    ]);
    syncListContinuationDom(completedEl, pendingInner, active);
    return;
  }
  if (pendingListMarkerLength(pending) !== null) {
    syncListPendingDom(completedEl, pending, pendingInner, active, openListItemFirstLine2);
    return;
  }
  clearBlockPendingDom(completedEl, ["continuation", "paragraph-continuation", "list-items"]);
  const existing = tailDirectPendingBlock(completedEl, false);
  if (!active || !pendingInner) {
    existing?.remove();
    return;
  }
  const tag = blockPendingTag(pending, openListItemFirstLine2);
  let el = existing;
  if (!el || el.tagName.toLowerCase() !== tag) {
    existing?.remove();
    el = document.createElement(tag);
    completedEl.append(el);
  }
  el.className = blockPendingClassName(pending, openListItemFirstLine2);
  const ordered = pendingListOrderedMarker(pending);
  const headingLevel = pendingAtxHeadingLevel(pending);
  if (ordered !== null)
    el.setAttribute("data-ordered-marker", ordered);
  else
    el.removeAttribute("data-ordered-marker");
  if (headingLevel !== null)
    el.setAttribute("data-heading-level", String(headingLevel));
  else
    el.removeAttribute("data-heading-level");
  el.innerHTML = wrapBlockPendingInner(pending, pendingInner);
}
function syncInlinePendingDom(pendingEl, pendingInner, active) {
  pendingEl.innerHTML = pendingInner;
  pendingEl.hidden = !active;
  pendingEl.className = "stream-pending";
  delete pendingEl.dataset["orderedMarker"];
}
function renderPendingTail(split, complete, formingActive, completeTokens) {
  const { pending, openListItemFirstLine: openListItemFirstLine2 } = split;
  const pendingInTable = pendingLineBelongsInTable(complete, pending, completeTokens);
  const pendingInner = pending && !pendingInTable && !formingActive ? sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending, openListItemFirstLine2)) : "";
  const pendingVisible = pending !== "" && !pendingInTable && !formingActive && pendingInner !== "";
  return { pendingInner, pendingVisible };
}
function renderStreamingMarkdown(content) {
  const split = splitForStreaming(content);
  const { complete, pending, openListItemFirstLine: openListItemFirstLine2, blocks } = split;
  let completeTokensCache = null;
  const completeTokens = () => completeTokensCache ??= tokenizeBlocks(complete);
  const completeTokensForPending = pending.includes("|") ? completeTokens() : void 0;
  const rendered = complete ? sanitizeRenderedMarkdown(renderMarkdown(complete, { tokens: completeTokens() })) : "";
  const fenceSource = formingFenceSource(content, blocks);
  const tableSource = fenceSource ? null : formingTableSource(complete, content, pending, blocks, completeTokensForPending);
  const formingHtml = fenceSource ? buildFormingFenceHtml(fenceSource) : tableSource ? buildFormingTableHtml(tableSource) : "";
  if (formingHtml) {
    return `${rendered}${formingHtml}`;
  }
  if (!pending)
    return rendered;
  if (pendingLineBelongsInTable(complete, pending, completeTokensForPending)) {
    return appendPendingTableRowHtml(rendered, pending);
  }
  const pendingInner = sanitizeRenderedMarkdown(renderPendingInlineMarkdown(pending, openListItemFirstLine2));
  if (!pendingInner)
    return rendered;
  if (isParagraphContinuationPending(split)) {
    const inserted = appendParagraphContinuationHtml(rendered, pendingInner);
    if (inserted)
      return inserted;
  }
  if (isListContinuationPending(pending, openListItemFirstLine2)) {
    const contHtml = blockPendingHtml(pending, pendingInner, openListItemFirstLine2);
    const inserted = insertBeforeTrailingListClose(rendered, contHtml);
    if (inserted)
      return inserted;
  }
  if (pendingListMarkerLength(pending) !== null) {
    return appendListPendingHtml(rendered, pending, pendingInner, openListItemFirstLine2);
  }
  const pendingHtml = isBlockLevelPending(pending, openListItemFirstLine2) ? blockPendingHtml(pending, pendingInner, openListItemFirstLine2) : inlinePendingSpanHtml(pendingInner);
  return `${rendered}${pendingHtml}`;
}
var StreamingMarkdownRenderer = class {
  completedEl = null;
  formingEl = null;
  pendingEl = null;
  lastComplete = "";
  /** `tokenizeBlocks(lastComplete)` — cached so pending-only frames stay O(tail). */
  committedTokens = [];
  /** Whether `lastComplete` contains `|` — cached for the same reason. */
  committedHasPipe = false;
  frozenTail = new FrozenTailRenderer();
  // Incremental scanners (#30): re-tokenize / re-scan only past the last safe
  // boundary instead of the whole string every update. One per source stream —
  // the raw content and the committed prefix advance differently.
  contentScanner = new IncrementalSourceScanner();
  completeScanner = new IncrementalSourceScanner();
  host;
  constructor(host) {
    this.host = host;
  }
  /** Render `content` (the full message text so far) into the host incrementally. */
  update(content) {
    const split = splitForStreamingFrom(content, this.contentScanner.tokenize(content));
    const { complete, pending, openListItemFirstLine: openListItemFirstLine2, blocks } = split;
    const { completedEl, formingEl, pendingEl } = this.ensureNodes();
    if (complete !== this.lastComplete) {
      this.committedTokens = this.completeScanner.tokenize(complete);
      this.committedHasPipe = complete.includes("|");
      this.frozenTail.update(completedEl, complete, this.committedTokens, this.completeScanner.linkRefs(complete));
      this.lastComplete = complete;
    }
    const completeTokensForPending = pending.includes("|") ? this.committedTokens : void 0;
    const mayHaveCommittedTable = this.committedHasPipe;
    const fenceSource = formingFenceSource(content, blocks);
    const tableSource = formingTableSource(complete, content, pending, blocks, completeTokensForPending);
    if (fenceSource || tableSource) {
      if (fenceSource)
        syncFormingFenceDom(formingEl, fenceSource);
      else if (tableSource)
        syncFormingTableDom(formingEl, tableSource);
      formingEl.hidden = false;
      const committed = mayHaveCommittedTable ? this.findLastCommittedTable() : null;
      if (committed)
        removePendingTableRow(committed);
    } else {
      clearFormingDom(formingEl);
      formingEl.hidden = true;
      if (mayHaveCommittedTable)
        this.syncCommittedTableRow(complete, pending, completeTokensForPending);
    }
    const formingActive = fenceSource !== null || tableSource !== null;
    const { pendingInner, pendingVisible } = renderPendingTail(split, complete, formingActive, completeTokensForPending);
    if (pendingVisible && isBlockLevelPending(pending, openListItemFirstLine2)) {
      syncBlockPendingDom(completedEl, split, pendingInner, true);
      syncInlinePendingDom(pendingEl, "", false);
    } else {
      clearBlockPendingDom(completedEl, ["continuation", "paragraph-continuation", "direct-blocks"]);
      syncInlinePendingDom(pendingEl, pendingInner, pendingVisible);
    }
  }
  syncCommittedTableRow(complete, pending, completeTokens) {
    const table = this.findLastCommittedTable();
    if (!table)
      return;
    if (pendingLineBelongsInTable(complete, pending, completeTokens)) {
      syncPendingTableRowDom(table, pending);
      return;
    }
    removePendingTableRow(table);
  }
  findLastCommittedTable() {
    const tables = this.completedEl?.querySelectorAll("table");
    const last = tables?.[tables.length - 1];
    if (last instanceof Element && last.tagName === "TABLE") {
      return last;
    }
    return null;
  }
  ensureNodes() {
    if (this.completedEl && this.formingEl && this.pendingEl && this.host.contains(this.completedEl)) {
      return {
        completedEl: this.completedEl,
        formingEl: this.formingEl,
        pendingEl: this.pendingEl
      };
    }
    this.host.replaceChildren();
    const completedEl = document.createElement("div");
    completedEl.className = "stream-complete";
    const formingEl = document.createElement("div");
    formingEl.className = "stream-forming";
    formingEl.hidden = true;
    const pendingEl = document.createElement("span");
    pendingEl.className = "stream-pending";
    pendingEl.hidden = true;
    this.host.append(completedEl, formingEl, pendingEl);
    this.completedEl = completedEl;
    this.formingEl = formingEl;
    this.pendingEl = pendingEl;
    this.lastComplete = "";
    this.committedTokens = [];
    this.committedHasPipe = false;
    this.frozenTail.reset();
    return { completedEl, formingEl, pendingEl };
  }
};
function formingTableSource(complete, content, pending, contentTokens, completeTokens) {
  if (getIncompleteFenceSource(content, contentTokens))
    return null;
  if (pendingLineBelongsInTable(complete, pending, completeTokens))
    return null;
  const fromTokens = getIncompleteTableSource(content, contentTokens);
  if (fromTokens)
    return fromTokens;
  const trimmed = pending.trimStart();
  if (trimmed.startsWith("|") && trimmed.includes("|", 1))
    return pending;
  return null;
}
function formingFenceSource(content, contentTokens) {
  return getIncompleteFenceSource(content, contentTokens);
}
function clearFormingDom(container) {
  clearFormingFenceDom(container);
  clearFormingTableDom(container);
}

// node_modules/dompurify/dist/purify.es.mjs
function _arrayLikeToArray(r, a) {
  (null == a || a > r.length) && (a = r.length);
  for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e];
  return n;
}
function _arrayWithHoles(r) {
  if (Array.isArray(r)) return r;
}
function _iterableToArrayLimit(r, l) {
  var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"];
  if (null != t) {
    var e, n, i, u, a = [], f = true, o = false;
    try {
      if (i = (t = t.call(r)).next, 0 === l) ;
      else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = true) ;
    } catch (r2) {
      o = true, n = r2;
    } finally {
      try {
        if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return;
      } finally {
        if (o) throw n;
      }
    }
    return a;
  }
}
function _nonIterableRest() {
  throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method.");
}
function _slicedToArray(r, e) {
  return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest();
}
function _unsupportedIterableToArray(r, a) {
  if (r) {
    if ("string" == typeof r) return _arrayLikeToArray(r, a);
    var t = {}.toString.call(r).slice(8, -1);
    return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0;
  }
}
var entries = Object.entries;
var setPrototypeOf = Object.setPrototypeOf;
var isFrozen = Object.isFrozen;
var getPrototypeOf = Object.getPrototypeOf;
var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var freeze = Object.freeze;
var seal = Object.seal;
var create = Object.create;
var _ref = typeof Reflect !== "undefined" && Reflect;
var apply = _ref.apply;
var construct = _ref.construct;
if (!freeze) {
  freeze = function freeze2(x) {
    return x;
  };
}
if (!seal) {
  seal = function seal2(x) {
    return x;
  };
}
if (!apply) {
  apply = function apply2(func, thisArg) {
    for (var _len = arguments.length, args = new Array(_len > 2 ? _len - 2 : 0), _key = 2; _key < _len; _key++) {
      args[_key - 2] = arguments[_key];
    }
    return func.apply(thisArg, args);
  };
}
if (!construct) {
  construct = function construct2(Func) {
    for (var _len2 = arguments.length, args = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
      args[_key2 - 1] = arguments[_key2];
    }
    return new Func(...args);
  };
}
var arrayForEach = unapply(Array.prototype.forEach);
var arrayLastIndexOf = unapply(Array.prototype.lastIndexOf);
var arrayPop = unapply(Array.prototype.pop);
var arrayPush = unapply(Array.prototype.push);
var arraySplice = unapply(Array.prototype.splice);
var arrayIsArray = Array.isArray;
var stringToLowerCase = unapply(String.prototype.toLowerCase);
var stringToString = unapply(String.prototype.toString);
var stringMatch = unapply(String.prototype.match);
var stringReplace = unapply(String.prototype.replace);
var stringIndexOf = unapply(String.prototype.indexOf);
var stringTrim = unapply(String.prototype.trim);
var numberToString = unapply(Number.prototype.toString);
var booleanToString = unapply(Boolean.prototype.toString);
var bigintToString = typeof BigInt === "undefined" ? null : unapply(BigInt.prototype.toString);
var symbolToString = typeof Symbol === "undefined" ? null : unapply(Symbol.prototype.toString);
var objectHasOwnProperty = unapply(Object.prototype.hasOwnProperty);
var objectToString = unapply(Object.prototype.toString);
var regExpTest = unapply(RegExp.prototype.test);
var typeErrorCreate = unconstruct(TypeError);
function unapply(func) {
  return function(thisArg) {
    if (thisArg instanceof RegExp) {
      thisArg.lastIndex = 0;
    }
    for (var _len3 = arguments.length, args = new Array(_len3 > 1 ? _len3 - 1 : 0), _key3 = 1; _key3 < _len3; _key3++) {
      args[_key3 - 1] = arguments[_key3];
    }
    return apply(func, thisArg, args);
  };
}
function unconstruct(Func) {
  return function() {
    for (var _len4 = arguments.length, args = new Array(_len4), _key4 = 0; _key4 < _len4; _key4++) {
      args[_key4] = arguments[_key4];
    }
    return construct(Func, args);
  };
}
function addToSet(set, array) {
  let transformCaseFunc = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : stringToLowerCase;
  if (setPrototypeOf) {
    setPrototypeOf(set, null);
  }
  if (!arrayIsArray(array)) {
    return set;
  }
  let l = array.length;
  while (l--) {
    let element = array[l];
    if (typeof element === "string") {
      const lcElement = transformCaseFunc(element);
      if (lcElement !== element) {
        if (!isFrozen(array)) {
          array[l] = lcElement;
        }
        element = lcElement;
      }
    }
    set[element] = true;
  }
  return set;
}
function cleanArray(array) {
  for (let index = 0; index < array.length; index++) {
    const isPropertyExist = objectHasOwnProperty(array, index);
    if (!isPropertyExist) {
      array[index] = null;
    }
  }
  return array;
}
function clone(object) {
  const newObject = create(null);
  for (const _ref2 of entries(object)) {
    var _ref3 = _slicedToArray(_ref2, 2);
    const property = _ref3[0];
    const value = _ref3[1];
    const isPropertyExist = objectHasOwnProperty(object, property);
    if (isPropertyExist) {
      if (arrayIsArray(value)) {
        newObject[property] = cleanArray(value);
      } else if (value && typeof value === "object" && value.constructor === Object) {
        newObject[property] = clone(value);
      } else {
        newObject[property] = value;
      }
    }
  }
  return newObject;
}
function stringifyValue(value) {
  switch (typeof value) {
    case "string": {
      return value;
    }
    case "number": {
      return numberToString(value);
    }
    case "boolean": {
      return booleanToString(value);
    }
    case "bigint": {
      return bigintToString ? bigintToString(value) : "0";
    }
    case "symbol": {
      return symbolToString ? symbolToString(value) : "Symbol()";
    }
    case "undefined": {
      return objectToString(value);
    }
    case "function":
    case "object": {
      if (value === null) {
        return objectToString(value);
      }
      const valueAsRecord = value;
      const valueToString = lookupGetter(valueAsRecord, "toString");
      if (typeof valueToString === "function") {
        const stringified = valueToString(valueAsRecord);
        return typeof stringified === "string" ? stringified : objectToString(stringified);
      }
      return objectToString(value);
    }
    default: {
      return objectToString(value);
    }
  }
}
function lookupGetter(object, prop) {
  while (object !== null) {
    const desc = getOwnPropertyDescriptor(object, prop);
    if (desc) {
      if (desc.get) {
        return unapply(desc.get);
      }
      if (typeof desc.value === "function") {
        return unapply(desc.value);
      }
    }
    object = getPrototypeOf(object);
  }
  function fallbackValue() {
    return null;
  }
  return fallbackValue;
}
function isRegex(value) {
  try {
    regExpTest(value, "");
    return true;
  } catch (_unused) {
    return false;
  }
}
var html$1 = freeze(["a", "abbr", "acronym", "address", "area", "article", "aside", "audio", "b", "bdi", "bdo", "big", "blink", "blockquote", "body", "br", "button", "canvas", "caption", "center", "cite", "code", "col", "colgroup", "content", "data", "datalist", "dd", "decorator", "del", "details", "dfn", "dialog", "dir", "div", "dl", "dt", "element", "em", "fieldset", "figcaption", "figure", "font", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "img", "input", "ins", "kbd", "label", "legend", "li", "main", "map", "mark", "marquee", "menu", "menuitem", "meter", "nav", "nobr", "ol", "optgroup", "option", "output", "p", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "search", "section", "select", "shadow", "slot", "small", "source", "spacer", "span", "strike", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time", "tr", "track", "tt", "u", "ul", "var", "video", "wbr"]);
var svg$1 = freeze(["svg", "a", "altglyph", "altglyphdef", "altglyphitem", "animatecolor", "animatemotion", "animatetransform", "circle", "clippath", "defs", "desc", "ellipse", "enterkeyhint", "exportparts", "filter", "font", "g", "glyph", "glyphref", "hkern", "image", "inputmode", "line", "lineargradient", "marker", "mask", "metadata", "mpath", "part", "path", "pattern", "polygon", "polyline", "radialgradient", "rect", "stop", "style", "switch", "symbol", "text", "textpath", "title", "tref", "tspan", "view", "vkern"]);
var svgFilters = freeze(["feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence"]);
var svgDisallowed = freeze(["animate", "color-profile", "cursor", "discard", "font-face", "font-face-format", "font-face-name", "font-face-src", "font-face-uri", "foreignobject", "hatch", "hatchpath", "mesh", "meshgradient", "meshpatch", "meshrow", "missing-glyph", "script", "set", "solidcolor", "unknown", "use"]);
var mathMl$1 = freeze(["math", "menclose", "merror", "mfenced", "mfrac", "mglyph", "mi", "mlabeledtr", "mmultiscripts", "mn", "mo", "mover", "mpadded", "mphantom", "mroot", "mrow", "ms", "mspace", "msqrt", "mstyle", "msub", "msup", "msubsup", "mtable", "mtd", "mtext", "mtr", "munder", "munderover", "mprescripts"]);
var mathMlDisallowed = freeze(["maction", "maligngroup", "malignmark", "mlongdiv", "mscarries", "mscarry", "msgroup", "mstack", "msline", "msrow", "semantics", "annotation", "annotation-xml", "mprescripts", "none"]);
var text = freeze(["#text"]);
var html = freeze(["accept", "action", "align", "alt", "autocapitalize", "autocomplete", "autopictureinpicture", "autoplay", "background", "bgcolor", "border", "capture", "cellpadding", "cellspacing", "checked", "cite", "class", "clear", "color", "cols", "colspan", "command", "commandfor", "controls", "controlslist", "coords", "crossorigin", "datetime", "decoding", "default", "dir", "disabled", "disablepictureinpicture", "disableremoteplayback", "download", "draggable", "enctype", "enterkeyhint", "exportparts", "face", "for", "headers", "height", "hidden", "high", "href", "hreflang", "id", "inert", "inputmode", "integrity", "ismap", "kind", "label", "lang", "list", "loading", "loop", "low", "max", "maxlength", "media", "method", "min", "minlength", "multiple", "muted", "name", "nonce", "noshade", "novalidate", "nowrap", "open", "optimum", "part", "pattern", "placeholder", "playsinline", "popover", "popovertarget", "popovertargetaction", "poster", "preload", "pubdate", "radiogroup", "readonly", "rel", "required", "rev", "reversed", "role", "rows", "rowspan", "spellcheck", "scope", "selected", "shape", "size", "sizes", "slot", "span", "srclang", "start", "src", "srcset", "step", "style", "summary", "tabindex", "title", "translate", "type", "usemap", "valign", "value", "width", "wrap", "xmlns"]);
var svg = freeze(["accent-height", "accumulate", "additive", "alignment-baseline", "amplitude", "ascent", "attributename", "attributetype", "azimuth", "basefrequency", "baseline-shift", "begin", "bias", "by", "class", "clip", "clippathunits", "clip-path", "clip-rule", "color", "color-interpolation", "color-interpolation-filters", "color-profile", "color-rendering", "cx", "cy", "d", "dx", "dy", "diffuseconstant", "direction", "display", "divisor", "dur", "edgemode", "elevation", "end", "exponent", "fill", "fill-opacity", "fill-rule", "filter", "filterunits", "flood-color", "flood-opacity", "font-family", "font-size", "font-size-adjust", "font-stretch", "font-style", "font-variant", "font-weight", "fx", "fy", "g1", "g2", "glyph-name", "glyphref", "gradientunits", "gradienttransform", "height", "href", "id", "image-rendering", "in", "in2", "intercept", "k", "k1", "k2", "k3", "k4", "kerning", "keypoints", "keysplines", "keytimes", "lang", "lengthadjust", "letter-spacing", "kernelmatrix", "kernelunitlength", "lighting-color", "local", "marker-end", "marker-mid", "marker-start", "markerheight", "markerunits", "markerwidth", "maskcontentunits", "maskunits", "max", "mask", "mask-type", "media", "method", "mode", "min", "name", "numoctaves", "offset", "operator", "opacity", "order", "orient", "orientation", "origin", "overflow", "paint-order", "path", "pathlength", "patterncontentunits", "patterntransform", "patternunits", "points", "preservealpha", "preserveaspectratio", "primitiveunits", "r", "rx", "ry", "radius", "refx", "refy", "repeatcount", "repeatdur", "restart", "result", "rotate", "scale", "seed", "shape-rendering", "slope", "specularconstant", "specularexponent", "spreadmethod", "startoffset", "stddeviation", "stitchtiles", "stop-color", "stop-opacity", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke", "stroke-width", "style", "surfacescale", "systemlanguage", "tabindex", "tablevalues", "targetx", "targety", "transform", "transform-origin", "text-anchor", "text-decoration", "text-rendering", "textlength", "type", "u1", "u2", "unicode", "values", "viewbox", "visibility", "version", "vert-adv-y", "vert-origin-x", "vert-origin-y", "width", "word-spacing", "wrap", "writing-mode", "xchannelselector", "ychannelselector", "x", "x1", "x2", "xmlns", "y", "y1", "y2", "z", "zoomandpan"]);
var mathMl = freeze(["accent", "accentunder", "align", "bevelled", "close", "columnalign", "columnlines", "columnspacing", "columnspan", "denomalign", "depth", "dir", "display", "displaystyle", "encoding", "fence", "frame", "height", "href", "id", "largeop", "length", "linethickness", "lquote", "lspace", "mathbackground", "mathcolor", "mathsize", "mathvariant", "maxsize", "minsize", "movablelimits", "notation", "numalign", "open", "rowalign", "rowlines", "rowspacing", "rowspan", "rspace", "rquote", "scriptlevel", "scriptminsize", "scriptsizemultiplier", "selection", "separator", "separators", "stretchy", "subscriptshift", "supscriptshift", "symmetric", "voffset", "width", "xmlns"]);
var xml = freeze(["xlink:href", "xml:id", "xlink:title", "xml:space", "xmlns:xlink"]);
var MUSTACHE_EXPR = seal(/{{[\w\W]*|^[\w\W]*}}/g);
var ERB_EXPR = seal(/<%[\w\W]*|^[\w\W]*%>/g);
var TMPLIT_EXPR = seal(/\${[\w\W]*/g);
var DATA_ATTR = seal(/^data-[\-\w.\u00B7-\uFFFF]+$/);
var ARIA_ATTR = seal(/^aria-[\-\w]+$/);
var IS_ALLOWED_URI = seal(
  /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
  // eslint-disable-line no-useless-escape
);
var IS_SCRIPT_OR_DATA = seal(/^(?:\w+script|data):/i);
var ATTR_WHITESPACE = seal(
  /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g
  // eslint-disable-line no-control-regex
);
var DOCTYPE_NAME = seal(/^html$/i);
var CUSTOM_ELEMENT = seal(/^[a-z][.\w]*(-[.\w]+)+$/i);
var ELEMENT_MARKUP_PROBE = seal(/<[/\w!]/g);
var COMMENT_MARKUP_PROBE = seal(/<[/\w]/g);
var FALLBACK_TAG_CLOSE = seal(/<\/no(script|embed|frames)/i);
var SELF_CLOSING_TAG = seal(/\/>/i);
var NODE_TYPE = {
  element: 1,
  attribute: 2,
  text: 3,
  cdataSection: 4,
  entityReference: 5,
  // Deprecated
  entityNode: 6,
  // Deprecated
  processingInstruction: 7,
  comment: 8,
  document: 9,
  documentType: 10,
  documentFragment: 11,
  notation: 12
  // Deprecated
};
var getGlobal = function getGlobal2() {
  return typeof window === "undefined" ? null : window;
};
var _createTrustedTypesPolicy = function _createTrustedTypesPolicy2(trustedTypes, purifyHostElement) {
  if (typeof trustedTypes !== "object" || typeof trustedTypes.createPolicy !== "function") {
    return null;
  }
  let suffix = null;
  const ATTR_NAME = "data-tt-policy-suffix";
  if (purifyHostElement && purifyHostElement.hasAttribute(ATTR_NAME)) {
    suffix = purifyHostElement.getAttribute(ATTR_NAME);
  }
  const policyName = "dompurify" + (suffix ? "#" + suffix : "");
  try {
    return trustedTypes.createPolicy(policyName, {
      createHTML(html2) {
        return html2;
      },
      createScriptURL(scriptUrl) {
        return scriptUrl;
      }
    });
  } catch (_) {
    console.warn("TrustedTypes policy " + policyName + " could not be created.");
    return null;
  }
};
var _createHooksMap = function _createHooksMap2() {
  return {
    afterSanitizeAttributes: [],
    afterSanitizeElements: [],
    afterSanitizeShadowDOM: [],
    beforeSanitizeAttributes: [],
    beforeSanitizeElements: [],
    beforeSanitizeShadowDOM: [],
    uponSanitizeAttribute: [],
    uponSanitizeElement: [],
    uponSanitizeShadowNode: []
  };
};
var _resolveSetOption = function _resolveSetOption2(cfg, key, fallback, options) {
  return objectHasOwnProperty(cfg, key) && arrayIsArray(cfg[key]) ? addToSet(options.base ? clone(options.base) : {}, cfg[key], options.transform) : fallback;
};
function createDOMPurify() {
  let window2 = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : getGlobal();
  const DOMPurify = (root) => createDOMPurify(root);
  DOMPurify.version = "3.4.11";
  DOMPurify.removed = [];
  if (!window2 || !window2.document || window2.document.nodeType !== NODE_TYPE.document || !window2.Element) {
    DOMPurify.isSupported = false;
    return DOMPurify;
  }
  let document2 = window2.document;
  const originalDocument = document2;
  const currentScript = originalDocument.currentScript;
  window2.DocumentFragment;
  const HTMLTemplateElement = window2.HTMLTemplateElement, Node = window2.Node, Element2 = window2.Element, NodeFilter = window2.NodeFilter, _window$NamedNodeMap = window2.NamedNodeMap;
  _window$NamedNodeMap === void 0 ? window2.NamedNodeMap || window2.MozNamedAttrMap : _window$NamedNodeMap;
  window2.HTMLFormElement;
  const DOMParser = window2.DOMParser, trustedTypes = window2.trustedTypes;
  const ElementPrototype = Element2.prototype;
  const cloneNode = lookupGetter(ElementPrototype, "cloneNode");
  const remove = lookupGetter(ElementPrototype, "remove");
  const getNextSibling = lookupGetter(ElementPrototype, "nextSibling");
  const getChildNodes = lookupGetter(ElementPrototype, "childNodes");
  const getParentNode = lookupGetter(ElementPrototype, "parentNode");
  const getShadowRoot = lookupGetter(ElementPrototype, "shadowRoot");
  const getAttributes = lookupGetter(ElementPrototype, "attributes");
  const getNodeType = Node && Node.prototype ? lookupGetter(Node.prototype, "nodeType") : null;
  const getNodeName = Node && Node.prototype ? lookupGetter(Node.prototype, "nodeName") : null;
  if (typeof HTMLTemplateElement === "function") {
    const template = document2.createElement("template");
    if (template.content && template.content.ownerDocument) {
      document2 = template.content.ownerDocument;
    }
  }
  let trustedTypesPolicy;
  let emptyHTML = "";
  let defaultTrustedTypesPolicy;
  let defaultTrustedTypesPolicyResolved = false;
  let IN_TRUSTED_TYPES_POLICY = 0;
  const _assertNotInTrustedTypesPolicy = function _assertNotInTrustedTypesPolicy2() {
    if (IN_TRUSTED_TYPES_POLICY > 0) {
      throw typeErrorCreate('A configured TRUSTED_TYPES_POLICY callback (createHTML or createScriptURL) must not call DOMPurify.sanitize, as that causes infinite recursion. Do not pass a policy whose callbacks wrap DOMPurify as TRUSTED_TYPES_POLICY; see the "DOMPurify and Trusted Types" section of the README.');
    }
  };
  const _createTrustedHTML = function _createTrustedHTML2(html2) {
    _assertNotInTrustedTypesPolicy();
    IN_TRUSTED_TYPES_POLICY++;
    try {
      return trustedTypesPolicy.createHTML(html2);
    } finally {
      IN_TRUSTED_TYPES_POLICY--;
    }
  };
  const _createTrustedScriptURL = function _createTrustedScriptURL2(scriptUrl) {
    _assertNotInTrustedTypesPolicy();
    IN_TRUSTED_TYPES_POLICY++;
    try {
      return trustedTypesPolicy.createScriptURL(scriptUrl);
    } finally {
      IN_TRUSTED_TYPES_POLICY--;
    }
  };
  const _getDefaultTrustedTypesPolicy = function _getDefaultTrustedTypesPolicy2() {
    if (!defaultTrustedTypesPolicyResolved) {
      defaultTrustedTypesPolicy = _createTrustedTypesPolicy(trustedTypes, currentScript);
      defaultTrustedTypesPolicyResolved = true;
    }
    return defaultTrustedTypesPolicy;
  };
  const _document = document2, implementation = _document.implementation, createNodeIterator = _document.createNodeIterator, createDocumentFragment = _document.createDocumentFragment, getElementsByTagName = _document.getElementsByTagName;
  const importNode = originalDocument.importNode;
  let hooks = _createHooksMap();
  DOMPurify.isSupported = typeof entries === "function" && typeof getParentNode === "function" && implementation && implementation.createHTMLDocument !== void 0;
  const MUSTACHE_EXPR$1 = MUSTACHE_EXPR, ERB_EXPR$1 = ERB_EXPR, TMPLIT_EXPR$1 = TMPLIT_EXPR, DATA_ATTR$1 = DATA_ATTR, ARIA_ATTR$1 = ARIA_ATTR, IS_SCRIPT_OR_DATA$1 = IS_SCRIPT_OR_DATA, ATTR_WHITESPACE$1 = ATTR_WHITESPACE, CUSTOM_ELEMENT$1 = CUSTOM_ELEMENT;
  let IS_ALLOWED_URI$1 = IS_ALLOWED_URI;
  let ALLOWED_TAGS2 = null;
  const DEFAULT_ALLOWED_TAGS = addToSet({}, [...html$1, ...svg$1, ...svgFilters, ...mathMl$1, ...text]);
  let ALLOWED_ATTR2 = null;
  const DEFAULT_ALLOWED_ATTR = addToSet({}, [...html, ...svg, ...mathMl, ...xml]);
  let CUSTOM_ELEMENT_HANDLING = Object.seal(create(null, {
    tagNameCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    attributeNameCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    allowCustomizedBuiltInElements: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: false
    }
  }));
  let FORBID_TAGS = null;
  let FORBID_ATTR = null;
  const EXTRA_ELEMENT_HANDLING = Object.seal(create(null, {
    tagCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    },
    attributeCheck: {
      writable: true,
      configurable: false,
      enumerable: true,
      value: null
    }
  }));
  let ALLOW_ARIA_ATTR = true;
  let ALLOW_DATA_ATTR = true;
  let ALLOW_UNKNOWN_PROTOCOLS = false;
  let ALLOW_SELF_CLOSE_IN_ATTR = true;
  let SAFE_FOR_TEMPLATES = false;
  let SAFE_FOR_XML = true;
  let WHOLE_DOCUMENT = false;
  let SET_CONFIG = false;
  let SET_CONFIG_ALLOWED_TAGS = null;
  let SET_CONFIG_ALLOWED_ATTR = null;
  let FORCE_BODY = false;
  let RETURN_DOM = false;
  let RETURN_DOM_FRAGMENT = false;
  let RETURN_TRUSTED_TYPE = false;
  let SANITIZE_DOM = true;
  let SANITIZE_NAMED_PROPS = false;
  const SANITIZE_NAMED_PROPS_PREFIX = "user-content-";
  let KEEP_CONTENT = true;
  let IN_PLACE = false;
  let USE_PROFILES = {};
  let FORBID_CONTENTS = null;
  const DEFAULT_FORBID_CONTENTS = addToSet({}, [
    "annotation-xml",
    "audio",
    "colgroup",
    "desc",
    "foreignobject",
    "head",
    "iframe",
    "math",
    "mi",
    "mn",
    "mo",
    "ms",
    "mtext",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
    "script",
    // <selectedcontent> mirrors the selected <option>'s subtree, cloned by
    // the UA (customizable <select>) — including any on* handlers — and the
    // engine re-mirrors synchronously whenever a removal changes which
    // option/selectedcontent is current, even inside DOMPurify's inert
    // DOMParser document. Hoisting its children on removal re-inserts a fresh
    // mirror target ahead of the walk, which the engine refills, looping
    // forever (DoS) and amplifying output. Dropping its content on removal
    // (rather than hoisting) breaks that cascade; the content is a duplicate
    // of the option, which is sanitized on its own. See campaign-3 F1/F6.
    "selectedcontent",
    "style",
    "svg",
    "template",
    "thead",
    "title",
    "video",
    "xmp"
  ]);
  let DATA_URI_TAGS = null;
  const DEFAULT_DATA_URI_TAGS = addToSet({}, ["audio", "video", "img", "source", "image", "track"]);
  let URI_SAFE_ATTRIBUTES = null;
  const DEFAULT_URI_SAFE_ATTRIBUTES = addToSet({}, ["alt", "class", "for", "id", "label", "name", "pattern", "placeholder", "role", "summary", "title", "value", "style", "xmlns"]);
  const MATHML_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
  let NAMESPACE = HTML_NAMESPACE;
  let IS_EMPTY_INPUT = false;
  let ALLOWED_NAMESPACES = null;
  const DEFAULT_ALLOWED_NAMESPACES = addToSet({}, [MATHML_NAMESPACE, SVG_NAMESPACE, HTML_NAMESPACE], stringToString);
  const DEFAULT_MATHML_TEXT_INTEGRATION_POINTS = freeze(["mi", "mo", "mn", "ms", "mtext"]);
  let MATHML_TEXT_INTEGRATION_POINTS = addToSet({}, DEFAULT_MATHML_TEXT_INTEGRATION_POINTS);
  const DEFAULT_HTML_INTEGRATION_POINTS = freeze(["annotation-xml"]);
  let HTML_INTEGRATION_POINTS = addToSet({}, DEFAULT_HTML_INTEGRATION_POINTS);
  const COMMON_SVG_AND_HTML_ELEMENTS = addToSet({}, ["title", "style", "font", "a", "script"]);
  let PARSER_MEDIA_TYPE = null;
  const SUPPORTED_PARSER_MEDIA_TYPES = ["application/xhtml+xml", "text/html"];
  const DEFAULT_PARSER_MEDIA_TYPE = "text/html";
  let transformCaseFunc = null;
  let CONFIG = null;
  const formElement = document2.createElement("form");
  const isRegexOrFunction = function isRegexOrFunction2(testValue) {
    return testValue instanceof RegExp || testValue instanceof Function;
  };
  const _parseConfig = function _parseConfig2() {
    let cfg = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    if (CONFIG && CONFIG === cfg) {
      return;
    }
    if (!cfg || typeof cfg !== "object") {
      cfg = {};
    }
    cfg = clone(cfg);
    PARSER_MEDIA_TYPE = // eslint-disable-next-line unicorn/prefer-includes
    SUPPORTED_PARSER_MEDIA_TYPES.indexOf(cfg.PARSER_MEDIA_TYPE) === -1 ? DEFAULT_PARSER_MEDIA_TYPE : cfg.PARSER_MEDIA_TYPE;
    transformCaseFunc = PARSER_MEDIA_TYPE === "application/xhtml+xml" ? stringToString : stringToLowerCase;
    ALLOWED_TAGS2 = _resolveSetOption(cfg, "ALLOWED_TAGS", DEFAULT_ALLOWED_TAGS, {
      transform: transformCaseFunc
    });
    ALLOWED_ATTR2 = _resolveSetOption(cfg, "ALLOWED_ATTR", DEFAULT_ALLOWED_ATTR, {
      transform: transformCaseFunc
    });
    ALLOWED_NAMESPACES = _resolveSetOption(cfg, "ALLOWED_NAMESPACES", DEFAULT_ALLOWED_NAMESPACES, {
      transform: stringToString
    });
    URI_SAFE_ATTRIBUTES = _resolveSetOption(cfg, "ADD_URI_SAFE_ATTR", DEFAULT_URI_SAFE_ATTRIBUTES, {
      transform: transformCaseFunc,
      base: DEFAULT_URI_SAFE_ATTRIBUTES
    });
    DATA_URI_TAGS = _resolveSetOption(cfg, "ADD_DATA_URI_TAGS", DEFAULT_DATA_URI_TAGS, {
      transform: transformCaseFunc,
      base: DEFAULT_DATA_URI_TAGS
    });
    FORBID_CONTENTS = _resolveSetOption(cfg, "FORBID_CONTENTS", DEFAULT_FORBID_CONTENTS, {
      transform: transformCaseFunc
    });
    FORBID_TAGS = _resolveSetOption(cfg, "FORBID_TAGS", clone({}), {
      transform: transformCaseFunc
    });
    FORBID_ATTR = _resolveSetOption(cfg, "FORBID_ATTR", clone({}), {
      transform: transformCaseFunc
    });
    USE_PROFILES = objectHasOwnProperty(cfg, "USE_PROFILES") ? cfg.USE_PROFILES && typeof cfg.USE_PROFILES === "object" ? clone(cfg.USE_PROFILES) : cfg.USE_PROFILES : false;
    ALLOW_ARIA_ATTR = cfg.ALLOW_ARIA_ATTR !== false;
    ALLOW_DATA_ATTR = cfg.ALLOW_DATA_ATTR !== false;
    ALLOW_UNKNOWN_PROTOCOLS = cfg.ALLOW_UNKNOWN_PROTOCOLS || false;
    ALLOW_SELF_CLOSE_IN_ATTR = cfg.ALLOW_SELF_CLOSE_IN_ATTR !== false;
    SAFE_FOR_TEMPLATES = cfg.SAFE_FOR_TEMPLATES || false;
    SAFE_FOR_XML = cfg.SAFE_FOR_XML !== false;
    WHOLE_DOCUMENT = cfg.WHOLE_DOCUMENT || false;
    RETURN_DOM = cfg.RETURN_DOM || false;
    RETURN_DOM_FRAGMENT = cfg.RETURN_DOM_FRAGMENT || false;
    RETURN_TRUSTED_TYPE = cfg.RETURN_TRUSTED_TYPE || false;
    FORCE_BODY = cfg.FORCE_BODY || false;
    SANITIZE_DOM = cfg.SANITIZE_DOM !== false;
    SANITIZE_NAMED_PROPS = cfg.SANITIZE_NAMED_PROPS || false;
    KEEP_CONTENT = cfg.KEEP_CONTENT !== false;
    IN_PLACE = cfg.IN_PLACE || false;
    IS_ALLOWED_URI$1 = isRegex(cfg.ALLOWED_URI_REGEXP) ? cfg.ALLOWED_URI_REGEXP : IS_ALLOWED_URI;
    NAMESPACE = typeof cfg.NAMESPACE === "string" ? cfg.NAMESPACE : HTML_NAMESPACE;
    MATHML_TEXT_INTEGRATION_POINTS = objectHasOwnProperty(cfg, "MATHML_TEXT_INTEGRATION_POINTS") && cfg.MATHML_TEXT_INTEGRATION_POINTS && typeof cfg.MATHML_TEXT_INTEGRATION_POINTS === "object" ? clone(cfg.MATHML_TEXT_INTEGRATION_POINTS) : addToSet({}, DEFAULT_MATHML_TEXT_INTEGRATION_POINTS);
    HTML_INTEGRATION_POINTS = objectHasOwnProperty(cfg, "HTML_INTEGRATION_POINTS") && cfg.HTML_INTEGRATION_POINTS && typeof cfg.HTML_INTEGRATION_POINTS === "object" ? clone(cfg.HTML_INTEGRATION_POINTS) : addToSet({}, DEFAULT_HTML_INTEGRATION_POINTS);
    const customElementHandling = objectHasOwnProperty(cfg, "CUSTOM_ELEMENT_HANDLING") && cfg.CUSTOM_ELEMENT_HANDLING && typeof cfg.CUSTOM_ELEMENT_HANDLING === "object" ? clone(cfg.CUSTOM_ELEMENT_HANDLING) : create(null);
    CUSTOM_ELEMENT_HANDLING = create(null);
    if (objectHasOwnProperty(customElementHandling, "tagNameCheck") && isRegexOrFunction(customElementHandling.tagNameCheck)) {
      CUSTOM_ELEMENT_HANDLING.tagNameCheck = customElementHandling.tagNameCheck;
    }
    if (objectHasOwnProperty(customElementHandling, "attributeNameCheck") && isRegexOrFunction(customElementHandling.attributeNameCheck)) {
      CUSTOM_ELEMENT_HANDLING.attributeNameCheck = customElementHandling.attributeNameCheck;
    }
    if (objectHasOwnProperty(customElementHandling, "allowCustomizedBuiltInElements") && typeof customElementHandling.allowCustomizedBuiltInElements === "boolean") {
      CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements = customElementHandling.allowCustomizedBuiltInElements;
    }
    seal(CUSTOM_ELEMENT_HANDLING);
    if (SAFE_FOR_TEMPLATES) {
      ALLOW_DATA_ATTR = false;
    }
    if (RETURN_DOM_FRAGMENT) {
      RETURN_DOM = true;
    }
    if (USE_PROFILES) {
      ALLOWED_TAGS2 = addToSet({}, text);
      ALLOWED_ATTR2 = create(null);
      if (USE_PROFILES.html === true) {
        addToSet(ALLOWED_TAGS2, html$1);
        addToSet(ALLOWED_ATTR2, html);
      }
      if (USE_PROFILES.svg === true) {
        addToSet(ALLOWED_TAGS2, svg$1);
        addToSet(ALLOWED_ATTR2, svg);
        addToSet(ALLOWED_ATTR2, xml);
      }
      if (USE_PROFILES.svgFilters === true) {
        addToSet(ALLOWED_TAGS2, svgFilters);
        addToSet(ALLOWED_ATTR2, svg);
        addToSet(ALLOWED_ATTR2, xml);
      }
      if (USE_PROFILES.mathMl === true) {
        addToSet(ALLOWED_TAGS2, mathMl$1);
        addToSet(ALLOWED_ATTR2, mathMl);
        addToSet(ALLOWED_ATTR2, xml);
      }
    }
    EXTRA_ELEMENT_HANDLING.tagCheck = null;
    EXTRA_ELEMENT_HANDLING.attributeCheck = null;
    if (objectHasOwnProperty(cfg, "ADD_TAGS")) {
      if (typeof cfg.ADD_TAGS === "function") {
        EXTRA_ELEMENT_HANDLING.tagCheck = cfg.ADD_TAGS;
      } else if (arrayIsArray(cfg.ADD_TAGS)) {
        if (ALLOWED_TAGS2 === DEFAULT_ALLOWED_TAGS) {
          ALLOWED_TAGS2 = clone(ALLOWED_TAGS2);
        }
        addToSet(ALLOWED_TAGS2, cfg.ADD_TAGS, transformCaseFunc);
      }
    }
    if (objectHasOwnProperty(cfg, "ADD_ATTR")) {
      if (typeof cfg.ADD_ATTR === "function") {
        EXTRA_ELEMENT_HANDLING.attributeCheck = cfg.ADD_ATTR;
      } else if (arrayIsArray(cfg.ADD_ATTR)) {
        if (ALLOWED_ATTR2 === DEFAULT_ALLOWED_ATTR) {
          ALLOWED_ATTR2 = clone(ALLOWED_ATTR2);
        }
        addToSet(ALLOWED_ATTR2, cfg.ADD_ATTR, transformCaseFunc);
      }
    }
    if (objectHasOwnProperty(cfg, "ADD_URI_SAFE_ATTR") && arrayIsArray(cfg.ADD_URI_SAFE_ATTR)) {
      addToSet(URI_SAFE_ATTRIBUTES, cfg.ADD_URI_SAFE_ATTR, transformCaseFunc);
    }
    if (objectHasOwnProperty(cfg, "FORBID_CONTENTS") && arrayIsArray(cfg.FORBID_CONTENTS)) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) {
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      }
      addToSet(FORBID_CONTENTS, cfg.FORBID_CONTENTS, transformCaseFunc);
    }
    if (objectHasOwnProperty(cfg, "ADD_FORBID_CONTENTS") && arrayIsArray(cfg.ADD_FORBID_CONTENTS)) {
      if (FORBID_CONTENTS === DEFAULT_FORBID_CONTENTS) {
        FORBID_CONTENTS = clone(FORBID_CONTENTS);
      }
      addToSet(FORBID_CONTENTS, cfg.ADD_FORBID_CONTENTS, transformCaseFunc);
    }
    if (KEEP_CONTENT) {
      ALLOWED_TAGS2["#text"] = true;
    }
    if (WHOLE_DOCUMENT) {
      addToSet(ALLOWED_TAGS2, ["html", "head", "body"]);
    }
    if (ALLOWED_TAGS2.table) {
      addToSet(ALLOWED_TAGS2, ["tbody"]);
      delete FORBID_TAGS.tbody;
    }
    if (cfg.TRUSTED_TYPES_POLICY) {
      if (typeof cfg.TRUSTED_TYPES_POLICY.createHTML !== "function") {
        throw typeErrorCreate('TRUSTED_TYPES_POLICY configuration option must provide a "createHTML" hook.');
      }
      if (typeof cfg.TRUSTED_TYPES_POLICY.createScriptURL !== "function") {
        throw typeErrorCreate('TRUSTED_TYPES_POLICY configuration option must provide a "createScriptURL" hook.');
      }
      const previousTrustedTypesPolicy = trustedTypesPolicy;
      trustedTypesPolicy = cfg.TRUSTED_TYPES_POLICY;
      try {
        emptyHTML = _createTrustedHTML("");
      } catch (error) {
        trustedTypesPolicy = previousTrustedTypesPolicy;
        throw error;
      }
    } else if (cfg.TRUSTED_TYPES_POLICY === null) {
      trustedTypesPolicy = void 0;
      emptyHTML = "";
    } else {
      if (trustedTypesPolicy === void 0) {
        trustedTypesPolicy = _getDefaultTrustedTypesPolicy();
      }
      if (trustedTypesPolicy && typeof emptyHTML === "string") {
        emptyHTML = _createTrustedHTML("");
      }
    }
    if (freeze) {
      freeze(cfg);
    }
    CONFIG = cfg;
  };
  const ALL_SVG_TAGS = addToSet({}, [...svg$1, ...svgFilters, ...svgDisallowed]);
  const ALL_MATHML_TAGS = addToSet({}, [...mathMl$1, ...mathMlDisallowed]);
  const _checkSvgNamespace = function _checkSvgNamespace2(tagName, parent, parentTagName) {
    if (parent.namespaceURI === HTML_NAMESPACE) {
      return tagName === "svg";
    }
    if (parent.namespaceURI === MATHML_NAMESPACE) {
      return tagName === "svg" && (parentTagName === "annotation-xml" || MATHML_TEXT_INTEGRATION_POINTS[parentTagName]);
    }
    return Boolean(ALL_SVG_TAGS[tagName]);
  };
  const _checkMathMlNamespace = function _checkMathMlNamespace2(tagName, parent, parentTagName) {
    if (parent.namespaceURI === HTML_NAMESPACE) {
      return tagName === "math";
    }
    if (parent.namespaceURI === SVG_NAMESPACE) {
      return tagName === "math" && HTML_INTEGRATION_POINTS[parentTagName];
    }
    return Boolean(ALL_MATHML_TAGS[tagName]);
  };
  const _checkHtmlNamespace = function _checkHtmlNamespace2(tagName, parent, parentTagName) {
    if (parent.namespaceURI === SVG_NAMESPACE && !HTML_INTEGRATION_POINTS[parentTagName]) {
      return false;
    }
    if (parent.namespaceURI === MATHML_NAMESPACE && !MATHML_TEXT_INTEGRATION_POINTS[parentTagName]) {
      return false;
    }
    return !ALL_MATHML_TAGS[tagName] && (COMMON_SVG_AND_HTML_ELEMENTS[tagName] || !ALL_SVG_TAGS[tagName]);
  };
  const _checkValidNamespace = function _checkValidNamespace2(element) {
    let parent = getParentNode(element);
    if (!parent || !parent.tagName) {
      parent = {
        namespaceURI: NAMESPACE,
        tagName: "template"
      };
    }
    const tagName = stringToLowerCase(element.tagName);
    const parentTagName = stringToLowerCase(parent.tagName);
    if (!ALLOWED_NAMESPACES[element.namespaceURI]) {
      return false;
    }
    if (element.namespaceURI === SVG_NAMESPACE) {
      return _checkSvgNamespace(tagName, parent, parentTagName);
    }
    if (element.namespaceURI === MATHML_NAMESPACE) {
      return _checkMathMlNamespace(tagName, parent, parentTagName);
    }
    if (element.namespaceURI === HTML_NAMESPACE) {
      return _checkHtmlNamespace(tagName, parent, parentTagName);
    }
    if (PARSER_MEDIA_TYPE === "application/xhtml+xml" && ALLOWED_NAMESPACES[element.namespaceURI]) {
      return true;
    }
    return false;
  };
  const _forceRemove = function _forceRemove2(node) {
    arrayPush(DOMPurify.removed, {
      element: node
    });
    try {
      getParentNode(node).removeChild(node);
    } catch (_) {
      remove(node);
      if (!getParentNode(node)) {
        throw typeErrorCreate("a node selected for removal could not be detached from its tree and cannot be safely returned; refusing to sanitize in place");
      }
    }
  };
  const _neutralizeRoot = function _neutralizeRoot2(root) {
    const childNodes = getChildNodes(root);
    if (childNodes) {
      const snapshot = [];
      arrayForEach(childNodes, (child) => {
        arrayPush(snapshot, child);
      });
      arrayForEach(snapshot, (child) => {
        try {
          remove(child);
        } catch (_) {
        }
      });
    }
    const attributes = getAttributes(root);
    if (attributes) {
      for (let i = attributes.length - 1; i >= 0; --i) {
        const attribute = attributes[i];
        const name = attribute && attribute.name;
        if (typeof name === "string") {
          try {
            root.removeAttribute(name);
          } catch (_) {
          }
        }
      }
    }
  };
  const _removeAttribute = function _removeAttribute2(name, element) {
    try {
      arrayPush(DOMPurify.removed, {
        attribute: element.getAttributeNode(name),
        from: element
      });
    } catch (_) {
      arrayPush(DOMPurify.removed, {
        attribute: null,
        from: element
      });
    }
    element.removeAttribute(name);
    if (name === "is") {
      if (RETURN_DOM || RETURN_DOM_FRAGMENT) {
        try {
          _forceRemove(element);
        } catch (_) {
        }
      } else {
        try {
          element.setAttribute(name, "");
        } catch (_) {
        }
      }
    }
  };
  const _stripDisallowedAttributes = function _stripDisallowedAttributes2(element) {
    const attributes = getAttributes(element);
    if (!attributes) {
      return;
    }
    for (let i = attributes.length - 1; i >= 0; --i) {
      const attribute = attributes[i];
      const name = attribute && attribute.name;
      if (typeof name !== "string" || ALLOWED_ATTR2[transformCaseFunc(name)]) {
        continue;
      }
      try {
        element.removeAttribute(name);
      } catch (_) {
      }
    }
  };
  const _neutralizeSubtree = function _neutralizeSubtree2(root) {
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      const nodeType = getNodeType ? getNodeType(node) : node.nodeType;
      if (nodeType === NODE_TYPE.element) {
        _stripDisallowedAttributes(node);
      }
      const childNodes = getChildNodes(node);
      if (childNodes) {
        for (let i = childNodes.length - 1; i >= 0; --i) {
          stack.push(childNodes[i]);
        }
      }
    }
  };
  const _initDocument = function _initDocument2(dirty) {
    let doc = null;
    let leadingWhitespace = null;
    if (FORCE_BODY) {
      dirty = "<remove></remove>" + dirty;
    } else {
      const matches = stringMatch(dirty, /^[\r\n\t ]+/);
      leadingWhitespace = matches && matches[0];
    }
    if (PARSER_MEDIA_TYPE === "application/xhtml+xml" && NAMESPACE === HTML_NAMESPACE) {
      dirty = '<html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>' + dirty + "</body></html>";
    }
    const dirtyPayload = trustedTypesPolicy ? _createTrustedHTML(dirty) : dirty;
    if (NAMESPACE === HTML_NAMESPACE) {
      try {
        doc = new DOMParser().parseFromString(dirtyPayload, PARSER_MEDIA_TYPE);
      } catch (_) {
      }
    }
    if (!doc || !doc.documentElement) {
      doc = implementation.createDocument(NAMESPACE, "template", null);
      try {
        doc.documentElement.innerHTML = IS_EMPTY_INPUT ? emptyHTML : dirtyPayload;
      } catch (_) {
      }
    }
    const body = doc.body || doc.documentElement;
    if (dirty && leadingWhitespace) {
      body.insertBefore(document2.createTextNode(leadingWhitespace), body.childNodes[0] || null);
    }
    if (NAMESPACE === HTML_NAMESPACE) {
      return getElementsByTagName.call(doc, WHOLE_DOCUMENT ? "html" : "body")[0];
    }
    return WHOLE_DOCUMENT ? doc.documentElement : body;
  };
  const _createNodeIterator = function _createNodeIterator2(root) {
    return createNodeIterator.call(
      root.ownerDocument || root,
      root,
      // eslint-disable-next-line no-bitwise
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT | NodeFilter.SHOW_PROCESSING_INSTRUCTION | NodeFilter.SHOW_CDATA_SECTION,
      null
    );
  };
  const _stripTemplateExpressions = function _stripTemplateExpressions2(value) {
    value = stringReplace(value, MUSTACHE_EXPR$1, " ");
    value = stringReplace(value, ERB_EXPR$1, " ");
    value = stringReplace(value, TMPLIT_EXPR$1, " ");
    return value;
  };
  const _scrubTemplateExpressions2 = function _scrubTemplateExpressions(node) {
    var _node$querySelectorAl;
    node.normalize();
    const walker = createNodeIterator.call(
      node.ownerDocument || node,
      node,
      // eslint-disable-next-line no-bitwise
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_CDATA_SECTION | NodeFilter.SHOW_PROCESSING_INSTRUCTION,
      null
    );
    let currentNode = walker.nextNode();
    while (currentNode) {
      currentNode.data = _stripTemplateExpressions(currentNode.data);
      currentNode = walker.nextNode();
    }
    const templates = (_node$querySelectorAl = node.querySelectorAll) === null || _node$querySelectorAl === void 0 ? void 0 : _node$querySelectorAl.call(node, "template");
    if (templates) {
      arrayForEach(templates, (tmpl) => {
        if (_isDocumentFragment(tmpl.content)) {
          _scrubTemplateExpressions2(tmpl.content);
        }
      });
    }
  };
  const _isClobbered = function _isClobbered2(element) {
    const realTagName = getNodeName ? getNodeName(element) : null;
    if (typeof realTagName !== "string") {
      return false;
    }
    if (transformCaseFunc(realTagName) !== "form") {
      return false;
    }
    return typeof element.nodeName !== "string" || typeof element.textContent !== "string" || typeof element.removeChild !== "function" || // Realm-safe NamedNodeMap detection: equality against the cached
    // prototype getter. Clobbered .attributes (e.g. <input name="attributes">)
    // makes the direct read diverge from the cached read; a clean form
    // (same-realm OR foreign-realm) has both reads pointing at the same
    // canonical NamedNodeMap.
    element.attributes !== getAttributes(element) || typeof element.removeAttribute !== "function" || typeof element.setAttribute !== "function" || typeof element.namespaceURI !== "string" || typeof element.insertBefore !== "function" || typeof element.hasChildNodes !== "function" || // NodeType clobbering probe. Cached Node.prototype.nodeType getter
    // returns the integer 1 for any Element regardless of realm; direct
    // read on a clobbered form (e.g. <input name="nodeType">) returns
    // the named child element. Cheap addition — nodeType is read from
    // an internal slot, no serialization cost — and removes a residual
    // clobbering surface used by several mXSS / PI / comment branches
    // in _sanitizeElements that compare currentNode.nodeType directly.
    element.nodeType !== getNodeType(element) || // HTMLFormElement has [LegacyOverrideBuiltIns]: a descendant named
    // "childNodes" shadows the prototype getter. Direct reads of
    // form.childNodes from a clobbered form return the named child
    // instead of the real NodeList, so any walk that reads it directly
    // skips the form's real children. Compare the direct read to the
    // cached Node.prototype getter — when the form's named-property
    // getter intercepts the read, the two values differ and we flag
    // the form. This catches every clobbering child type (input,
    // select, etc.) regardless of whether the named child happens to
    // carry a numeric .length, which a typeof-based probe would miss
    // (e.g. HTMLSelectElement.length is a defined unsigned-long).
    element.childNodes !== getChildNodes(element);
  };
  const _isDocumentFragment = function _isDocumentFragment2(value) {
    if (!getNodeType || typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return getNodeType(value) === NODE_TYPE.documentFragment;
    } catch (_) {
      return false;
    }
  };
  const _isNode = function _isNode2(value) {
    if (!getNodeType || typeof value !== "object" || value === null) {
      return false;
    }
    try {
      return typeof getNodeType(value) === "number";
    } catch (_) {
      return false;
    }
  };
  function _executeHooks(hooks2, currentNode, data) {
    if (hooks2.length === 0) {
      return;
    }
    arrayForEach(hooks2, (hook) => {
      hook.call(DOMPurify, currentNode, data, CONFIG);
    });
  }
  const _isUnsafeNode = function _isUnsafeNode2(currentNode, tagName) {
    if (SAFE_FOR_XML && currentNode.hasChildNodes() && !_isNode(currentNode.firstElementChild) && regExpTest(ELEMENT_MARKUP_PROBE, currentNode.textContent) && regExpTest(ELEMENT_MARKUP_PROBE, currentNode.innerHTML)) {
      return true;
    }
    if (SAFE_FOR_XML && currentNode.namespaceURI === HTML_NAMESPACE && tagName === "style" && _isNode(currentNode.firstElementChild)) {
      return true;
    }
    if (currentNode.nodeType === NODE_TYPE.processingInstruction) {
      return true;
    }
    if (SAFE_FOR_XML && currentNode.nodeType === NODE_TYPE.comment && regExpTest(COMMENT_MARKUP_PROBE, currentNode.data)) {
      return true;
    }
    return false;
  };
  const _sanitizeDisallowedNode = function _sanitizeDisallowedNode2(currentNode, tagName) {
    if (!FORBID_TAGS[tagName] && _isBasicCustomElement(tagName)) {
      if (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, tagName)) {
        return false;
      }
      if (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(tagName)) {
        return false;
      }
    }
    if (KEEP_CONTENT && !FORBID_CONTENTS[tagName]) {
      const parentNode = getParentNode(currentNode);
      const childNodes = getChildNodes(currentNode);
      if (childNodes && parentNode) {
        const childCount = childNodes.length;
        for (let i = childCount - 1; i >= 0; --i) {
          const hoisted = IN_PLACE ? childNodes[i] : cloneNode(childNodes[i], true);
          parentNode.insertBefore(hoisted, getNextSibling(currentNode));
        }
      }
    }
    _forceRemove(currentNode);
    return true;
  };
  const _sanitizeElements = function _sanitizeElements2(currentNode) {
    _executeHooks(hooks.beforeSanitizeElements, currentNode, null);
    if (_isClobbered(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    const tagName = transformCaseFunc(getNodeName ? getNodeName(currentNode) : currentNode.nodeName);
    _executeHooks(hooks.uponSanitizeElement, currentNode, {
      tagName,
      allowedTags: ALLOWED_TAGS2
    });
    if (_isUnsafeNode(currentNode, tagName)) {
      _forceRemove(currentNode);
      return true;
    }
    if (FORBID_TAGS[tagName] || !(EXTRA_ELEMENT_HANDLING.tagCheck instanceof Function && EXTRA_ELEMENT_HANDLING.tagCheck(tagName)) && !ALLOWED_TAGS2[tagName]) {
      return _sanitizeDisallowedNode(currentNode, tagName);
    }
    const nt = getNodeType ? getNodeType(currentNode) : currentNode.nodeType;
    if (nt === NODE_TYPE.element && !_checkValidNamespace(currentNode)) {
      _forceRemove(currentNode);
      return true;
    }
    if ((tagName === "noscript" || tagName === "noembed" || tagName === "noframes") && regExpTest(FALLBACK_TAG_CLOSE, currentNode.innerHTML)) {
      _forceRemove(currentNode);
      return true;
    }
    if (SAFE_FOR_TEMPLATES && currentNode.nodeType === NODE_TYPE.text) {
      const content = _stripTemplateExpressions(currentNode.textContent);
      if (currentNode.textContent !== content) {
        arrayPush(DOMPurify.removed, {
          element: currentNode.cloneNode()
        });
        currentNode.textContent = content;
      }
    }
    _executeHooks(hooks.afterSanitizeElements, currentNode, null);
    return false;
  };
  const _isValidAttribute = function _isValidAttribute2(lcTag, lcName, value) {
    if (FORBID_ATTR[lcName]) {
      return false;
    }
    if (SANITIZE_DOM && (lcName === "id" || lcName === "name") && (value in document2 || value in formElement)) {
      return false;
    }
    const nameIsPermitted = ALLOWED_ATTR2[lcName] || EXTRA_ELEMENT_HANDLING.attributeCheck instanceof Function && EXTRA_ELEMENT_HANDLING.attributeCheck(lcName, lcTag);
    if (ALLOW_DATA_ATTR && regExpTest(DATA_ATTR$1, lcName)) ;
    else if (ALLOW_ARIA_ATTR && regExpTest(ARIA_ATTR$1, lcName)) ;
    else if (!nameIsPermitted) {
      if (
        // First condition does a very basic check if a) it's basically a valid custom element tagname AND
        // b) if the tagName passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.tagNameCheck
        // and c) if the attribute name passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.attributeNameCheck
        _isBasicCustomElement(lcTag) && (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, lcTag) || CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(lcTag)) && (CUSTOM_ELEMENT_HANDLING.attributeNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.attributeNameCheck, lcName) || CUSTOM_ELEMENT_HANDLING.attributeNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.attributeNameCheck(lcName, lcTag)) || // Alternative, second condition checks if it's an `is`-attribute, AND
        // the value passes whatever the user has configured for CUSTOM_ELEMENT_HANDLING.tagNameCheck
        lcName === "is" && CUSTOM_ELEMENT_HANDLING.allowCustomizedBuiltInElements && (CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof RegExp && regExpTest(CUSTOM_ELEMENT_HANDLING.tagNameCheck, value) || CUSTOM_ELEMENT_HANDLING.tagNameCheck instanceof Function && CUSTOM_ELEMENT_HANDLING.tagNameCheck(value))
      ) ;
      else {
        return false;
      }
    } else if (URI_SAFE_ATTRIBUTES[lcName]) ;
    else if (regExpTest(IS_ALLOWED_URI$1, stringReplace(value, ATTR_WHITESPACE$1, ""))) ;
    else if ((lcName === "src" || lcName === "xlink:href" || lcName === "href") && lcTag !== "script" && stringIndexOf(value, "data:") === 0 && DATA_URI_TAGS[lcTag]) ;
    else if (ALLOW_UNKNOWN_PROTOCOLS && !regExpTest(IS_SCRIPT_OR_DATA$1, stringReplace(value, ATTR_WHITESPACE$1, ""))) ;
    else if (value) {
      return false;
    } else ;
    return true;
  };
  const RESERVED_CUSTOM_ELEMENT_NAMES = addToSet({}, ["annotation-xml", "color-profile", "font-face", "font-face-format", "font-face-name", "font-face-src", "font-face-uri", "missing-glyph"]);
  const _isBasicCustomElement = function _isBasicCustomElement2(tagName) {
    return !RESERVED_CUSTOM_ELEMENT_NAMES[stringToLowerCase(tagName)] && regExpTest(CUSTOM_ELEMENT$1, tagName);
  };
  const _applyTrustedTypesToAttribute = function _applyTrustedTypesToAttribute2(lcTag, lcName, namespaceURI, value) {
    if (trustedTypesPolicy && typeof trustedTypes === "object" && typeof trustedTypes.getAttributeType === "function" && !namespaceURI) {
      switch (trustedTypes.getAttributeType(lcTag, lcName)) {
        case "TrustedHTML": {
          return _createTrustedHTML(value);
        }
        case "TrustedScriptURL": {
          return _createTrustedScriptURL(value);
        }
      }
    }
    return value;
  };
  const _setAttributeValue = function _setAttributeValue2(currentNode, name, namespaceURI, value) {
    try {
      if (namespaceURI) {
        currentNode.setAttributeNS(namespaceURI, name, value);
      } else {
        currentNode.setAttribute(name, value);
      }
      if (_isClobbered(currentNode)) {
        _forceRemove(currentNode);
      } else {
        arrayPop(DOMPurify.removed);
      }
    } catch (_) {
      _removeAttribute(name, currentNode);
    }
  };
  const _sanitizeAttributes = function _sanitizeAttributes2(currentNode) {
    _executeHooks(hooks.beforeSanitizeAttributes, currentNode, null);
    const attributes = currentNode.attributes;
    if (!attributes || _isClobbered(currentNode)) {
      return;
    }
    const hookEvent = {
      attrName: "",
      attrValue: "",
      keepAttr: true,
      allowedAttributes: ALLOWED_ATTR2,
      forceKeepAttr: void 0
    };
    let l = attributes.length;
    const lcTag = transformCaseFunc(currentNode.nodeName);
    while (l--) {
      const attr = attributes[l];
      const name = attr.name, namespaceURI = attr.namespaceURI, attrValue = attr.value;
      const lcName = transformCaseFunc(name);
      const initValue = attrValue;
      let value = name === "value" ? initValue : stringTrim(initValue);
      hookEvent.attrName = lcName;
      hookEvent.attrValue = value;
      hookEvent.keepAttr = true;
      hookEvent.forceKeepAttr = void 0;
      _executeHooks(hooks.uponSanitizeAttribute, currentNode, hookEvent);
      value = hookEvent.attrValue;
      if (SANITIZE_NAMED_PROPS && (lcName === "id" || lcName === "name") && stringIndexOf(value, SANITIZE_NAMED_PROPS_PREFIX) !== 0) {
        _removeAttribute(name, currentNode);
        value = SANITIZE_NAMED_PROPS_PREFIX + value;
      }
      if (SAFE_FOR_XML && regExpTest(/((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (lcName === "attributename" && stringMatch(value, "href")) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (hookEvent.forceKeepAttr) {
        continue;
      }
      if (!hookEvent.keepAttr) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (!ALLOW_SELF_CLOSE_IN_ATTR && regExpTest(SELF_CLOSING_TAG, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      if (SAFE_FOR_TEMPLATES) {
        value = _stripTemplateExpressions(value);
      }
      if (!_isValidAttribute(lcTag, lcName, value)) {
        _removeAttribute(name, currentNode);
        continue;
      }
      value = _applyTrustedTypesToAttribute(lcTag, lcName, namespaceURI, value);
      if (value !== initValue) {
        _setAttributeValue(currentNode, name, namespaceURI, value);
      }
    }
    _executeHooks(hooks.afterSanitizeAttributes, currentNode, null);
  };
  const _sanitizeShadowDOM2 = function _sanitizeShadowDOM(fragment) {
    let shadowNode = null;
    const shadowIterator = _createNodeIterator(fragment);
    _executeHooks(hooks.beforeSanitizeShadowDOM, fragment, null);
    while (shadowNode = shadowIterator.nextNode()) {
      _executeHooks(hooks.uponSanitizeShadowNode, shadowNode, null);
      _sanitizeElements(shadowNode);
      _sanitizeAttributes(shadowNode);
      if (_isDocumentFragment(shadowNode.content)) {
        _sanitizeShadowDOM2(shadowNode.content);
      }
      const shadowNodeType = getNodeType ? getNodeType(shadowNode) : shadowNode.nodeType;
      if (shadowNodeType === NODE_TYPE.element) {
        const innerSr = getShadowRoot(shadowNode);
        if (_isDocumentFragment(innerSr)) {
          _sanitizeAttachedShadowRoots(innerSr);
          _sanitizeShadowDOM2(innerSr);
        }
      }
    }
    _executeHooks(hooks.afterSanitizeShadowDOM, fragment, null);
  };
  const _sanitizeAttachedShadowRoots = function _sanitizeAttachedShadowRoots2(root) {
    const stack = [{
      node: root,
      shadow: null
    }];
    while (stack.length > 0) {
      const item = stack.pop();
      if (item.shadow) {
        _sanitizeShadowDOM2(item.shadow);
        continue;
      }
      const node = item.node;
      const nodeType = getNodeType ? getNodeType(node) : node.nodeType;
      const isElement = nodeType === NODE_TYPE.element;
      const childNodes = getChildNodes(node);
      if (childNodes) {
        for (let i = childNodes.length - 1; i >= 0; --i) {
          stack.push({
            node: childNodes[i],
            shadow: null
          });
        }
      }
      if (isElement) {
        const rootName = getNodeName ? getNodeName(node) : null;
        if (typeof rootName === "string" && transformCaseFunc(rootName) === "template") {
          const content = node.content;
          if (_isDocumentFragment(content)) {
            stack.push({
              node: content,
              shadow: null
            });
          }
        }
      }
      if (isElement) {
        const sr = getShadowRoot(node);
        if (_isDocumentFragment(sr)) {
          stack.push({
            node: null,
            shadow: sr
          }, {
            node: sr,
            shadow: null
          });
        }
      }
    }
  };
  DOMPurify.sanitize = function(dirty) {
    let cfg = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : {};
    let body = null;
    let importedNode = null;
    let currentNode = null;
    let returnNode = null;
    IS_EMPTY_INPUT = !dirty;
    if (IS_EMPTY_INPUT) {
      dirty = "<!-->";
    }
    if (typeof dirty !== "string" && !_isNode(dirty)) {
      dirty = stringifyValue(dirty);
      if (typeof dirty !== "string") {
        throw typeErrorCreate("dirty is not a string, aborting");
      }
    }
    if (!DOMPurify.isSupported) {
      return dirty;
    }
    if (SET_CONFIG) {
      ALLOWED_TAGS2 = SET_CONFIG_ALLOWED_TAGS;
      ALLOWED_ATTR2 = SET_CONFIG_ALLOWED_ATTR;
    } else {
      _parseConfig(cfg);
    }
    if (hooks.uponSanitizeElement.length > 0 || hooks.uponSanitizeAttribute.length > 0) {
      ALLOWED_TAGS2 = clone(ALLOWED_TAGS2);
    }
    if (hooks.uponSanitizeAttribute.length > 0) {
      ALLOWED_ATTR2 = clone(ALLOWED_ATTR2);
    }
    DOMPurify.removed = [];
    const inPlace = IN_PLACE && typeof dirty !== "string" && _isNode(dirty);
    if (inPlace) {
      const nn = getNodeName ? getNodeName(dirty) : dirty.nodeName;
      if (typeof nn === "string") {
        const tagName = transformCaseFunc(nn);
        if (!ALLOWED_TAGS2[tagName] || FORBID_TAGS[tagName]) {
          throw typeErrorCreate("root node is forbidden and cannot be sanitized in-place");
        }
      }
      if (_isClobbered(dirty)) {
        throw typeErrorCreate("root node is clobbered and cannot be sanitized in-place");
      }
      try {
        _sanitizeAttachedShadowRoots(dirty);
      } catch (error) {
        _neutralizeRoot(dirty);
        throw error;
      }
    } else if (_isNode(dirty)) {
      body = _initDocument("<!---->");
      importedNode = body.ownerDocument.importNode(dirty, true);
      if (importedNode.nodeType === NODE_TYPE.element && importedNode.nodeName === "BODY") {
        body = importedNode;
      } else if (importedNode.nodeName === "HTML") {
        body = importedNode;
      } else {
        body.appendChild(importedNode);
      }
      _sanitizeAttachedShadowRoots(importedNode);
    } else {
      if (!RETURN_DOM && !SAFE_FOR_TEMPLATES && !WHOLE_DOCUMENT && // eslint-disable-next-line unicorn/prefer-includes
      dirty.indexOf("<") === -1) {
        return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? _createTrustedHTML(dirty) : dirty;
      }
      body = _initDocument(dirty);
      if (!body) {
        return RETURN_DOM ? null : RETURN_TRUSTED_TYPE ? emptyHTML : "";
      }
    }
    if (body && FORCE_BODY) {
      _forceRemove(body.firstChild);
    }
    const nodeIterator = _createNodeIterator(inPlace ? dirty : body);
    try {
      while (currentNode = nodeIterator.nextNode()) {
        _sanitizeElements(currentNode);
        _sanitizeAttributes(currentNode);
        if (_isDocumentFragment(currentNode.content)) {
          _sanitizeShadowDOM2(currentNode.content);
        }
      }
    } catch (error) {
      if (inPlace) {
        _neutralizeRoot(dirty);
      }
      throw error;
    }
    if (inPlace) {
      arrayForEach(DOMPurify.removed, (entry) => {
        if (entry.element) {
          _neutralizeSubtree(entry.element);
        }
      });
      if (SAFE_FOR_TEMPLATES) {
        _scrubTemplateExpressions2(dirty);
      }
      return dirty;
    }
    if (RETURN_DOM) {
      if (SAFE_FOR_TEMPLATES) {
        _scrubTemplateExpressions2(body);
      }
      if (RETURN_DOM_FRAGMENT) {
        returnNode = createDocumentFragment.call(body.ownerDocument);
        while (body.firstChild) {
          returnNode.appendChild(body.firstChild);
        }
      } else {
        returnNode = body;
      }
      if (ALLOWED_ATTR2.shadowroot || ALLOWED_ATTR2.shadowrootmode) {
        returnNode = importNode.call(originalDocument, returnNode, true);
      }
      return returnNode;
    }
    let serializedHTML = WHOLE_DOCUMENT ? body.outerHTML : body.innerHTML;
    if (WHOLE_DOCUMENT && ALLOWED_TAGS2["!doctype"] && body.ownerDocument && body.ownerDocument.doctype && body.ownerDocument.doctype.name && regExpTest(DOCTYPE_NAME, body.ownerDocument.doctype.name)) {
      serializedHTML = "<!DOCTYPE " + body.ownerDocument.doctype.name + ">\n" + serializedHTML;
    }
    if (SAFE_FOR_TEMPLATES) {
      serializedHTML = _stripTemplateExpressions(serializedHTML);
    }
    return trustedTypesPolicy && RETURN_TRUSTED_TYPE ? _createTrustedHTML(serializedHTML) : serializedHTML;
  };
  DOMPurify.setConfig = function() {
    let cfg = arguments.length > 0 && arguments[0] !== void 0 ? arguments[0] : {};
    _parseConfig(cfg);
    SET_CONFIG = true;
    SET_CONFIG_ALLOWED_TAGS = ALLOWED_TAGS2;
    SET_CONFIG_ALLOWED_ATTR = ALLOWED_ATTR2;
  };
  DOMPurify.clearConfig = function() {
    CONFIG = null;
    SET_CONFIG = false;
    SET_CONFIG_ALLOWED_TAGS = null;
    SET_CONFIG_ALLOWED_ATTR = null;
    trustedTypesPolicy = defaultTrustedTypesPolicy;
    emptyHTML = "";
  };
  DOMPurify.isValidAttribute = function(tag, attr, value) {
    if (!CONFIG) {
      _parseConfig({});
    }
    const lcTag = transformCaseFunc(tag);
    const lcName = transformCaseFunc(attr);
    return _isValidAttribute(lcTag, lcName, value);
  };
  DOMPurify.addHook = function(entryPoint, hookFunction) {
    if (typeof hookFunction !== "function") {
      return;
    }
    if (!objectHasOwnProperty(hooks, entryPoint)) {
      return;
    }
    arrayPush(hooks[entryPoint], hookFunction);
  };
  DOMPurify.removeHook = function(entryPoint, hookFunction) {
    if (!objectHasOwnProperty(hooks, entryPoint)) {
      return void 0;
    }
    if (hookFunction !== void 0) {
      const index = arrayLastIndexOf(hooks[entryPoint], hookFunction);
      return index === -1 ? void 0 : arraySplice(hooks[entryPoint], index, 1)[0];
    }
    return arrayPop(hooks[entryPoint]);
  };
  DOMPurify.removeHooks = function(entryPoint) {
    if (!objectHasOwnProperty(hooks, entryPoint)) {
      return;
    }
    hooks[entryPoint] = [];
  };
  DOMPurify.removeAllHooks = function() {
    hooks = _createHooksMap();
  };
  return DOMPurify;
}
var purify = createDOMPurify();

// dist/sanitize-dompurify.js
var hookInstalled = false;
var activeOnElement;
function installHook() {
  if (hookInstalled)
    return;
  hookInstalled = true;
  purify.addHook("uponSanitizeElement", (node, data) => {
    activeOnElement?.(node, data.tagName);
  });
}
var dompurifyBackend = {
  sanitize(html2, config) {
    installHook();
    activeOnElement = config.onElement;
    try {
      return purify.sanitize(html2, {
        ALLOWED_TAGS: [...config.allowedTags],
        ALLOWED_ATTR: [...config.allowedAttr]
      });
    } finally {
      activeOnElement = void 0;
    }
  }
};

// docs/browser-entry.mjs
function loadHighlightBackend() {
  return import("./streaming-markdown.highlight-hljs-PK6PNYST.mjs").then((m) => m.loadHighlightjs());
}
function loadMermaidBackend() {
  return import("./streaming-markdown.mermaid-mermaidjs-K4REBTEK.mjs").then((m) => m.loadMermaid());
}
export {
  StreamingMarkdownRenderer,
  dompurifyBackend,
  hydratePendingDiagrams,
  isBrowserSanitizerSupported,
  loadHighlightBackend,
  loadMermaidBackend,
  renderStreamingMarkdown,
  setSanitizerBackend
};
/*! Bundled license information:

dompurify/dist/purify.es.mjs:
  (*! @license DOMPurify 3.4.11 | (c) Cure53 and other contributors | Released under the Apache license 2.0 and Mozilla Public License 2.0 | github.com/cure53/DOMPurify/blob/3.4.11/LICENSE *)
*/
