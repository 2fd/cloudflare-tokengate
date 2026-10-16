import { describe, expect, it } from 'vitest';
import { ConfirmDialog, Dialog, DialogClose, DialogTrigger } from '../../src';
import { render } from '../render';

describe('DialogTrigger', () => {
  it('opens the dialog as a modal, with the popover fallback, and never submits', () => {
    expect(
      render(
        <DialogTrigger dialog="dlg-del" variant="danger">
          Delete Slack…
        </DialogTrigger>,
      ),
    ).toBe(
      '<button class="btn danger" type="button" commandfor="dlg-del" command="show-modal" popovertarget="dlg-del">Delete Slack…</button>',
    );
  });

  it('defaults to secondary and takes size and classes', () => {
    expect(
      render(
        <DialogTrigger dialog="d" size="sm" class="x">
          Edit…
        </DialogTrigger>,
      ),
    ).toContain('class="btn secondary sm x"');
  });
});

describe('DialogClose', () => {
  it('closes without submitting', () => {
    expect(render(<DialogClose dialog="d" />)).toBe(
      '<button class="btn secondary" type="button" commandfor="d" command="close" popovertarget="d" popovertargetaction="hide">Cancel</button>',
    );
  });
});

describe('Dialog', () => {
  it('is labelled by its title and described by its description', () => {
    const html = render(
      <Dialog
        id="dlg-rename"
        title="Rename Slack"
        description="Lists show the new name."
        action="/r"
        footer="f"
        wide
        class="x"
      >
        body
      </Dialog>,
    );
    expect(html).toBe(
      '<dialog class="dlg wide x" id="dlg-rename" aria-labelledby="dlg-rename-h" aria-describedby="dlg-rename-d" popover="auto"><form method="post" action="/r"><div class="dlg-h"><h2 id="dlg-rename-h">Rename Slack</h2><p id="dlg-rename-d">Lists show the new name.</p></div><div class="dlg-b">body</div><div class="dlg-f">f</div></form></dialog>',
    );
  });

  it('drops the body and description when empty, and supports GET', () => {
    const html = render(<Dialog id="d" title="T" footer="f" method="get" />);
    expect(html).not.toContain('dlg-b');
    expect(html).not.toContain('aria-describedby');
    expect(html).toContain('<form method="get">');
  });

  it('renders open in the page flow without the popover attribute', () => {
    const html = render(<Dialog id="d" title="T" footer="f" open />);
    expect(html).toMatch(/^<dialog class="dlg" id="d" aria-labelledby="d-h" open="">/);
    expect(html).not.toContain('popover=');
  });

  it('puts hidden fields first in the form', () => {
    expect(
      render(
        <Dialog id="d" title="T" footer="f" fields={<input type="hidden" name="a" value="1" />} />,
      ),
    ).toContain('<form method="post"><input type="hidden" name="a" value="1"/><div class="dlg-h">');
  });
});

describe('ConfirmDialog', () => {
  const html = render(
    <ConfirmDialog
      id="dlg-del"
      title="Delete Slack and its 3 consumer accesses?"
      description="This cannot be undone."
      action="/admin/tokens/svc_1/delete"
      confirmLabel="Delete Slack"
      consequences={['The secret is erased.', '3 consumer accesses are deleted.']}
      affected={['acme/api · environment production']}
      confirmText={{
        value: 'slack',
        hint: 'The slug of this token, in lower case.',
        name: 'confirm_slug',
      }}
      fields={<input type="hidden" name="confirm" value="1" />}
    >
      <p>extra</p>
    </ConfirmDialog>,
  );

  it('lists the consequences and the affected objects', () => {
    expect(html).toContain(
      '<div class="dlg-b"><ul class="conseq"><li>The secret is erased.</li><li>3 consumer accesses are deleted.</li></ul><ul class="dlg-list"><li>acme/api · environment production</li></ul><p>extra</p>',
    );
  });

  it('wires the type-to-confirm field', () => {
    expect(html).toContain(
      '<label for="dlg-del-confirm">Type <code>slack</code> to confirm</label>',
    );
    expect(html).toContain(
      '<span class="hint" id="dlg-del-confirm-hint">The slug of this token, in lower case.</span>',
    );
    expect(html).toContain(
      '<input class="input mono" type="text" id="dlg-del-confirm" name="confirm_slug" required="" pattern="slack" autocomplete="off" spellcheck="false" autocapitalize="none" aria-describedby="dlg-del-confirm-hint" autofocus=""/>',
    );
  });

  it('ends with Cancel, then the solid danger confirm', () => {
    expect(html).toContain(
      '<div class="dlg-f"><button class="btn secondary" type="button" commandfor="dlg-del" command="close" popovertarget="dlg-del" popovertargetaction="hide">Cancel</button><button class="btn danger-solid" type="submit">Delete Slack</button></div>',
    );
  });

  it('matches the confirm text literally', () => {
    const out = render(
      <ConfirmDialog
        id="d"
        title="T"
        action="/x"
        confirmLabel="Go"
        confirmText={{ value: 'acme/api (1.2)' }}
      />,
    );
    expect(out).toContain('pattern="acme\\/api \\(1\\.2\\)"');
    expect(new RegExp('^(?:acme\\/api \\(1\\.2\\))$', 'v').test('acme/api (1.2)')).toBe(true);
  });

  it('has no body when there is nothing to list, and a primary tone', () => {
    const out = render(
      <ConfirmDialog
        id="d"
        title="Approve?"
        action="/x"
        confirmLabel="Approve"
        tone="primary"
        cancelLabel="Not now"
      />,
    );
    expect(out).not.toContain('dlg-b');
    expect(out).toContain('<button class="btn primary" type="submit">Approve</button>');
    expect(out).toContain('>Not now</button>');
  });

  it('uses a Cancel link when rendered open on a page', () => {
    const out = render(
      <ConfirmDialog
        id="d"
        title="T"
        action="/x"
        confirmLabel="Go"
        open
        cancelHref="/admin/tokens/slack"
      />,
    );
    expect(out).toContain('open=""');
    expect(out).toContain('<a class="btn secondary" href="/admin/tokens/slack">Cancel</a>');
  });

  it('escapes the title and the confirm text', () => {
    const out = render(
      <ConfirmDialog
        id="d"
        title="<b>"
        action="/x"
        confirmLabel="Go"
        confirmText={{ value: '"x"' }}
      />,
    );
    expect(out).toContain('<h2 id="d-h">&lt;b&gt;</h2>');
    expect(out).toContain('pattern="&quot;x&quot;"');
  });
});

describe('ConfirmDialog focus', () => {
  it('focuses Cancel when there is no confirm field, never the destructive button', () => {
    const out = render(<ConfirmDialog id="d" title="T" action="/x" confirmLabel="Remove" />);
    expect(out).toContain('popovertargetaction="hide" autofocus="">Cancel</button>');
    expect(out).not.toMatch(/danger-solid"[^>]*autofocus/);
  });

  it('focuses the confirm field, and nothing when drawn open in the page', () => {
    const withField = render(
      <ConfirmDialog id="d" title="T" action="/x" confirmLabel="Go" confirmText={{ value: 'x' }} />,
    );
    expect(withField.match(/autofocus/g)).toHaveLength(1);
    expect(withField).toMatch(/<input[^>]*autofocus=""/);
    const open = render(
      <ConfirmDialog
        id="d"
        title="T"
        action="/x"
        confirmLabel="Go"
        open
        confirmText={{ value: 'x' }}
      />,
    );
    expect(open).not.toContain('autofocus');
  });
});
