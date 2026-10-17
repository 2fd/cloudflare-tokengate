import { describe, expect, it } from 'vitest';
import { NeedsAttention } from '../../src';
import { render } from '../render';

describe('NeedsAttention', () => {
  const html = render(
    <NeedsAttention
      items={[
        {
          level: 'warn',
          title: 'The secret of OpenAI expires on 21 Oct 2026 (in 6 days).',
          body: 'Its 1 consumer access stops working then.',
          actions: (
            <a class="btn sm secondary" href="/admin/tokens/openai/secret">
              Replace secret
            </a>
          ),
        },
        {
          level: 'warn',
          title: '1 person needs a decision.',
          body: (
            <>
              <b>Sam Ito</b> · sam@acme.dev · signed in first 25 min ago. Approve as:
            </>
          ),
          approve: {
            action: '/admin/users/usr_sam/decide',
            subject: 'sam@acme.dev',
            hidden: { csrf: 'c5rf"<' },
            roles: [
              { value: 'viewer', label: 'Viewer' },
              { value: 'token_manager', label: 'Token manager' },
            ],
            more: { href: '/admin/users/usr_sam', label: 'Owner or reject…' },
          },
        },
        { level: 'info', title: 'Only one active owner.' },
        { level: 'bad', levelLabel: 'Keyring', title: 'The keyring is unavailable.' },
      ]}
    />,
  );

  it('defaults to the 4-column card row', () => {
    expect(html.startsWith('<ul class="att cols"><li>')).toBe(true);
  });

  it('shows the level as a word with a hidden glyph', () => {
    expect(html).toContain(
      '<span class="att-lvl warn"><span class="g" aria-hidden="true">!</span>Warning</span>',
    );
    expect(html).toContain(
      '<span class="att-lvl info"><span class="g" aria-hidden="true">i</span>Note</span>',
    );
    expect(html).toContain(
      '<span class="att-lvl bad"><span class="g" aria-hidden="true">✕</span>Keyring</span>',
    );
  });

  it('renders title, body and the inline fix', () => {
    expect(html).toContain(
      '<p class="att-t">The secret of OpenAI expires on 21 Oct 2026 (in 6 days).</p><p class="att-b">Its 1 consumer access stops working then.</p><div class="att-a"><a class="btn sm secondary" href="/admin/tokens/openai/secret">Replace secret</a></div>',
    );
    expect(html).toContain('<p class="att-t">Only one active owner.</p></li>');
  });

  it('approves inline: one submit per role, named with the subject, hidden fields escaped', () => {
    expect(html).toContain(
      '<form class="att-a roles" method="post" action="/admin/users/usr_sam/decide"><input type="hidden" name="csrf" value="c5rf&quot;&lt;"/>',
    );
    expect(html).toContain(
      '<button class="btn sm secondary" type="submit" name="role" value="viewer"><span class="vh">Approve sam@acme.dev as </span>Viewer</button>',
    );
    expect(html).toContain(
      'value="token_manager"><span class="vh">Approve sam@acme.dev as </span>Token manager</button>',
    );
    expect(html).toContain(
      '<a class="linkish" href="/admin/users/usr_sam">Owner or reject…</a></form>',
    );
  });

  it('has a stacked list layout, a custom field name and a class', () => {
    const list = render(
      <NeedsAttention
        layout="list"
        class="x"
        items={[
          {
            level: 'warn',
            title: 't',
            approve: {
              action: '/a',
              subject: 's',
              name: 'grant',
              roles: [{ value: 'v', label: 'V' }],
            },
          },
        ]}
      />,
    );
    expect(list.startsWith('<ul class="att x">')).toBe(true);
    expect(list).toContain('name="grant" value="v"');
    expect(list).not.toContain('linkish');
    expect(list).not.toContain(' id=');
  });

  it('puts the form id on the approve form in both layouts and keeps actions after it', () => {
    const approve = {
      action: '/a',
      subject: 's',
      id: 'ap-sam',
      roles: [{ value: 'v', label: 'V' }],
    };
    const grid = render(
      <NeedsAttention
        items={[
          {
            level: 'warn',
            title: 't',
            approve,
            actions: <button class="btn sm ghost">Dismiss</button>,
          },
        ]}
      />,
    );
    expect(grid).toContain('<form id="ap-sam" class="att-a roles" method="post" action="/a">');
    expect(grid).toContain(
      'V</button></form><div class="att-a"><button class="btn sm ghost">Dismiss</button></div></li>',
    );
    const legend = render(
      <NeedsAttention
        layout="list"
        items={[
          {
            who: { id: 'w1', avatar: null, name: 'sam@acme.dev' },
            approve: { ...approve, legend: 'Approve as' },
            actions: <p class="err">Pick a role.</p>,
          },
        ]}
      />,
    );
    expect(legend).toContain('<div class="att-a"><form id="ap-sam" method="post" action="/a">');
    expect(legend).toContain(
      '</fieldset></form></div><div class="att-a"><p class="err">Pick a role.</p></div></li>',
    );
  });
});
