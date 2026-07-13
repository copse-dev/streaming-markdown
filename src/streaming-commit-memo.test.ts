// Sealed-commit memos (ADR 0004 Phase 2): the generic commit path adopts
// live DOM it can prove byte-correct instead of re-sanitizing + re-parsing +
// re-diffing it — the delta adopt-in-place / extension adoption, the
// unchanged-tail reuse, and the targeted link-ref part patch. These tests
// pin each skip deterministically (timing-free, via the FrozenTailRenderer
// diagnostics) and, above all, that every skip stays byte-identical to the
// whole-string render — wrong output is never an acceptable trade for speed.
import '../tests/setup-dom-jsdom.ts'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { tokenizeBlocks } from './block-tokenizer.ts'
import { renderMarkdownUnsafe } from './renderer.ts'
import { sanitizeRenderedMarkdown } from './sanitize.ts'
import { FrozenTailRenderer } from './streaming-frozen-tail.ts'
import { StreamingMarkdownRenderer } from './streaming.ts'
import { splitForStreaming } from './streaming-split.ts'
import { withConfig } from './config.ts'

/** Drive a FrozenTailRenderer directly through `commits`, asserting parity at each. */
function drive(commits: string[]): { ft: FrozenTailRenderer; host: HTMLElement } {
  const host = document.createElement('div')
  const ft = new FrozenTailRenderer()
  for (const complete of commits) {
    ft.update(host, complete, tokenizeBlocks(complete))
    assert.equal(
      host.innerHTML,
      sanitizeRenderedMarkdown(renderMarkdownUnsafe(complete)),
      `parity after committing ${JSON.stringify(complete.slice(-40))}`,
    )
  }
  return { ft, host }
}

describe('delta adopt-in-place (settling blocks reuse their tail DOM)', () => {
  it('a tail that settles unchanged advances the boundary without a re-parse', () => {
    // Commit 1 renders `<p>alpha</p>` as the tail; commit 2 settles exactly
    // that block (delta === memoized tail) — the live node is adopted whole.
    const { ft, host } = drive(['alpha beta\n', 'alpha beta\n\ngamma\n'])
    assert.equal(ft.deltaCommitsSkipped, 1)
    assert.ok(host.innerHTML.includes('<p>alpha beta</p>'))
  })

  it('adoption preserves the settling block’s node identity', () => {
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    ft.update(host, 'alpha\n', tokenizeBlocks('alpha\n'))
    const tailNode = host.querySelector('p')
    ft.update(host, 'alpha\n\nbeta\n', tokenizeBlocks('alpha\n\nbeta\n'))
    assert.equal(ft.deltaCommitsSkipped, 1)
    assert.equal(host.querySelector('p'), tailNode, 'the adopted node is the same instance')
  })

  it('a delta that EXTENDS the memoized tail adopts it and parses only the rest', () => {
    // Commit 1: tail = `<p>alpha</p>`. Commit 2: the delta settles that
    // paragraph PLUS a new heading — the paragraph part is byte-identical to
    // the memo, so only the heading (and the new tail) is parsed.
    const { ft } = drive(['alpha\n', 'alpha\n\n# Title\n\nbeta\n'])
    assert.equal(ft.deltaPrefixesAdopted, 1)
    assert.equal(ft.deltaCommitsSkipped, 0)
  })

  it('a tail that grew before settling is NOT adopted (byte mismatch falls back)', () => {
    const { ft } = drive(['alpha\n', 'alpha continued\n\nbeta\n'])
    assert.equal(ft.deltaCommitsSkipped + ft.deltaPrefixesAdopted, 0)
  })

  it('adoption never engages across a full-morph rebuild (memo invalidated)', () => {
    // The middle update rewrites the FROZEN prefix in place (not an
    // append-only extension), forcing the full-morph fallback; the memo from
    // commit 1's tail must not survive into commit 3's delta decision.
    const { ft } = drive([
      'alpha\n\nbeta\n',
      'REWRITTEN\n\nbeta two\n',
      'REWRITTEN\n\nbeta two\n\ngamma\n',
    ])
    assert.equal(ft.deltaCommitsSkipped, 0)
  })
})

describe('tail reuse (unchanged tail skips sanitize + parse + diff)', () => {
  it('a commit that leaves the tail render unchanged reuses the live nodes', () => {
    // The trailing newline extends the open paragraph's source but renders
    // identically — the tail morph is skipped outright.
    const { ft } = drive(['alpha', 'alpha\n'])
    assert.equal(ft.tailMorphsSkipped, 1)
  })

  it('re-committing identical content parses nothing new', () => {
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    const md = 'alpha\n\nbeta still open'
    ft.update(host, md, tokenizeBlocks(md))
    const parsedOnce = ft.parsedChars
    ft.update(host, md, tokenizeBlocks(md))
    assert.equal(ft.parsedChars, parsedOnce, 'second identical commit re-parses nothing')
    assert.equal(ft.tailMorphsSkipped, 1)
    assert.equal(
      host.innerHTML,
      sanitizeRenderedMarkdown(renderMarkdownUnsafe(md)),
    )
  })

  it('the skipped tail still sweeps stale trailing children', () => {
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    const md = 'alpha still open'
    ft.update(host, md, tokenizeBlocks(md))
    // A block-level pending element appended after the committed tail (what
    // the streaming renderer attaches between commits at the top level).
    const stale = document.createElement('p')
    stale.className = 'stream-pending stream-pending-paragraph stream-pending-block'
    host.append(stale)
    ft.update(host, md, tokenizeBlocks(md))
    assert.equal(ft.tailMorphsSkipped, 1)
    assert.equal(host.contains(stale), false, 'stale trailing child trimmed despite the skip')
    assert.equal(host.innerHTML, sanitizeRenderedMarkdown(renderMarkdownUnsafe(md)))
  })
})

describe('parsed-work stays below rendered-work on a steady stream (CI guard)', () => {
  it('adoption keeps cumulative parse work under the no-memo bound', () => {
    // Streamed at commit granularity through the real splitter. Every block
    // is rendered once as the tail and once as the settling delta; without
    // the memo both renders are parsed, with it the identical settle parse
    // is skipped — so parsedChars must undercut renderedChars by at least
    // the adopted share. The exact counters pin the skips deterministically.
    const md =
      Array.from({ length: 12 }, (_, i) => `Paragraph ${String(i)} with **bold** and \`code\`.`).join('\n\n') + '\n'
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    let last = ''
    for (let cut = 1; cut <= md.length; cut++) {
      const complete = splitForStreaming(md.slice(0, cut)).complete
      if (complete === last) continue
      ft.update(host, complete, tokenizeBlocks(complete))
      last = complete
    }
    assert.equal(
      host.innerHTML,
      sanitizeRenderedMarkdown(renderMarkdownUnsafe(last)),
    )
    assert.ok(
      ft.deltaCommitsSkipped + ft.deltaPrefixesAdopted >= 10,
      `expected most of the 12 settling paragraphs to be adopted, got ` +
        `${String(ft.deltaCommitsSkipped)} full + ${String(ft.deltaPrefixesAdopted)} partial`,
    )
    assert.ok(
      ft.parsedChars < ft.renderedChars,
      `parsedChars ${String(ft.parsedChars)} should stay below renderedChars ${String(ft.renderedChars)}`,
    )
  })
})

describe('targeted link-ref part patches (limitation J, ADR 0004 Phase 2)', () => {
  it('patches only the citing part and preserves every other frozen node', () => {
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    const body = 'uses [spec] here\n\nplain paragraph\n\n# Heading\n\n'
    ft.update(host, body, tokenizeBlocks(body))
    const [citing, plain] = Array.from(host.querySelectorAll('p'))
    const heading = host.querySelector('h1')
    const parsedBefore = ft.parsedChars
    const withDef = `${body}[spec]: https://example.com/x "T"\n\nafter\n\n`
    ft.update(host, withDef, tokenizeBlocks(withDef))
    assert.equal(
      host.innerHTML,
      sanitizeRenderedMarkdown(renderMarkdownUnsafe(withDef)),
      'patched output equals the whole-string render',
    )
    assert.equal(ft.linkRefPatchCommits, 1)
    assert.equal(host.querySelectorAll('p')[0], citing, 'the citing <p> keeps its identity')
    assert.equal(host.querySelectorAll('p')[1], plain, 'unrelated <p> untouched')
    assert.equal(host.querySelector('h1'), heading, 'unrelated heading untouched')
    assert.ok(host.innerHTML.includes('<a href="https://example.com/x"'), 'the reference resolved')
    // The patch re-parsed the one citing part plus the ordinary delta/tail —
    // far less than the whole document again.
    assert.ok(ft.parsedChars - parsedBefore < withDef.length * 2)
  })

  it('a matching span that is not a real reference (code) is a no-op patch', () => {
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    const body = 'code `[spec]` only\n\nfiller\n\n'
    ft.update(host, body, tokenizeBlocks(body))
    const withDef = `${body}[spec]: /url\n\nafter\n\n`
    ft.update(host, withDef, tokenizeBlocks(withDef))
    assert.equal(ft.linkRefPatchCommits, 1, 'candidate matched, handled without a full morph')
    assert.equal(host.innerHTML, sanitizeRenderedMarkdown(renderMarkdownUnsafe(withDef)))
  })

  it('patches a group sealed out of intra-list mode (span-only part record)', () => {
    // A long list (intra-list freezing engages) whose item cites [ref]; the
    // list seals when the paragraph after it commits, then the definition
    // arrives. The sealed group's part record has no cached render, so the
    // patch re-renders the whole group and morphs it in place.
    const items = Array.from({ length: 6 }, (_, i) =>
      i === 2 ? `- item ${String(i)} cites [ref]` : `- item ${String(i)} plain`,
    ).join('\n')
    const commits: string[] = []
    for (let n = 1; n <= 6; n++) {
      commits.push(items.split('\n').slice(0, n).join('\n') + '\n')
    }
    commits.push(`${items}\n\nafter list\n\n`)
    commits.push(`${items}\n\nafter list\n\n[ref]: /sealed\n\ntrailer\n\n`)
    const { ft, host } = drive(commits)
    assert.equal(ft.linkRefPatchCommits, 1)
    assert.ok(host.innerHTML.includes('<a href="/sealed">ref</a>'))
  })

  it('falls back to the full morph while the citing list is still shared (intra-list active)', () => {
    const items = Array.from({ length: 6 }, (_, i) => `- item ${String(i)} cites [ref]`).join('\n')
    const commits: string[] = []
    for (let n = 1; n <= 6; n++) {
      commits.push(items.split('\n').slice(0, n).join('\n') + '\n')
    }
    commits.push(`${items}\n\n[ref]: /live\n\ntrailer\n\n`)
    const { ft, host } = drive(commits)
    assert.equal(ft.linkRefPatchCommits, 0, 'shared-list state is not patchable — full morph')
    assert.ok(host.innerHTML.includes('<a href="/live">ref</a>'))
  })

  it('patches a value change (streaming title) without a full morph', () => {
    // Commit 2 upgrades the reference when `[x]: /u` arrives. Commit 3
    // CHANGES that definition's value — a next-line title attaches to it —
    // which re-patches the same citing part under the new map. drive()
    // asserts byte-parity with the whole-string render at every commit.
    const commits = [
      'see [x] here\n\nfiller\n\n',
      'see [x] here\n\nfiller\n\n[x]: /u\n',
      'see [x] here\n\nfiller\n\n[x]: /u\n"Title"\n\nend\n\n',
    ]
    const { ft, host } = drive(commits)
    assert.equal(ft.linkRefPatchCommits, 2, 'the arrival and the value change both patch')
    // The title itself is stripped by the test sanitizer profile; the parity
    // assertions inside drive() are the real oracle for the value change.
    assert.ok(host.innerHTML.includes('<a href="/u">x</a>'))
  })

  it('absorbs a definition-run retreat/return (removals) as patches, not full morphs', () => {
    // The splitter holds a blank-free definition run as one open block, so
    // `complete` legitimately RETREATS past all committed definitions when
    // the next line starts streaming and returns when it ends. Each flip
    // changes the whole map; both directions must land on the targeted patch
    // path, keep byte-parity, and leave non-citing frozen nodes untouched.
    const body = 'cites [a] and [b]\n\nplain paragraph\n\n'
    const commits = [
      `${body}[a]: /a\n[b]: /b\n`, // run committed
      body, // retreat: next def line started streaming
      `${body}[a]: /a\n[b]: /b\n[c]: /c\n`, // return with one more def
    ]
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    ft.update(host, body, tokenizeBlocks(body))
    const plain = host.querySelectorAll('p')[1]
    for (const complete of commits) {
      ft.update(host, complete, tokenizeBlocks(complete))
      assert.equal(
        host.innerHTML,
        sanitizeRenderedMarkdown(renderMarkdownUnsafe(complete)),
        `parity after ${JSON.stringify(complete.slice(-20))}`,
      )
    }
    assert.equal(ft.linkRefPatchCommits, 3, 'add, retreat, and return all patch')
    assert.equal(host.querySelectorAll('p')[1], plain, 'the non-citing paragraph keeps its node')
  })

  it('declines the patch when a frozen slot is not the element the records expect', () => {
    // Out-of-band host interference: a frozen element replaced by a text
    // node. The layout verification refuses the ambiguous mapping and the
    // full morph restores byte-correct output.
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    const body = 'alpha\n\nuses [spec] here\n\nfiller\n\n'
    ft.update(host, body, tokenizeBlocks(body))
    const frozen = host.querySelector('p')
    assert.ok(frozen)
    host.replaceChild(document.createTextNode('tampered'), frozen)
    const withDef = `${body}[spec]: /x\n\nend\n\n`
    ft.update(host, withDef, tokenizeBlocks(withDef))
    assert.equal(ft.linkRefPatchCommits, 0, 'tampered layout declines the patch')
    assert.equal(host.innerHTML, sanitizeRenderedMarkdown(renderMarkdownUnsafe(withDef)))
  })

  it('declines the patch when a seam slot is not the expected text node', () => {
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    const body = 'alpha\n\nuses [spec] here\n\nfiller\n\n'
    ft.update(host, body, tokenizeBlocks(body))
    const seam = host.childNodes[1]
    assert.ok(seam && seam.nodeType === 3)
    host.replaceChild(document.createElement('hr'), seam)
    const withDef = `${body}[spec]: /x\n\nend\n\n`
    ft.update(host, withDef, tokenizeBlocks(withDef))
    assert.equal(ft.linkRefPatchCommits, 0, 'tampered seam declines the patch')
    assert.equal(host.innerHTML, sanitizeRenderedMarkdown(renderMarkdownUnsafe(withDef)))
  })

  it('falls back to one full morph when a definition touches too many parts', () => {
    // Per-part patching pays a sanitize + parse per part; past a handful the
    // single whole-document morph is cheaper, so a definition cited by many
    // frozen parts declines the patch. Byte-parity is unaffected either way.
    const body =
      Array.from({ length: 12 }, (_, i) => `Paragraph ${String(i)} cites [hub] again.`).join('\n\n') + '\n\n'
    const { ft, host } = drive([body, `${body}[hub]: /many\n\ntrailer\n\n`])
    assert.equal(ft.linkRefPatchCommits, 0, 'a widely-cited label takes the full morph')
    assert.ok(host.innerHTML.includes('<a href="/many">hub</a>'))
  })

  it('falls back when a frozen raw part breaks the one-element-per-part layout (passthrough)', () => {
    withConfig({ htmlPolicy: 'passthrough' }, () => {
      const host = document.createElement('div')
      const ft = new FrozenTailRenderer()
      // The raw block is ONE part but parses to two top-level elements, so
      // the part→node mapping is ambiguous and the patch must decline.
      const body = '<div>a</div><div>b</div>\n\nuses [spec] here\n\nfiller\n\n'
      ft.update(host, body, tokenizeBlocks(body))
      const withDef = `${body}[spec]: /raw\n\nend\n\n`
      ft.update(host, withDef, tokenizeBlocks(withDef))
      assert.equal(ft.linkRefPatchCommits, 0, 'ambiguous layout declines the patch')
      assert.equal(host.innerHTML, sanitizeRenderedMarkdown(renderMarkdownUnsafe(withDef)))
    })
  })
})

describe('stale trailing children are swept even off the generic tail morph', () => {
  // The streaming renderer now sweeps its pending artifacts BEFORE each
  // commit, so the in-commit trims below are safety nets for direct
  // FrozenTailRenderer callers; they must keep working.
  it('a framed commit (open <details> re-root) trims leftovers after the anchor', () => {
    withConfig({ htmlPolicy: 'passthrough' }, () => {
      const host = document.createElement('div')
      const ft = new FrozenTailRenderer()
      const c1 = '<details>\n\ninside paragraph\n\n'
      ft.update(host, c1, tokenizeBlocks(c1))
      assert.equal(host.innerHTML, sanitizeRenderedMarkdown(renderMarkdownUnsafe(c1)))
      const stale = document.createElement('p')
      stale.className = 'stream-pending stream-pending-block'
      host.append(stale)
      const c2 = `${c1}more inside\n\n`
      ft.update(host, c2, tokenizeBlocks(c2))
      assert.equal(host.contains(stale), false, 'leftover after the frame anchor trimmed')
      assert.equal(host.innerHTML, sanitizeRenderedMarkdown(renderMarkdownUnsafe(c2)))
    })
  })

  it('a shared-list commit (intra-list mode) trims leftovers after the list', () => {
    const items = (n: number): string =>
      Array.from({ length: n }, (_, i) => `- item ${String(i)}`).join('\n') + '\n'
    const host = document.createElement('div')
    const ft = new FrozenTailRenderer()
    for (let n = 1; n <= 5; n++) ft.update(host, items(n), tokenizeBlocks(items(n)))
    const stale = document.createElement('p')
    stale.className = 'stream-pending stream-pending-block'
    host.append(stale)
    ft.update(host, items(6), tokenizeBlocks(items(6)))
    assert.equal(host.contains(stale), false, 'leftover after the shared list trimmed')
    assert.equal(host.innerHTML, sanitizeRenderedMarkdown(renderMarkdownUnsafe(items(6))))
  })
})

describe('trailing-table lookup skips a committed footnotes section', () => {
  it('a pipe-bearing document ending in table + footnotes stays byte-correct', () => {
    const md = 'ref[^1]\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n[^1]: note text\n\n'
    const host = document.createElement('div')
    const scratch = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= md.length; cut++) {
      const prefix = md.slice(0, cut)
      r.update(prefix)
      const split = splitForStreaming(prefix)
      if (split.pending !== '') continue
      scratch.innerHTML = String(sanitizeRenderedMarkdown(renderMarkdownUnsafe(split.complete)))
      const el = host.querySelector('.stream-complete')
      assert.ok(el instanceof HTMLElement)
      assert.equal(el.innerHTML, scratch.innerHTML, `cut=${String(cut)}`)
    }
  })
})

describe('memo safety across the streaming renderer’s pending machinery', () => {
  it('pending artifacts between commits never leak into adopted DOM', () => {
    // Streams char-by-char so pending blocks / list items / continuation
    // spans attach and detach between every commit, while the memos engage
    // underneath. Byte-parity at every fully-committed frame is the oracle.
    const md =
      'intro paragraph\n\n- alpha item\n- beta item\n\ntail paragraph with **bold**\n\n' +
      'closing [spec] reference\n\n[spec]: /end\n\ndone\n\n'
    const host = document.createElement('div')
    const scratch = document.createElement('div')
    const r = new StreamingMarkdownRenderer(host)
    for (let cut = 1; cut <= md.length; cut++) {
      const prefix = md.slice(0, cut)
      r.update(prefix)
      const split = splitForStreaming(prefix)
      if (split.pending !== '') continue
      scratch.innerHTML = String(sanitizeRenderedMarkdown(renderMarkdownUnsafe(split.complete)))
      const el = host.querySelector('.stream-complete')
      assert.ok(el instanceof HTMLElement)
      assert.equal(el.innerHTML, scratch.innerHTML, `cut=${String(cut)}`)
    }
  })
})
