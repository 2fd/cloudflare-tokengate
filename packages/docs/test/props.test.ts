// Every docs props table lists exactly the props of the component it documents, as declared in
// the @tokengate/ui source: a renamed, added or removed prop fails here until the table follows.
// A row may group related props ("name / value") and may describe a nested field of a declared
// prop ("items[].approve").
import { describe, expect, it } from 'vitest';
import { GROUPS, REGISTRY } from '../src/registry';
import { componentProps } from './props-source';

const tables = GROUPS.flatMap((group) =>
  REGISTRY[group.key].flatMap((doc) =>
    doc.props.map((table) => [`${group.key}/${doc.slug} ${table.component}`, table] as const),
  ),
);

describe('props tables', () => {
  it.each(tables)('%s matches the component props', (_, table) => {
    const declared = componentProps(table.component).sort();
    const rows = table.props.map((prop) => prop.name);
    const nested = rows.filter((row) => /[[.]/.test(row));
    for (const row of nested) {
      expect(declared, `${row} describes a field of a declared prop`).toContain(
        row.split(/[[.]/)[0],
      );
    }
    const documented = rows
      .filter((row) => !nested.includes(row))
      .flatMap((row) => row.split(/\s*[,/]\s*/))
      .sort();
    expect(documented).toEqual(declared);
  });
});
