import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

export interface IdentityProps {
  /** Decorative 40px tile before the name: a `logo lg` tile or an `avatar lg`, `aria-hidden`. */
  logo?: Child;
  /** The object name: the page H1 ("Slack"). */
  title: Child;
  /** Status badge after the name, inside the H1 ("✓ Active"). */
  status?: Child;
  /** First meta fact: the type or a description ("Slack Web API"). */
  type?: Child;
  /** Mono slug ("slack"). */
  slug?: string;
  /**
   * The full object ID in a mono chip (`.idchip`, selects as a whole: the copy source). `label`
   * names the kind of ID ("Token ID") as the chip's tooltip and for screen readers.
   */
  entityId?: { value: string; label: string };
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
  const hasMeta =
    props.type !== undefined ||
    props.slug !== undefined ||
    props.entityId !== undefined ||
    facts.length > 0;
  return (
    <div class={cx('ident', props.class)}>
      {props.logo}
      <div>
        <h1>
          {props.title}
          {props.status ? <> {props.status}</> : null}
        </h1>
        {hasMeta ? (
          <div class="ident-meta">
            {props.type !== undefined ? <span>{props.type}</span> : null}
            {props.slug !== undefined ? <span class="slug">{props.slug}</span> : null}
            {props.entityId ? (
              <>
                {/* the label stays outside the chip, so selecting the chip copies only the ID */}
                <span class="vh">{props.entityId.label}</span>
                <span class="idchip" title={props.entityId.label}>
                  {props.entityId.value}
                </span>
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
