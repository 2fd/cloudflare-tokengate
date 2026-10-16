import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export type AttentionLevel = 'warn' | 'info' | 'bad';

export interface AttentionRole {
  /** Submitted value ("viewer", "token_manager"). */
  value: string;
  /** Visible label ("Viewer"). */
  label: string;
}

/** Approve a person inline: one submit button per role, one click each. */
export interface AttentionApprove {
  /** Form action (POST). */
  action: string;
  /** Who is approved, for the buttons' accessible names: "Approve sam@acme.dev as Viewer". */
  subject: string;
  roles: readonly AttentionRole[];
  /** Name of the submitted field. Default `role`. */
  name?: string;
  /** Hidden fields sent with every button (a CSRF token, the user id). */
  hidden?: Readonly<Record<string, string>>;
  /** The link for the choices that need a page (Owner, reject): "Owner or reject…". */
  more?: { href: string; label: Child };
}

export interface AttentionItem {
  level: AttentionLevel;
  /** The level word; defaults to Warning, Note or Error. */
  levelLabel?: string;
  /** What needs attention, in one sentence. */
  title: Child;
  /** The consequence or the context. `<b>` marks names. */
  body?: Child;
  /** The inline fix: one or two `.btn.sm.secondary` links or buttons. */
  actions?: Child;
  /** Approve-as-role buttons instead of `actions`. */
  approve?: AttentionApprove;
}

export interface NeedsAttentionProps {
  items: readonly AttentionItem[];
  /**
   * `cols` (default): cards in a row with 1px gap lines, 4 per row (2 below 80rem, 1 below
   * 40rem), for the Overview. `list`: stacked rows, for a narrow column.
   */
  layout?: 'cols' | 'list';
  class?: string;
}

const LEVEL = {
  warn: { glyph: '!', word: 'Warning' },
  info: { glyph: 'i', word: 'Note' },
  bad: { glyph: '✕', word: 'Error' },
} as const;

function Approve(props: { approve: AttentionApprove }) {
  const { approve } = props;
  const name = approve.name ?? 'role';
  return (
    <form class="att-a roles" method="post" action={approve.action}>
      {Object.entries(approve.hidden ?? {}).map(([key, value]) => (
        <input type="hidden" name={key} value={value} />
      ))}
      {approve.roles.map((role) => (
        <button class="btn sm secondary" type="submit" name={name} value={role.value}>
          <span class="vh">{`Approve ${approve.subject} as `}</span>
          {role.label}
        </button>
      ))}
      {approve.more ? (
        <a class="linkish" href={approve.more.href}>
          {approve.more.label}
        </a>
      ) : null}
    </form>
  );
}

/**
 * Needs attention (`ul.att`): one card per problem, worst first, each with its level, one
 * sentence, the consequence and an inline fix. Goes inside a `.panel` in a tray titled
 * "Needs attention" with the count.
 */
export function NeedsAttention({ items, layout = 'cols', class: className }: NeedsAttentionProps) {
  return (
    <ul class={cx('att', layout === 'cols' && 'cols', className)}>
      {items.map((item) => {
        const level = LEVEL[item.level];
        return (
          <li>
            <span class={`att-lvl ${item.level}`}>
              <span class="g" aria-hidden="true">
                {level.glyph}
              </span>
              {item.levelLabel ?? level.word}
            </span>
            <p class="att-t">{item.title}</p>
            {item.body !== undefined ? <p class="att-b">{item.body}</p> : null}
            {item.approve ? (
              <Approve approve={item.approve} />
            ) : item.actions !== undefined ? (
              <div class="att-a">{item.actions}</div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
