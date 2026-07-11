# Changelog

All notable changes are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [2.4.0] — 2025-11-02

### Added

- Streaming parser now exposes a `flush()` method to force-commit the pending
  tail at end-of-stream (#412).
- New `onCommit` hook fires once per settled block, useful for analytics and
  scroll-anchoring.

### Fixed

- A footnote reference that arrived *before* its definition rendered as literal
  `[^1]` text and never upgraded once the definition streamed in (#398).
- `tel:` links were percent-encoded twice, breaking dialer handoff on iOS.
- Nested blockquotes deeper than 32 levels threw a `RangeError` instead of
  degrading gracefully (#405).

### Changed

- **Breaking:** `render()` now returns a branded `SafeHtml` instead of `string`.
  Assigning it to `innerHTML` still works; the brand adds compile-time checking.
  Migrate by widening any explicit `string` annotations on the result.

## [2.3.1] — 2025-09-18

### Fixed

- Regression where an unclosed code fence at the very end of a message flashed
  its interior as escaped prose for one frame before settling.

## [2.3.0] — 2025-08-30

### Added

- Tables now support alignment markers (`:---`, `:---:`, `---:`).
- Task lists render as real `<input type="checkbox" disabled>` elements.

> Upgrading from 2.2? The only behavioral change is table alignment; everything
> else is additive. See the [migration notes](https://example.com/migrate/2.3).
