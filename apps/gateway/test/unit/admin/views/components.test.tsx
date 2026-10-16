// Markup contracts of the shared admin components (A8): labels and ids, aria-describedby with only
// rendered ids, native validation only on always-visible controls, the dialog fallbacks, tables in
// labelled regions, repeating rows, and patterns that compile the way browsers compile them.
import type { Child } from 'hono/jsx';
import { describe, expect, it } from 'vitest';
import type { Permission } from '../../../../src/admin/auth/rbac';
import { parseRows, type ViewContext } from '../../../../src/admin/render';
import {
  AlertList,
  ApproveForm,
  AskSomeone,
  CheckboxGroup,
  Choice,
  ConfirmDialog,
  DataTable,
  ErrorSummary,
  Field,
  fieldId,
  ID_PATTERNS,
  IdWithLabelField,
  NoticeView,
  RadioCards,
  Select,
  StatusBadge,
  SubmitButtons,
  Tabs,
  TextArea,
} from '../../../../src/admin/views/components';
import { AddRowsButton, RepeatingRows } from '../../../../src/admin/views/rows';

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
  };
}

describe('Field', () => {
  it('links the label, hint and error to the input by id', () => {
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
    expect(out).toContain('<p class="hint" id="f-base_url-hint">The API root.</p>');
    expect(out).toContain(
      '<p class="field-error" id="f-base_url-error"><span class="vh">Error:</span> Enter a host like api.slack.com</p>',
    );
    const input = tagWithId(out, 'input', 'f-base_url');
    expect(input).toContain('aria-describedby="f-base_url-hint f-base_url-error"');
    expect(input).toContain('aria-invalid="true"');
    expect(out).toContain('<div class="field" data-invalid="true">');
  });

  it('describes the input only by ids that are rendered', () => {
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
    expect(out).toContain(
      '<datalist id="f-rules-0-path-list"><option value="/a">/a</option><option value="/b">B</option></datalist>',
    );
    expect(out).toContain('<span class="optional"> (optional)</span>');
  });

  it('has no autocomplete default: the prop is required by its type', () => {
    // @ts-expect-error autocomplete is a required prop
    const out = html(<Field name="x" label="X" />);
    expect(tagWithId(out, 'input', 'f-x')).not.toContain('autocomplete');
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

  it('keeps password managers and autofill away from secret inputs (A7.8)', () => {
    const input = tagWithId(
      html(<Field name="credential" label="Secret" type="password" autocomplete="new-password" />),
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
  });
});

describe('Select and Choice', () => {
  const options = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));

  it('renders an empty first option for a required select without a value', () => {
    const out = html(
      <Select
        name="token"
        label="Token"
        options={options(2)}
        placeholder="Choose a token"
        required
      />,
    );
    expect(out).toContain('<option value="" selected="">Choose a token</option>');
    expect(tagWithId(out, 'select', 'f-token')).toContain('required');
    expect(out).toContain('<label for="f-token">Token</label>');
  });

  it('marks the chosen option and supports groups', () => {
    const out = html(
      <Select
        name="t"
        label="T"
        value="b"
        options={[
          {
            group: 'G',
            options: [
              { value: 'a', label: 'A' },
              { value: 'b', label: 'B' },
            ],
          },
        ]}
      />,
    );
    expect(out).toContain(
      '<optgroup label="G"><option value="a">A</option><option value="b" selected="">B</option></optgroup>',
    );
  });

  it('renders one option as fixed text and a hidden input', () => {
    const out = html(<Choice name="type" label="Type" options={options(1)} />);
    expect(out).toContain('<input type="hidden" name="type" value="v0"/>');
    expect(out).toContain('Option 0');
    expect(out).not.toContain('<select');
    expect(out).not.toContain('type="radio"');
  });

  it('renders the hint and error of a one-option choice at the field', () => {
    const out = html(
      <Choice
        name="type"
        label="Type"
        options={options(1)}
        hint="Fixed by the template."
        error="Choose a type"
      />,
    );
    expect(out).toContain('<div class="field" data-invalid="true">');
    expect(out).toContain('<p class="hint" id="f-type-hint">Fixed by the template.</p>');
    expect(out).toContain(
      '<p class="field-error" id="f-type-error"><span class="vh">Error:</span> Choose a type</p>',
    );
  });

  it('renders 2 to 6 options as radio cards and 7 or more as a select', () => {
    for (const n of [2, 6]) {
      const out = html(<Choice name="type" label="Type" options={options(n)} />);
      expect(out.match(/type="radio"/g)).toHaveLength(n);
      expect(out).toContain('<legend>Type</legend>');
    }
    const seven = html(<Choice name="type" label="Type" options={options(7)} />);
    expect(seven).toContain('<select');
    expect(seven).not.toContain('type="radio"');
  });

  it('puts the group error on the fieldset and links it from the first radio', () => {
    const out = html(
      <RadioCards
        name="mode"
        legend="Mode"
        error="Choose a mode"
        options={[
          { value: 'a', title: 'A', description: 'First' },
          { value: 'b', title: 'B', risk: 'Any branch can use it.', reveal: <p>more</p> },
        ]}
      />,
    );
    expect(out).toContain('<fieldset class="cards" data-invalid="true">');
    const first = tagWithId(out, 'input', 'f-mode');
    expect(first).toContain('aria-describedby="f-mode-desc f-mode-error"');
    expect(tagWithId(out, 'input', 'f-mode-1')).toContain('aria-describedby="f-mode-1-desc"');
    expect(out).toContain('<strong>Risk:</strong> Any branch can use it.');
    expect(out).toContain('<div class="reveal"><p>more</p></div>');
  });
});

describe('CheckboxGroup and SubmitButtons', () => {
  it('marks the first checkbox of a group with an error as invalid', () => {
    const out = html(
      <CheckboxGroup
        name="events"
        legend="Events"
        error="Choose at least one event"
        options={[
          { value: 'push', label: 'push' },
          { value: 'tag', label: 'tag' },
        ]}
      />,
    );
    const first = tagWithId(out, 'input', 'f-events');
    expect(first).toContain('aria-invalid="true"');
    expect(first).toContain('aria-describedby="f-events-error"');
    expect(tagWithId(out, 'input', 'f-events-1')).not.toContain('aria-invalid');
  });

  it('marks the current option visibly, not only for screen readers', () => {
    const out = html(
      <SubmitButtons
        name="join_policy"
        legend="Who can join"
        options={[
          { value: 'pending', label: 'Ask an owner first', current: true },
          { value: 'closed', label: 'Only invited people' },
        ]}
      />,
    );
    expect(out).toContain('<span class="badge">Current</span>');
    expect(out.match(/Current/g)).toHaveLength(1);
    expect(out).not.toContain('class="vh"> (current)');
  });

  it('accepts only submits dialogs: a standalone one would nest a form in the surrounding form', () => {
    const options: Parameters<typeof SubmitButtons>[0]['options'] = [
      {
        value: 'owner',
        label: 'Owner',
        confirm: {
          id: 'o',
          trigger: 'Owner…',
          title: 'Owner?',
          body: 'b',
          confirmLabel: 'Yes',
          // @ts-expect-error the standalone variant renders its own <form>
          variant: 'standalone',
          action: '/a',
          csrf: 't',
        },
      },
    ];
    expect(options).toHaveLength(1);
  });
});

describe('ErrorSummary', () => {
  it('is focused on load and links field errors to their controls', () => {
    const out = html(
      <ErrorSummary
        errors={[
          { field: 'rules.0.path', message: 'Enter a path' },
          { field: null, message: 'Someone else changed this token.' },
        ]}
      />,
    );
    // role=group: ARIA does not let a plain div be named by aria-labelledby.
    expect(out).toContain(
      '<div class="error-summary" role="group" tabindex="-1" autofocus="" aria-labelledby="es-h">',
    );
    expect(out).toContain('<h2 id="es-h">There is a problem</h2>');
    expect(out).toContain('<li><a href="#f-rules-0-path">Enter a path</a></li>');
    expect(out).toContain('<li>Someone else changed this token.</li>');
    expect(out).not.toContain('role="alert"');
  });

  it('renders nothing without errors', () => {
    expect(html(<ErrorSummary errors={[]} />)).toBe('');
  });
});

describe('ConfirmDialog', () => {
  it('standalone: a button trigger, a popover dialog and its own form with confirm=1', () => {
    const out = html(
      <ConfirmDialog
        id="delete-svc"
        trigger="Delete…"
        triggerContext="Slack bot"
        title="Delete Slack bot?"
        body="Requests to it fail at once."
        confirmLabel="Delete Slack bot"
        danger
        variant="standalone"
        action="/admin/tokens/svc_1/delete"
        csrf="tok"
        fields={{ expected_updated_at: '5' }}
      />,
    );
    expect(out).toContain(
      '<button type="button" class="confirm-trigger danger" commandfor="dlg-delete-svc" command="show-modal" popovertarget="dlg-delete-svc">Delete…<span class="vh"> Slack bot</span></button>',
    );
    expect(out).toMatch(
      /<dialog id="dlg-delete-svc" class="confirm" popover="auto" aria-labelledby="dlg-delete-svc-h">/,
    );
    const form =
      /<form method="post" action="\/admin\/tokens\/svc_1\/delete"[^>]*>(.*?)<\/form>/s.exec(
        out,
      )?.[1];
    expect(form).toContain('name="_csrf" value="tok"');
    expect(form).toContain('<input type="hidden" name="confirm" value="1"/>');
    expect(form).toContain('name="expected_updated_at" value="5"');
    expect(out).toContain(
      'commandfor="dlg-delete-svc" command="close" popovertarget="dlg-delete-svc" popovertargetaction="hide" autofocus="">Cancel</button>',
    );
  });

  it('submits: the confirm submits the named form and nests no form', () => {
    const out = html(
      <ConfirmDialog
        id="invite-owner"
        trigger="Owner…"
        title="Invite as owner?"
        body="Owners can change everything."
        confirmLabel="Invite as Owner"
        variant="submits"
        formId="invite-form"
        name="role"
        value="owner"
        formnovalidate
      />,
    );
    expect(out).not.toContain('<form');
    expect(out).toContain(
      '<button type="submit" form="invite-form" name="role" value="owner" formnovalidate=""',
    );
    const defaults = html(
      <ConfirmDialog
        id="x"
        trigger="T"
        title="T"
        body="B"
        confirmLabel="C"
        variant="submits"
        formId="f"
      />,
    );
    expect(defaults).toContain('name="confirm" value="1"');
  });
});

describe('DataTable', () => {
  it('renders a captioned table with column and row headers in a focusable region', () => {
    const out = html(
      <DataTable
        id="tokens"
        caption="Service tokens"
        columns={[
          { key: 'name', header: 'Name', render: (r: { name: string; n: number }) => r.name },
          { key: 'n', header: 'Requests', numeric: true, render: (r) => String(r.n) },
        ]}
        rowHeader="name"
        rows={[{ name: '<Slack>', n: 3 }]}
      />,
    );
    expect(out).toContain(
      '<div class="table-region" role="region" aria-labelledby="tokens-cap" tabindex="0">',
    );
    expect(out).toContain('<caption id="tokens-cap">Service tokens</caption>');
    expect(out).toContain('<th scope="col">Name</th><th scope="col" class="num">Requests</th>');
    expect(out).toContain('<th scope="row">&lt;Slack&gt;</th><td class="num">3</td>');
  });

  it('shows the empty state instead of an empty table', () => {
    const out = html(
      <DataTable
        id="t"
        caption="T"
        columns={[]}
        rowHeader="x"
        rows={[]}
        empty={<p>None yet.</p>}
      />,
    );
    expect(out).toBe('<p>None yet.</p>');
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
    expect(out).toContain('name="rules.0.remove"');
    expect(out).not.toContain('name="rules.1.remove"');
  });

  it('places "Add 2 more rows" after the primary submit', () => {
    const out = html(rows);
    const save = out.indexOf('<button type="submit">Save</button>');
    const add = out.indexOf(
      '<button type="submit" name="_action" value="add:rules" formnovalidate="" class="secondary">Add 2 more rows</button>',
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

  it('every pattern the shared components render compiles with the v flag', () => {
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
    expect(out).toContain('spellcheck="false"');
    expect(out).toContain('<code>gh api repos/acme/api</code>');
  });
});

describe('status, notices, tabs and AskSomeone', () => {
  it('renders a status badge with a hidden glyph and a text label', () => {
    expect(html(<StatusBadge status="active" />)).toBe(
      '<span class="badge ok"><span aria-hidden="true">✓ </span>Active</span>',
    );
    expect(html(<StatusBadge status="expiring" detail="6" />)).toContain('Expires in 6 days');
    expect(html(<StatusBadge status="inactive" detail="token disabled" />)).toContain(
      'Inactive: token disabled',
    );
    expect(html(<StatusBadge status="not_confirmed" />)).toBe(
      '<span class="badge bad">not confirmed</span>',
    );
  });

  it('renders a notice as a focused status region with its next link and undo form', () => {
    const out = html(
      <NoticeView
        csrf="tok"
        notice={{
          text: 'Disabled Slack bot.',
          next: { href: '/admin/tokens', label: 'All tokens' },
          undo: {
            action: '/admin/tokens/svc_1/toggle',
            fields: { enabled: '1' },
            label: 'Enable again',
          },
        }}
      />,
    );
    expect(out).toContain('<div class="notice" role="status" tabindex="-1" autofocus="">');
    expect(out).toContain('<a href="/admin/tokens">All tokens</a>');
    expect(out).toContain('name="_csrf" value="tok"');
    expect(out).toContain('name="enabled" value="1"');
    // A <form> start tag closes an open <p>, so the actions are a div.
    expect(out).toContain('<div class="actions"><a href="/admin/tokens">');
    expect(out).not.toMatch(/<p\b[^>]*>(?:(?!<\/p>).)*<form/s);
    expect(html(<NoticeView csrf="t" notice={{ text: 'x' }} autofocus={false} />)).not.toContain(
      'autofocus',
    );
  });

  it('marks the current tab, as the page or as an ancestor', () => {
    const items = [
      { key: 'tokens', href: '/admin/tokens', label: 'Tokens' },
      { key: 'hosts', href: '/admin/tokens/hosts', label: 'Allowed hosts' },
    ];
    const page = html(<Tabs label="Service tokens pages" items={items} current="hosts" />);
    expect(page).toContain('<nav aria-label="Service tokens pages" class="tabs">');
    expect(page).toContain('<a href="/admin/tokens/hosts" aria-current="page">');
    expect(page).not.toContain('<a href="/admin/tokens" aria-current');
    const below = html(<Tabs label="L" items={items} current="tokens" currentState="true" />);
    expect(below).toContain('<a href="/admin/tokens" aria-current="true">');
  });

  it('names who to ask, with mailto links and the remaining count', () => {
    const out = html(
      <AskSomeone
        permission="tokens:write"
        ctx={view({ 'tokens:write': ['tm@example.com', 'owner@example.com'] }, 2)}
      />,
    );
    expect(out).toBe(
      '<p class="ask">Ask a token manager: <a href="mailto:tm@example.com">tm@example.com</a>, <a href="mailto:owner@example.com">owner@example.com</a> and 2 more.</p>',
    );
    const owners = html(
      <AskSomeone
        permission="settings:write"
        ctx={view({ 'settings:write': ['a@x.test', 'b@x.test'] })}
      />,
    );
    expect(owners).toContain(
      'Ask an owner: <a href="mailto:a@x.test">a@x.test</a> or <a href="mailto:b@x.test">b@x.test</a>.',
    );
  });
});

describe('ApproveForm and AlertList', () => {
  const owner = { ...view(), role: 'owner' as const, can: () => true };

  it('approves with one submit per role, Owner behind a dialog placed after the form', () => {
    const out = html(
      <ApproveForm
        user={{ id: 'usr_1', email: 'alex@example.com', updated_at: 5 }}
        ctx={owner}
        returnTo="overview"
      />,
    );
    const form =
      /<form method="post" action="\/admin\/users\/usr_1\/approve" id="approve-usr_1">(.*?)<\/form>/s.exec(
        out,
      );
    expect(form?.[1]).toContain('name="_csrf" value="csrf-token"');
    expect(form?.[1]).toContain('<input type="hidden" name="_return" value="overview"/>');
    const roles = [...(form?.[1] ?? '').matchAll(/name="role" value="([a-z_]+)"/g)].map(
      (m) => m[1],
    );
    expect(roles).toEqual(['viewer', 'token_manager', 'access_manager', 'admin']);
    expect(form?.[1]).toContain('commandfor="dlg-approve-owner-usr_1"');
    expect(form?.[1]).not.toContain('<dialog');
    const dialog = out.indexOf('<dialog id="dlg-approve-owner-usr_1"');
    expect(dialog).toBeGreaterThan(out.indexOf('</form>'));
    expect(out).toContain('form="approve-usr_1" name="role" value="owner" formnovalidate=""');
    expect(out).toContain('action="/admin/users/usr_1/reject"');
    expect(out).toContain('Reject<span class="vh"> alex@example.com</span>');
  });

  it('shows fixes only to holders of the permission, otherwise who to ask', () => {
    const alerts = [
      {
        code: 'outside_hosts' as const,
        level: 'warning' as const,
        title: '1 token points at a host that Allowed hosts refuses: slack.',
        detail: '',
        objects: [{ href: '/admin/tokens?status=outside_hosts', label: 'slack' }],
        fix: {
          href: '/admin/tokens/hosts',
          label: 'Open allowed hosts',
          permission: 'settings:write' as const,
        },
      },
    ];
    const viewer = html(
      <AlertList alerts={alerts} ctx={view({ 'settings:write': ['owner@example.com'] })} />,
    );
    expect(viewer).toContain('<ul class="alerts"><li class="alert alert-warning">');
    expect(viewer).toContain('<strong>Warning:</strong>');
    expect(viewer).toContain('<a href="/admin/tokens?status=outside_hosts">slack</a>');
    expect(viewer).not.toContain('Open allowed hosts');
    expect(viewer).toContain('Ask an owner:');
    expect(viewer).not.toContain('role="alert"');
    expect(html(<AlertList alerts={alerts} ctx={owner} />)).toContain(
      '<a href="/admin/tokens/hosts">Open allowed hosts</a>',
    );
  });
});
