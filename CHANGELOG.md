# Changelog

All notable changes to this project are documented in this file. Each entry is
generated at release time from the commits since the previous tag. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-03

### Bug Fixes

- stop destroying anchors that carry data-* attributes (#257) (`cfe1660`)

### Chores

- Bump @types/react-dom in the npm-minor-patch group (#256) (`45764f3`)
- Bump dompurify in the npm-minor-patch group (#254) (`fef86b5`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.8...v1.1.0

## [1.0.8] - 2026-08-24

### Continuous Integration

- dispatch agent-pane as the release App over workflow_dispatch (#252) (`153581f`)

### Chores

- Bump the npm-minor-patch group with 3 updates (#253) (`1a5bcde`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.7...v1.0.8

## [1.0.7] - 2026-08-20

### Chores

- Bump @types/jsdom from 28.0.3 to 30.0.0 (#251) (`a88e625`)
- Bump the npm-minor-patch group with 5 updates (#250) (`37f8b3a`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.6...v1.0.7

## [1.0.6] - 2026-08-15

### Chores

- Bump the npm-minor-patch group with 6 updates (#248) (`95c135f`)
- Bump jsdom from 29.1.1 to 30.0.1 (#249) (`07b9c93`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.5...v1.0.6

## [1.0.5] - 2026-08-09

### Chores

- Bump mermaid from 11.16.0 to 11.16.1 in /bench/competitors (#245) (`29daca8`)
- Bump dompurify from 3.4.12 to 3.4.13 in /bench/competitors (#246) (`3ceedc0`)
- Bump dompurify from 3.4.12 to 3.4.13 (#247) (`dfbf678`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.4...v1.0.5

## [1.0.4] - 2026-08-06

### Chores

- Bump undici from 7.28.0 to 7.29.0 in /bench/competitors (#243) (`5ca3b80`)
- Bump undici from 7.28.0 to 7.29.0 (#244) (`22f64ec`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.3...v1.0.4

## [1.0.3] - 2026-08-04

### Chores

- Bump the npm-minor-patch group with 3 updates (#242) (`daf715d`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.2...v1.0.3

## [1.0.2] - 2026-07-28

### Chores

- Bump katex in the npm-minor-patch group (#240) (`7e453f3`)
- Bump c8 from 11.0.0 to 12.0.0 (#241) (`ba12378`)
- Bump dompurify from 3.4.11 to 3.4.12 in /bench/competitors (#239) (`b7224e8`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.1...v1.0.2

## [1.0.1] - 2026-07-23

### Bug Fixes

- treat hard-break sentinel as flanking whitespace (#238) (`5107a13`)

### Chores

- Bump the npm-minor-patch group with 3 updates (#236) (`2a390ec`)
- Bump actions/setup-node from 6 to 7 (#235) (`1e5b24e`)
- Bump typescript from 6.0.3 to 7.0.2 (#237) (`322ae1d`)

### Other Changes

- Fix streaming inline code preview (#234) (`6fad7de`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v1.0.0...v1.0.1

## [1.0.0] - 2026-07-14

### Bug Fixes

- keep the pending tail above the trailing footnotes section (#228) (`7a34c18`)
- namespace ids to prevent cross-instance collisions; a11y parity (#221) (`ddcf474`)
- enable math grammar before renderer construction (#193) (`4825084`)

### Performance

- sealed-commit path consumes scan events — render-once span adoption + event-verified prefix (#213) (`2a3b920`)
- release settled leading definitions of an open blank-free link-ref run (#212) (`5002a0f`)
- sealed-commit memos and targeted link-ref patches — ADR 0004 Phase 2 (#203) (`4cef347`)
- pending-line plain-text fast path — append inert deltas to the DOM text node (#202) (`5773d76`)
- selector-free hot path, single-parse commits, inert-definition skips (#197) (`4415614`)

### Documentation

- correct GFM conformance numbers after task-list baseline bump (#223) (`f0f942f`)
- document CommonMark-vs-GFM equal-length nesting divergence (#208) (`365c245`)
- correct drifted spec numbers; generate the report from baselines (#207) (`5fe883a`)
- ADR 0005 — industry benchmarks and evals for the plumbing (#198) (`6dc8b3a`)
- post-merge table regeneration + published LLM-delta-sized parity section (#210) (`e463ae2`)
- measure the direct-DOM floor — verdict: do not build it (#201) (`263e349`)
- final combined tables — escape-all parity row on the hot-path code (#200) (`93222d9`)
- genericise sample artifact path in normalizeHostImagePath (#199) (`7fabdd3`)

### Tests

- pin the three Babelmark divergence cases not covered by the spec suites (#222) (`7536297`)
- strip task-list decorations so GFM task lists score 2/2 (#209) (`31e5dda`)

### Continuous Integration

- fetch the GFM spec before the gate; print uncovered lines on coverage failure (#233) (`9fd3d87`)
- gate on ci.yml's Node version; switch to Node 24 only to publish (#232) (`bc82ff0`)
- gate docs numbers against baselines (--check) (#225) (`3c23c9c`)

### Chores

- Bump actions/upload-artifact from 4 to 7 (#205) (`295e180`)
- Bump actions/create-github-app-token from 2 to 3 (#206) (`2bc0e02`)
- Bump actions/cache from 4 to 6 (#204) (`ba30554`)

### Other Changes

- Footnote streaming presentation: CSS snap follow, section + unresolved refs held until resolve/settle; prereleases under `next` (#229) (`0105400`)
- Promote experimental tier to stable v1 API at 1.0 release (#227) (`f5f47a3`)
- Style pending mermaid diagrams with consistent streaming indicators (#226) (`066c283`)
- Document first-party React bindings and component API (#211) (`b0291df`)
- Improve hero demo streaming UX and fix layout shifts (#224) (`f547340`)
- bench(competitors): validate rendered output per contestant — coverage + structure metrics (#214) (`80e246c`)
- perf(scan) + guard: fix measured long-document super-linear terms; op-count doubling gate (ADR 0004 Phase 3) (#215) (`03bf055`)
- htmlPolicy 'escape-all': literalize every raw tag, retire the balance guards (#196) (`4160cce`)
- Re-rooted append points for open raw containers (ADR 0004 Phase 2) (#194) (`c82fc55`)
- smd like-for-like benchmarking, feature gates, and the sealed-block plan (ADR 0004 Phases 0–1) (#195) (`37ad049`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v.0.11.0...v1.0.0

## [0.11.0] - 2026-07-12

### ⚠ BREAKING CHANGES

- evict workspace/host residue from the neutral core (#146) (#190) (`cf8f130`)
- config-injected renderer API — replace per-slot setters with MarkdownConfig + setDefaultConfig (#186) (`2b64851`)

### Features

- side-by-side streaming playground with failure cases (#158) (#189) (`f60dda6`)
- first-party React wrapper (/react export) (#156) (#191) (`1d11d36`)

### Bug Fixes

- snapshot config at construction (#153) (#187) (`efd7d3a`)
- route angle autolinks through the scheme allowlist (#139) (#169) (`64f5ad5`)
- brand renderStreamingMarkdown's return as SanitizedHtml (#140) (#171) (`be999ef`)
- decode hex non-breaking space `&#xa0;` in the streaming pending tail (#143) (#163) (`f5a4229`)
- restore the prior footnote context after a nested render (#144) (#170) (`9f2bdcb`)
- hold the pending tail in the DOM emitter for an open `<details>` (#138) (#166) (`def43f4`)

### Performance

- compute renderAnchor's isWorkspace lazily (#146) (#181) (`af947b7`)
- restore ~O(n) streaming via an append-only fast path (#133) (#162) (`41e5195`)

### Documentation

- mark the experimental main-entry surface before v1 (#147) (#188) (`24acca0`)
- add a React integration guide (#156) (#182) (`1c8348f`)
- add a security model + threat model page (#159) (#167) (`082d92f`)
- correct stale GFM extended-autolink conformance figure (11/11, #149) (#164) (`721e993`)
- mark the over-exposed main-entry internals @experimental (#147) (#180) (`ecb5b30`)
- document the SanitizerBackend serialization contract (#148) (#165) (`700cca2`)

### Tests

- mid-stream string/DOM emitter parity fuzz (#150) (#178) (`60e7082`)
- extension-API reentrancy — recursive renderMarkdownUnsafe (#151) (#176) (`41f2849`)
- pin a second baseline under the shipping passthrough default (#141) (#172) (`3ee0d14`)
- entity-decode matrix over the streaming pending path (#152) (#175) (`ed6d01b`)
- adversarial-input hardening suite (deep nesting, floods, wide tables) (#142) (#168) (`5f02cc6`)

### Other Changes

- Add cross-library streaming benchmark harness (#157) (#185) (`4b94e71`)
- bench: adopt a real-document corpus for the relative growth guard (#154) (#179) (`6fd5181`)
- demo: add an "Edge cases" preset with the canonical streaming failure shapes (#158) (#183) (`c8ef998`)
- bench: add a code-block-heavy streaming case + re-highlight scaling guard (#155) (#173) (`fba3f72`)
- Config model (#137): ADR 0003 + per-render overrides for the security-policy tier (#161) (`010c574`)
- v1 review: restore coverage (#132), remove dead branches, fix block-nesting DoS (#136) (#160) (`fa78392`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.10.0...v0.11.0

## [0.10.0] - 2026-07-10

### ⚠ BREAKING CHANGES

- neutral default link output and host-only workspace subpath (#112) (#124) (`cf58cbf`)

### Features

- support GFM extended www, URL, and email autolinks (#125) (`bc77b95`)
- make renderMarkdown safe by default, add renderMarkdownUnsafe (#104) (#116) (`21104d4`)

### Bug Fixes

- hold trailing ~~ and sweep stale pending &lt;li&gt; in streaming (#119) (`f6fbfb0`)
- restore setext-at-EOF heading rendering and green up main CI (#129) (`c3a2b76`)
- reliable mobile iOS load + no horizontal scroll on action bar (#128) (`ecb7b72`)
- keep GFM table when header cell has bold label or image (#106) (#120) (`dd9f2b2`)
- stop splicing a pending top-level bullet inside a trailing blockquote (#123) (`0176877`)
- keep balanced parens in bare-URL autolinks (#107) (#117) (`fb0bb65`)
- render unterminated setext underline as a heading at rest (#105) (#122) (`f23fe45`)

### Performance

- advance the safe boundary inside lists and blockquotes (#111) (#126) (`8e73c10`)
- incremental footnote rendering instead of full re-morph (#110) (#127) (`e191b73`)

### Documentation

- refresh stale conformance numbers and feature status (#118) (`476f81c`)

### Tests

- add group ride announcement regression fixture (#130) (`8ea4a60`)

### Continuous Integration

- raise Node heap for the bench job to fix the main-branch OOM (#134) (`1cbf361`)
- gate Trusted Types e2e, Node 20+22 matrix, bench guard, and bundle size (#121) (`7765a7b`)
- dispatch agent-pane sync from release.yml + manual notify trigger (#102) (`939b49d`)

### Other Changes

- Drop comment-only list items instead of rendering a blank bullet (#131) (`ef15e21`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.9.0...v0.10.0

## [Unreleased]

### Breaking Changes

- **Neutral default link output (#112).** The built-in default `LinkDecorator`
  is now host-agnostic: rendered `<a>` anchors carry only `href`/`title` and no
  longer include `target="_blank"`, `rel="noopener noreferrer"`,
  `data-browser-link`, `data-workspace-link`, or `class="workspace-markdown-link"`.
  A general-purpose `renderMarkdown`/streaming render no longer injects a specific
  host's routing semantics.

  **Migration.** Hosts that want the previous in-app behaviour opt in with a
  single call:

  ```ts
  import { setLinkDecorator } from '@copse/streaming-markdown'
  import { appLinkDecorator } from '@copse/streaming-markdown/host/workspace'

  setLinkDecorator(appLinkDecorator)
  ```

- **Host/workspace helpers moved off the main entry (#112).** `appLinkDecorator`,
  `stripAppLinkAttributes`, `stripAppImageAttributes`, `stripAppCodeDecorations`,
  `isWorkspaceMarkdownLinkHref`, `workspaceLinkTargetFromHref`, and the
  `WorkspaceLinkTarget` type are no longer re-exported from
  `@copse/streaming-markdown`. Import them from the dedicated host subpath
  `@copse/streaming-markdown/host/workspace` instead.

## [0.9.0] - 2026-07-09

### Other Changes

- Raw-HTML passthrough as default, escape as opt-out (#600) (#101) (`59b073b`)

**Full Changelog**: https://github.com/copse-dev/streaming-markdown/compare/v0.8.0...v0.9.0

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
