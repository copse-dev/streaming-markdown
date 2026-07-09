# Changelog

All notable changes to this project are documented in this file. Each entry is
generated at release time from the commits since the previous tag. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-07-09

### Continuous Integration

- add advisory TypeScript 7 canary job (#99) (`c900e15`)

### Chores

- Bump actions/upload-pages-artifact from 3 to 5 (#97) (`b564d49`)
- Bump actions/upload-artifact from 4 to 7 (#95) (`0f6e764`)
- Bump actions/deploy-pages from 4 to 5 (#96) (`cff1a3a`)
- Bump @types/node in the npm-minor-patch group (#98) (`6941010`)

### Other Changes

- Add input smoother demo showcasing token arrival smoothing (#100) (`e84a51e`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.7.0...v0.8.0

## [0.7.0] - 2026-07-09

### Features

- opt-in CJK-friendly emphasis and autolink boundaries (#90) (`cf6cdba`)
- opt-in link/image origin policy (#83) (#92) (`fb4a74b`)
- optional input smoother behind /smoothing subpath (#84) (#89) (`c274477`)
- ship optional emoji-shortcode inline pass (#91) (`3cc6f73`)

### Documentation

- host-UI recipe guide for code-block copy buttons (#88) (`5efea0d`)

### Continuous Integration

- use Node 24 for publish instead of upgrading npm in place (#94) (`ad8a6cc`)

### Other Changes

- Make entity decoding pluggable with zero-dependency default (#93) (`1ef8769`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.6.0...v0.7.0

## [0.6.0] - 2026-07-07

### Features

- showcase math, footnotes, alerts, and the Shiki backend (#79) (#82) (`e849c1d`)
- gate math prose syntax on renderer registration, add setMathSyntax (#78) (#81) (`07cbed1`)
- GFM footnotes and GitHub alerts in the core parser (#76) (`e68098d`)
- Shiki highlighter backend behind ./highlighters/shiki (#71) (#74) (`a758456`)
- first-class math support with a lazy KaTeX backend (`math/katex`) (#75) (`3706af6`)

### Bug Fixes

- keep a streaming table separator with its header in one block (#77) (`e49cb9f`)

### Tests

- GFM streaming fuzz corpus + mid-stream display invariants (#80) (`005b035`)

### Continuous Integration

- replace pick-runner probe jobs with CHECKS_RUNNER variable routing (#69) (`498d1b1`)
- dispatch agent-pane sync on every published release (#68) (`5000517`)

### Other Changes

- Refactor pending block styling to use :has() for unified highlights (#73) (`9da3499`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.5.0...v0.6.0

## [0.5.0] - 2026-07-06

### Features

- land pluggable inline syntax passes (setInlinePasses) on main (#66) (`d28e2b2`)
- pluggable fence-handler registry for mermaid-style custom blocks (#53) (#54) (`8431595`)

### Bug Fixes

- validate content of preserved raw-HTML tags before emit (#57) (`920ee52`)
- remove ReDoS in the angle-autolink verbatim regex (#56) (`0bd15d7`)

### Documentation

- readable prose-link colors + wave favicon set (#64) (`78a3e93`)
- slim the README, add an extending guide, tidy the site (#63) (`9c3df98`)

### Continuous Integration

- deploy demo to GitHub Pages instead of committing built bundles (#61) (`1dc36e5`)
- scope CI token to read, harden the release workflow (#59) (`67712ee`)

### Chores

- optional highlight.js peer, require(esm) support, sane maps (#58) (`fee8a7f`)

### Other Changes

- Trusted Types e2e suite, browser sink benchmark, and compile-time SanitizedHtml brand (#67) (`fcc33d9`)
- Add Trusted Types support with innerHTML chokepoint (#65) (`70ce784`)
- docs,scripts: fix changelog-gen bugs, cwd-independent loaders, stale refs (#60) (`b3de187`)
- Full GFM table conformance (Tables extension 8/8) (#62) (`85ab15b`)
- Add GFM spec conformance harness + refresh conformance docs (#52) (`a856d95`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.4.0...v0.5.0

## [0.4.0] - 2026-07-06

### Documentation

- demo lazy loading of highlight.js and mermaid on the site (#51) (`4d4d87b`)

### Other Changes

- Add comprehensive test coverage and coverage-gate ratchet (#50) (`dfeb935`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.3.0...v0.4.0

## [0.3.0] - 2026-07-06

### Bug Fixes

- deterministic host image paths to stop screenshot churn (#43) (`efd6ba7`)

### Performance

- incremental tokenize + link-ref scanning via safe resume boundaries (#30) (#40) (`b0791d0`)
- intra-list tail bounding — freeze settled items of an open list (#29) (#39) (`82182e0`)
- incremental committed-prefix rendering (fixes #21) (#23) (`ca2286a`)

### Refactors

- compile-enforced settle classification + review dedups (#32) (#36) (`3f6c472`)

### Documentation

- soft-wrap API snippets and drop the install badge glyph (#46) (`ad6c727`)
- fix hero pane scroll, badge selection, and fidelity check (#44) (`23fcf53`)

### Tests

- CI-able perf-regression guard + share top-level render opts (#34) (`979e718`)

### Build System

- drop private:true now that publishing is intentional (#35) (`38be874`)
- require Node >=21 so npm test can't silently run zero tests (#28) (`7700739`)

### Continuous Integration

- harden release publishing (OIDC trusted publishing + publish-before-push) (#27) (`8b9526e`)

### Other Changes

- Support paragraph continuation in streaming markdown renderer (#49) (`20497c2`)
- Align CommonMark spec compliance for links, blocks, and emphasis (#47) (`dd367bb`)
- sanitize: native backend preserves allowlisted class (hljs/mermaid hooks) (#45) (`55d0389`)
- Add self-hosted runner routing to CI workflow (#42) (`cb23310`)
- Prototype: lazy-load the generator's highlight.js dependency (#37) (`9e31620`)
- Add GitHub Pages live demo with browser bundle (#41) (`e34694d`)
- styles: ship optional core + default reference stylesheets (#26) (`870999a`)
- Add GitHub Pages demo (docs/) and streaming e2e test suite (#38) (`5b2123a`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.2.0...v0.3.0

## [0.2.0] - 2026-07-05

### Other Changes

- Fix attribute injection via fenceCodeClass in the string emitter (#25) (`dc6560d`)
- Release workflow: version dropdown + publish to public npm with provenance (#24) (`ce3c896`)
- Make the HTML sanitizer backend pluggable (native Sanitizer API / DOMPurify) (#19) (`85f75c3`)
- Fix safeLinkHref scheme check running before entity decoding (#22) (`128c47b`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.1.1...v0.2.0

## [0.1.1] - 2026-07-05

### Features

- render top-level indented HTML as prose, not a code block (#672) (`0a0fda0`)
- reveal streaming link label while URL is incomplete (#673) (`14e7ba4`)
- GFM task lists (- [ ] / - [x]) (#669) (`9217a75`)
- GFM strikethrough (~~text~~) (#667) (`576d986`)

### Bug Fixes

- point package.json repository.url at copse-dev/streaming-markdown (`6c767fe`)
- multi-line link reference definitions + trailing-content guard (#681) (`89fdb1e`)
- fenced-code content fidelity + info-string language decode (#671) (`50b1655`)
- clear the 25 Dependabot alerts via patched-version overrides (#643) (`338fe28`)

### Performance

- streaming performance benchmark harness (#618) (#675) (`478053a`)

### Refactors

- make raw-image handling host-injectable; docs + dependabot (`260c78f`)
- enforce package boundary + injectable LinkDecorator (#601) (#674) (`2f14a59`)

### Documentation

- streaming-markdown vs remend/streamdown gap analysis + conformity policy (#14) (`62aa51d`)
- resolve indented code block + tab expansion decision (#9) (#15) (`e72db69`)
- declare raw-HTML policy + in-scope conformance ceiling (#670) (`b1045c8`)

### Build System

- add prepare script so git installs build dist/ (`6942fc7`)

### Continuous Integration

- add manual release workflow (version bump + changelog + GitHub Release/Package) (#20) (`7c029cc`)
- run the normalizer-parity check in this repo; pin esbuild (`f15066c`)

### Chores

- Bump @types/node from 22.20.0 to 26.0.1 (#7) (`fb1a5bf`)
- Bump entities from 4.5.0 to 8.0.0 (#6) (`29a7f63`)
- Bump @types/jsdom from 21.1.7 to 28.0.3 (`63d9fb4`)
- Bump esbuild in the npm-minor-patch group (`6876d77`)
- Bump actions/setup-node from 4 to 6 (`b0f5fe5`)
- Bump actions/checkout from 4 to 7 (`43fb404`)

### Other Changes

- markdown: link/image/autolink conformance improvements (#18) (`f80173e`)
- markdown: list/list-item conformance improvements (#17) (`3dc08e3`)
- streaming: minimal pending→committed DOM patches (#16) (`7c6ca77`)
- Stand up as an independent repo (build, tests, CI) (`61d99a4`)
- Add gortex as primary semantic search backend (#680) (`0511eeb`)
- CommonMark inline + tab coverage: emphasis, autolinks, image alt, indented code/ATX tabs (#640) (`0f38fdb`)
- Fix bold-wrapped markdown links and code path labels (#626) (`0445538`)
- Extract @copse/streaming-markdown package; implement escapes, entities, and list conformance (#593, #594, #595) (#610) (`777c2f6`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/commits/v0.1.1
