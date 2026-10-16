import type { Child } from 'hono/jsx';
import { cx } from '../../lib/cx';

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
  /** Sidebar navigation, usually a `SideNav`. */
  nav: Child;
  /** Health line under the brand, a `HealthLine` (`a.health`); hidden below 40rem. */
  health?: Child;
  /** Account block at the bottom of the sidebar, an `AccountMenu` (it renders `.acct`). */
  account?: Child;
  /** Error-level health strip at the top of main, a `HealthStrip` (`p.hstrip[role=alert]`). */
  banner?: Child;
  /** Id of `<main>`, the skip link target. One main per page. */
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

/** The shield mark of the instance block. */
function Mark() {
  return (
    <span class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
        <circle cx="12" cy="11" r="2" />
      </svg>
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
          <details class="navd">
            <summary>Menu</summary>
            <div class="navd-in">
              {props.nav}
              {props.account}
            </div>
          </details>
        </div>
      </div>
      <Main class="main" id={mainId}>
        {props.banner}
        {props.children}
      </Main>
    </div>
  );
}
