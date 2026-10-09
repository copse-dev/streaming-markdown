/**
 * The one definition of a custom `data-*` attribute name, shared by the two
 * gates that have to agree about them: the pre-sink escape gate
 * (`SAFE_OUTER_TAG_RE` in `escape.ts`) and the sink allowlist walk
 * (`enforceSanitizerAllowlist` in `sanitize-browser.ts`).
 *
 * They are shared rather than written twice because two copies of an attribute
 * allowlist drifting apart is exactly what #146 left behind: it dropped the
 * host-specific `data-browser-link` / `data-workspace-link` names from both
 * gates but gave only the sink a replacement hook, so a host `linkDecorator`
 * emitting them had its whole `<a …>` escaped to literal text.
 *
 * `data-*` is allowed generically rather than name-by-name because it carries no
 * behavioural surface in HTML — no script, no URL, no navigation, no form
 * control — which is why DOMPurify's own `ALLOW_DATA_ATTR` defaults to `true`.
 * Matching that default keeps the two shipped sanitizer backends interchangeable
 * and spares hosts (and future core markers) an allowlist edit per attribute.
 * See the caveat on `SanitizeExtension` in `sanitize.ts` for the one environment
 * where `data-*` is *not* inert.
 */
export const DATA_ATTR_NAME_SOURCE = 'data-[a-z0-9-]+'

/** {@link DATA_ATTR_NAME_SOURCE} as a whole-name test. */
export const DATA_ATTR_NAME_RE = /* @__PURE__ */ new RegExp(`^${DATA_ATTR_NAME_SOURCE}$`, 'i')
