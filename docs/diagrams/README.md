# Diagrams

This folder holds the diagrams used in the documentation. They are for anyone who reads the docs or
changes a diagram.

| Diagram | Used in | Source |
|---|---|---|
| [request-flow.svg](request-flow.svg) | [README](../../README.md), [callers/github-actions.md](../callers/github-actions.md) | [src/request-flow.sequence.json](src/request-flow.sequence.json) |
| [components.svg](components.svg) | [architecture.md](../architecture.md) | [src/components.architecture.json](src/components.architecture.json) |
| [proxy-pipeline.svg](proxy-pipeline.svg) | [architecture.md](../architecture.md#proxy-pipeline) | [src/proxy-pipeline.workflow.json](src/proxy-pipeline.workflow.json) |
| [domain-model.svg](domain-model.svg) | [concepts.md](../concepts.md) | [src/domain-model.architecture.json](src/domain-model.architecture.json) |
| [grant-evaluation.svg](grant-evaluation.svg) | [policies.md](../policies.md) | [src/grant-evaluation.workflow.json](src/grant-evaluation.workflow.json) |
| [trust-boundaries.svg](trust-boundaries.svg) | [threat-model.md](../threat-model.md#trust-boundaries) | [src/trust-boundaries.architecture.json](src/trust-boundaries.architecture.json) |
| [telemetry.svg](telemetry.svg) | [observability.md](../observability.md) | [src/telemetry.dataflow.json](src/telemetry.dataflow.json) |
| [audit-trail.svg](audit-trail.svg) | [observability.md](../observability.md) | [src/audit-trail.dataflow.json](src/audit-trail.dataflow.json) |

The data model diagram in [architecture.md](../architecture.md#data-model) stays in Mermaid,
because archify has no entity-relationship type.

## How the diagrams are made

Each diagram is a small JSON specification in [`src/`](src/). The file name gives the diagram type:
`<name>.<type>.json`, where the type is `architecture`, `workflow`, `sequence` or `dataflow`.
The SVG files are rendered from these specifications with
[archify](https://github.com/tt-a1i/archify). Each SVG follows the reader's light or dark theme.

The specifications describe the code. When you change behavior that a diagram shows, update the
specification in the same change. For example, a new step in `src/proxy/handler.ts` changes
`src/proxy-pipeline.workflow.json`.

## Change a diagram

1. Edit the specification in `src/`.
2. Validate it. The diagram must pass the `showcase` quality profile with no errors and no warnings:

   ```bash
   node <archify>/bin/archify.mjs validate <type> docs/diagrams/src/<name>.<type>.json --quality showcase
   ```

3. Render the interactive HTML viewer:

   ```bash
   node <archify>/bin/archify.mjs deliver <type> docs/diagrams/src/<name>.<type>.json docs/diagrams/<name>.html --quality showcase
   ```

4. Open the HTML file in a browser, select **Export**, then **SVG**. Save it as
   `docs/diagrams/<name>.svg`, replacing the old file.
5. Check the SVG in both light and dark mode.

The HTML viewers (`*.html`) and archify's screenshot files (`*.visual-check.*`) are not committed.
They are large and can be generated again at any time with step 3.
