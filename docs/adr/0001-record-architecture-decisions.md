# 1. Record architecture decisions

This ADR explains why and how the project records design decisions. It is for contributors and reviewers.

Date: 2026-10-13

## Status

Accepted

## Context

tokengate holds upstream API credentials for a whole company. Security reviewers must understand what it trusts and why. Contributors must know which constraints are deliberate before they change code. Code comments explain local constraints, but they do not explain alternatives that were rejected.

## Decision

We record each significant design decision as an architecture decision record (ADR) in `docs/adr/`. We use the format by Michael Nygard: title, date, Status, Context, Decision, Consequences.

- Files are numbered in order: `NNNN-short-title.md`.
- An accepted ADR is not rewritten. A new ADR supersedes it, and the old one's status changes to `Superseded by NNNN`.
- A change to a security-relevant design (trust model, cryptography, storage, authentication, telemetry) needs an ADR in the same pull request.

Reference: Michael Nygard, "Documenting Architecture Decisions" (https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

## Consequences

- Reviewers can find the reason for each design choice in one place, listed in the [ADR index](README.md).
- Design changes take slightly more work, because the author must write the context and the consequences.
- ADRs describe decisions at the time they were made. [architecture.md](../architecture.md) and the code describe the current state.
