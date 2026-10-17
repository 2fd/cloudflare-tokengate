import { ActionForm, Badge, ButtonRow } from '@tokengate/ui';
import type { ComponentDoc } from '../types';

export const actionForm: ComponentDoc = {
  slug: 'action-form',
  name: 'ActionForm',
  summary:
    'A one-button POST form: the hidden fields (the _csrf token first) and one submit Button. The row actions of the admin: Disable, Reject, Revoke, Undo.',
  usage: {
    when: [
      'A reversible action on one object that needs no more input: Disable an access, Reject a request, Undo a role change.',
      'A row action in a table cell (Cell act) or a DangerRow action.',
    ],
    whenNot: [
      'An irreversible action: a DialogTrigger that opens a ConfirmDialog.',
      'An action with a field: FieldInline (one field) or a form.',
      'Navigation (GET): a Button with href.',
    ],
  },
  examples: [
    {
      title: 'Row actions',
      description:
        'Small secondary submits in their own forms. srSuffix names the row object, so “Disable” is read “Disable acme/api → Slack”.',
      render: () => (
        <ButtonRow>
          <ActionForm
            action="#"
            hidden={{ _csrf: 'csrf-token', expected_updated_at: '2026-10-03T09:00:00Z' }}
            size="sm"
            srSuffix="acme/api → Slack"
          >
            Disable
          </ActionForm>
          <ActionForm
            action="#"
            hidden={{ _csrf: 'csrf-token' }}
            size="sm"
            srSuffix="acme/web → Slack"
          >
            Renew
          </ActionForm>
        </ButtonRow>
      ),
      code: `<ActionForm action="/admin/issuer-access-rules/a1/disable" size="sm" srSuffix="acme/api → Slack"
  hidden={{ _csrf: csrf, expected_updated_at: access.updatedAt }}>
  Disable
</ActionForm>`,
    },
    {
      title: 'A named choice',
      description:
        'name and value travel with the button, as in a decision: Reject with a danger outline.',
      render: () => (
        <ActionForm
          action="#"
          hidden={{ _csrf: 'csrf-token' }}
          variant="danger"
          size="sm"
          name="decision"
          value="reject"
          srSuffix="sam@acme.dev (you can reactivate Sam later)"
        >
          Reject
        </ActionForm>
      ),
      code: `<ActionForm action="/admin/users/usr_sam/decide" hidden={{ _csrf: csrf }}
  variant="danger" size="sm" name="decision" value="reject"
  srSuffix="sam@acme.dev (you can reactivate Sam later)">
  Reject
</ActionForm>`,
    },
    {
      title: 'Undo in a notice',
      description:
        'The undo of the last change is one POST too, next to the words that say what changed.',
      render: () => (
        <>
          <Badge status="active">Role changed</Badge>
          <ActionForm
            action="#"
            hidden={{ _csrf: 'csrf-token', undo: 'evt_01JB8W2C' }}
            size="sm"
            variant="ghost"
          >
            Undo
          </ActionForm>
        </>
      ),
      code: `<ActionForm action="/admin/users/usr_diego/undo" hidden={{ _csrf: csrf, undo: eventId }}
  size="sm" variant="ghost">Undo</ActionForm>`,
    },
  ],
  props: [
    {
      component: 'ActionForm',
      props: [
        { name: 'action', type: 'string', required: true, description: 'Where the button posts.' },
        {
          name: 'hidden',
          type: 'HiddenFields',
          description:
            'Hidden fields, one input type="hidden" each: _csrf, ids, expected_updated_at.',
        },
        {
          name: 'variant',
          type: 'ButtonVariant',
          default: "'secondary'",
          description: 'Button style. danger for a reversible destructive action (Reject).',
        },
        {
          name: 'size / block / disabled / plus / icon / id / describedBy / name / value / formnovalidate',
          type: 'as Button',
          description: 'Passed to the submit Button.',
        },
        {
          name: 'srSuffix',
          type: 'string',
          description: 'Hidden suffix naming the row object. The space is added.',
        },
        { name: 'class', type: 'string', description: 'Classes on the form (.action-form).' },
        { name: 'buttonClass', type: 'string', description: 'Classes on the button.' },
        { name: 'children', type: 'Child', required: true, description: 'The label: the outcome.' },
      ],
    },
  ],
  accessibility: [
    'It is a real form with a submit button: it works with the keyboard and without JavaScript.',
    'In a list of rows every button needs srSuffix, so “Disable” is unique on the page.',
    'The gateway refuses an unsafe request without its _csrf field: pass it in hidden.',
  ],
  do: [
    'Use it for actions that can be undone, and show the Undo after.',
    'Keep the visible label short; the object goes in srSuffix.',
  ],
  dont: [
    'Do not use it for Delete or anything that cannot be undone: confirm in a dialog.',
    'Do not hand-write the form: every POST of the admin carries the same hidden fields.',
  ],
  classes: ['action-form', 'btn', 'sm', 'secondary', 'vh'],
};
