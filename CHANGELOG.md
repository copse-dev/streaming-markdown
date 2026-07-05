# Changelog

All notable changes to this project are documented in this file. Each entry is
generated at release time from the commits since the previous tag. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
