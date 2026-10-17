// Contracts of the shared admin adapters over @tokengate/ui (ADR 0022): only what the admin adds to
// the design system is tested here (packages/ui tests the markup of each component). The field id
// convention and aria-describedby with only rendered ids, native validation only on always-visible
// controls, secret inputs, the Choice thresholds, the group ids, ErrorSummary targets and role,
// confirm=1 on every confirm dialog, the status vocabulary, the notice focus and Undo, who to ask,
// the not-found texts, repeating rows, and patterns that compile the way browsers compile them.
import type { Child } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import type { Permission } from '../../../../src/admin/auth/rbac';
import { parseRows, type ViewContext } from '../../../../src/admin/render';
import {
  ActionButton,
  AskSomeone,
  Checkbox,
  CheckboxGroup,
  Chip,
  Choice,
  ConfirmDialog,
  EmptyState,
  ErrorSummary,
  Field,
  FocusTargets,
  fieldId,
  focusTarget,
  ID_PATTERNS,
  IdWithLabelField,
  NotFound,
  NoticeView,
  notFoundText,
  Pager,
  RadioCards,
  Select,
  StatusBadge,
  Tabs,
  TextArea,
  Time,
} from '../../../../src/admin/views/components';
import { LearnMore } from '../../../../src/admin/views/header';
import { AddRowsButton, RepeatingRows } from '../../../../src/admin/views/rows';
import { STATUS, type StatusKey } from '../../../../src/admin/views/status';

function html(node: Child): string {
  return String(node);
}

/** The opening tag of the first element matching `tag` with `id`. */
function tagWithId(markup: string, tag: string, id: string): string {
  const match = new RegExp(`<${tag}\\b[^>]*\\bid="${id}"[^>]*>`).exec(markup);
  if (!match) throw new Error(`no <${tag} id="${id}"> in ${markup}`);
  return match[0];
}

function view(people: Partial<Record<Permission, string[]>> = {}, more = 0): ViewContext {
  return {
    csrf: 'csrf-token',
    userId: 'usr_x',
    role: 'viewer',
    host: 'gw.test',
    now: 0,
    can: () => false,
    askers: (permission) => (people[permission] ?? []).map((email) => ({ email })),
    askersMore: () => more,
    hidden: (extra) => ({ _csrf: 'csrf-token', ...extra }),
  };
}

describe('Field', () => {
  it('links the label, hint and error to the input by the field id', () => {
    const out = html(
      <Field
        name="base_url"
        label="Base URL"
        hint="The API root."
        error="Enter a host like api.slack.com"
        autocomplete="off"
      />,
    );
    expect(out).toContain('<label for="f-base_url">Base URL</label>');
    expect(out).toContain('<span class="hint" id="f-base_url-hint">The API root.</span>');
    expect(out).toContain('<p class="field-error" id="f-base_url-error">');
    expect(out).toContain('<span class="vh">Error:</span> Enter a host like api.slack.com</p>');
    const input = tagWithId(out, 'input', 'f-base_url');
    expect(input).toContain('name="base_url"');
    expect(input).toContain('aria-describedby="f-base_url-hint f-base_url-error"');
    expect(input).toContain('aria-invalid="true"');
  });

  it('describes the input only by ids that are rendered, then the extra ids', () => {
    const hintOnly = tagWithId(
      html(<Field name="slug" label="Slug" hint="Lowercase." autocomplete="off" />),
      'input',
      'f-slug',
    );
    expect(hintOnly).toContain('aria-describedby="f-slug-hint"');
    expect(hintOnly).not.toContain('aria-invalid');
    const bare = tagWithId(
      html(<Field name="slug" label="Slug" autocomplete="off" />),
      'input',
      'f-slug',
    );
    expect(bare).not.toContain('aria-describedby');
    const shared = tagWithId(
      html(
        <Field
          name="email"
          label="Email"
          hint="Their Access email."
          describedBy={['invite-existing']}
          autocomplete="off"
        />,
      ),
      'input',
      'f-email',
    );
    expect(shared).toContain('aria-describedby="f-email-hint invite-existing"');
  });

  it('maps dotted names to ids and renders suggestions as a datalist', () => {
    expect(fieldId('rules.0.path')).toBe('f-rules-0-path');
    const out = html(
      <Field
        name="rules.0.path"
        label="Path"
        autocomplete="off"
        pattern="/[a-z]*"
        example="/repos/acme"
        optional
        suggestions={[{ value: '/a' }, { value: '/b', label: 'B' }]}
      />,
    );
    const input = tagWithId(out, 'input', 'f-rules-0-path');
    expect(input).toContain('list="f-rules-0-path-list"');
    expect(input).toContain('pattern="/[a-z]*"');
    expect(input).toContain('placeholder="/repos/acme"');
    expect(out).toContain('<datalist id="f-rules-0-path-list">');
    expect(out).toContain('<option value="/b">B</option>');
    expect(out).toContain('<span class="opt">(optional)</span>');
  });

  it('drops native validation from a conditional control (A7.6)', () => {
    const props = {
      name: 'host',
      label: 'Host',
      autocomplete: 'off',
      required: true,
      pattern: '[a-z.]+',
      min: 1,
      max: 9,
      minlength: 3,
    } as const;
    const always = tagWithId(html(<Field {...props} type="url" />), 'input', 'f-host');
    for (const attribute of ['required', 'pattern=', 'min=', 'max=', 'minlength=', 'type="url"']) {
      expect(always).toContain(attribute);
    }
    const conditional = tagWithId(
      html(<Field {...props} type="url" conditional />),
      'input',
      'f-host',
    );
    for (const attribute of ['required', 'pattern=', 'min=', 'max=', 'minlength=', 'type="url"']) {
      expect(conditional).not.toContain(attribute);
    }
    expect(conditional).toContain('type="text"');
    expect(conditional).toContain('inputmode="url"');
    const email = tagWithId(html(<Field {...props} type="email" conditional />), 'input', 'f-host');
    expect(email).toContain('type="text"');
    expect(email).toContain('inputmode="email"');
    // number and date would still block a hidden submit (badInput, step), so they become text.
    const number = tagWithId(
      html(<Field {...props} type="number" step={1} conditional />),
      'input',
      'f-host',
    );
    expect(number).toContain('type="text"');
    expect(number).toContain('inputmode="numeric"');
    expect(number).not.toContain('step=');
    expect(
      tagWithId(html(<Field {...props} type="number" step={1} />), 'input', 'f-host'),
    ).toContain('step="1"');
    const dateOut = html(<Field {...props} name="expires_on" type="date" conditional />);
    const date = tagWithId(dateOut, 'input', 'f-expires_on');
    expect(date).toContain('type="text"');
    expect(date).toContain('aria-describedby="f-expires_on-hint"');
    expect(dateOut).toContain('Use a date like 2027-01-31.');
  });

  it('keeps password managers and autofill away from secret inputs, and never renders a value (A7.8)', () => {
    const input = tagWithId(
      html(
        <Field
          name="credential"
          label="Secret"
          type="password"
          value="xoxb-leak"
          autocomplete="new-password"
        />,
      ),
      'input',
      'f-credential',
    );
    for (const attribute of [
      'type="password"',
      'autocomplete="off"',
      'spellcheck="false"',
      'autocapitalize="none"',
      'autocorrect="off"',
      'data-1p-ignore="true"',
      'data-lpignore="true"',
      'data-bwignore="true"',
    ]) {
      expect(input).toContain(attribute);
    }
    expect(input).not.toContain('value=');
    expect(input).not.toContain('xoxb-leak');
  });

  it('escapes values and renders a TextArea value as its content', () => {
    expect(html(<Field name="n" label="N" value={'"><b>x'} autocomplete="off" />)).toContain(
      'value="&quot;&gt;&lt;b&gt;x"',
    );
    const area = html(
      <TextArea name="hosts" label="Hosts" value="<a>" autocomplete="off" required conditional />,
    );
    expect(area).toContain('&lt;a&gt;</textarea>');
    expect(tagWithId(area, 'textarea', 'f-hosts')).not.toContain('required');
    // spellcheck={false} marks exact values: mono, no spellcheck.
    const exact = tagWithId(
      html(<TextArea name="hosts" label="Hosts" autocomplete="off" spellcheck={false} />),
      'textarea',
      'f-hosts',
    );
    expect(exact).toContain('class="input mono"');
    expect(exact).toContain('spellcheck="false"');
  });

  it('renders ID fields mono, with the pattern and the command that prints the format', () => {
    const out = html(
      <IdWithLabelField
        name="repository"
        label="Repository"
        kind="github_repo"
        findCommand="gh api repos/acme/api"
        autocomplete="off"
      />,
    );
    const input = tagWithId(out, 'input', 'f-repository');
    expect(input).toContain('class="input mono"');
    expect(input).toContain('spellcheck="false"');
    expect(input).toContain('autocapitalize="none"');
    expect(out).toContain('<code>gh api repos/acme/api</code>');
  });
});

describe('Select and Choice', () => {
  const options = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));

  it('keeps the placeholder selectable, so a filter can go back to "any"', () => {
    const empty = html(
      <Select name="token" label="Credential" options={options(2)} placeholder="Any token" />,
    );
    expect(empty).toContain('<option value="" selected="">Any token</option>');
    const chosen = html(
      <Select
        name="token"
        label="Credential"
        options={options(2)}
        placeholder="Any token"
        value="v1"
      />,
    );
    expect(chosen).toContain('<option value="">Any token</option>');
    expect(chosen).toContain('<option value="v1" selected="">Option 1</option>');
  });

  it('marks the chosen option, supports groups and links label, hint and error', () => {
    const out = html(
      <Select
        name="target"
        label="Target"
        value="b"
        hint="What changed."
        error="Choose a target from the list."
        required
        options={[
          { group: 'Credentials', options: [{ value: 'a', label: 'A' }] },
          { group: 'Credential access rules', options: [{ value: 'b', label: 'B' }] },
        ]}
      />,
    );
    expect(out).toContain('<label for="f-target">Target</label>');
    expect(out).toContain(
      '<optgroup label="Credential access rules"><option value="b" selected="">B</option>',
    );
    const select = tagWithId(out, 'select', 'f-target');
    expect(select).toContain('required');
    expect(select).toContain('aria-describedby="f-target-hint f-target-error"');
    expect(select).toContain('aria-invalid="true"');
    expect(
      tagWithId(
        html(<Select name="t" label="T" options={options(2)} required conditional />),
        'select',
        'f-t',
      ),
    ).not.toContain('required');
  });

  it('renders one option as a fixed fact and a hidden input, with its hint and error', () => {
    const out = html(
      <Choice
        name="type"
        label="Type"
        options={options(1)}
        hint="Fixed by the template."
        error="Choose a type"
      />,
    );
    expect(out).toContain('<div class="fixedbar"><span class="lbl">Type</span>');
    expect(out).toContain('<b>Option 0</b>');
    expect(out).toContain('<input type="hidden" name="type" value="v0"/>');
    expect(out).toContain('<span class="hint" id="f-type-hint">Fixed by the template.</span>');
    expect(out).toContain('<p class="field-error" id="f-type-error">');
    expect(out).not.toContain('type="radio"');
  });

  it('renders 2 to 6 options as radio cards and 7 or more as a select', () => {
    for (const n of [2, 6]) {
      const out = html(<Choice name="mode" label="Mode" options={options(n)} />);
      expect(out.match(/type="radio"/g), String(n)).toHaveLength(n);
      expect(out).not.toContain('<select');
    }
    const many = html(<Choice name="mode" label="Mode" options={options(7)} />);
    expect(many).toContain('<select class="select" id="f-mode" name="mode"');
    expect(many).not.toContain('type="radio"');
  });
});

describe('RadioCards and checkboxes', () => {
  it('puts the group id, hint and error on the fieldset; the radios are id-1, id-2 …', () => {
    const out = html(
      <RadioCards
        name="mode"
        legend="Mode"
        value="b"
        hint="Pick one."
        error="Choose a mode"
        options={[
          { value: 'a', title: 'A' },
          { value: 'b', title: 'B', description: 'Second.' },
        ]}
      />,
    );
    const fieldset = tagWithId(out, 'fieldset', 'f-mode');
    expect(fieldset).toContain('aria-describedby="f-mode-hint f-mode-error"');
    expect(out).toContain('<legend>Mode</legend>');
    expect(tagWithId(out, 'input', 'f-mode-1')).toContain('value="a"');
    expect(tagWithId(out, 'input', 'f-mode-2')).toContain('checked=""');
    expect(out).toContain('<span class="rc-d">Second.</span>');
    expect(
      tagWithId(
        html(
          <RadioCards
            name="x"
            legend="X"
            idPrefix="f-ctx"
            options={[
              { value: 'a', title: 'A' },
              { value: 'b', title: 'B' },
            ]}
          />,
        ),
        'input',
        'f-ctx-1',
      ),
    ).toContain('name="x"');
  });

  it('marks a risky option with the risk tag and "Risk:" in words, and keeps reveals unvalidated', () => {
    const out = html(
      <RadioCards
        name="events"
        legend="Events"
        options={[
          { value: 'push', title: 'Push' },
          {
            value: 'pr',
            title: 'Pull requests',
            description: 'Code from forks.',
            risk: 'pull_request jobs run the proposed code.',
            reveal: <Field name="branch" label="Branch" required conditional autocomplete="off" />,
          },
        ]}
      />,
    );
    expect(out).toContain('<label class="rc risk" data-o="2" data-risk="true">');
    expect(out).toContain(
      'Code from forks. <strong>Risk:</strong> pull_request jobs run the proposed code.',
    );
    expect(out).toContain('<div class="reveal">');
    expect(tagWithId(out, 'input', 'f-branch')).not.toContain('required');
  });

  it('gives each checkbox of a group its own id and marks the first one invalid on error', () => {
    const out = html(
      <CheckboxGroup
        name="events"
        legend="Events"
        error="Choose at least one event"
        options={[
          { value: 'push', label: 'Push', hint: 'Every push.' },
          { value: 'tag', label: 'Tag', checked: true },
        ]}
      />,
    );
    expect(tagWithId(out, 'fieldset', 'f-events')).toContain('aria-describedby="f-events-error"');
    expect(tagWithId(out, 'input', 'f-events-1')).toContain('aria-invalid="true"');
    expect(tagWithId(out, 'input', 'f-events-2')).not.toContain('aria-invalid');
    expect(tagWithId(out, 'input', 'f-events-2')).toContain('checked=""');
    expect(out).toContain('<span class="hint">Every push.</span>');
  });

  it('on error, marks the first enabled radio invalid and records it as the link target', () => {
    const targets = new Map<string, string>();
    const out = html(
      <FocusTargets.Provider value={targets}>
        <RadioCards
          name="mode"
          legend="Mode"
          error="Choose a mode"
          options={[
            { value: 'a', title: 'A', disabled: true },
            { value: 'b', title: 'B' },
          ]}
        />
        <CheckboxGroup
          name="events"
          legend="Events"
          error="Choose at least one event"
          options={[
            { value: 'push', label: 'Push' },
            { value: 'tag', label: 'Tag' },
          ]}
        />
      </FocusTargets.Provider>,
    );
    expect(tagWithId(out, 'input', 'f-mode-2')).toContain('aria-invalid="true"');
    expect(tagWithId(out, 'input', 'f-mode-1')).not.toContain('aria-invalid');
    expect([...targets]).toEqual([
      ['f-mode', 'f-mode-2'],
      ['f-events', 'f-events-1'],
    ]);
    expect(focusTarget(targets, 'mode')).toBe('f-mode-2');
    expect(focusTarget(targets, 'name')).toBe('f-name');
    // Without an error no radio is invalid.
    expect(
      html(<RadioCards name="m" legend="M" options={[{ value: 'a', title: 'A' }]} />),
    ).not.toContain('aria-invalid');
  });

  it('sends 1 from a single checkbox and shows its error above it', () => {
    const out = html(
      <Checkbox name="accept" label="I accept the risk" error="Accept the risk to continue." />,
    );
    const input = tagWithId(out, 'input', 'f-accept');
    expect(input).toContain('value="1"');
    expect(input).toContain('aria-describedby="f-accept-error"');
    expect(out.indexOf('id="f-accept-error"')).toBeLessThan(out.indexOf('<label class="check">'));
  });
});

describe('ErrorSummary', () => {
  it('is focused on load, a group (no role=alert), and links field errors to their controls', () => {
    const out = html(
      <ErrorSummary
        errors={[
          { field: 'rules.0.path', message: 'Enter a path' },
          { field: null, message: 'The token changed since you opened the page.' },
        ]}
      />,
    );
    expect(out).toContain(
      '<div class="callout bad errsum" id="error-summary" role="group" tabindex="-1" autofocus="" aria-labelledby="error-summary-h">',
    );
    expect(out).not.toContain('role="alert"');
    expect(out).toContain('<h2 id="error-summary-h">There is a problem</h2>');
    expect(out).toContain('<li><a href="#f-rules-0-path">Enter a path</a></li>');
    expect(out).toContain('<li>The token changed since you opened the page.</li>');
  });

  it('maps targets (a group to its first input) and takes a heading and sentence', () => {
    const out = html(
      <ErrorSummary
        errors={[{ field: 'mode', message: 'Choose a mode' }]}
        target={(field) => `${fieldId(field)}-1`}
        title="The token was not saved"
        description="Nothing changed."
      />,
    );
    expect(out).toContain('<a href="#f-mode-1">Choose a mode</a>');
    expect(out).toContain('The token was not saved</h2><p>Nothing changed.</p>');
  });

  it('renders nothing without errors', () => {
    expect(html(<ErrorSummary errors={[]} />)).toBe('');
  });
});

describe('ConfirmDialog and ActionButton', () => {
  const base = {
    id: 'del-svc_1',
    trigger: 'Delete…',
    triggerContext: 'Slack',
    title: 'Delete Slack?',
    body: 'This cannot be undone.',
    affected: ['2 issuer access rules stop working'],
    confirmLabel: 'Delete Slack',
    danger: true,
  };

  it('standalone: a button trigger and a popover dialog posting its own form with confirm=1', () => {
    const out = html(
      <ConfirmDialog
        {...base}
        variant="standalone"
        action="/admin/credentials/svc_1/delete"
        csrf="csrf-token"
        fields={{ expected_updated_at: '5' }}
        returnTo="list"
      />,
    );
    expect(out).toContain(
      '<button class="btn danger" type="button" command="show-modal" commandfor="dlg-del-svc_1" popovertarget="dlg-del-svc_1">Delete…<span class="vh"> Slack</span></button>',
    );
    expect(out).toContain('<dialog class="dlg" id="dlg-del-svc_1"');
    expect(out).toContain('popover="auto"');
    const form =
      /<form method="post" action="\/admin\/credentials\/svc_1\/delete">(.*?)<\/form>/s.exec(
        out,
      )?.[1];
    for (const field of [
      'name="_csrf" value="csrf-token"',
      'name="_return" value="list"',
      'name="expected_updated_at" value="5"',
      'name="confirm" value="1"',
    ]) {
      expect(form).toContain(field);
    }
    expect(form).toContain('<li>2 issuer access rules stop working</li>');
    expect(form).toContain('<button class="btn danger-solid" type="submit">Delete Slack</button>');
  });

  it('submits: the confirm submits the named form, and the dialog nests no form', () => {
    const out = html(
      <ConfirmDialog
        {...base}
        danger={false}
        variant="submits"
        formId="role-usr_1"
        name="role"
        value="owner"
        formnovalidate
      />,
    );
    const dialog = /<dialog[\s\S]*<\/dialog>/.exec(out)?.[0] ?? '';
    expect(dialog).not.toContain('<form');
    expect(dialog).toContain(
      '<button class="btn primary" type="submit" name="role" value="owner" form="role-usr_1" formnovalidate="">Delete Slack</button>',
    );
    // The default confirm value is the one the server requires.
    const plain = html(<ConfirmDialog {...base} variant="submits" formId="f" />);
    expect(plain).toContain('name="confirm" value="1" form="f"');
  });

  it('posts one button with _csrf, _return and the fields, naming its row for screen readers', () => {
    const out = html(
      <ActionButton
        action="/admin/credentials/svc_1/toggle"
        csrf="csrf-token"
        label="Disable"
        context="Slack"
        size="sm"
        fields={{ enabled: '0' }}
        returnTo="list"
      />,
    );
    expect(out).toContain(
      '<form class="action-form" method="post" action="/admin/credentials/svc_1/toggle">',
    );
    expect(out).toContain(
      '<input type="hidden" name="_csrf" value="csrf-token"/><input type="hidden" name="_return" value="list"/><input type="hidden" name="enabled" value="0"/>',
    );
    expect(out).toContain(
      '<button class="btn sm secondary" type="submit">Disable<span class="vh"> Slack</span></button>',
    );
  });
});

describe('EmptyState', () => {
  it('titles the missing thing, a level 2 heading by default, with the text under it', () => {
    expect(html(<EmptyState>No credentials yet.</EmptyState>)).toContain(
      '<div class="empty"><h2>No credentials yet.</h2></div>',
    );
    const out = html(
      <EmptyState title="No credentials yet" headingLevel={3}>
        Add one to start.
      </EmptyState>,
    );
    expect(out).toContain('<h3>No credentials yet</h3>');
    expect(out).toContain('Add one to start.');
  });
});

describe('RepeatingRows', () => {
  const keys = ['method', 'path'] as const;
  const rows = (
    <form method="post" action="/x">
      <RepeatingRows
        group="rules"
        legend="Rules"
        keys={keys}
        rows={[{ method: 'GET', path: '/a' }]}
        render={(_i, row, prefix) => (
          <Field name={`${prefix}path`} label="Path" value={row.path} autocomplete="off" />
        )}
      />
      <button type="submit">Save</button>
      <AddRowsButton group="rules" />
    </form>
  );

  it('renders the existing rows plus 2 blank rows, each removable once saved', () => {
    const out = html(rows);
    expect(out.match(/class="row"/g)).toHaveLength(3);
    expect(out).toContain('name="rules.0.path"');
    expect(out).toContain('id="f-rules-2-path"');
    expect(tagWithId(out, 'input', 'f-rules-0-remove')).toContain('value="1"');
    expect(out).not.toContain('name="rules.1.remove"');
  });

  it('places "Add 2 more rows" after the primary submit, without browser validation', () => {
    const out = html(rows);
    const save = out.indexOf('<button type="submit">Save</button>');
    const add = out.indexOf(
      '<button class="btn ghost" type="submit" name="_action" value="add:rules" formnovalidate="">',
    );
    expect(save).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(save);
  });

  it('parses rows back, skipping removed and all-blank rows', () => {
    expect(
      parseRows(
        {
          'rules.0.method': 'GET',
          'rules.0.path': '/a',
          'rules.1.method': '',
          'rules.1.path': ' ',
          'rules.2.method': 'POST',
          'rules.2.path': '/b',
          'rules.2.remove': '1',
          'rules.10.method': 'PUT',
          'rules.10.path': '/c',
          'rules.01.path': '/leading-zero',
          'rules.999.path': '/too-far',
          'rules.3.other': 'x',
          'other.0.path': '/d',
        },
        'rules',
        keys,
      ),
    ).toEqual([
      { method: 'GET', path: '/a' },
      { method: 'PUT', path: '/c' },
    ]);
  });
});

describe('patterns', () => {
  it('every ID pattern compiles as browsers compile it (v flag, anchored)', () => {
    for (const pattern of Object.values(ID_PATTERNS)) {
      expect(() => new RegExp(`^(?:${pattern})$`, 'v')).not.toThrow();
    }
  });

  it.each([
    ['github_repo', 'acme/api (89012345)', true],
    ['github_repo', '89012345', true],
    ['github_repo', 'acme/api', false],
    ['github_owner_list', 'acme (1234567), acme-labs (7654321)', true],
    ['github_owner_list', 'acme', false],
    ['gitlab_project', 'acme-group/app (4567890)', true],
    ['gitlab_group_list', 'acme-group (5678901), acme-group/platform (5678902)', true],
  ] as const)('%s accepts %s: %s', (kind, value, ok) => {
    expect(new RegExp(`^(?:${ID_PATTERNS[kind]})$`, 'v').test(value)).toBe(ok);
  });

  it('every pattern the ID fields render compiles with the v flag', () => {
    const out = html(
      <>
        {(Object.keys(ID_PATTERNS) as Array<keyof typeof ID_PATTERNS>).map((kind) => (
          <IdWithLabelField
            name={kind}
            label={kind}
            kind={kind}
            findCommand="gh api repos/acme/api"
            autocomplete="off"
          />
        ))}
      </>,
    );
    const rendered = [...out.matchAll(/pattern="([^"]*)"/g)].map((m) =>
      (m[1] as string).replaceAll('&amp;', '&').replaceAll('&quot;', '"'),
    );
    expect(rendered).toHaveLength(4);
    for (const pattern of rendered) {
      expect(() => new RegExp(`^(?:${pattern})$`, 'v')).not.toThrow();
    }
  });
});

describe('status, time, notices, navigation', () => {
  it('renders every status of the vocabulary as a badge with a hidden glyph and its word', () => {
    expect(html(<StatusBadge status="active" />)).toBe(
      '<span class="badge ok"><span aria-hidden="true">✓</span>Active</span>',
    );
    expect(html(<StatusBadge status="expiring" detail="1" />)).toContain('Expires in 1 day</span>');
    // The admin's gray tone is the ui `off` tone; a status without a glyph renders no glyph span.
    expect(html(<StatusBadge status="unused" />)).toBe(
      '<span class="badge off">Unused 30+ days</span>',
    );
    for (const key of Object.keys(STATUS) as StatusKey[]) {
      const out = html(<StatusBadge status={key} detail="2" />);
      expect(out, key).toMatch(/^<span class="badge(?: (?:ok|warn|bad|off))?">/);
    }
  });

  it('writes times in UTC with the exact ISO value, or relative to now', () => {
    const ms = Date.UTC(2026, 9, 13, 15, 0, 1, 250);
    expect(html(<Time ms={ms} />)).toBe(
      '<time datetime="2026-10-13T15:00:01.250Z">13 Oct 2026, 15:00</time>',
    );
    expect(html(<Time ms={ms} relative now={ms + 3 * 3_600_000} />)).toBe(
      '<time datetime="2026-10-13T15:00:01.250Z">3 h ago</time>',
    );
  });

  it('renders a notice as a focused status callout with its next link and Undo form', () => {
    const notice = {
      text: 'Made lena@acme.dev Admin.',
      more: 'It applies on their next request.',
      next: { href: '/admin/users', label: 'Back to People' },
      undo: {
        action: '/admin/users/usr_1',
        fields: { role: 'viewer', expected_updated_at: '7' },
        label: 'Undo',
        srSuffix: ': make lena@acme.dev Viewer again',
      },
    };
    const out = html(<NoticeView notice={notice} csrf="csrf-token" />);
    expect(out).toContain(
      '<div class="callout ok notice" role="status" tabindex="-1" autofocus="">',
    );
    expect(out).toContain(
      '<p><b>Made lena@acme.dev Admin.</b></p><p class="more">It applies on their next request.</p>',
    );
    expect(out).toContain('<a class="btn sm secondary" href="/admin/users">Back to People</a>');
    const form =
      /<form class="action-form" method="post" action="\/admin\/users\/usr_1">(.*?)<\/form>/s.exec(
        out,
      )?.[1];
    expect(form).toContain('name="_csrf" value="csrf-token"');
    expect(form).toContain('name="expected_updated_at" value="7"');
    expect(form).toContain('Undo<span class="vh">: make lena@acme.dev Viewer again</span>');
    // An ErrorSummary takes the focus when there are errors.
    const quiet = html(<NoticeView notice={{ text: 'Saved.' }} csrf="c" autofocus={false} />);
    expect(quiet).not.toContain('autofocus');
    expect(quiet).not.toContain('tabindex');
  });

  it('marks the current tab, as the page or as an ancestor', () => {
    const items = [
      { key: 'a', href: '/a', label: 'A', count: 2 },
      { key: 'b', href: '/b', label: 'B' },
    ];
    const page = html(<Tabs label="Views" items={items} current="a" />);
    expect(page).toContain('<nav class="tabs" aria-label="Views">');
    expect(page).toContain('<a href="/a" aria-current="page">A <span class="n">2</span></a>');
    expect(page).toContain('<a href="/b">B</a>');
    expect(html(<Tabs label="Views" items={items} current="b" currentState="true" />)).toContain(
      '<a href="/b" aria-current="true">B</a>',
    );
  });

  it('pages a log with newest, newer and older links, and renders nothing without any', () => {
    expect(html(<Pager />)).toBe('');
    const out = html(<Pager newest="/l" newer="/l?after=x" />);
    expect(out).toContain('<a class="btn sm secondary" href="/l">Newest entries</a>');
    expect(out).toContain('rel="prev"');
    expect(out).toContain('Newer entries');
    expect(out).not.toContain('rel="next"');
  });

  it('speaks a relationship chip as one sentence and hides its visible name and glyph', () => {
    const out = html(
      <Chip href="/a/1" text="acme/api" status="active" srText="acme/api can use Slack: Active." />,
    );
    expect(out).toContain('href="/a/1"');
    expect(out).toContain(
      '<span aria-hidden="true">acme/api</span><span class="vh">acme/api can use Slack: Active.</span>',
    );
  });

  it('adds a "Learn more" docs link that names its topic', () => {
    expect(html(<LearnMore path="concepts.md#credential" about="credentials" />)).toBe(
      ' <a href="https://github.com/2fd/cloudflare-tokengate/blob/main/docs/concepts.md#credential">Learn more<span class="vh"> about credentials (GitHub docs)</span></a>',
    );
  });
});

describe('AskSomeone', () => {
  it('says who can do it, names at most the askers in bold and counts the rest', () => {
    const out = html(
      <AskSomeone
        permission="tokens:write"
        verb="add a credential"
        ctx={view({ 'tokens:write': ['tm@example.com', 'owner@example.com'] }, 2)}
      />,
    );
    expect(out).toBe(
      '<p class="ask">Only credential managers can add a credential. Ask <b>tm@example.com</b> or <b>owner@example.com</b> and 2 more. <a href="mailto:tm@example.com,owner@example.com">Email them</a></p>',
    );
  });

  it('asks an owner when nobody holds the permission, and can leave out the lead', () => {
    expect(html(<AskSomeone permission="settings:write" ctx={view()} />)).toBe(
      '<p class="ask">Only owners can make this change. Ask an owner.</p>',
    );
    const bare = html(
      <AskSomeone
        permission="access:write"
        lead={false}
        subject="Access to Slack"
        ctx={view({ 'access:write': ['am@example.com'] })}
      />,
    );
    expect(bare).not.toContain('Only');
    expect(bare).toContain('Ask <b>am@example.com</b>.');
    expect(bare).toContain('href="mailto:am@example.com?subject=Access%20to%20Slack"');
  });
});

describe('NotFound', () => {
  it('links the four sections in sidebar order as link cards and never echoes anything', () => {
    const out = html(<NotFound />);
    const links = [...out.matchAll(/<a class="tcard" href="([^"]+)">/g)].map((m) => m[1]);
    expect(links).toEqual([
      '/admin',
      '/admin/credentials',
      '/admin/credential-access-rules',
      '/admin/users',
    ]);
    expect(out).toContain('<h2 id="nf-sections-h">Go to a section</h2>');
    expect(out).toContain(
      '<a class="tcard" href="/admin/credentials"><span class="t">Credentials</span><span class="d">Tokens, allowed hosts and encryption keys</span>',
    );
    // No bare user-agent list: the cards are a plain list.
    expect(out).not.toMatch(/<ul>/);
    expect(notFoundText('token')).toBe(
      'There is no credential with this ID. It may have been deleted.',
    );
  });

  it('shows a hint as a callout of phrasing content, and moved links as a titled tray', () => {
    const out = html(
      <NotFound
        hint={{ title: 'Records are kept 7 days.', text: 'See Data retention.' }}
        links={{
          title: 'Where each setting is now',
          items: [{ href: '/admin/retention', title: 'Data retention', description: 'Retention' }],
        }}
      />,
    );
    expect(out).toContain('<p><b>Records are kept 7 days.</b> See Data retention.</p>');
    expect(out).toContain('<h2 id="nf-moved-h">Where each setting is now</h2>');
    expect(out).toContain(
      '<a class="tcard" href="/admin/retention"><span class="t">Data retention</span><span class="d">Retention</span>',
    );
    // The moved links come before the sections.
    expect(out.indexOf('nf-moved-h')).toBeLessThan(out.indexOf('nf-sections-h'));
    // Block content never sits inside the callout paragraph.
    expect(out).not.toMatch(/<p>(?:(?!<\/p>)[\s\S])*<(?:ul|div|p)[ >]/);
  });
});
