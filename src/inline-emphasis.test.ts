import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  pendingHoldIndex,
  renderEmphasisDelimiters,
  renderEmphasisOutsideInlineHtml,
} from './inline-emphasis.ts'

describe('renderEmphasisDelimiters (delimiter-stack AST)', () => {
  it('renders strong and em with CommonMark flanking rules', () => {
    assert.equal(renderEmphasisDelimiters('**bold**'), '<strong>bold</strong>')
    assert.equal(renderEmphasisDelimiters('*italic*'), '<em>italic</em>')
    assert.equal(renderEmphasisDelimiters('_italic_'), '<em>italic</em>')
  })

  it('collapses soft line breaks inside emphasis spans (#405, #423)', () => {
    assert.equal(renderEmphasisDelimiters('**bold\ntext**'), '<strong>bold text</strong>')
    assert.equal(renderEmphasisDelimiters('start *em\nmore* end'), 'start <em>em more</em> end')
  })

  it('does not treat list-marker asterisks as emphasis openers', () => {
    assert.equal(renderEmphasisDelimiters('* alpha'), '* alpha')
    assert.equal(renderEmphasisDelimiters('* alpha\n* beta'), '* alpha\n* beta')
  })

  it('does not emphasize underscores inside identifiers (cross-line AST path)', () => {
    assert.equal(renderEmphasisDelimiters('see some\nlong_identifier'), 'see some\nlong_identifier')
  })

  it('uses nearest-opener pairing across soft breaks', () => {
    assert.equal(renderEmphasisDelimiters('**foo **bar\nbaz**'), '**foo <strong>bar baz</strong>')
  })

  it('renders nested emphasis per CommonMark (#411)', () => {
    assert.equal(renderEmphasisDelimiters('*foo**bar**baz*'), '<em>foo<strong>bar</strong>baz</em>')
    assert.equal(renderEmphasisDelimiters('***foo** bar*'), '<em><strong>foo</strong> bar</em>')
    assert.equal(renderEmphasisDelimiters('*foo **bar***'), '<em>foo <strong>bar</strong></em>')
    assert.equal(renderEmphasisDelimiters('*foo**bar***'), '<em>foo<strong>bar</strong></em>')
  })

  // These equal-length delimiter runs NEST rather than merge. That is the
  // canonical `process_emphasis` result and matches CommonMark ≥0.30 (spec.txt
  // #417, #464–#466, #468 as pinned via `commonmark-spec`). Note the older GFM
  // spec (cmark-gfm 0.29, tests/fixtures/gfm/spec.txt #398/#426/#434–#436/
  // #473–#475/#477) expects the MERGED form (`****foo****` → `<strong>foo</strong>`);
  // the two specs contradict each other 1:1 on exactly these inputs, so the
  // renderer cannot satisfy both. It tracks current CommonMark — do NOT "fix"
  // this to merge, as that regresses the CommonMark conformance baseline by the
  // same count it would gain in the GFM one.
  it('nests multiple strong delimiters per CommonMark (#417, #464–#466, #468)', () => {
    assert.equal(
      renderEmphasisDelimiters('foo******bar*********baz'),
      'foo<strong><strong><strong>bar</strong></strong></strong>***baz',
    )
    assert.equal(renderEmphasisDelimiters('****foo****'), '<strong><strong>foo</strong></strong>')
    assert.equal(renderEmphasisDelimiters('____foo____'), '<strong><strong>foo</strong></strong>')
    assert.equal(
      renderEmphasisDelimiters('******foo******'),
      '<strong><strong><strong>foo</strong></strong></strong>',
    )
    assert.equal(
      renderEmphasisDelimiters('_____foo_____'),
      '<em><strong><strong>foo</strong></strong></em>',
    )
  })

  it('ignores delimiters inside inline code spans', () => {
    assert.equal(renderEmphasisDelimiters('use `a**b` here'), 'use `a**b` here')
  })

  it('shields rendered <code> from cross-span pairing', () => {
    assert.equal(
      renderEmphasisOutsideInlineHtml('2 ** 3 with <code>a**b</code> tail'),
      '2 ** 3 with <code>a**b</code> tail',
    )
  })

  it('does not duplicate a grandchild span in deep nesting (spec 418/432)', () => {
    assert.equal(
      renderEmphasisDelimiters('*foo **bar *baz* bim** bop*'),
      '<em>foo <strong>bar <em>baz</em> bim</strong> bop</em>',
    )
    assert.equal(
      renderEmphasisDelimiters('**foo *bar **baz**\nbim* bop**'),
      '<strong>foo <em>bar <strong>baz</strong> bim</em> bop</strong>',
    )
  })
})

describe('pendingHoldIndex (shared with streaming)', () => {
  const visible = (s: string): string => s.slice(0, pendingHoldIndex(s))

  it('holds unresolved emphasis across a soft line break', () => {
    assert.equal(visible('intro **bold\ntext'), 'intro ')
    assert.equal(pendingHoldIndex('**bold\ntext**'), '**bold\ntext**'.length)
  })
})
