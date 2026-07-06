import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as api from './index.ts'

// The package entry (index.ts) is a pure re-export barrel — it is the published
// surface every consumer imports. This smoke test evaluates the barrel (so a
// broken re-export fails CI instead of a downstream install) and pins the set of
// exported runtime symbols so an accidental add/remove is caught in review.

const EXPECTED_FUNCTIONS = [
  'renderMarkdown',
  'renderStreamingMarkdown',
  'splitForStreaming',
  'sanitizeRenderedMarkdown',
  'setSanitizeExtension',
  'setSanitizerBackend',
  'isBrowserSanitizerSupported',
  'setRawImageRenderer',
  'normalizeHostImagePath',
  'escapeHtml',
  'escapeHtmlTextNodes',
  'decodeSafeMarkdownEntities',
  'fenceCodeClass',
  'getCodeHighlighter',
  'highlightFenceCode',
  'setCodeHighlighter',
  'stripAppCodeDecorations',
  'mermaidSourceCandidates',
  'prepareMermaidSource',
  'getDiagramRenderer',
  'hydratePendingDiagrams',
  'setDiagramRenderer',
  'appLinkDecorator',
  'getSafeHrefSchemes',
  'renderAnchor',
  'setLinkDecorator',
  'setSafeHrefSchemes',
  'stripAppImageAttributes',
  'stripAppLinkAttributes',
  'isWorkspaceMarkdownLinkHref',
  'workspaceLinkTargetFromHref',
] as const

describe('public API barrel (index.ts)', () => {
  it('re-exports every documented runtime symbol as a function', () => {
    for (const name of EXPECTED_FUNCTIONS) {
      assert.equal(
        typeof (api as Record<string, unknown>)[name],
        'function',
        `expected export "${name}" to be a function`,
      )
    }
  })

  it('re-exports the constructor and value constants', () => {
    assert.equal(typeof api.StreamingMarkdownRenderer, 'function')
    assert.equal(typeof api.PENDING_DIAGRAM_SELECTOR, 'string')
    assert.ok(Array.isArray(api.DEFAULT_SAFE_HREF_SCHEMES))
    assert.ok(api.DEFAULT_SAFE_HREF_SCHEMES.includes('https'))
    assert.ok(api.KNOWN_LANGUAGES instanceof Set || Array.isArray(api.KNOWN_LANGUAGES))
  })

  it('the barrel adds no unexpected runtime exports', () => {
    const runtimeExports = Object.entries(api)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
      .sort()
    const expected = [
      ...EXPECTED_FUNCTIONS,
      'StreamingMarkdownRenderer',
      'PENDING_DIAGRAM_SELECTOR',
      'DEFAULT_SAFE_HREF_SCHEMES',
      'KNOWN_LANGUAGES',
      'browserSanitizerBackend',
    ].sort()
    assert.deepEqual(runtimeExports, expected)
  })
})
