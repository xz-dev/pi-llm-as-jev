## Why

Jev is reachable only at the endpoints in Pi's catalog. Users with a third-party host of the same API (for example a TypeSafe System One mirror or proxy) cannot point judgment at it without changing the provider endpoint for every Pi consumer through `models.json`. The service owns native classifier selection, so it is the natural place to scope an endpoint override to judgment calls only.

## What Changes

- Add optional `classifierBaseUrl` to `llm-as-jev.json`: an http(s) URL that replaces the explicit `classifierModel`'s catalog `baseUrl` for judgment dispatch.
- Require `classifierModel` when `classifierBaseUrl` is present; an invalid URL or a URL without `classifierModel` invalidates the file under the existing all-or-defaults rule.
- For System One APIs, accept either the base (`https://host/v1`) or the full endpoint (`https://host/v1/systemone`); Pi appends `systemone` itself, so the suffix is removed instead of doubling the path.
- Keep credentials owned by Pi for the selected provider. No new key field, header field or auth resolver.
- Do not mutate Pi's provider registration or catalog; other extensions and Pi itself keep the original endpoint.
- Saves keep the URL only while the same `classifierModel` stays selected; choosing another classifier drops it.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `judge-model-settings`: new optional `classifierBaseUrl` setting, validation and save behavior.

## Impact

- Runtime: `src/config.ts` (field, validation, save), `src/backend-jev.ts` (`withBaseUrl`, applied in `resolveNativeClassifier` for the explicit selection), `src/service.ts` (passes the setting through `nativeSelection`).
- Capacity: built-in TypeSafe/OpenRouter channel limits stay keyed to their known endpoints, so an overridden endpoint uses the model window unless `contextLimits` sets a profile. Review transport identity already digests the model, so overridden endpoints calibrate separately.
- Verification: config validation/save tests and native selector tests; a real Pi run against a local System One stub confirmed dispatch to the overridden URL with the provider's Pi credential.
- Documentation: README Configuration section.
- Compatibility: additive; files without the field behave as before.
