import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  completeEndsInOpenTable,
  getIncompleteFenceSource,
  isAmbiguousBlockLine,
  isEmptyListItemLine,
  isGfmTableRowLine,
  isListItemLine,
  listItemContentColumn,
  pendingLineBelongsInTable,
  scanLines,
  streamingHoldStart,
  tokenizeBlocks,
} from './block-tokenizer.ts'
import { splitCore } from '../tests/split-core.ts'

describe('scanLines', () => {
  it('marks the final line unterminated when source lacks a trailing newline', () => {
    const lines = scanLines('a\nb')
    assert.equal(lines.length, 2)
    const first = lines[0]
    const second = lines[1]
    assert.ok(first && second)
    assert.equal(first.terminated, true)
    assert.equal(second.terminated, false)
  })
})

describe('tokenizeBlocks', () => {
  it('marks an ATX heading line without newline as ambiguous', () => {
    const blocks = tokenizeBlocks('## Title')
    assert.deepEqual(blocks, [{ kind: 'atx_heading', status: 'ambiguous', start: 0, end: 8 }])
  })

  it('marks a completed ATX heading once the line ends', () => {
    const blocks = tokenizeBlocks('## Title\n')
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'atx_heading')
    assert.equal(block.status, 'complete')
  })

  it('marks an open fenced code block', () => {
    const source = '```ts\nconst x = 1'
    const blocks = tokenizeBlocks(source)
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'fence')
    assert.equal(block.status, 'open')
    assert.equal(block.start, 0)
  })

  it('marks a complete fenced code block', () => {
    const source = '```ts\nconst x = 1\n```\n'
    const blocks = tokenizeBlocks(source)
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'fence')
    assert.equal(block.status, 'complete')
  })

  it('marks an open table when the last row has no trailing newline', () => {
    const source = '| A | B |\n| - | - |\n| one'
    const blocks = tokenizeBlocks(source)
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'table')
    assert.equal(block.status, 'open')
  })

  it('keeps a header and its still-streaming separator as one open table block', () => {
    // `|---` matches TABLE_SEP_RE but has fewer columns than the header while it
    // streams; splitting them made the header vanish and the partial separator
    // render as a dashes-only forming table.
    const blocks = tokenizeBlocks('| A | B | C |\n|---')
    assert.deepEqual(blocks, [{ kind: 'table', status: 'open', start: 0, end: 18 }])
  })

  it('still rejects a terminated separator whose column count mismatches (spec 203)', () => {
    const blocks = tokenizeBlocks('| A | B |\n| - |\nbody\n')
    assert.equal(
      blocks.some((b) => b.kind === 'table' && b.status === 'complete'),
      false,
    )
  })

  it('marks a lone final text line as an open paragraph (setext waits for next line)', () => {
    const blocks = tokenizeBlocks('Heading')
    const block = blocks[0]
    assert.ok(block)
    assert.equal(block.kind, 'paragraph')
    assert.equal(block.status, 'open')
  })

  it('ends an unordered list item when blank is followed by under-indented text (#255)', () => {
    const blocks = tokenizeBlocks('- one\n\n two\n')
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['list_item', 'blank', 'paragraph'],
    )
  })

  it('continues an unordered list item when blank is followed by indented text (#256)', () => {
    const blocks = tokenizeBlocks('- one\n\n  two\n')
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['list_item'],
    )
  })

  it('treats a 10-digit ordered marker as a paragraph (#266)', () => {
    const blocks = tokenizeBlocks('1234567890. not ok\n')
    assert.deepEqual(
      blocks.map((b) => b.kind),
      ['paragraph'],
    )
  })

  it('tokenizes bare markers as empty list items (#281, #283)', () => {
    assert.deepEqual(
      tokenizeBlocks('- foo\n-\n- bar\n').map((b) => b.kind),
      ['list_item', 'list_item', 'list_item'],
    )
    assert.deepEqual(
      tokenizeBlocks('1. foo\n2.\n3. bar\n').map((b) => b.kind),
      ['list_item', 'list_item', 'list_item'],
    )
  })

  it('does not let an empty list marker interrupt a paragraph (#285)', () => {
    assert.deepEqual(
      tokenizeBlocks('foo\n*\n').map((b) => b.kind),
      ['paragraph'],
    )
    assert.deepEqual(
      tokenizeBlocks('foo\n1.\n').map((b) => b.kind),
      ['paragraph'],
    )
  })
})

describe('list item marker helpers', () => {
  it('recognizes bare markers as list item lines', () => {
    assert.equal(isListItemLine('-'), true)
    assert.equal(isListItemLine('2.'), true)
    assert.equal(isListItemLine('foo'), false)
  })

  it('flags empty list item markers', () => {
    assert.equal(isEmptyListItemLine('-'), true)
    assert.equal(isEmptyListItemLine('2.'), true)
    assert.equal(isEmptyListItemLine('-   '), true)
    assert.equal(isEmptyListItemLine('- foo'), false)
    assert.equal(isEmptyListItemLine('foo'), false)
  })

  it('applies the CommonMark 1-4 vs 5+ space content column rule (#273, #274, #278)', () => {
    // 1-4 spaces after the marker: content begins after all of them.
    assert.equal(listItemContentColumn('- foo'), 2)
    assert.equal(listItemContentColumn('-   foo'), 4)
    // 5+ spaces: only one space counts, the rest is indented code.
    assert.equal(listItemContentColumn('1.     indented code'), 3)
    assert.equal(listItemContentColumn('1.      indented code'), 3)
    // Empty item: content column is marker width + 1.
    assert.equal(listItemContentColumn('-'), 2)
    assert.equal(listItemContentColumn('2.'), 3)
    // Leading indent of the marker line is included.
    assert.equal(listItemContentColumn('  - foo'), 4)
  })
})

describe('streamingHoldStart', () => {
  it('holds from the first non-complete block', () => {
    const source = 'done\n## Title'
    const blocks = tokenizeBlocks(source)
    assert.equal(streamingHoldStart(blocks), 'done\n'.length)
  })
})

describe('isAmbiguousBlockLine', () => {
  it('detects block-start patterns on the pending line', () => {
    assert.equal(isAmbiguousBlockLine('- item'), true)
    assert.equal(isAmbiguousBlockLine('plain text'), false)
  })

  it('does not treat RFC-style metadata lines as ambiguous table rows', () => {
    const metadata =
      '**Status:** Proposed &nbsp;&nbsp;|&nbsp;&nbsp; **Authors:** Engineering Guild &nbsp;&nbsp;|&nbsp;&nbsp; **Created:** 2025-01-25'
    assert.equal(isAmbiguousBlockLine(metadata), false)
    assert.equal(isAmbiguousBlockLine('| A | B |'), true)
  })

  it('does not tokenize consecutive JD metadata lines as a table', () => {
    const md = [
      '# Job',
      '',
      '**Department:** Engineering &nbsp;&nbsp;|&nbsp;&nbsp; **Reports To:** VP',
      '**Employment Type:** Full-Time &nbsp;&nbsp;|&nbsp;&nbsp; **Salary Range:** $160k',
      '',
    ].join('\n')
    const kinds = tokenizeBlocks(md).map((b) => b.kind)
    assert.ok(!kinds.includes('table'))
  })
})

describe('prose-metadata header with a matching delimiter row (#106)', () => {
  it('treats a `**Label:**` header as a table row when a matching delimiter follows', () => {
    const header = '| **Name:** Widget | Qty |'
    // Without a following delimiter row the prose-metadata heuristic still wins.
    assert.equal(isGfmTableRowLine(header), false)
    // A matching delimiter row is unambiguous table syntax and overrides it.
    assert.equal(isGfmTableRowLine(header, '| --- | --- |'), true)
    // A delimiter row with a different column count does not (spec 203).
    assert.equal(isGfmTableRowLine(header, '| --- |'), false)
  })

  it('treats an inline-image header as a table row when a matching delimiter follows', () => {
    const header = '| ![logo](x.png) Name | Qty |'
    assert.equal(isGfmTableRowLine(header, '| --- | --- |'), true)
  })

  it('tokenizes a bold-label header + delimiter as a single table block', () => {
    const md = '| **Name:** Widget | Qty |\n| --- | --- |\n| a | 1 |\n'
    const kinds = tokenizeBlocks(md).map((b) => b.kind)
    assert.deepEqual(kinds, ['table'])
  })

  it('still keeps a bold-label pipe line as prose with no delimiter row', () => {
    const md = '| **Name:** Widget | Qty |\nplain follow-up line\n'
    const kinds = tokenizeBlocks(md).map((b) => b.kind)
    assert.ok(!kinds.includes('table'), `expected no table block, got ${kinds.join(', ')}`)
  })
})

describe('table streaming helpers', () => {
  it('detects an open table tail', () => {
    const complete = '| A | B |\n| - | - |\n| one |\n'
    assert.equal(completeEndsInOpenTable(complete), true)
    assert.equal(pendingLineBelongsInTable(complete, '| two | cells |'), true)
  })
})

describe('splitForStreaming (tokenizer #475)', () => {
  it('holds an ambiguous ATX heading until its line ends', () => {
    assert.deepEqual(splitCore('## Title'), {
      complete: '',
      pending: '## Title',
    })
  })

  it('holds a table header row until the separator confirms structure', () => {
    assert.deepEqual(splitCore('| A | B |'), {
      complete: '',
      pending: '| A | B |',
    })
    assert.deepEqual(splitCore('| A | B |\n| - |'), {
      complete: '',
      pending: '| A | B |\n| - |',
    })
  })

  it('commits a table once header and separator lines are complete', () => {
    assert.deepEqual(splitCore('| A | B |\n| - | - |\n'), {
      complete: '| A | B |\n| - | - |\n',
      pending: '',
    })
  })

  it('holds an open fence from its opener', () => {
    assert.deepEqual(splitCore('intro\n```ts\ncode'), {
      complete: 'intro\n',
      pending: '```ts\ncode',
    })
  })

  it('returns incomplete fence source while the closing fence is missing', () => {
    const source = 'intro\n```yaml\nstatic_resources:\n'
    assert.equal(getIncompleteFenceSource(source), '```yaml\nstatic_resources:\n')
  })

  it('holds unresolved inline emphasis inside an open paragraph', () => {
    assert.deepEqual(splitCore('intro **bold\ntext'), {
      complete: 'intro ',
      pending: '**bold\ntext',
    })
  })

  it('falls back to line split for safe plain text', () => {
    assert.deepEqual(splitCore('done\nplain tail'), {
      complete: 'done\n',
      pending: 'plain tail',
      // A later line of the same open paragraph is a lazy continuation (#11).
      paragraphContinuation: true,
    })
  })

  it('commits finished list items while the next item is still streaming', () => {
    assert.deepEqual(splitCore('- item one\n- item two'), {
      complete: '- item one\n',
      pending: '- item two',
      openListItemFirstLine: '- item two',
    })
  })

  it('commits finished table body rows while the next row is still streaming', () => {
    assert.deepEqual(
      splitCore(
        '| Path | Role |\n| - | - |\n| src/ | Application source |\n| tests/e2e/ | WebdriverIO specs |',
      ),
      {
        complete: '| Path | Role |\n| - | - |\n| src/ | Application source |\n',
        pending: '| tests/e2e/ | WebdriverIO specs |',
      },
    )
  })
})

describe('blockquote lazy continuation (incremental memo, #111)', () => {
  // The blockquote scanner memoises `endsInOpenParagraph` over the growing
  // stripped content so a long lazy run is O(1)/line instead of O(n)/line. The
  // memo must never diverge from a fresh determination: these cases pin the
  // block extents that a wrong fast-path (e.g. treating indented code or a
  // `>`-blank-closed paragraph as an open paragraph) would break.
  function kinds(src: string): string[] {
    return tokenizeBlocks(src).map((t) => `${t.kind}:${JSON.stringify(src.slice(t.start, t.end))}`)
  }

  it('folds a long unmarked lazy run into one blockquote paragraph', () => {
    const src = '> start\nlazy one\nlazy two\nlazy three\n'
    assert.deepEqual(kinds(src), [`blockquote:${JSON.stringify(src)}`])
  })

  it('resumes lazy continuation after a re-marked line', () => {
    const src = '> start\nlazy\n> marked again\nmore lazy\n'
    assert.deepEqual(kinds(src), [`blockquote:${JSON.stringify(src)}`])
  })

  it('does not lazily continue indented code inside a quote (spec 236)', () => {
    // `>     foo` is indented code inside the quote; the unmarked `    bar` is a
    // separate indented code block, not a lazy continuation.
    assert.deepEqual(kinds('>     foo\n    bar\n'), [
      'blockquote:">     foo\\n"',
      'indented_code:"    bar\\n"',
    ])
  })

  it('does not lazily continue after a `>`-blank closes the paragraph (spec 237)', () => {
    // The empty `>` line closes the paragraph; the following unmarked `bar` can
    // no longer lazily continue it.
    assert.deepEqual(kinds('> foo\n>\nbar\n'), ['blockquote:"> foo\\n>\\n"', 'paragraph:"bar\\n"'])
  })

  it('lazily continues a paragraph nested in a blockquote', () => {
    const src = '> > inner\nlazy inner continuation\n'
    assert.deepEqual(kinds(src), [`blockquote:${JSON.stringify(src)}`])
  })

  it('breaks the quote at an unmarked ATX heading, not a lazy continuation', () => {
    assert.deepEqual(kinds('> para\n# heading\n'), ['blockquote:"> para\\n"', 'atx_heading:"# heading\\n"'])
  })

  it('a setext underline under quoted text is not an open-paragraph continuation', () => {
    // `> text` then unmarked `===` turns the quoted paragraph into a setext
    // heading; the underline is consumed by the quote, not left dangling.
    const src = '> text\n===\n'
    const toks = tokenizeBlocks(src)
    assert.equal(toks.length, 1)
    assert.equal(toks[0]?.kind, 'blockquote')
    assert.equal(src.slice(toks[0]?.start ?? 0, toks[0]?.end ?? 0), src)
  })
})
