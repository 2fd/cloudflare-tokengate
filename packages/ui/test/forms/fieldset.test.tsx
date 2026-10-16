import { describe, expect, it } from 'vitest';
import { Field, FieldSet, Input, Picks } from '../../src';
import { render } from '../render';

const picks = [
  { value: 'never', label: 'Never' },
  { value: '7d', label: '7 days' },
];

describe('FieldSet', () => {
  it('renders the legend and gives its id to the choices', () => {
    expect(
      render(
        <FieldSet id="exp" legend="Expires">
          <Picks name="exp" options={picks} value="never" />
        </FieldSet>,
      ),
    ).toBe(
      '<fieldset class="field" id="exp"><legend>Expires</legend><div class="picks"><label class="pick" data-o="1"><input type="radio" id="exp-1" name="exp" value="never" checked=""/>Never</label><label class="pick" data-o="2"><input type="radio" id="exp-2" name="exp" value="7d"/>7 days</label></div></fieldset>',
    );
  });

  it('is described by its hint and error', () => {
    const html = render(
      <FieldSet
        id="env"
        legend="Environment"
        neededFor="Environment"
        hint="Exact name."
        error="Pick an environment."
      >
        <Picks name="env" options={picks} />
      </FieldSet>,
    );
    expect(html).toMatch(
      /^<fieldset class="field" id="env" aria-describedby="env-hint env-error">/,
    );
    expect(html).toContain(
      '<legend>Environment <span class="opt">(needed for Environment)</span></legend>',
    );
    expect(html).toContain('<span class="hint" id="env-hint">Exact name.</span>');
    expect(html).toContain('<p class="field-error" id="env-error">');
  });

  it('adds the live slot, the count scope and the class', () => {
    expect(
      render(
        <FieldSet id="ops" legend="Operations" live={5} countScope optional class="x">
          <Picks name="o" options={picks} />
        </FieldSet>,
      ),
    ).toMatch(
      /^<fieldset class="field sf5 count-scope x" id="ops"><legend>Operations <span class="opt">\(optional\)<\/span><\/legend>/,
    );
  });

  it('a Field inside keeps its own wiring', () => {
    const html = render(
      <FieldSet id="opts" legend="Name and options" hint="Leave empty.">
        <Field id="slug" label="Slug" hint="Lowercase.">
          <Input mono />
        </Field>
      </FieldSet>,
    );
    expect(html).toContain('id="slug" type="text" aria-describedby="slug-hint"');
  });

  it('escapes the legend', () => {
    expect(
      render(
        <FieldSet id="e" legend="<b>">
          x
        </FieldSet>,
      ),
    ).toContain('<legend>&lt;b&gt;</legend>');
  });
});
