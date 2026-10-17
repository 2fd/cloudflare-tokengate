import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { Hidden, type HiddenFields } from '../../lib/hidden';

export type AttentionLevel = 'warn' | 'info' | 'bad';

export interface AttentionRole {
  /** Submitted value ("viewer", "token_manager"). */
  value: string;
  /** Visible label ("Viewer", "Owner…"). */
  label: string;
  /** Opens this confirm `Dialog` instead of submitting (Owner…: the label ends with "…"). */
  dialog?: string;
}

/** Approve a person inline: one submit button per role, one click each. */
export interface AttentionApprove {
  /** Form action (POST). */
  action: string;
  /**
   * Id of the approve `<form>`, so a control outside it can submit it: the Owner… `ConfirmDialog`
   * with `form={id}`. Unique on the page.
   */
  id?: string;
  /** Who is approved, for the buttons' accessible names: "Approve sam@acme.dev as Viewer". */
  subject: string;
  roles: readonly AttentionRole[];
  /** Name of the submitted field. Default `role`. */
  name?: string;
  /** Hidden fields sent with every button (`_csrf`, the user id). */
  hidden?: HiddenFields;
  /**
   * Group the role buttons under a legend (`fieldset` > `legend`, "Approve as"), as a decision
   * item does. Without it the buttons fill a two-column grid (`.att-a.roles`).
   */
  legend?: string;
  /** The link for the choices that need a page (Owner, reject): "Owner or reject…". */
  more?: { href: string; label: Child };
  /** A Reject button in its own form, at the end of the row (`.reject`, danger). */
  reject?: {
    action: string;
    hidden?: HiddenFields;
    /** Default "Reject". */
    label?: string;
    /** Submitted name and value. Default `decision=reject`. */
    name?: string;
    value?: string;
    /** Screen-reader suffix ("sam@acme.dev (you can reactivate Sam later)"). */
    srSuffix?: string;
  };
}

/** Who a decision is about: a person waiting for approval (`.att-who`). */
export interface AttentionWho {
  /** Id of the heading; the item is labelled by it. Unique on the page. */
  id: string;
  /** Decorative avatar or tile (`Avatar size="lg" variant="pending"`). */
  avatar: Child;
  /** The person ("sam@acme.dev"), as a heading. */
  name: Child;
  /** Status badge after the name ("◐ Pending approval"). */
  status?: Child;
  /** One meta line: name, when they first signed in, last tried. */
  meta?: Child;
}

interface AttentionBase {
  /** The consequence or the context. `<b>` marks names. */
  body?: Child;
  /**
   * The inline fix: one or two `.btn.sm.secondary` links or buttons. With `approve`, it follows
   * the approve buttons (Dismiss, an inline `FieldError`).
   */
  actions?: Child;
  /** Approve-as-role buttons, before `actions`. */
  approve?: AttentionApprove;
}

export type AttentionItem = AttentionBase &
  (
    | {
        level: AttentionLevel;
        /** The level word; defaults to Warning, Note or Error. */
        levelLabel?: string;
        /** What needs attention, in one sentence. */
        title: Child;
        who?: undefined;
      }
    | {
        /**
         * A decision about a person ("Needs your decision"): the avatar, the name as a heading
         * with its status, and a meta line, instead of a level and a title line.
         */
        who: AttentionWho;
        level?: undefined;
        levelLabel?: undefined;
        title?: undefined;
      }
  );

export interface NeedsAttentionProps {
  items: readonly AttentionItem[];
  /**
   * `cols` (default): cards in a row with 1px gap lines, 4 per row (2 below 80rem, 1 below
   * 40rem), for the Overview. `list`: stacked rows, for a narrow column or decisions.
   */
  layout?: 'cols' | 'list';
  /** Level of a decision item's name. Default 3, one under the tray title (a Tray sets it). */
  headingLevel?: HeadingLevel;
  class?: string;
}

const LEVEL = {
  warn: { glyph: '!', word: 'Warning' },
  info: { glyph: 'i', word: 'Note' },
  bad: { glyph: '✕', word: 'Error' },
} as const;

function RoleButton(props: { approve: AttentionApprove; role: AttentionRole; name: string }) {
  const { approve, role } = props;
  const label = (
    <>
      <span class="vh">{`Approve ${approve.subject} as `}</span>
      {role.label}
    </>
  );
  return role.dialog ? (
    <button
      class="btn sm secondary"
      type="button"
      command="show-modal"
      commandfor={role.dialog}
      popovertarget={role.dialog}
    >
      {label}
    </button>
  ) : (
    <button class="btn sm secondary" type="submit" name={props.name} value={role.value}>
      {label}
    </button>
  );
}

function Approve(props: { approve: AttentionApprove }) {
  const { approve } = props;
  const name = approve.name ?? 'role';
  const buttons = approve.roles.map((role) => (
    <RoleButton approve={approve} role={role} name={name} />
  ));
  const more = approve.more ? (
    <a class="linkish" href={approve.more.href}>
      {approve.more.label}
    </a>
  ) : null;
  const reject = approve.reject ? (
    <form class="reject" method="post" action={approve.reject.action}>
      <Hidden fields={approve.reject.hidden} />
      <button
        class="btn sm danger"
        type="submit"
        name={approve.reject.name ?? 'decision'}
        value={approve.reject.value ?? 'reject'}
      >
        {approve.reject.label ?? 'Reject'}
        {approve.reject.srSuffix ? <span class="vh">{` ${approve.reject.srSuffix}`}</span> : null}
      </button>
    </form>
  ) : null;
  if (approve.legend !== undefined) {
    return (
      <div class="att-a">
        <form id={approve.id} method="post" action={approve.action}>
          <Hidden fields={approve.hidden} />
          <fieldset>
            <legend>{approve.legend}</legend>
            <div class="btn-row">{buttons}</div>
          </fieldset>
        </form>
        {more}
        {reject}
      </div>
    );
  }
  return (
    <>
      <form id={approve.id} class="att-a roles" method="post" action={approve.action}>
        <Hidden fields={approve.hidden} />
        {buttons}
        {more}
      </form>
      {reject ? <div class="att-a">{reject}</div> : null}
    </>
  );
}

function Who(props: { who: AttentionWho; level: number }) {
  const { who } = props;

  return (
    <div class="att-who">
      {who.avatar}
      <div>
        <H level={props.level} id={who.id}>
          {who.name}
          {who.status !== undefined ? <> {who.status}</> : null}
        </H>
        {who.meta !== undefined ? <p class="meta">{who.meta}</p> : null}
      </div>
    </div>
  );
}

/**
 * Needs attention (`ul.att`): one card per problem, worst first, each with its level, one
 * sentence, the consequence and an inline fix. A decision item (`who`) shows the person and
 * Approve-as buttons with a separate Reject. Goes inside a `.panel` in a tray titled "Needs
 * attention" (or "Needs your decision") with the count.
 */
export function NeedsAttention({
  items,
  layout = 'cols',
  headingLevel,
  class: className,
}: NeedsAttentionProps) {
  const level = useHeadingLevel(headingLevel ?? 3);
  return (
    <ul class={cx('att', layout === 'cols' && 'cols', className)}>
      {items.map((item) => {
        return (
          <li aria-labelledby={item.who?.id}>
            {item.who ? (
              <Who who={item.who} level={level} />
            ) : (
              <>
                <span class={`att-lvl ${item.level}`}>
                  <span class="g" aria-hidden="true">
                    {LEVEL[item.level].glyph}
                  </span>
                  {item.levelLabel ?? LEVEL[item.level].word}
                </span>
                <p class="att-t">{item.title}</p>
              </>
            )}
            {item.body !== undefined ? <p class="att-b">{item.body}</p> : null}
            {item.approve ? <Approve approve={item.approve} /> : null}
            {item.actions !== undefined ? <div class="att-a">{item.actions}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}
