// The registry is the single source of the component docs: entries are complete, slugs are unique,
// every documented name is a real export, and every exported component has a docs page.
import * as ui from '@tokengate/ui';
import * as base from '@tokengate/ui/base';
import * as data from '@tokengate/ui/data';
import * as forms from '@tokengate/ui/forms';
import * as layout from '@tokengate/ui/layout';
import * as viz from '@tokengate/ui/viz';
import { describe, expect, it } from 'vitest';
import { GROUPS, REGISTRY, type GroupKey } from '../src/registry';

const BARRELS: Record<GroupKey, Record<string, unknown>> = { base, forms, layout, data, viz };

/** Exported components: functions named in PascalCase. */
function components(barrel: Record<string, unknown>): string[] {
  return Object.entries(barrel)
    .filter(([name, value]) => typeof value === 'function' && /^[A-Z]/.test(name))
    .map(([name]) => name);
}

describe.each(GROUPS.map((group) => group.key))('group %s', (group) => {
  const docs = REGISTRY[group];

  it('has unique kebab-case slugs', () => {
    const slugs = docs.map((doc) => doc.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('documents only exports of its own group barrel', () => {
    const exported = new Set(components(BARRELS[group]));
    for (const doc of docs) {
      for (const name of [doc.name, ...(doc.related ?? [])]) {
        expect(
          exported.has(name),
          `${group}/${doc.slug}: ${name} is not exported by @tokengate/ui/${group}`,
        ).toBe(true);
      }
    }
  });

  it('has a docs page for every exported component', () => {
    const documented = new Set(docs.flatMap((doc) => [doc.name, ...(doc.related ?? [])]));
    const missing = components(BARRELS[group]).filter((name) => !documented.has(name));
    expect(missing, `add these to apps/docs/src/registry/${group}.tsx`).toEqual([]);
  });

  it('fills every section of the template', () => {
    for (const doc of docs) {
      const where = `${group}/${doc.slug}`;
      expect(doc.summary, where).not.toBe('');
      expect(doc.usage.when.length, `${where} usage.when`).toBeGreaterThan(0);
      expect(doc.examples.length, `${where} examples`).toBeGreaterThan(0);
      for (const example of doc.examples)
        expect(example.code.trim(), `${where} ${example.title}`).not.toBe('');
      expect(
        doc.props.map((table) => table.component),
        `${where} props`,
      ).toEqual([doc.name, ...(doc.related ?? [])]);
      expect(doc.accessibility.length, `${where} accessibility`).toBeGreaterThan(0);
      expect(doc.do.length, `${where} do`).toBeGreaterThan(0);
      expect(doc.dont.length, `${where} dont`).toBeGreaterThan(0);
      expect(doc.classes.length, `${where} classes`).toBeGreaterThan(0);
    }
  });
});

it('the root barrel re-exports every group', () => {
  for (const barrel of Object.values(BARRELS)) {
    for (const name of Object.keys(barrel)) expect(ui, name).toHaveProperty(name);
  }
});
