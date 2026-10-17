import { describe, expect, it } from 'vitest';
import { Button, ButtonRow, LinkAction } from '../../src';
import { render } from '../render';

describe('Button', () => {
  it('is a secondary type="button" by default', () => {
    expect(render(<Button>Test</Button>)).toBe(
      '<button class="btn secondary" type="button">Test</button>',
    );
  });

  it.each(['primary', 'secondary', 'ghost', 'danger', 'danger-solid'] as const)(
    'renders the %s variant',
    (variant) => {
      expect(render(<Button variant={variant}>x</Button>)).toBe(
        `<button class="btn ${variant}" type="button">x</button>`,
      );
    },
  );

  it('renders size, block and extra classes in order', () => {
    expect(
      render(
        <Button size="sm" variant="primary" block class="x">
          Give access
        </Button>,
      ),
    ).toBe('<button class="btn sm primary block x" type="button">Give access</button>');
  });

  it('submits with a name and value', () => {
    expect(
      render(
        <Button type="submit" name="role" value="viewer" size="sm">
          Viewer
        </Button>,
      ),
    ).toBe(
      '<button class="btn sm secondary" type="submit" name="role" value="viewer">Viewer</button>',
    );
  });

  it('opens a dialog with invoker commands, no JS', () => {
    expect(
      render(
        <Button variant="danger" command="show-modal" commandfor="dlg-del">
          Delete Slack…
        </Button>,
      ),
    ).toBe(
      '<button class="btn danger" type="button" command="show-modal" commandfor="dlg-del">Delete Slack…</button>',
    );
  });

  it('adds a hidden plus, an icon and a screen-reader suffix (the space is added)', () => {
    const html = render(
      <Button variant="primary" plus icon="token" srSuffix="to Slack">
        Give access
      </Button>,
    );
    expect(html).toBe(
      '<button class="btn primary" type="button"><span class="plus" aria-hidden="true">+</span><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"></circle><path d="M11 12l9-9M16 7l3 3"></path></svg>Give access<span class="vh"> to Slack</span></button>',
    );
  });

  it('is a link with href', () => {
    expect(
      render(
        <Button href="/admin/credentials/new" variant="primary" id="b" describedBy="h">
          Add credential
        </Button>,
      ),
    ).toBe(
      '<a class="btn primary" id="b" href="/admin/credentials/new" aria-describedby="h">Add credential</a>',
    );
  });

  it('disables a button with disabled and a link without href', () => {
    expect(render(<Button disabled>Save</Button>)).toBe(
      '<button class="btn secondary" type="button" disabled="">Save</button>',
    );
    expect(
      render(
        <Button href="/x" disabled>
          Open
        </Button>,
      ),
    ).toBe('<a class="btn secondary" aria-disabled="true">Open</a>');
  });

  it('escapes the label and attributes', () => {
    expect(
      render(
        <Button href={'/x?a="b"'} srSuffix="<i>">
          {'<b>'}
        </Button>,
      ),
    ).toBe(
      '<a class="btn secondary" href="/x?a=&quot;b&quot;">&lt;b&gt;<span class="vh"> &lt;i&gt;</span></a>',
    );
  });
});

describe('Button formnovalidate', () => {
  it('skips constraint validation on a secondary submit', () => {
    expect(
      render(
        <Button type="submit" name="_action" value="add:cond" formnovalidate>
          Add condition
        </Button>,
      ),
    ).toBe(
      '<button class="btn secondary" type="submit" name="_action" value="add:cond" formnovalidate="">Add condition</button>',
    );
  });

  it('is absent by default and when false', () => {
    expect(render(<Button type="submit">Save</Button>)).not.toContain('formnovalidate');
    expect(
      render(
        <Button type="submit" formnovalidate={false}>
          Save
        </Button>,
      ),
    ).not.toContain('formnovalidate');
  });

  it('is ignored on a link', () => {
    expect(
      render(
        <Button href="/x" formnovalidate>
          Open
        </Button>,
      ),
    ).toBe('<a class="btn secondary" href="/x">Open</a>');
  });
});

describe('ButtonRow', () => {
  it('takes an id', () => {
    expect(
      render(
        <ButtonRow id="invite-existing">
          <Button>Invite</Button>
        </ButtonRow>,
      ),
    ).toBe(
      '<div class="btn-row" id="invite-existing"><button class="btn secondary" type="button">Invite</button></div>',
    );
  });

  it('wraps buttons in .btn-row', () => {
    expect(
      render(
        <ButtonRow class="x">
          <Button variant="primary">Give access</Button>
        </ButtonRow>,
      ),
    ).toBe(
      '<div class="btn-row x"><button class="btn primary" type="button">Give access</button></div>',
    );
  });
});

describe('LinkAction', () => {
  it('renders .linkish with a hidden arrow and context', () => {
    expect(
      render(
        <LinkAction href="/admin/requests?outcome=denied" arrow srSuffix="requests">
          See denied
        </LinkAction>,
      ),
    ).toBe(
      '<a class="linkish" href="/admin/requests?outcome=denied">See denied<span class="vh"> requests</span><span aria-hidden="true"> →</span></a>',
    );
  });

  it('keeps extra classes', () => {
    expect(
      render(
        <LinkAction href="#" class="x">
          Owner or reject…
        </LinkAction>,
      ),
    ).toBe('<a class="linkish x" href="#">Owner or reject…</a>');
  });
});
