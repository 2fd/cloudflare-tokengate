import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel } from '../../lib/heading';
import { IdChip } from '../base/IdChip';
import { LogoTile, type LogoSpec } from '../base/Logo';

export interface IdentityProps {
  /** Brand tile (40px, `logo lg`) before the name, decorative. */
  logo?: LogoSpec;
  /** A custom decorative node instead of `logo`: an `Avatar size="lg"` for a person. */
  logoSlot?: Child;
  /** The object name: the page H1 ("Slack"). */
  title: Child;
  /** Status badge after the name, inside the H1 ("✓ Active"). */
  status?: Child;
  /** First meta fact: the type or a description ("Slack Web API"). */
  type?: Child;
  /** Mono slug ("slack"). */
  slug?: string;
  /**
   * The full object ID in an `IdChip` (selects as a whole: the copy source). `kind` names the
   * kind of object ("Token"): the chip's tooltip and the hidden label read "Token ID".
   */
  entityId?: { value: string; kind: string };
  /** Facts after the ID, in order ("Created 3 Oct 2026", "Last sign-in 2 h ago"). */
  facts?: readonly Child[];
  class?: string;
}

/**
 * Detail identity row (`.ident`): logo, H1 with the status badge, and the meta line in the fixed
 * order type → slug → ID chip → facts. Use it as `PageHeader`'s `identity`.
 */
export function Identity(props: IdentityProps) {
  const facts = props.facts ?? [];
  const level = useHeadingLevel(1);
  const hasMeta =
    props.type !== undefined ||
    props.slug !== undefined ||
    props.entityId !== undefined ||
    facts.length > 0;
  return (
    <div class={cx('ident', props.class)}>
      {props.logo !== undefined ? <LogoTile logo={props.logo} size="lg" /> : props.logoSlot}
      <div>
        <H level={level} class={level !== 1 ? 'h1' : undefined}>
          {props.title}
          {props.status ? <> {props.status}</> : null}
        </H>
        {hasMeta ? (
          <div class="ident-meta">
            {props.type !== undefined ? <span>{props.type}</span> : null}
            {props.slug !== undefined ? <span class="slug">{props.slug}</span> : null}
            {props.entityId ? (
              <>
                {/* the label stays outside the chip, so selecting the chip copies only the ID */}
                <span class="vh">{`${props.entityId.kind} ID`}</span>
                <IdChip kind={props.entityId.kind}>{props.entityId.value}</IdChip>
              </>
            ) : null}
            {facts.map((fact) => (
              <span>{fact}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
