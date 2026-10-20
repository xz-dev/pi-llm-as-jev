## REMOVED Requirements

### Requirement: Optional observation contract
**Reason**: The plugin no longer exposes a review/transport observation capability.
**Migration**: Consumers use strict final judgments. Existing Pi-owned classifier/fetch APIs and their behavior outside this plugin remain unchanged.

### Requirement: Actual transport attempt lifecycle
**Reason**: Maintaining a transport accounting layer is outside stateless classification and judgment.
**Migration**: Remove this plugin's attempt collectors and consumer expectations; do not label a logical judgment or question count as an HTTP attempt count.

### Requirement: Partial answers remain separate
**Reason**: Partial-result persistence and retry reuse are removed.
**Migration**: Validate complete raw answers for each model attempt; failures expose no final answers. Consumers retain already completed independent business work under their own policy.

### Requirement: Honest usage and price provenance
**Reason**: Per-attempt usage totals and catalog billing estimates are no longer supplied by this plugin.
**Migration**: Preserve optional backend-reported usage only under its actual reporting scope. Remove completeness/zero-cost claims when observations are unavailable rather than inventing totals.

### Requirement: Observation privacy
**Reason**: No observation payload remains to publish or persist.
**Migration**: Keep request/error redaction and consumer diagnostic privacy under the ordinary judgment and integration contracts. Do not retain raw transport bodies as a replacement diagnostic mechanism.
