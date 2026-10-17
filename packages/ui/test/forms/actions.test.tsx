// ActionForm, ActionCards, FieldGrid and the secret Input: one-click POST forms and their parts.
import { describe, expect, it } from 'vitest';
import { ActionCards, ActionForm, FieldGrid, Input } from '../../src';
import { render } from '../render';

describe('ActionForm', () => {
  it('posts one button with the hidden fields first', () => {
    expect(
      render(
        <ActionForm
          action="/admin/access/a1/disable"
          hidden={{ _csrf: 'tok', id: 'a1' }}
          size="sm"
          srSuffix="acme/api → Slack"
        >
          Disable
        </ActionForm>,
      ),
    ).toBe(
      '<form class="action-form" method="post" action="/admin/access/a1/disable"><input type="hidden" name="_csrf" value="tok"/><input type="hidden" name="id" value="a1"/><button class="btn sm secondary" type="submit">Disable<span class="vh"> acme/api → Slack</span></button></form>',
    );
  });

  it('takes the variant, name and value of the button, and classes for both', () => {
    const html = render(
      <ActionForm
        action="/x"
        variant="danger"
        name="decision"
        value="reject"
        class="f"
        buttonClass="b"
      >
        Reject
      </ActionForm>,
    );
    expect(html).toContain('<form class="action-form f" method="post" action="/x">');
    expect(html).toContain(
      '<button class="btn danger b" type="submit" name="decision" value="reject">',
    );
  });
});

describe('ActionCards', () => {
  const html = render(
    <ActionCards
      name="join_policy"
      go="Save →"
      columns={1}
      labelledBy="p-h"
      cards={[
        { value: 'closed', title: 'Only invited people', description: 'Anyone else is refused.' },
        { value: 'ask', title: 'Ask an owner first', current: true },
        {
          value: 'tm',
          title: 'Let them in as Token manager…',
          risk: true,
          dialog: 'dlg-tm',
          go: 'Confirm next →',
        },
        {
          value: 'viewer',
          title: 'Viewer',
          srPrefix: 'Invite as',
          footnote: <span class="badge">Reads only</span>,
        },
      ]}
    />,
  );

  it('is a labelled group of cards', () => {
    expect(html).toMatch(/^<div class="rcs c1" role="group" aria-labelledby="p-h">/);
  });

  it('submits name=value with one click', () => {
    expect(html).toContain(
      '<button class="rc" type="submit" name="join_policy" value="closed"><span class="rc-b"><span class="rc-t">Only invited people<span class="rc-go" aria-hidden="true">Save →</span></span><span class="rc-d">Anyone else is refused.</span></span></button>',
    );
  });

  it('marks the current value as a plain card', () => {
    expect(html).toContain(
      '<div class="rc is-current" aria-current="true"><span class="rc-b"><span class="rc-t">Ask an owner first <span class="badge accent"><span aria-hidden="true">✓</span>Current</span></span></span></div>',
    );
  });

  it('opens the confirm dialog of a risky card instead of submitting', () => {
    expect(html).toContain(
      '<button class="rc risk" type="button" command="show-modal" commandfor="dlg-tm" popovertarget="dlg-tm">',
    );
    expect(html).toContain('<span class="risktag"><span aria-hidden="true">⚠</span>Risk</span>');
  });

  it('reads the prefix and shows the footnote', () => {
    expect(html).toContain('<span class="vh">Invite as </span>Viewer');
    expect(html).toContain('<span class="rc-q"><span class="badge">Reads only</span></span>');
  });
});

describe('FieldGrid', () => {
  it('puts short fields in one row', () => {
    expect(render(<FieldGrid class="x">f</FieldGrid>)).toBe('<div class="fgrid x">f</div>');
  });
});

describe('Input secret', () => {
  it('never renders a value, even one passed in at runtime', () => {
    const props = { id: 'c', secret: true, value: 'xoxp-123' } as unknown as Parameters<
      typeof Input
    >[0];
    const html = render(<Input {...props} />);
    expect(html).toContain('type="password"');
    expect(html).not.toContain('xoxp-123');
    expect(html).not.toContain('value=');
  });
});
