// Presentational building blocks shared by admin pages. Hono JSX escapes all interpolated text;
// dangerouslySetInnerHTML is a lint error (oxlint react/no-danger).
import type { Child } from 'hono/jsx';
import { CSRF_FIELD } from '../auth/csrf';

/** Hidden synchronizer token required on every POST form (I-CSRF-1). */
export function Csrf(props: { token: string }) {
  return <input type="hidden" name={CSRF_FIELD} value={props.token} />;
}

/**
 * Hidden `updated_at` of the row an edit form shows, so a save over someone else's newer change
 * is refused (optimistic concurrency; ops compare it as `expected_updated_at`).
 */
export function VersionField(props: { value: string }) {
  return <input type="hidden" name="expected_updated_at" value={props.value} />;
}

/** A POST form rendered as a single button, for actions such as enable/disable/delete. */
export function ActionButton(props: {
  action: string;
  csrf: string;
  label: string;
  danger?: boolean;
  fields?: Record<string, string>;
}) {
  return (
    <form method="post" action={props.action} class="inline">
      <Csrf token={props.csrf} />
      {Object.entries(props.fields ?? {}).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      <button type="submit" class={props.danger ? 'danger' : 'secondary'}>
        {props.label}
      </button>
    </form>
  );
}

export function Field(props: {
  label: string;
  name: string;
  value?: string | number | null;
  type?: string;
  hint?: Child;
  required?: boolean;
  placeholder?: string;
  readonly?: boolean;
  autocomplete?: string;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? 'text'}
        name={props.name}
        value={props.value == null ? '' : String(props.value)}
        required={props.required}
        placeholder={props.placeholder}
        readonly={props.readonly}
        autocomplete={props.autocomplete ?? 'off'}
      />
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

export function TextArea(props: {
  label: string;
  name: string;
  value?: string | null;
  hint?: Child;
  rows?: number;
  required?: boolean;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <textarea name={props.name} rows={props.rows ?? 4} required={props.required}>
        {props.value ?? ''}
      </textarea>
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

export function Select(props: {
  label: string;
  name: string;
  value?: string | null;
  options: Array<{ value: string; label: string }>;
  hint?: Child;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <select name={props.name}>
        {props.options.map((option) => (
          <option value={option.value} selected={option.value === props.value}>
            {option.label}
          </option>
        ))}
      </select>
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

export function Checkbox(props: { label: Child; name: string; checked?: boolean; hint?: Child }) {
  return (
    <label class="checkbox">
      <input type="checkbox" name={props.name} value="1" checked={props.checked} />
      <span>{props.label}</span>
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

export function Messages(props: { errors?: string[]; warnings?: string[] }) {
  return (
    <>
      {(props.errors ?? []).map((text) => (
        <p class="banner error" role="alert">
          {text}
        </p>
      ))}
      {(props.warnings ?? []).map((text) => (
        <p class="banner warning">{text}</p>
      ))}
    </>
  );
}

export function Badge(props: { tone?: 'ok' | 'warn' | 'bad' | 'muted'; children?: Child }) {
  return <span class={`badge ${props.tone ?? ''}`}>{props.children}</span>;
}

export function EnabledBadge(props: { enabled: boolean }) {
  return props.enabled ? <Badge tone="ok">enabled</Badge> : <Badge tone="muted">disabled</Badge>;
}

export function EmptyState(props: { children?: Child }) {
  return <p class="empty">{props.children}</p>;
}

/** Key/value table for detail pages. */
export function Details(props: { rows: Array<[string, Child]> }) {
  return (
    <dl class="details">
      {props.rows.map(([key, value]) => (
        <>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </>
      ))}
    </dl>
  );
}

/** "Older" link for keyset pagination on time-ordered ids. */
export function NextPage(props: { href: string | null }) {
  return props.href ? (
    <p>
      <a href={props.href}>Older entries →</a>
    </p>
  ) : null;
}

export function Code(props: { children?: Child }) {
  return <code>{props.children}</code>;
}

export function Pre(props: { children?: Child }) {
  return <pre>{props.children}</pre>;
}
