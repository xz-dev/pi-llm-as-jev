## 1. Configuration

- [x] 1.1 Add `classifierBaseUrl` to `JudgmentConfig` and known keys; accept only http(s) URLs and require `classifierModel`, otherwise apply the all-or-defaults rule; verify config tests cover valid, non-URL, non-http(s), non-string and missing-`classifierModel` cases.
- [x] 1.2 Preserve `classifierBaseUrl` on saves while `classifierModel` is unchanged and drop it when the classifier changes; verify the written file and returned config.

## 2. Native dispatch

- [x] 2.1 Replace the explicit model's `baseUrl` on a copy after selection, stripping a trailing `/systemone` for System One APIs; verify the catalog model is not mutated and non-System-One paths are kept.
- [x] 2.2 Pass the setting through the service's native selection for judgment, review and availability; verify a real Pi run dispatches to the overridden endpoint with the provider's credential.

## 3. Documentation

- [x] 3.1 Document the setting, its scope, credential source, System One path handling and capacity implications in the README.
