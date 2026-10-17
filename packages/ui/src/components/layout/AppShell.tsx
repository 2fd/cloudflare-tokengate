import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';
import { Icon } from '../base/Icon';

export interface AppShellBrand {
  /** Product or instance name ("tokengate"). */
  name: string;
  /** Home link of the app. */
  href: string;
  /** Mono line under the name: the host ("gate.acme.dev") or a subtitle. */
  host?: string;
}

export interface AppShellProps {
  brand: AppShellBrand;
  /**
   * Sidebar navigation, usually a `SideNav`. Optional: with neither `nav` nor `account` (pre-login
   * pages), the sidebar holds only the brand and health, and no "Menu" button is rendered.
   */
  nav?: Child;
  /** Health line under the brand, a `HealthLine` (`a.health`); hidden below 40rem. */
  health?: Child;
  /** Account block at the bottom of the sidebar, an `AccountMenu` (it renders `.acct`). */
  account?: Child;
  /** Error-level health strip at the top of main, a `HealthStrip` (`p.hstrip[role=alert]`). */
  banner?: Child;
  /**
   * Id of `<main>`, the skip link target. One main per page. `main` has `tabindex="-1"`, so the skip
   * link moves focus into it; Tab never stops there.
   */
  mainId?: string;
  /**
   * `false` renders the main column as a `div` and drops the skip link: for a shell drawn inside
   * another page (docs examples), which already has its own `main`. Default `true`.
   */
  landmarks?: boolean;
  class?: string;
  /** The main column content, usually a `Page`. */
  children?: Child;
}

/** True when a slot was passed (`undefined`, `null` and `false` render nothing). */
function present(node: Child | undefined): boolean {
  return node !== undefined && node !== null && node !== false;
}

/** The shield mark of the instance block: the `gate` icon of the set on the accent tile. */
function Mark() {
  return (
    <span class="mark" aria-hidden="true">
      <Icon name="gate" />
    </span>
  );
}

/**
 * App shell (`.app`): skip link, light sidebar (brand, health, navigation, account) and the main
 * column. Below 40rem the sidebar becomes a top bar and the navigation opens from a "Menu" button
 * (`details.navd`, no JS); from 40rem it is always open. The main column holds the error-level
 * banner, then the content, usually one centered `Page`.
 */
export function AppShell(props: AppShellProps) {
  const mainId = props.mainId ?? 'main';
  const landmarks = props.landmarks !== false;
  const Main = landmarks ? 'main' : 'div';
  const hasNav = present(props.nav) || present(props.account);
  return (
    <div class={cx('app', props.class)}>
      {landmarks ? (
        <a class="skip-link" href={`#${mainId}`}>
          Skip to content
        </a>
      ) : null}
      <div class="side">
        <div class="side-in">
          <div class="inst">
            <Mark />
            <a class="inst-name" href={props.brand.href}>
              {props.brand.name}
            </a>
            {props.brand.host ? <span class="inst-host">{props.brand.host}</span> : null}
          </div>
          {props.health}
          {hasNav ? (
            <details class="navd">
              <summary>
                {/* a stable name: the open state is aria-expanded and the turned chevron */}
                Menu
                <span class="chev" aria-hidden="true">
                  ▾
                </span>
              </summary>
              <div class="navd-in">
                {props.nav}
                {props.account}
              </div>
            </details>
          ) : null}
        </div>
      </div>
      <Main class="main" id={mainId} tabindex={landmarks ? -1 : undefined}>
        {props.banner}
        {props.children}
      </Main>
    </div>
  );
}
