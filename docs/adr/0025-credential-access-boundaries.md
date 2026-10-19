# Credential access boundaries replace standalone issuers

## Status

Superseded by [0026](0026-global-and-credential-access-rules.md)

Credentials, Credential Access Rules and Issuer Access Rules replace service tokens, standalone consumers and grants. An issuer is a value in a credential boundary, including its verification settings; keeping a shared issuer resource would let changing one tenant's trust configuration affect unrelated credentials. This replaces the entity relationships of ADR 0005 and the consumer workflows of ADR 0021.

A Credential Access Rule belongs to exactly one credential and limits the issuer and identity filters that may receive access. An Issuer Access Rule references that boundary and the same credential; a composite foreign key enforces the relationship. Credential administrators own boundaries, while access administrators may grant only within them. Boundaries never grant access themselves.

Containment is checked on create, edit and enable, and on each request. Exact values can narrow glob limits; otherwise pattern limits must be retained verbatim. This deliberately rejects uncertain containment instead of accepting an access that could escape its boundary. Tightening a boundary can revoke an existing access without editing it first.

The proxy tries all applicable enabled boundaries for the issuer and destination, since the same issuer can have several audiences or sets of filters. Missing, malformed, disabled or unmatched boundaries fail closed. Export schema 3 includes both rule kinds and their credential relationships. As this repository is pre-release, the initial schemas are updated according to its existing migration policy; existing databases need an explicit rebuild or a separately planned data migration before using this schema.
