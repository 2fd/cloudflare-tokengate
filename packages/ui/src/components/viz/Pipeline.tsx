import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Delta, type DeltaProps } from './Delta';
import { fmt } from './parts';

export interface PipelineDrop {
  /** How many calls stopped at this stage. */
  count: number | string;
  /** Short unit after the count ("not recognized", "no access", "upstream errors"). */
  unit: Child;
  /** Why they stopped, in one sentence. */
  why: Child;
  /** The filtered request list. Without it the drop is not a link. */
  href?: string;
  /** Link line; defaults to "See {count} requests". */
  go?: Child;
  /** `error` (warn colors) for upstream errors; `denied` (red, default) for refusals. */
  kind?: 'denied' | 'error';
}

export interface PipelineTotal {
  /** "Denied", "Errors". */
  label: string;
  count: number | string;
  /** Share of received ("2.9 %"). */
  share?: string;
  /** Change against the previous period. */
  delta?: Omit<DeltaProps, 'class'>;
  href: string;
  /** `error` shows the count in warn color; `denied` (default) in red. */
  kind?: 'denied' | 'error';
}

export interface PipelineStage {
  /** Stage name ("Received", "Caller verified", "Access matched", "Upstream OK · allowed"). */
  label: string;
  /** Calls that reached the stage. */
  value: number | string;
  /** Line under the number: share of received, latency, a `Delta`. */
  meta?: Child;
  /** The request list filtered to this stage. Without it the stage is not a link. */
  href?: string;
  /** Link line at the bottom of the stage; default "See requests". */
  go?: Child;
  /** Calls lost between the previous stage and this one, shown under it. */
  drop?: PipelineDrop;
  /** Totals under the first stage (Denied, Errors). */
  totals?: readonly PipelineTotal[];
}

export interface PipelineProps {
  /** In order; four stages fill a row (2 per row below 64rem, 1 below 40rem). */
  stages: readonly PipelineStage[];
  /** Accessible name of the list, when the tray title does not already say it. */
  label?: string;
  class?: string;
}

function Go(props: { children: Child }) {
  return (
    <span class="stage-go">
      {props.children}
      <span aria-hidden="true"> →</span>
    </span>
  );
}

function Stage(props: { stage: PipelineStage; position: 'in' | 'out' | undefined }) {
  const { stage } = props;
  const body = (
    <>
      <span class="lbl">{stage.label}</span>
      <span class="big">{fmt(stage.value)}</span>
      {stage.meta !== undefined ? <span class="meta">{stage.meta}</span> : null}
      {stage.href ? <Go>{stage.go ?? 'See requests'}</Go> : null}
    </>
  );
  const cls = cx('stage', props.position);
  return stage.href ? (
    <a class={cls} href={stage.href}>
      {body}
    </a>
  ) : (
    <div class={cls}>{body}</div>
  );
}

function Drop(props: { drop: PipelineDrop }) {
  const { drop } = props;
  const cls = cx('drop', drop.kind === 'error' && 'err');
  const body = (
    <>
      <span class="drop-n">
        {fmt(drop.count)} <small>{drop.unit}</small>
      </span>
      <span class="drop-why">{drop.why}</span>
      {drop.href ? (
        <span class="drop-go">{drop.go ?? `See ${fmt(drop.count)} requests`}</span>
      ) : null}
    </>
  );
  return drop.href ? (
    <a class={cls} href={drop.href}>
      {body}
    </a>
  ) : (
    <div class={cls}>{body}</div>
  );
}

/**
 * The request pipeline (`ol.pipe`): Received → Caller verified → Access matched → Upstream OK,
 * each stage a link to the filtered request list, with the calls lost at each step hanging below
 * it. Arrows and drop stems are CSS. Goes inside a `.panel`.
 */
export function Pipeline(props: PipelineProps) {
  const { stages } = props;
  const last = stages.length - 1;
  return (
    <ol class={cx('pipe', props.class)} aria-label={props.label}>
      {stages.map((stage, index) => (
        <li class="pipe-step">
          <Stage
            stage={stage}
            position={index === 0 ? 'in' : index === last && last > 0 ? 'out' : undefined}
          />
          {stage.drop ? <Drop drop={stage.drop} /> : null}
          {stage.totals && stage.totals.length > 0 ? (
            <div class="pipe-tot">
              {stage.totals.map((total) => (
                <a class={cx(total.kind === 'error' && 'err')} href={total.href}>
                  <span class="tl">{total.label}</span>
                  <b>{fmt(total.count)}</b>
                  {total.share ? <span>{total.share}</span> : null}
                  {total.delta ? <Delta {...total.delta} /> : null}
                </a>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
