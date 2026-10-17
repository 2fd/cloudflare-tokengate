// The rendered pages keep the outline and the references that assistive tech relies on: one h1,
// no skipped heading level, distinct landmark names, references that point at elements, and a
// name for every table. Examples are real product markup, so this also checks the components.
import { describe, expect, it } from 'vitest';
import { createDocsApp } from '../src/app';
import { FOUNDATIONS } from '../src/foundations';
import { GROUPS, REGISTRY, componentHref } from '../src/registry';

const app = createDocsApp();
const pages = [
  '/docs',
  ...FOUNDATIONS.map((topic) => `/docs/foundations/${topic.slug}`),
  ...GROUPS.map((group) => `/docs/components/${group.key}`),
  ...GROUPS.flatMap((group) =>
    REGISTRY[group.key].map((doc) => componentHref(group.key, doc.slug)),
  ),
];

async function html(path: string): Promise<string> {
  return (await app.request(`https://docs.test${path}`)).text();
}

describe.each(pages)('%s', (path) => {
  it('has one h1 and never skips a heading level going down', async () => {
    const page = await html(path);
    const levels = [...page.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels.filter((level) => level === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    const skips = levels.flatMap((level, i) =>
      i > 0 && level > (levels[i - 1] as number) + 1 ? [`h${levels[i - 1]} → h${level}`] : [],
    );
    expect(skips).toEqual([]);
  });

  it('gives every navigation landmark its own name', async () => {
    const page = await html(path);
    const names = [...page.matchAll(/<nav\b[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it('points every fragment link, label, description and invoker at an element', async () => {
    const page = await html(path);
    const ids = new Set([...page.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const refs = [
      ...[...page.matchAll(/\shref="#([^"]+)"/g)].map((m) => m[1] as string),
      ...[...page.matchAll(/\s(?:aria-labelledby|aria-describedby)="([^"]+)"/g)].flatMap((m) =>
        (m[1] as string).split(/\s+/),
      ),
      ...[...page.matchAll(/\s(?:commandfor|popovertarget|for|list|form)="([^"]+)"/g)].map(
        (m) => m[1] as string,
      ),
    ];
    expect([...new Set(refs.filter((ref) => !ids.has(ref)))]).toEqual([]);
  });

  it('names every table: a caption, or a labelled scroll region around it', async () => {
    const page = await html(path);
    const unnamed: string[] = [];
    for (const m of page.matchAll(/<table\b[^>]*>/g)) {
      const at = m.index as number;
      const after = page.slice(at, at + 400);
      if (/^<table\b[^>]*>\s*<caption/.test(after)) continue;
      if (/aria-label(ledby)?=/.test(m[0])) continue;
      const before = page.slice(Math.max(0, at - 300), at);
      if (
        /<div class="[^"]*" role="region"[^>]*aria-label(?:ledby)?="[^"]+"[^>]*>\s*$/.test(before)
      )
        continue;
      unnamed.push(m[0]);
    }
    expect(unnamed).toEqual([]);
  });
});
