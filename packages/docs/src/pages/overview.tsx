// /docs: what the design system is, its principles, how to use the package, and the index of
// foundations and component groups.
import { CodeBlock, PageHeader, Panel, Tray } from '@tokengate/ui';
import { FOUNDATIONS } from '../foundations';
import { DocsLayout } from '../layout';
import { GROUPS, REGISTRY } from '../registry';
import { LinkCards } from './parts';

const PRINCIPLES: ReadonlyArray<{ key: string; title: string; body: string; href?: string }> = [
  {
    key: 'no-js',
    title: 'No client JavaScript',
    body: 'Every page is server-rendered HTML and CSS. The CSP has no script-src: interaction is links, forms, details, dialog with commandfor, popover and :has().',
    href: '/docs/foundations/accessibility#dx-a-nojs',
  },
  {
    key: 'a11y',
    title: 'Accessible by default',
    body: 'WCAG 2.2 AA in light and dark. Components wire ids, labels and ARIA from their props, so the accessible markup is the one you get without trying.',
    href: '/docs/foundations/accessibility',
  },
  {
    key: 'layout',
    title: 'Centered content column',
    body: 'A fixed sidebar and one column of at most 76rem, centered on the window. Header, trays, tables and forms share its left edge; form pages narrow to the form.',
    href: '/docs/foundations/layout',
  },
  {
    key: 'density',
    title: 'Dense, calm surfaces',
    body: 'Page → tray → panel. 44px rows, 40px controls, two weights, one violet accent, mono IDs. Facts go in a meta line, not in extra columns.',
    href: '/docs/foundations/spacing',
  },
  {
    key: 'status',
    title: 'Status in words',
    body: 'Active, Expires in 6 days, Expired, Risk accepted, Pending approval, Disabled. A glyph and a color only add to the word.',
    href: '/docs/foundations/status',
  },
  {
    key: 'one-source',
    title: 'One stylesheet, shared markup',
    body: 'All classes live in ui.css and every app renders them through the same components, so the sidebar or a map is never hand-varied per page.',
  },
];

const SNIPPET_DEP = `// apps/<app>/package.json
"dependencies": { "@tokengate/ui": "workspace:*", "hono": "^4.13.13" }`;

const SNIPPET_RULE = `// apps/<app>/wrangler.jsonc
"rules": [{ "type": "Text", "globs": ["**/*.css"], "fallthrough": true }]`;

const SNIPPET_ROUTE = `import { serveCss, uiCss } from '@tokengate/ui/css';

// /static/ui.<hash>.css: immutable, cached for a year. /static/ui.css: revalidated.
app.get('/static/:file', (c) =>
  serveCss([uiCss], c.req.path, c.req.header('if-none-match')) ?? c.notFound(),
);`;

const SNIPPET_LINK = `import { uiCss } from '@tokengate/ui/css';

<link rel="stylesheet" href={uiCss.href} />`;

const SNIPPET_RENDER = `import { AppShell, Page, PageHeader, SideNav, Tray, Panel } from '@tokengate/ui';

<AppShell brand={{ name: 'tokengate', href: '/admin' }} nav={<SideNav label="Sections" sections={sections} />}>
  <Page>
    <PageHeader title="Service tokens" count={6} description="…" />
    <Tray id="all-tokens" title="All tokens">
      <Panel variant="flush">…</Panel>
    </Tray>
  </Page>
</AppShell>`;

export function OverviewPage() {
  return (
    <DocsLayout
      title="Overview"
      description="The tokengate design system: one stylesheet and server-rendered Hono JSX components."
      at={{ kind: 'overview' }}
    >
      <PageHeader
        title="Design system"
        description="The components and rules every tokengate screen is built from: one stylesheet and server-rendered Hono JSX components in @tokengate/ui."
      />
      <Tray id="dx-what" title="What it is">
        <Panel variant="pad">
          <p class="dx-lead">
            A connections-first admin console: the sidebar, the pipeline, needs attention, the
            connections map and a one-page give-access flow, drawn as a calm developer console with
            tray cards, a violet accent, dense rows, mono IDs and a right rail.
          </p>
          <div class="dx-prose">
            <p>
              The package has two parts. <code>@tokengate/ui/css</code> is the stylesheet, served by
              each app from its own origin. <code>@tokengate/ui</code> is a set of function
              components with typed props that render that stylesheet’s markup. Pages compose
              components; they do not write the markup by hand.
            </p>
            <p>
              These pages exist in local development only. Run <code>pnpm dev</code> from the
              repository root and open <code>http://localhost:8787/docs</code>: the gateway serves
              them on <code>localhost</code>, <code>127.0.0.1</code> and <code>[::1]</code>. Deploys
              never include them, so <code>/docs</code> answers 404 in production.
            </p>
          </div>
        </Panel>
      </Tray>
      <Tray id="dx-principles" title="Principles">
        <ul class="dx-principles">
          {PRINCIPLES.map((p) => (
            <li>
              <h3>{p.title}</h3>
              <p>{p.body}</p>
              {p.href ? (
                <p>
                  <a href={p.href}>
                    Read more<span class="vh">: {p.title}</span>
                  </a>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </Tray>
      <Tray
        id="dx-use"
        title="Use the package"
        description="In a Worker of this monorepo. Five steps, once per app."
      >
        <Panel variant="pad">
          <ol class="dx-steps">
            <li>
              <h3>Add the dependency</h3>
              <p>A workspace dependency; Hono is a peer dependency.</p>
              <CodeBlock label="Dependency">{SNIPPET_DEP}</CodeBlock>
            </li>
            <li>
              <h3>Bundle CSS as text</h3>
              <p>
                Workers cannot read files at runtime, so the stylesheet is imported as a string.
              </p>
              <CodeBlock label="Wrangler rule">{SNIPPET_RULE}</CodeBlock>
            </li>
            <li>
              <h3>Serve the stylesheet</h3>
              <p>
                From the app’s own origin, so it works with <code>style-src 'self'</code>. The
                hashed URL changes with every change to the CSS.
              </p>
              <CodeBlock label="Route">{SNIPPET_ROUTE}</CodeBlock>
            </li>
            <li>
              <h3>Link it</h3>
              <p>
                One stylesheet link in the document head. No inline styles, no style attributes.
              </p>
              <CodeBlock label="Link">{SNIPPET_LINK}</CodeBlock>
            </li>
            <li>
              <h3>Render components</h3>
              <p>Shell, page column, header, trays and panels; the content goes inside.</p>
              <CodeBlock label="Render">{SNIPPET_RENDER}</CodeBlock>
            </li>
          </ol>
        </Panel>
      </Tray>
      <Tray id="foundations" title="Foundations" count={FOUNDATIONS.length}>
        <Panel variant="pad">
          <LinkCards
            label="Foundations"
            cards={FOUNDATIONS.map((topic) => ({
              href: `/docs/foundations/${topic.slug}`,
              title: topic.title,
              description: topic.summary,
            }))}
          />
        </Panel>
      </Tray>
      <Tray
        id="components"
        title="Components"
        count={GROUPS.reduce((n, g) => n + REGISTRY[g.key].length, 0)}
      >
        <Panel variant="pad">
          <LinkCards
            label="Component groups"
            cards={GROUPS.map((group) => ({
              href: `/docs/components/${group.key}`,
              title: group.label,
              meta: `${REGISTRY[group.key].length}`,
              description: group.description,
            }))}
          />
        </Panel>
      </Tray>
    </DocsLayout>
  );
}
