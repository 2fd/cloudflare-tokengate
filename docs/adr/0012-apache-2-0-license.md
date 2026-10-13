# 12. Apache-2.0 license

This ADR explains the choice of license. It is for companies that deploy or fork tokengate and for contributors.

Date: 2026-10-13

## Status

Accepted

## Context

Each company deploys its own copy and often forks it, for example to add an internal profile or service template. Legal teams must approve the license before adoption. The code includes security and cryptography code, where patent terms matter.

Options considered:

- **MIT.** Widely approved, but has no explicit patent grant.
- **AGPL-3.0.** Requires sharing the source of modified copies that users reach over a network. Many companies ban it internally. It mainly stops a hosted reseller, which is not the risk for a self-hosted tool.
- **Apache-2.0.** Widely pre-approved, with an explicit patent grant and patent retaliation. It does not require forks to publish changes.

## Decision

tokengate is licensed under Apache-2.0 (`LICENSE`), with a `NOTICE` file. `package.json` declares `"license": "Apache-2.0"`.

## Consequences

- Companies can fork and change the code for internal use without publishing their changes.
- Contributors grant a patent license for their contributions.
- Redistributions must keep `LICENSE` and `NOTICE` and mark changed files.
- Dependencies must have licenses compatible with Apache-2.0. CI checks dependency licenses in pull requests (`.github/workflows/dependency-review.yml`).
