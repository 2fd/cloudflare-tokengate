// Shared admin components (the design system). Every section builds its pages from these; a
// section-specific primitive goes in that section's own views file, not here. Hono JSX escapes all
// interpolated text, dangerouslySetInnerHTML is a lint error (oxlint react/no-danger), and nothing
// here uses style= or script (CSP). Conventions behind the markup:
// - ids: a field named `a.b` has the id `f-a-b` (fieldId), its hint `…-hint`, its error `…-error`;
//   aria-describedby lists only ids that are rendered.
// - native validation (required, pattern, min, …) only on controls that are visible whenever their
//   form can be submitted; `conditional` drops it for controls inside a .reveal or closed details.
// - dialogs open with invoker commands, fall back to popover, and render inline without either;
//   the server always requires the confirm value, so the dialog is never the only guard.
import type { Child } from 'hono/jsx';
import type { User } from '../../db/types';
import { CSRF_FIELD } from '../auth/csrf';
import type { Permission } from '../auth/rbac';
import type { Notice } from '../notice';
import type { FieldError } from '../ops/shared';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { ApproveForm } from './approve-form';
import { formatTime, relativeTime } from './format';
import { rolesFor, ROLE_INFO } from './roles';
import { STATUS, type StatusKey, statusLabel } from './status';

export type { Tone } from './status';
// ApproveForm has its own file (it encodes the Users approve flow); pages import it from here.
export { ApproveForm };

export interface Suggestion {
  value: string;
  label?: string;
}

/** The id of the control for form field `name` (`.` becomes `-`, as in `f-rules-0-path`). */
export function fieldId(name: string): string {
  return `f-${name.replace(/[.]/g, '-')}`;
}

function describedBy(ids: Array<string | null | undefined | false>): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return present.length > 0 ? present.join(' ') : undefined;
}

// ---------------------------------------------------------------------------------------------
// Forms

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

function HiddenFields(props: { fields?: Record<string, string> }) {
  return (
    <>
      {Object.entries(props.fields ?? {}).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** A POST form that always carries the CSRF token, so no page can forget it (I-CSRF-1). */
export function PostForm(props: {
  action: string;
  csrf: string;
  class?: string;
  id?: string;
  /** A `_return` key (paths.ts returnPath), never a URL. */
  returnTo?: string;
  children?: Child;
}) {
  return (
    <form method="post" action={props.action} class={props.class} id={props.id}>
      <Csrf token={props.csrf} />
      {props.returnTo ? <input type="hidden" name="_return" value={props.returnTo} /> : null}
      {props.children}
    </form>
  );
}

/**
 * A POST form rendered as one button. `context` is appended visually hidden, so repeated buttons
 * have distinct accessible names that start with the visible label ("Disable" + " Slack bot").
 */
export function ActionButton(props: {
  action: string;
  csrf: string;
  label: string;
  context?: string;
  tone?: 'primary' | 'secondary' | 'danger';
  fields?: Record<string, string>;
  returnTo?: string;
}) {
  return (
    <PostForm action={props.action} csrf={props.csrf} class="inline" returnTo={props.returnTo}>
      <HiddenFields fields={props.fields} />
      <button type="submit" class={props.tone ?? 'secondary'}>
        {props.label}
        {props.context ? <span class="vh"> {props.context}</span> : null}
      </button>
    </PostForm>
  );
}

type InputMode = 'text' | 'numeric' | 'url' | 'email' | 'search';

export interface FieldProps {
  name: string;
  label: string;
  id?: string;
  value?: string | number | null;
  type?: 'text' | 'search' | 'number' | 'date' | 'password' | 'email' | 'url';
  hint?: Child;
  /** An exact example value, shown as the placeholder (never "e.g."). */
  example?: string;
  error?: string | null;
  required?: boolean;
  /** Adds "(optional)" to the label. Required fields get no marker. */
  optional?: boolean;
  /** The control can be hidden while its form is submittable: no native validation (A7.6). */
  conditional?: boolean;
  pattern?: string;
  inputmode?: InputMode;
  /** No default: pass a token, or `off`. */
  autocomplete: string;
  spellcheck?: boolean;
  autocapitalize?: 'none';
  min?: number | string;
  max?: number | string;
  step?: number | string;
  minlength?: number;
  maxlength?: number;
  readonly?: boolean;
  disabled?: boolean;
  suggestions?: readonly Suggestion[];
  labelHidden?: boolean;
  /** Extra ids for aria-describedby, after the hint and error. */
  describedBy?: string[];
  enterkeyhint?: 'send' | 'done' | 'go';
  /** Page-level focus target (the first new row after "Add rows"). */
  autofocus?: boolean;
}

/** Label, hint and error around a control; the shared frame of Field, TextArea and Select. */
function FieldFrame(props: {
  id: string;
  label: string;
  optional?: boolean;
  labelHidden?: boolean;
  hint?: Child;
  error?: string | null;
  children: Child;
}) {
  return (
    <div class="field" data-invalid={props.error ? 'true' : undefined}>
      <label for={props.id} class={props.labelHidden ? 'vh' : undefined}>
        {props.label}
        {props.optional ? <span class="optional"> (optional)</span> : null}
      </label>
      {hasContent(props.hint) ? (
        <p class="hint" id={`${props.id}-hint`}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p class="field-error" id={`${props.id}-error`}>
          <span class="vh">Error:</span> {props.error}
        </p>
      ) : null}
      {props.children}
    </div>
  );
}

function hasContent(child: Child | undefined): boolean {
  return child !== undefined && child !== null && child !== false && child !== '';
}

function frameIds(id: string, p: { hint?: Child; error?: string | null; describedBy?: string[] }) {
  return describedBy([
    hasContent(p.hint) && `${id}-hint`,
    p.error && `${id}-error`,
    ...(p.describedBy ?? []),
  ]);
}

/**
 * What A7.8 puts on every secret input (type="password"): no autofill, spellcheck or autocorrect,
 * and password managers told to leave it alone. Paste is never blocked.
 */
export const SECRET_INPUT_ATTRIBUTES = {
  autocomplete: 'off',
  spellcheck: false,
  autocapitalize: 'none',
  autocorrect: 'off',
  'data-1p-ignore': 'true',
  'data-lpignore': 'true',
  'data-bwignore': 'true',
} as const;

export function Field(props: FieldProps) {
  const id = props.id ?? fieldId(props.name);
  const conditional = props.conditional === true;
  let type = props.type ?? 'text';
  let inputmode = props.inputmode;
  if (conditional && (type === 'url' || type === 'email')) {
    inputmode = inputmode ?? type;
    type = 'text';
  }
  const listId = props.suggestions && props.suggestions.length > 0 ? `${id}-list` : undefined;
  return (
    <FieldFrame
      id={id}
      label={props.label}
      optional={props.optional}
      labelHidden={props.labelHidden}
      hint={props.hint}
      error={props.error}
    >
      <input
        id={id}
        name={props.name}
        type={type}
        value={props.value == null ? '' : String(props.value)}
        placeholder={props.example}
        required={!conditional && props.required ? true : undefined}
        pattern={conditional ? undefined : props.pattern}
        min={conditional ? undefined : props.min}
        max={conditional ? undefined : props.max}
        minlength={conditional ? undefined : props.minlength}
        step={props.step}
        maxlength={props.maxlength}
        inputmode={inputmode}
        autocomplete={props.autocomplete}
        spellcheck={props.spellcheck}
        autocapitalize={props.autocapitalize}
        readonly={props.readonly}
        disabled={props.disabled}
        enterkeyhint={props.enterkeyhint}
        autofocus={props.autofocus}
        list={listId}
        aria-describedby={frameIds(id, props)}
        aria-invalid={props.error ? 'true' : undefined}
        {...(type === 'password' ? SECRET_INPUT_ATTRIBUTES : {})}
      />
      {listId ? (
        <datalist id={listId}>
          {(props.suggestions ?? []).map((suggestion) => (
            <option value={suggestion.value}>{suggestion.label ?? suggestion.value}</option>
          ))}
        </datalist>
      ) : null}
    </FieldFrame>
  );
}

export function TextArea(
  props: Omit<
    FieldProps,
    'type' | 'pattern' | 'inputmode' | 'min' | 'max' | 'step' | 'suggestions'
  > & {
    rows?: number;
  },
) {
  const id = props.id ?? fieldId(props.name);
  const conditional = props.conditional === true;
  return (
    <FieldFrame
      id={id}
      label={props.label}
      optional={props.optional}
      labelHidden={props.labelHidden}
      hint={props.hint}
      error={props.error}
    >
      <textarea
        id={id}
        name={props.name}
        rows={props.rows ?? 4}
        placeholder={props.example}
        required={!conditional && props.required ? true : undefined}
        minlength={conditional ? undefined : props.minlength}
        maxlength={props.maxlength}
        autocomplete={props.autocomplete}
        spellcheck={props.spellcheck}
        autocapitalize={props.autocapitalize}
        readonly={props.readonly}
        disabled={props.disabled}
        autofocus={props.autofocus}
        aria-describedby={frameIds(id, props)}
        aria-invalid={props.error ? 'true' : undefined}
      >
        {props.value == null ? '' : String(props.value)}
      </textarea>
    </FieldFrame>
  );
}

export type IdKind = 'github_repo' | 'github_owner_list' | 'gitlab_project' | 'gitlab_group_list';

const GITHUB_OWNER = '[A-Za-z0-9\\-]{1,39} \\([0-9]{1,20}\\)';
const GITLAB_GROUP = '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)* \\([0-9]{1,20}\\)';

/** The `name (ID)` formats of A7.8, as HTML patterns (compiled with the `v` flag by browsers). */
export const ID_PATTERNS: Readonly<Record<IdKind, string>> = {
  github_repo: '[A-Za-z0-9\\-]{1,39}/[A-Za-z0-9_.\\-]{1,100} \\([0-9]{1,20}\\)|[0-9]{1,20}',
  github_owner_list: `${GITHUB_OWNER}(?:, *${GITHUB_OWNER})*`,
  gitlab_project: '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)+ \\([0-9]{1,20}\\)|[0-9]{1,20}',
  gitlab_group_list: `${GITLAB_GROUP}(?:, *${GITLAB_GROUP})*`,
};

const ID_HINTS: Readonly<Record<IdKind, (command: Child) => Child>> = {
  github_repo: (command) => (
    <>
      Pick one used before, or paste the output of {command}. The ID keeps working after a rename.
    </>
  ),
  github_owner_list: (command) => (
    <>
      Paste the output of {command} (a user account: <code>gh api users/NAME …</code>).
    </>
  ),
  gitlab_project: (command) => (
    <>Paste the output of {command}, or project page ⋮ → Copy project ID.</>
  ),
  gitlab_group_list: (command) => (
    <>Paste the output of {command}. Add every subgroup whose projects call the gateway.</>
  ),
};

/**
 * A numeric ID with a human label, typed as `name (ID)` (A7.8). The hint names the command whose
 * output is exactly that format; IDs stay strings end to end (they can exceed 2^53).
 */
export function IdWithLabelField(
  props: Omit<FieldProps, 'pattern' | 'inputmode' | 'type'> & { kind: IdKind; findCommand: string },
) {
  const { kind, findCommand, hint, ...field } = props;
  return (
    <Field
      {...field}
      type="text"
      inputmode="text"
      pattern={ID_PATTERNS[kind]}
      spellcheck={false}
      autocapitalize="none"
      hint={
        <>
          {ID_HINTS[kind](<code>{findCommand}</code>)}
          {hasContent(hint) ? <> {hint}</> : null}
        </>
      }
    />
  );
}

export interface Option {
  value: string;
  label: string;
}
export type OptionList = Option[] | Array<{ group: string; options: Option[] }>;

function flatOptions(options: OptionList): Option[] {
  return options.flatMap((entry) => ('group' in entry ? entry.options : [entry]));
}

export interface SelectProps {
  name: string;
  label: string;
  id?: string;
  value?: string | null;
  options: OptionList;
  /** Rendered as a first `<option value="">`, selected while there is no value. */
  placeholder?: string;
  required?: boolean;
  hint?: Child;
  error?: string | null;
  labelHidden?: boolean;
  conditional?: boolean;
}

export function Select(props: SelectProps) {
  const id = props.id ?? fieldId(props.name);
  const value = props.value ?? '';
  const option = (entry: Option) => (
    <option value={entry.value} selected={entry.value === value}>
      {entry.label}
    </option>
  );
  return (
    <FieldFrame
      id={id}
      label={props.label}
      labelHidden={props.labelHidden}
      hint={props.hint}
      error={props.error}
    >
      <select
        id={id}
        name={props.name}
        required={!props.conditional && props.required ? true : undefined}
        aria-describedby={frameIds(id, props)}
        aria-invalid={props.error ? 'true' : undefined}
      >
        {props.placeholder !== undefined ? (
          <option value="" selected={value === ''}>
            {props.placeholder}
          </option>
        ) : null}
        {props.options.map((entry) =>
          'group' in entry ? (
            <optgroup label={entry.group}>{entry.options.map(option)}</optgroup>
          ) : (
            option(entry)
          ),
        )}
      </select>
    </FieldFrame>
  );
}

/**
 * A choice whose control follows the option count: 1 option is fixed text plus a hidden input
 * (nothing to decide), 2–6 are RadioCards, 7 or more a Select.
 */
export function Choice(props: SelectProps & { descriptions?: Record<string, Child> }) {
  const options = flatOptions(props.options);
  const [only] = options;
  if (options.length === 1 && only) {
    const id = props.id ?? fieldId(props.name);
    return (
      <div class="field">
        <p class="fixed" id={id}>
          <span class={props.labelHidden ? 'vh' : 'label'}>{props.label}:</span> {only.label}
        </p>
        <input type="hidden" name={props.name} value={only.value} />
        {hasContent(props.descriptions?.[only.value]) ? (
          <p class="hint">{props.descriptions?.[only.value]}</p>
        ) : null}
      </div>
    );
  }
  if (options.length >= 2 && options.length <= 6) {
    return (
      <RadioCards
        name={props.name}
        legend={props.label}
        legendHidden={props.labelHidden}
        value={props.value}
        idPrefix={props.id}
        hint={props.hint}
        error={props.error}
        options={options.map((option) => ({
          value: option.value,
          title: option.label,
          description: props.descriptions?.[option.value],
        }))}
      />
    );
  }
  return <Select {...props} />;
}

export interface RadioOption {
  value: string;
  title: string;
  description?: Child;
  disabled?: boolean;
  /** Rendered as "Risk: …" in the option's hint. */
  risk?: string;
  /** Shown only while this option is checked (CSS :has); never holds native validation. */
  reveal?: Child;
}

/**
 * Radio options as cards. The first radio has the group's field id, so an ErrorSummary link to
 * the group lands on it; the group error is on the fieldset and described from the first radio.
 */
export function RadioCards(props: {
  name: string;
  legend: string;
  legendHidden?: boolean;
  value?: string | null;
  idPrefix?: string;
  options: RadioOption[];
  hint?: Child;
  error?: string | null;
}) {
  const prefix = props.idPrefix ?? fieldId(props.name);
  const hintId = hasContent(props.hint) ? `${prefix}-hint` : null;
  const errorId = props.error ? `${prefix}-error` : null;
  return (
    <fieldset class="cards" data-invalid={props.error ? 'true' : undefined}>
      <legend class={props.legendHidden ? 'vh' : undefined}>{props.legend}</legend>
      {hintId ? (
        <p class="hint" id={hintId}>
          {props.hint}
        </p>
      ) : null}
      {errorId ? (
        <p class="field-error" id={errorId}>
          <span class="vh">Error:</span> {props.error}
        </p>
      ) : null}
      {props.options.map((option, index) => {
        const id = index === 0 ? prefix : `${prefix}-${index}`;
        const hasHint = hasContent(option.description) || option.risk !== undefined;
        return (
          <>
            <div class="choice">
              <input
                type="radio"
                id={id}
                name={props.name}
                value={option.value}
                checked={option.value === props.value}
                disabled={option.disabled}
                aria-describedby={describedBy([
                  hasHint && `${id}-desc`,
                  index === 0 && hintId,
                  index === 0 && errorId,
                ])}
                aria-invalid={index === 0 && props.error ? 'true' : undefined}
              />
              <label for={id}>{option.title}</label>
              {hasHint ? (
                <p class="hint" id={`${id}-desc`}>
                  {option.description}
                  {option.risk !== undefined ? (
                    <>
                      {hasContent(option.description) ? ' ' : null}
                      <strong>Risk:</strong> {option.risk}
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
            {hasContent(option.reveal) ? <div class="reveal">{option.reveal}</div> : null}
          </>
        );
      })}
    </fieldset>
  );
}

/** Checkboxes sharing one name; the server reads the submitted values as an array. */
export function CheckboxGroup(props: {
  name: string;
  legend: string;
  options: Array<{
    value: string;
    label: Child;
    hint?: Child;
    checked?: boolean;
    disabled?: boolean;
  }>;
  hint?: Child;
  error?: string | null;
  /** Accepted for symmetry with Field: a checkbox group never carries native validation. */
  conditional?: boolean;
}) {
  const prefix = fieldId(props.name);
  const hintId = hasContent(props.hint) ? `${prefix}-hint` : null;
  const errorId = props.error ? `${prefix}-error` : null;
  return (
    <fieldset class="checks" data-invalid={props.error ? 'true' : undefined}>
      <legend>{props.legend}</legend>
      {hintId ? (
        <p class="hint" id={hintId}>
          {props.hint}
        </p>
      ) : null}
      {errorId ? (
        <p class="field-error" id={errorId}>
          <span class="vh">Error:</span> {props.error}
        </p>
      ) : null}
      {props.options.map((option, index) => {
        const id = index === 0 ? prefix : `${prefix}-${index}`;
        return (
          <div class="choice">
            <input
              type="checkbox"
              id={id}
              name={props.name}
              value={option.value}
              checked={option.checked}
              disabled={option.disabled}
              aria-describedby={describedBy([
                hasContent(option.hint) && `${id}-desc`,
                index === 0 && hintId,
                index === 0 && errorId,
              ])}
            />
            <label for={id}>{option.label}</label>
            {hasContent(option.hint) ? (
              <p class="hint" id={`${id}-desc`}>
                {option.hint}
              </p>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}

export function Checkbox(props: {
  name: string;
  label: Child;
  checked?: boolean;
  hint?: Child;
  error?: string | null;
  required?: boolean;
  value?: string;
  id?: string;
}) {
  const id = props.id ?? fieldId(props.name);
  return (
    <div class="field checkbox" data-invalid={props.error ? 'true' : undefined}>
      <input
        type="checkbox"
        id={id}
        name={props.name}
        value={props.value ?? '1'}
        checked={props.checked}
        required={props.required}
        aria-describedby={describedBy([
          hasContent(props.hint) && `${id}-hint`,
          props.error && `${id}-error`,
        ])}
        aria-invalid={props.error ? 'true' : undefined}
      />
      <label for={id}>{props.label}</label>
      {hasContent(props.hint) ? (
        <p class="hint" id={`${id}-hint`}>
          {props.hint}
        </p>
      ) : null}
      {props.error ? (
        <p class="field-error" id={`${id}-error`}>
          <span class="vh">Error:</span> {props.error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One submit button per option (the button is the choice: "Invite as Viewer"). Options with
 * `confirm` render a dialog trigger instead; their dialogs follow every button, so the first plain
 * option stays the form's default button (Enter).
 */
export function SubmitButtons(props: {
  name: string;
  legend: string;
  options: Array<{
    value: string;
    label: string;
    context?: string;
    description?: Child;
    current?: boolean;
    confirm?: ConfirmDialogProps;
  }>;
}) {
  const plain = props.options.filter((option) => !option.confirm);
  const confirmed = props.options.filter((option) => option.confirm);
  return (
    <fieldset class="submits">
      <legend>{props.legend}</legend>
      <div class="actions">
        {plain.map((option) => (
          <span class="submit-option">
            <button
              type="submit"
              name={props.name}
              value={option.value}
              class={option.current ? 'secondary current' : 'secondary'}
              aria-describedby={
                hasContent(option.description)
                  ? `${fieldId(props.name)}-${option.value}-desc`
                  : undefined
              }
            >
              {option.label}
              {option.context ? <span class="vh"> {option.context}</span> : null}
              {option.current ? <span class="vh"> (current)</span> : null}
            </button>
            {hasContent(option.description) ? (
              <span class="hint" id={`${fieldId(props.name)}-${option.value}-desc`}>
                {option.description}
              </span>
            ) : null}
          </span>
        ))}
        {confirmed.map((option) =>
          option.confirm ? <ConfirmTrigger {...option.confirm} /> : null,
        )}
      </div>
      {confirmed.map((option) => (option.confirm ? <ConfirmBox {...option.confirm} /> : null))}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// Messages

/**
 * "There is a problem", focused on load (no role=alert: autofocus already announces it). Field
 * errors link to their control; other errors are plain items.
 */
export function ErrorSummary(props: { errors: FieldError[] }) {
  if (props.errors.length === 0) return null;
  return (
    <div class="error-summary" tabindex={-1} autofocus aria-labelledby="es-h">
      <h2 id="es-h">There is a problem</h2>
      <ul>
        {props.errors.map((error) => (
          <li>
            {error.field ? <a href={`#${fieldId(error.field)}`}>{error.message}</a> : error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A success notice after a POST-redirect-GET (notice.ts), focused on load unless errors are. */
export function NoticeView(props: { notice: Notice; csrf: string; autofocus?: boolean }) {
  const { notice } = props;
  return (
    <div class="notice" role="status" tabindex={-1} autofocus={props.autofocus !== false}>
      <p>{notice.text}</p>
      {notice.next || notice.undo ? (
        <p class="actions">
          {notice.next ? <a href={notice.next.href}>{notice.next.label}</a> : null}
          {notice.undo ? (
            <PostForm action={notice.undo.action} csrf={props.csrf} class="inline">
              <HiddenFields fields={notice.undo.fields} />
              <button type="submit" class="secondary">
                {notice.undo.label}
              </button>
            </PostForm>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Confirmation dialogs

export type ConfirmDialogProps = {
  /** Suffix of the dialog id: `dlg-<id>`. */
  id: string;
  /** Visible trigger text, for example "Delete…". */
  trigger: string;
  triggerContext?: string;
  title: string;
  body: Child;
  affected?: Child[];
  confirmLabel: string;
  danger?: boolean;
} & (
  | {
      variant: 'standalone';
      action: string;
      csrf: string;
      fields?: Record<string, string>;
      returnTo?: string;
    }
  | { variant: 'submits'; formId: string; name?: string; value?: string; formnovalidate?: boolean }
);

/**
 * A trigger button and its modal dialog. `standalone` holds its own form with `confirm=1`;
 * `submits` submits another form (`formId`) and must be placed after that form in tree order, so
 * the form's default button does not change.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <>
      <ConfirmTrigger {...props} />
      <ConfirmBox {...props} />
    </>
  );
}

/**
 * The trigger alone. `type="button"`: per the HTML spec a submit button inside a form runs no
 * command. `commandfor` opens a real modal; `popovertarget` is the fallback without invoker
 * commands; without either the dialog is shown inline by CSS and the trigger hidden.
 */
export function ConfirmTrigger(props: ConfirmDialogProps) {
  const dialogId = `dlg-${props.id}`;
  return (
    <button
      type="button"
      class={props.danger ? 'confirm-trigger danger' : 'confirm-trigger secondary'}
      commandfor={dialogId}
      command="show-modal"
      popovertarget={dialogId}
    >
      {props.trigger}
      {props.triggerContext ? <span class="vh"> {props.triggerContext}</span> : null}
    </button>
  );
}

/** The dialog alone (see ConfirmTrigger). */
export function ConfirmBox(props: ConfirmDialogProps) {
  const dialogId = `dlg-${props.id}`;
  const confirmClass = props.danger ? 'danger' : 'primary';
  return (
    <dialog id={dialogId} class="confirm" popover="auto" aria-labelledby={`${dialogId}-h`}>
      <h2 id={`${dialogId}-h`}>{props.title}</h2>
      <p>{props.body}</p>
      {props.affected && props.affected.length > 0 ? (
        <ul class="affected">
          {props.affected.map((item) => (
            <li>{item}</li>
          ))}
        </ul>
      ) : null}
      <div class="actions">
        {props.variant === 'standalone' ? (
          <PostForm
            action={props.action}
            csrf={props.csrf}
            class="inline"
            returnTo={props.returnTo}
          >
            <HiddenFields fields={props.fields} />
            <input type="hidden" name="confirm" value="1" />
            <button type="submit" class={confirmClass}>
              {props.confirmLabel}
            </button>
          </PostForm>
        ) : (
          <button
            type="submit"
            form={props.formId}
            name={props.name ?? 'confirm'}
            value={props.value ?? '1'}
            formnovalidate={props.formnovalidate}
            class={confirmClass}
          >
            {props.confirmLabel}
          </button>
        )}
        <button
          type="button"
          class="secondary"
          commandfor={dialogId}
          command="close"
          popovertarget={dialogId}
          popovertargetaction="hide"
          autofocus
        >
          Cancel
        </button>
      </div>
    </dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Navigation

/**
 * Links as tabs (no ARIA tab roles: those need script). The current item gets
 * aria-current="page", or "true" when the page is below it (a token page under Tokens).
 */
export function Tabs(props: {
  label: string;
  items: Array<{ key: string; href: string; label: string; count?: number }>;
  current: string;
  class?: string;
  currentState?: 'page' | 'true';
}) {
  return (
    <nav aria-label={props.label} class={props.class ?? 'tabs'}>
      <ul>
        {props.items.map((item) => (
          <li>
            <a
              href={item.href}
              aria-current={item.key === props.current ? (props.currentState ?? 'page') : undefined}
            >
              {item.label}
              {item.count !== undefined ? (
                <>
                  {' '}
                  <span class="count">{item.count}</span>
                </>
              ) : null}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** `Service tokens › Slack bot › Change secret`; the last item is the current page. */
export function Breadcrumbs(props: { items: Array<{ href: string; label: string }> }) {
  const last = props.items.length - 1;
  return (
    <nav aria-label="Breadcrumb" class="breadcrumb">
      <ol>
        {props.items.map((item, index) => (
          <li>
            <a href={item.href} aria-current={index === last ? 'page' : undefined}>
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Newest, newer and older links of a keyset-paginated list. */
export function Pager(props: {
  newest?: string | null;
  newer?: string | null;
  older?: string | null;
}) {
  if (!props.newest && !props.newer && !props.older) return null;
  return (
    <nav aria-label="Pages" class="pager">
      {props.newest ? <a href={props.newest}>Newest entries</a> : null}
      {props.newer ? (
        <a href={props.newer}>
          <span aria-hidden="true">← </span>Newer entries
        </a>
      ) : null}
      {props.older ? (
        <a href={props.older}>
          Older entries<span aria-hidden="true"> →</span>
        </a>
      ) : null}
    </nav>
  );
}

/** The active filters of a list, each removable, plus "Clear filters". */
export function FilterChips(props: {
  items: Array<{ label: string; removeHref: string }>;
  clearHref: string;
}) {
  if (props.items.length === 0) return null;
  return (
    <ul class="chips filters" aria-label="Active filters">
      {props.items.map((item) => (
        <li>
          <a class="chip" href={item.removeHref}>
            {item.label}
            <span class="vh"> (remove this filter)</span>
            <span aria-hidden="true"> ×</span>
          </a>
        </li>
      ))}
      <li>
        <a href={props.clearHref}>Clear filters</a>
      </li>
    </ul>
  );
}

// ---------------------------------------------------------------------------------------------
// Data display

/** `<span class="badge <tone>">` with an aria-hidden glyph; the label carries the meaning. */
export function StatusBadge(props: { status: StatusKey; detail?: string }) {
  const info = STATUS[props.status];
  return (
    <span class={`badge ${info.tone}`}>
      {info.glyph ? <span aria-hidden="true">{info.glyph} </span> : null}
      {statusLabel(props.status, props.detail)}
    </span>
  );
}

export interface ChipProps {
  href?: string;
  text: string;
  secondary?: string;
  status?: StatusKey;
  statusDetail?: string;
  /** The full sentence a screen reader hears: "acme/api in production can use Slack bot: Active". */
  srText: string;
}

export function Chip(props: ChipProps) {
  const visible = (
    <span aria-hidden="true">
      {props.text}
      {props.secondary ? <span class="secondary-text"> {props.secondary}</span> : null}
      {props.status ? (
        <>
          {' '}
          <StatusBadge status={props.status} detail={props.statusDetail} />
        </>
      ) : null}
    </span>
  );
  const spoken = <span class="vh">{props.srText}</span>;
  return props.href ? (
    <a class="chip" href={props.href}>
      {visible}
      {spoken}
    </a>
  ) : (
    <span class="chip">
      {visible}
      {spoken}
    </span>
  );
}

export function ChipList(props: {
  label: string;
  items: ChipProps[];
  max?: number;
  moreHref?: string;
  moreText?: string;
}) {
  const max = props.max ?? 6;
  const shown = props.items.slice(0, max);
  const rest = props.items.length - shown.length;
  return (
    <ul class="chips" aria-label={props.label}>
      {shown.map((item) => (
        <li>
          <Chip {...item} />
        </li>
      ))}
      {rest > 0 ? (
        <li>
          {props.moreHref ? (
            <a href={props.moreHref}>{props.moreText ?? `and ${rest} more`}</a>
          ) : (
            (props.moreText ?? `and ${rest} more`)
          )}
        </li>
      ) : null}
    </ul>
  );
}

export function EmptyState(props: { title?: string; children: Child; action?: Child }) {
  return (
    <div class="empty">
      {props.title ? <h2>{props.title}</h2> : null}
      <p>{props.children}</p>
      {hasContent(props.action) ? <div class="actions">{props.action}</div> : null}
    </div>
  );
}

export interface Column<R> {
  key: string;
  header: string;
  numeric?: boolean;
  render: (row: R) => Child;
}

/**
 * Every table: inside a labelled, focusable region that scrolls on its own (never the page,
 * WCAG 1.4.10), with a caption, column headers and a row header cell.
 */
export function DataTable<R>(props: {
  id: string;
  caption: string;
  captionHidden?: boolean;
  columns: Array<Column<R>>;
  /** Key of the column whose cells are row headers. */
  rowHeader: string;
  rows: readonly R[];
  /** Shown instead of the table when there are no rows. */
  empty?: Child;
}) {
  if (props.rows.length === 0 && hasContent(props.empty)) return <>{props.empty}</>;
  const captionId = `${props.id}-cap`;
  return (
    <div class="table-region" role="region" aria-labelledby={captionId} tabindex={0}>
      <table id={props.id}>
        <caption id={captionId} class={props.captionHidden ? 'vh' : undefined}>
          {props.caption}
        </caption>
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th scope="col" class={column.numeric ? 'num' : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row) => (
            <tr>
              {props.columns.map((column) =>
                column.key === props.rowHeader ? (
                  <th scope="row" class={column.numeric ? 'num' : undefined}>
                    {column.render(row)}
                  </th>
                ) : (
                  <td class={column.numeric ? 'num' : undefined}>{column.render(row)}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Key/value list for detail pages; each fact once. */
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

/** `<time datetime>` in UTC, plus "3 min ago" when `relative`. */
export function Time(props: { ms: number; relative?: boolean; now?: number }) {
  return (
    <>
      <time datetime={new Date(props.ms).toISOString()}>{formatTime(props.ms)}</time>
      {props.relative && props.now !== undefined ? (
        <span class="muted"> ({relativeTime(props.ms, props.now)})</span>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Role-aware help

/**
 * Who can make a change the viewer cannot: active users whose role holds `permission`, owners
 * last, at most 3 named. The same wording everywhere (WCAG 3.2.4). Every role can already see
 * these emails on Users, so this discloses nothing new.
 */
export function AskSomeone(props: { permission: Permission; ctx: ViewContext; verb?: string }) {
  const [least] = rolesFor(props.permission).filter((role) => role !== 'viewer');
  const noun = least ? ROLE_INFO[least].noun : 'an owner';
  const people = props.ctx.askers(props.permission);
  const more = props.ctx.askersMore(props.permission);
  const lead = `Ask ${noun}${props.verb ? ` to ${props.verb}` : ''}`;
  if (people.length === 0) return <p class="ask">{lead}.</p>;
  return (
    <p class="ask">
      {lead}:{' '}
      {people.map((person, index) => (
        <>
          {index > 0 ? (index === people.length - 1 && more === 0 ? ' or ' : ', ') : null}
          <a href={`mailto:${person.email}`}>{person.email}</a>
        </>
      ))}
      {more > 0 ? ` and ${more} more` : ''}.
    </p>
  );
}

const NOT_FOUND_TEXT: Readonly<
  Record<'page' | 'token' | 'consumer' | 'access' | 'user' | 'request', string>
> = {
  page: 'There is no page at this address.',
  token: 'There is no service token with this ID. It may have been deleted.',
  consumer: 'There is no service consumer with this ID. It may have been deleted.',
  access: 'There is no consumer access with this ID. It may have been deleted.',
  user: 'There is no user with this ID. They may have been deleted.',
  request: 'There is no request record with this ID. It may have been purged by data retention.',
};

const SECTION_LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: paths.overview(), label: 'Monitoring' },
  { href: paths.users(), label: 'Users' },
  { href: paths.tokens(), label: 'Service tokens' },
  { href: paths.consumers(), label: 'Service consumers' },
];

/** The body of every not-found page. Static text only: the requested path is never echoed. */
export function NotFound(props: {
  what: 'page' | 'token' | 'consumer' | 'access' | 'user' | 'request';
  hint?: Child;
}) {
  return (
    <>
      {hasContent(props.hint) ? <div class="moved">{props.hint}</div> : null}
      <p>{NOT_FOUND_TEXT[props.what]} Go to one of the sections:</p>
      <ul>
        {SECTION_LINKS.map((section) => (
          <li>
            <a href={section.href}>{section.label}</a>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Alerts (the Overview problems and each object page's own)

export type AlertCode =
  | 'keyring_unavailable'
  | 'key_missing'
  | 'key_changed'
  | 'credential_malformed'
  | 'key_not_active'
  | 'credential_expired'
  | 'credential_expiring'
  | 'credential_missing_used'
  | 'upstream_auth'
  | 'outside_hosts'
  | 'schema_behind'
  | 'schema_ahead'
  | 'schema_unknown'
  | 'config_problem'
  | 'cron_failing'
  | 'cron_stale'
  | 'cron_never'
  | 'access_expiring'
  | 'users_need_decision'
  | 'single_owner';

export type PendingUser = Pick<User, 'id' | 'email' | 'updated_at'>;

export interface Alert {
  code: AlertCode;
  level: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
  /** Always shown. */
  objects: Array<{ href: string; label: string }>;
  /** Shown only to holders of `permission`; others see AskSomeone(permission). */
  fix?: { href: string; label: string; permission: Permission } | null;
  form?:
    | { kind: 'approve-pending'; users: PendingUser[] }
    | { kind: 'rewrap'; count: number }
    | null;
}

const ALERT_PREFIX: Readonly<Record<Alert['level'], string>> = {
  error: 'Error:',
  warning: 'Warning:',
  info: 'Note:',
};

/** Static list (no role=alert); past `max` the rest sit in a closed details. */
export function AlertList(props: { alerts: Alert[]; ctx: ViewContext; max?: number }) {
  if (props.alerts.length === 0) return null;
  const max = props.max ?? 10;
  const shown = props.alerts.slice(0, max);
  const rest = props.alerts.slice(max);
  return (
    <>
      <ul class="alerts">
        {shown.map((alert) => (
          <AlertItem alert={alert} ctx={props.ctx} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details>
          <summary>
            {rest.length} more {rest.length === 1 ? 'problem' : 'problems'}
          </summary>
          <ul class="alerts">
            {rest.map((alert) => (
              <AlertItem alert={alert} ctx={props.ctx} />
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function AlertItem(props: { alert: Alert; ctx: ViewContext }) {
  const { alert, ctx } = props;
  const form = alert.form ?? null;
  return (
    <li class={`alert alert-${alert.level}`}>
      <p>
        <strong>{ALERT_PREFIX[alert.level]}</strong> {alert.title}
        {alert.detail ? <> {alert.detail}</> : null}
      </p>
      {alert.objects.length > 0 ? (
        <p class="objects">
          {alert.objects.map((object, index) => (
            <>
              {index > 0 ? ' · ' : null}
              <a href={object.href}>{object.label}</a>
            </>
          ))}
        </p>
      ) : null}
      {alert.fix ? (
        ctx.can(alert.fix.permission) ? (
          <p>
            <a href={alert.fix.href}>{alert.fix.label}</a>
          </p>
        ) : (
          <AskSomeone permission={alert.fix.permission} ctx={ctx} />
        )
      ) : null}
      {form?.kind === 'rewrap' && ctx.can('keyring:rewrap') ? (
        <PostForm
          action="/admin/tokens/keys/rewrap"
          csrf={ctx.csrf}
          class="inline"
          returnTo="overview"
        >
          <button type="submit" class="secondary">
            Re-encrypt {form.count} {form.count === 1 ? 'secret' : 'secrets'} with the active key
          </button>
        </PostForm>
      ) : null}
      {form?.kind === 'approve-pending' ? (
        ctx.can('users:write') ? (
          <ul class="pending">
            {form.users.map((user) => (
              <li>
                <ApproveForm user={user} ctx={ctx} returnTo="overview" compact />
              </li>
            ))}
          </ul>
        ) : (
          <AskSomeone permission="users:write" ctx={ctx} />
        )
      ) : null}
    </li>
  );
}
