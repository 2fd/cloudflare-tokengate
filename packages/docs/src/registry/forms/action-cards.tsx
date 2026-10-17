import { ActionCards, Badge, ConfirmDialog } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

export const actionCards: ComponentDoc = {
  slug: 'action-cards',
  name: 'ActionCards',
  summary:
    'Radio-card looks on submit buttons: the click is the choice (“Invite as Viewer”). A risky card confirms in a dialog first; the current value is a plain card.',
  usage: {
    when: [
      'One decision with 2–6 options, each with a line of explanation, where nothing else is asked: invite as a role, the sign-in policy.',
      'A dialog body whose every option saves at once.',
    ],
    whenNot: [
      'A choice that is part of a larger form: RadioCards (radios, saved with the form).',
      'Navigation to a form page per type: LinkCards.',
    ],
  },
  examples: [
    {
      title: 'Invite as a role',
      description:
        'Each card submits the form with role=value. The hidden prefix reads “Invite as Viewer”; the footnote is a badge of what the role can do.',
      layout: 'stack',
      render: () => (
        <form method="post" action="#">
          <ActionCards
            name="role"
            go="Invite →"
            cards={[
              {
                value: 'viewer',
                title: 'Viewer',
                srPrefix: 'Invite as',
                description: 'Sees every page. Changes nothing. No page shows a secret.',
                footnote: <Badge>Reads only</Badge>,
              },
              {
                value: 'token_manager',
                title: 'Credential manager',
                srPrefix: 'Invite as',
                description: 'Adds, rotates, tests, disables and deletes credentials.',
                footnote: <Badge tone="accent">Loads keys</Badge>,
              },
              {
                value: 'access_manager',
                title: 'Access manager',
                srPrefix: 'Invite as',
                description: 'Decides which consumers may use which token. Never sees a secret.',
                footnote: <Badge tone="accent">Grants access</Badge>,
              },
              {
                value: 'admin',
                title: 'Admin',
                srPrefix: 'Invite as',
                description: 'Credential manager and Access manager together, plus the export.',
                footnote: <Badge>Both duties</Badge>,
              },
            ]}
          />
        </form>
      ),
      code: `<form method="post" action="/admin/users/invite">
  <input type="hidden" name="_csrf" value={csrf} />
  <ActionCards name="role" go="Invite →" cards={[
    { value: 'viewer', title: 'Viewer', srPrefix: 'Invite as',
      description: 'Sees every page. Changes nothing. No page shows a secret.',
      footnote: <Badge>Reads only</Badge> },
    …
  ]} />
</form>`,
    },
    {
      title: 'Current value and risky options',
      description:
        'The current policy is a plain card marked aria-current. Options that let people in with write access open a confirm dialog instead of saving.',
      layout: 'stack',
      render: () => (
        <form method="post" action="#">
          <p class="lbl" id="ac-pol-h">
            When someone new signs in
          </p>
          <ActionCards
            name="join_policy"
            go="Save →"
            columns={1}
            labelledBy="ac-pol-h"
            cards={[
              {
                value: 'closed',
                title: 'Only invited people',
                description: 'Anyone else is recorded as suspended and refused.',
              },
              {
                value: 'ask',
                title: 'Ask an owner first',
                description: 'They wait under People until an owner approves them with a role.',
                current: true,
              },
              {
                value: 'active:token_manager',
                title: 'Let them in as Credential manager…',
                description: 'Anyone Access admits can add, replace and delete credentials.',
                risk: true,
                dialog: 'ac-dlg-tm',
                go: 'Confirm next →',
              },
            ]}
          />
          <ConfirmDialog
            id="ac-dlg-tm"
            title="Let everyone Access admits in as Credential manager?"
            action="#"
            confirmLabel="Let them in"
            hidden={{ _csrf: 'csrf-token', join_policy: 'active:token_manager' }}
          />
        </form>
      ),
      code: `<ActionCards name="join_policy" go="Save →" columns={1} labelledBy="policy-h" cards={[
  { value: 'closed', title: 'Only invited people', description: '…' },
  { value: 'ask', title: 'Ask an owner first', description: '…', current: true },
  { value: 'active:token_manager', title: 'Let them in as Credential manager…', description: '…',
    risk: true, dialog: 'dlg-pol-tm', go: 'Confirm next →' },
]} />`,
    },
  ],
  props: [
    {
      component: 'ActionCards',
      props: [
        {
          name: 'name',
          type: 'string',
          required: true,
          description: 'Name of the submitted field; the cards sit inside its form.',
        },
        {
          name: 'cards',
          type: 'readonly ActionCard[]',
          required: true,
          description:
            'value, title, description?, badge?, footnote? (under a dashed line), srPrefix?, go?, current?, risk?, dialog? (confirm first).',
        },
        {
          name: 'go',
          type: 'Child',
          default: "'Choose →'",
          description: 'The verb on every card.',
        },
        { name: 'columns', type: '1 | 2 | 3', default: '2', description: 'Cards per row.' },
        {
          name: 'labelledBy',
          type: 'string',
          description: 'Id of the heading that names the group (role="group").',
        },
        { name: 'class', type: 'string', description: 'Extra classes on .rcs.' },
      ],
    },
  ],
  accessibility: [
    'Each card is a real submit button: its name is the title (with the hidden prefix), the description and the footnote.',
    'The verb (“Invite →”) is decorative; the prefix says what the click does.',
    'The current value is not a button: it is a card marked aria-current, so it is announced as the current one and cannot be clicked to no effect.',
    'A risky card opens a confirm dialog (command="show-modal"): its title ends with “…”.',
  ],
  do: [
    'Put the cards in the form that carries the _csrf field.',
    'Say in each description what the choice allows.',
  ],
  dont: [
    'Do not mix them with other fields: one click saves.',
    'Do not let a risky option save without a confirm.',
  ],
  classes: ['rcs', 'rc', 'rc-b', 'rc-t', 'rc-d', 'rc-go', 'rc-q', 'is-current', 'risk', 'risktag'],
};
