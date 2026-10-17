import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { H, useHeadingLevel, type HeadingLevel } from '../../lib/heading';
import { SrSuffix } from '../../lib/sr';
import { LogoTile, type LogoSpec } from '../base/Logo';
import { fmt } from './parts';

export interface WhoAccess {
  /** The repository or project (“acme/api”). */
  name: Child;
  /** The access page. */
  href: string;
  /** The constraint, muted after a “·” (“environment production (protected refs)”). */
  context?: Child;
  /** Second line: operation, expiry, last use (`<code>POST /chat.postMessage</code> · …`). */
  meta?: Child;
  /** The status `Badge` at the right (“✓ Active”, “⌛ Expires in 9 days”). */
  status: Child;
  /** Under the status: a fix link (“Renew”). */
  statusAction?: Child;
  /** Needs attention: warn ring and dashed wires (`.wrow.warn`). */
  warn?: boolean;
}

export interface WhoGroup {
  /** The consumer of the accesses. */
  consumer: {
    name: Child;
    href: string;
    /** Second line (“org acme · 2 accesses”). */
    line?: Child;
    logo: LogoSpec;
    /** Accesses of this consumer to the token; the count pill. */
    count: number;
  };
  /** The accesses shown, most used first (the server caps them). */
  accesses: readonly WhoAccess[];
  /** The rest of this consumer's accesses, as one dashed row: “+ 5 more accesses”. */
  more?: { href: string; label: Child; srSuffix?: string; meta?: Child };
}

export interface WhoCanUseProps {
  /** The token every line ends at (the hub). */
  token: { name: Child; logo: LogoSpec; path: string };
  /** Consumers with their accesses, most requests first. Empty: the ghost shows `empty`. */
  groups: readonly WhoGroup[];
  /** Accessible name of the list (“Accesses to Slack, grouped by consumer”). */
  label: string;
  /** The consumers not drawn, as one group node that opens the matrix. */
  rest?: { href: string; label: Child; line?: Child };
  /**
   * The empty map (`.wmap.is-empty`): a dashed ghost where the first consumer will appear, with
   * a title and what to do (an `AskSomeone`, a link field).
   */
  empty?: { title: Child; children?: Child };
  /** Level of the empty title. Default 3, one under the tray title (a Tray sets it). */
  headingLevel?: HeadingLevel;
  /**
   * Scale note inside the panel, under the map (`.cmap-note`): how many consumers and accesses
   * the map leaves out, with a link to all of them.
   */
  note?: Child;
  /** Footer line under the panel (`.wfoot`): what is missing, and one ghost button. */
  footer?: Child;
  /** Action at the right of the footer (“+ Give another issuer access rules”). */
  footerAction?: Child;
  class?: string;
}

/**
 * “Who can use” map of a token page (`.wmap`): each consumer node, its access rows, and wires
 * into the token hub, drawn with CSS lines (no geometry to compute). Every line is a real link
 * row, so the map is its own text form. Below 64rem the hub moves on top and the wires drop out.
 * Renders the body of a tray: the panel, then the footer.
 */
export function WhoCanUse(props: WhoCanUseProps) {
  const isEmpty = props.groups.length === 0 && props.rest === undefined;
  const emptyLevel = useHeadingLevel(props.headingLevel ?? 3);
  const hub = (
    <div class="whub" aria-hidden="true">
      <div class="node is-on">
        <LogoTile logo={props.token.logo} />
        <span class="nm">{props.token.name}</span>
        <span class="meta">{props.token.path}</span>
      </div>
    </div>
  );
  return (
    <>
      <div class={cx('panel', props.class)}>
        <div class={cx('wmap', isEmpty && 'is-empty')}>
          {isEmpty ? (
            <div class="wghost">
              {props.empty ? <H level={emptyLevel}>{props.empty.title}</H> : null}
              {props.empty?.children}
            </div>
          ) : (
            <ul class="wgroups" aria-label={props.label}>
              {props.groups.map((group) => (
                <li class="wg">
                  <div class="node cnode">
                    <LogoTile logo={group.consumer.logo} />
                    <a class="id" href={group.consumer.href}>
                      <span class="nm">{group.consumer.name}</span>
                      {group.consumer.line !== undefined ? (
                        <span class="nl">{group.consumer.line}</span>
                      ) : null}
                    </a>
                    <span class="cnt" aria-hidden="true">
                      {fmt(group.consumer.count)}
                    </span>
                  </div>
                  <ul class="wrows">
                    {group.accesses.map((access) => (
                      <li class={cx('wrow', access.warn && 'warn')}>
                        <span class="ent-t">
                          <span>
                            <a class="ent-n" href={access.href}>
                              {access.name}
                            </a>
                            {access.context !== undefined ? (
                              <>
                                {' '}
                                <span class="ctx">· {access.context}</span>
                              </>
                            ) : null}
                          </span>
                          {access.meta !== undefined ? (
                            <span class="meta">{access.meta}</span>
                          ) : null}
                        </span>
                        {access.statusAction !== undefined ? (
                          <span class="wst">
                            {access.status}
                            {access.statusAction}
                          </span>
                        ) : (
                          access.status
                        )}
                      </li>
                    ))}
                    {group.more ? (
                      <li class="wrow more">
                        <a href={group.more.href}>
                          {group.more.label}
                          <SrSuffix text={group.more.srSuffix} />
                        </a>
                        {group.more.meta !== undefined ? (
                          <span class="meta">{group.more.meta}</span>
                        ) : null}
                      </li>
                    ) : null}
                  </ul>
                </li>
              ))}
              {props.rest ? (
                <li class="wg rest">
                  <a class="node group" href={props.rest.href}>
                    <span class="id">
                      <span class="nm">{props.rest.label}</span>
                      {props.rest.line !== undefined ? (
                        <span class="nl">{props.rest.line}</span>
                      ) : null}
                    </span>
                  </a>
                </li>
              ) : null}
            </ul>
          )}
          {hub}
        </div>
        {props.note !== undefined ? <p class="cmap-note">{props.note}</p> : null}
      </div>
      {props.footer !== undefined || props.footerAction !== undefined ? (
        <div class="wfoot">
          {props.footer !== undefined ? <span>{props.footer}</span> : null}
          {props.footerAction}
        </div>
      ) : null}
    </>
  );
}
