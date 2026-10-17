import { describe, expect, it } from 'vitest';
import { Field, FieldError, Input, Select, Textarea } from '../../src';
import { render } from '../render';

describe('Field', () => {
  it('labels the control and leaves out describedby when there is nothing to describe', () => {
    expect(
      render(
        <Field id="name" label="Name">
          <Input name="name" />
        </Field>,
      ),
    ).toBe(
      '<div class="field"><label for="name">Name</label><input class="input" id="name" name="name" type="text"/></div>',
    );
  });

  it('wires hint, error and note in order into aria-describedby and sets aria-invalid', () => {
    const html = render(
      <Field
        id="cred"
        label="Bot token"
        hint="Starts with xoxb-."
        error="Slack answered invalid_auth."
        note="Secret kept for 15 minutes."
      >
        <Input secret />
      </Field>,
    );
    expect(html).toContain('<span class="hint" id="cred-hint">Starts with xoxb-.</span>');
    expect(html).toContain(
      '<p class="field-error" id="cred-error"><span aria-hidden="true">✕</span><span class="vh">Error:</span> Slack answered invalid_auth.</p>',
    );
    expect(html).toContain('<p class="hint" id="cred-note">Secret kept for 15 minutes.</p>');
    expect(html).toContain('aria-invalid="true" aria-describedby="cred-hint cred-error cred-note"');
    // label, hint, error, control, note
    expect(html.indexOf('cred-hint"')).toBeLessThan(html.indexOf('id="cred-error"'));
    expect(html.indexOf('id="cred-error"')).toBeLessThan(html.indexOf('<input'));
    expect(html.indexOf('<input')).toBeLessThan(html.indexOf('id="cred-note"'));
  });

  it('marks optional and needed-for fields after the label', () => {
    expect(
      render(
        <Field id="a" label="Note" optional>
          <Textarea />
        </Field>,
      ),
    ).toContain('<label for="a">Note <span class="opt">(optional)</span></label>');
    expect(
      render(
        <Field id="b" label="Branch" neededFor="Branch">
          <Input />
        </Field>,
      ),
    ).toContain('<label for="b">Branch <span class="opt">(needed for Branch)</span></label>');
  });

  it('wires Select and Textarea the same way', () => {
    const select = render(
      <Field id="region" label="Region" hint="Where the API runs.">
        <Select options={[{ value: 'eu', label: 'eu-west-1' }]} />
      </Field>,
    );
    expect(select).toContain('<select class="select" id="region" aria-describedby="region-hint">');
    const textarea = render(
      <Field id="why" label="Why" error="Say why.">
        <Textarea />
      </Field>,
    );
    expect(textarea).toContain(
      '<textarea class="input" id="why" aria-invalid="true" aria-describedby="why-error"></textarea>',
    );
  });

  it('lets the control override id and invalid, and does not leak the wiring past the field', () => {
    const html = render(
      <>
        <Field id="x" label="X" hint="h">
          <Input id="y" invalid={false} />
        </Field>
        <Input id="z" />
      </>,
    );
    expect(html).toContain('<input class="input" id="y" type="text" aria-describedby="x-hint"/>');
    expect(html).toContain('<input class="input" id="z" type="text"/>');
  });

  it('appends an explicit describedBy after the Field hint, error and note ids', () => {
    const html = render(
      <Field id="f-name" label="Name" hint="h" error="e">
        <Input describedBy="shared-hint" />
      </Field>,
    );
    expect(html).toContain('aria-describedby="f-name-hint f-name-error shared-hint"');
    const select = render(
      <Field id="s" label="S" note="n">
        <Select options={[]} describedBy="shared" />
      </Field>,
    );
    expect(select).toContain('aria-describedby="s-note shared"');
    const textarea = render(
      <Field id="t" label="T" hint="h">
        <Textarea describedBy="shared" />
      </Field>,
    );
    expect(textarea).toContain('aria-describedby="t-hint shared"');
    expect(render(<Input id="solo" describedBy="shared" />)).toContain('aria-describedby="shared"');
  });

  it('escapes label, hint and error text', () => {
    const html = render(
      <Field id="e" label="<b>" hint="<i>" error="<script>">
        <Input />
      </Field>,
    );
    expect(html).not.toMatch(/<b>|<i>|<script>/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('appends the class', () => {
    expect(
      render(
        <Field id="c" label="C" class="span-all">
          <Input />
        </Field>,
      ),
    ).toMatch(/^<div class="field span-all">/);
  });

  it('FieldError renders the error line on its own', () => {
    expect(render(<FieldError id="q-error">Enter a value.</FieldError>)).toBe(
      '<p class="field-error" id="q-error"><span aria-hidden="true">✕</span><span class="vh">Error:</span> Enter a value.</p>',
    );
  });
});
