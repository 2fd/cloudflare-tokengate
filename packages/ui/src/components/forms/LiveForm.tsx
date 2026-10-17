import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { Hidden, type HiddenFields } from '../../lib/hidden';
import { Icon, type IconName } from '../base/Icon';
import { LogoTile, type LogoSpec } from '../base/Logo';
import type { LiveSlot } from './context';

export interface LiveFormProps {
  method?: 'post' | 'get';
  action?: string;
  id?: string;
  /** Hidden fields at the top of the form (`_csrf`, ids), one `input type="hidden"` each. */
  hidden?: HiddenFields;
  /** The summary rail (a LiveSummary), right of the form at >= 80rem, under it otherwise. */
  rail?: Child;
  class?: string;
  /** The form column: FixedBar, Stepper, RiskAcceptance, SubmitRow, stacked 32px apart. */
  children: Child;
}

/**
 * A form whose summary and hidden branches follow its choices without JS (`form.lform`, laid out
 * as `.form-layout`). Contract: a FieldSet or FormStep with `live={N}` is field N; its option K
 * shows `LivePhrase` phrase K of field N and `Reveal field={N} option={K}`; a `risk` option shows
 * the RiskAcceptance and flips RiskSwitch. Render the server's current choice checked, so the
 * first paint is already right.
 */
export function LiveForm(props: LiveFormProps) {
  return (
    <form
      class={cx('lform', 'form-layout', props.class)}
      method={props.method ?? 'post'}
      action={props.action}
      id={props.id}
    >
      <Hidden fields={props.hidden} />
      <div class="stack">{props.children}</div>
      {props.rail ?? null}
    </form>
  );
}

export interface LiveSummaryProps {
  /** Heading id base: the rail is labelled by `${id}-h`. */
  id: string;
  /** Rail title (“This access”). */
  title: Child;
  /** One line under the title (“Follows the choices in this form.”). */
  description?: Child;
  /** Level of the rail title. Default 2: the rail sits beside the form, under the page H1. */
  headingLevel?: HeadingLevel;
  /**
   * `rail` (default): the sticky summary rail of a LiveForm (`aside.rail` > tray > panel).
   * `plan`: the summary alone in a panel (`.lsum.plan`, dashed wires), for a plan of what is
   * not built yet, such as the empty install, in its own tray (no rail, not sticky).
   */
  variant?: 'rail' | 'plan';
  class?: string;
  /** SummaryRow, SummaryWire and SummaryFoot. */
  children: Child;
}

/**
 * The summary rail of a LiveForm (`aside.rail` > tray > panel > `.lsum`): the access being made,
 * as consumer → may call → token. Sticky next to a long form at >= 80rem.
 */
export function LiveSummary(props: LiveSummaryProps) {
  const headingId = `${props.id}-h`;
  const level = useHeadingLevel(props.headingLevel ?? 2);
  const hLevel = level;
  const plan = props.variant === 'plan';
  const tray = (
    <section
      class={cx('tray', plan && props.class)}
      id={plan ? props.id : undefined}
      aria-labelledby={plan ? headingId : undefined}
    >
      <div class="tray-h">
        <div class="t">
          <H level={hLevel} id={headingId}>
            {props.title}
          </H>
          {props.description ? <p>{props.description}</p> : null}
        </div>
      </div>
      <div class="panel">
        <div class={cx('lsum', plan && 'plan')}>{props.children}</div>
      </div>
    </section>
  );
  if (plan) return tray;
  return (
    <aside class={cx('rail', props.class)} id={props.id} aria-labelledby={headingId}>
      {tray}
    </aside>
  );
}

export interface SummaryRowProps {
  /** Leading brand tile (32px), decorative. */
  logo?: LogoSpec;
  /** A custom decorative node instead of `logo`: a `decorative` LivePhrase of logos. */
  logoSlot?: Child;
  /** Leading icon in a gray tile (`.ico`) when there is no logo (the tokengate `gate`). */
  icon?: IconName;
  /** Leading glyph in the gray tile when there is no logo or icon (“→”). Decorative. */
  glyph?: string;
  /** Bold first line. */
  title: Child;
  /** Second line: values (LivePhrase), the proxy URL. */
  meta?: Child;
  /** Mono second line, for URLs and paths. */
  mono?: boolean;
  class?: string;
}

/** One row of the summary (`.lsum-row`): tile, bold line, meta line. */
export function SummaryRow(props: SummaryRowProps) {
  return (
    <div class={cx('lsum-row', props.class)}>
      {props.logo !== undefined ? (
        <LogoTile logo={props.logo} />
      ) : props.logoSlot !== undefined ? (
        props.logoSlot
      ) : (
        <span class="ico" aria-hidden="true">
          {props.icon ? <Icon name={props.icon} /> : (props.glyph ?? '→')}
        </span>
      )}
      <span>
        <b>{props.title}</b>
        {props.meta ? <span class={cx('meta', props.mono && 'mono')}>{props.meta}</span> : null}
      </span>
    </div>
  );
}

/** The vertical line between two SummaryRows (`.lsum-wire`). Decorative. */
export function SummaryWire(props: { class?: string }) {
  return <div class={cx('lsum-wire', props.class)} aria-hidden="true"></div>;
}

/** The last line of the summary (`p.lsum-foot`): expiry and the risk state. */
export function SummaryFoot(props: { class?: string; children: Child }) {
  return <p class={cx('lsum-foot', props.class)}>{props.children}</p>;
}

export interface LivePhraseProps {
  /** Field slot whose checked option picks the phrase. */
  field: LiveSlot;
  /** Phrase per option number (`data-o`): `{ 1: 'GitHub Actions (acme)', 2: … }`. */
  phrases: Readonly<Record<number, Child>>;
  /** Shown while nothing in the field is checked (`data-o="0"`): “Choose a consumer”. */
  empty?: Child;
  /** `b` for a bold phrase. */
  as?: 'span' | 'b';
  /** Hide from assistive tech: a phrase of logos. */
  decorative?: boolean;
  class?: string;
}

/**
 * A slot of the live summary (`.svN`): every phrase is rendered, and CSS shows the one of the
 * checked option (several for checkboxes). Server-rendered text, so it is escaped and translatable.
 */
export function LivePhrase(props: LivePhraseProps) {
  const Tag = props.as ?? 'span';
  return (
    <Tag
      class={cx(`sv${props.field}`, props.class)}
      aria-hidden={props.decorative ? 'true' : undefined}
    >
      {Object.entries(props.phrases).map(([o, phrase]) => (
        <span data-o={o}>{phrase}</span>
      ))}
      {props.empty !== undefined ? <span data-o="0">{props.empty}</span> : null}
    </Tag>
  );
}

export interface RiskSwitchProps {
  /** Shown while a risky option is checked (`.if-risk`, warn text). */
  risk: Child;
  /** Shown otherwise (`.if-norisk`). */
  safe: Child;
}

/** Two phrases that swap when a risky option of the LiveForm is checked. */
export function RiskSwitch(props: RiskSwitchProps) {
  return (
    <>
      <span class="if-norisk">{props.safe}</span>
      <span class="if-risk t-warn">{props.risk}</span>
    </>
  );
}
