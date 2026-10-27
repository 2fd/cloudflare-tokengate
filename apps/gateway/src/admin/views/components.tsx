// Shared admin adapters over the design system (@tokengate/ui, ADR 0022). An adapter stays here
// only where the admin adds behavior: the field id convention, conditional validation, the status
// vocabulary, who to ask, the not-found texts. Everything else, a page takes from @tokengate/ui
// directly. Hono JSX escapes all interpolated text, dangerouslySetInnerHTML is a lint error (oxlint
// react/no-danger), and nothing here uses style= or script (CSP). Conventions behind the markup:
// - ids: a field named `a.b` has the id `f-a-b` (fieldId), its hint `…-hint`, its error `…-error`;
//   a group of choices (FieldSet) has the field id, and its inputs `…-1`, `…-2` …; an ErrorSummary
//   link to the group lands on its first enabled input (FocusTargets, filled while the body renders).
// - native validation (required, pattern, min, …) only on controls that are visible whenever their
//   form can be submitted; `conditional` drops it for controls inside a .reveal or closed details.
// - dialogs open with invoker commands and fall back to popover; the server always requires the
//   confirm value, so the dialog is never the only guard.
import {
  ActionForm,
  AskSomeone as UiAskSomeone,
  Badge,
  Checkbox as UiCheckbox,
  Chip as UiChip,
  ConfirmDialog as UiConfirmDialog,
  DialogTrigger,
  EmptyState as UiEmptyState,
  ErrorSummary as UiErrorSummary,
  Field as UiField,
  FieldSet,
  FixedBar,
  firstChoiceId,
  Input,
  KeyValue,
  type LinkCard,
  LinkCards,
  Notice,
  Pager as UiPager,
  RadioCards as UiRadioCards,
  Select as UiSelect,
  type SelectOption,
  type Suggestion,
  Tabs as UiTabs,
  Textarea,
  Time as UiTime,
  Button,
  Callout,
  Panel,
  Tray,
} from '@tokengate/ui';
import { type Child, createContext, useContext } from 'hono/jsx';
import { CSRF_FIELD } from '../auth/csrf';
import type { Permission } from '../auth/rbac';
import type { Notice as NoticeData } from '../notice';
import type { FieldError } from '../ops/shared';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { relativeTime } from './format';
import { ROLE_INFO, rolesFor } from './roles';
import { STATUS, type StatusKey, statusLabel, uiTone } from './status';

export type { Suggestion } from '@tokengate/ui';
export type { Tone } from './status';

/** The id of the control for form field `name` (`.` becomes `-`, as in `f-rules-0-path`). */
export function fieldId(name: string): string {
  return `f-${name.replace(/[.]/g, '-')}`;
}

/**
 * Field ids that are on an element that cannot take focus (a group's fieldset), mapped to the
 * control an ErrorSummary link must land on (the group's first enabled input). The group adapters
 * fill it while the page body renders; renderPage renders the body first, then the summary.
 */
export const FocusTargets = createContext<Map<string, string> | null>(null);

/** The ErrorSummary target of field `name`: its control, also when the field is a group. */
export function focusTarget(targets: ReadonlyMap<string, string>, name: string): string {
  const id = fieldId(name);
  return targets.get(id) ?? id;
}

function hasContent(child: Child | undefined): boolean {
  return child !== undefined && child !== null && child !== false && child !== '';
}

/** The ids of `ids` that are set, as one attribute value (undefined when none is). */
function idList(ids: Array<string | null | undefined | false>): string | undefined {
  const present = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return present.length > 0 ? present.join(' ') : undefined;
}

// ---------------------------------------------------------------------------------------------
// Forms

/** Hidden synchronizer token required on every POST form (I-CSRF-1). */
function Csrf(props: { token: string }) {
  return <input type="hidden" name={CSRF_FIELD} value={props.token} />;
}

/**
 * Hidden `updated_at` of the row an edit form shows, so a save over someone else's newer change
 * is refused (optimistic concurrency; ops compare it as `expected_updated_at`).
 */
export function VersionField(props: { value: string }) {
  return <input type="hidden" name="expected_updated_at" value={props.value} />;
}

/** The hidden fields of a one-button form: `_csrf` first, then `_return`, then the rest. */
function hiddenFields(
  csrf: string,
  fields?: Record<string, string>,
  returnTo?: string,
): Record<string, string> {
  return { [CSRF_FIELD]: csrf, ...(returnTo ? { _return: returnTo } : {}), ...fields };
}

/**
 * A POST form that always carries the CSRF token, so no page can forget it (I-CSRF-1). For a form
 * with several controls; a one-button form is an ActionButton (ui ActionForm).
 */
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
 * A POST form rendered as one button (ui ActionForm). `context` is appended visually hidden, so
 * repeated buttons have distinct accessible names that start with the visible label ("Disable" +
 * " Slack bot").
 */
export function ActionButton(props: {
  action: string;
  csrf: string;
  label: string;
  context?: string;
  tone?: 'primary' | 'secondary' | 'danger';
  /** `sm` in table rows, callouts and notices. */
  size?: 'sm';
  fields?: Record<string, string>;
  returnTo?: string;
}) {
  return (
    <ActionForm
      action={props.action}
      hidden={hiddenFields(props.csrf, props.fields, props.returnTo)}
      variant={props.tone ?? 'secondary'}
      size={props.size}
      srSuffix={props.context}
    >
      {props.label}
    </ActionForm>
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
  /** Mono type for IDs, paths, URLs: also no autocomplete, spellcheck or autocapitalize. */
  mono?: boolean;
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
  /** Extra ids for aria-describedby, after the hint and error. */
  describedBy?: string[];
  enterkeyhint?: 'send' | 'done' | 'go';
  /** Page-level focus target (the first new row after "Add rows"). */
  autofocus?: boolean;
}

/**
 * A labelled input (ui Field + Input). `type="password"` is a ui secret input: it never renders a
 * value and password managers leave it alone (A7.8). A conditional control is plain text without
 * native validation: a hidden control the browser refuses (badInput, typeMismatch, step) blocks the
 * submit and cannot be focused, so the server validates it.
 */
export function Field(props: FieldProps) {
  const id = props.id ?? fieldId(props.name);
  const conditional = props.conditional === true;
  let type = props.type ?? 'text';
  let inputmode = props.inputmode;
  let hint = props.hint;
  if (conditional && (type === 'url' || type === 'email')) {
    inputmode = inputmode ?? type;
    type = 'text';
  } else if (conditional && type === 'number') {
    inputmode = inputmode ?? 'numeric';
    type = 'text';
  } else if (conditional && type === 'date') {
    hint = hasContent(hint) ? (
      <>{hint} Use a date like 2027-01-31.</>
    ) : (
      'Use a date like 2027-01-31.'
    );
    type = 'text';
  }
  const common = {
    name: props.name,
    placeholder: props.example,
    required: !conditional && props.required ? true : undefined,
    pattern: conditional ? undefined : props.pattern,
    minlength: conditional ? undefined : props.minlength,
    maxlength: props.maxlength,
    inputmode,
    autocomplete: props.autocomplete,
    spellcheck: props.spellcheck,
    autocapitalize: props.autocapitalize,
    readonly: props.readonly,
    disabled: props.disabled,
    enterkeyhint: props.enterkeyhint,
    autofocus: props.autofocus,
    describedBy: idList(props.describedBy ?? []),
  };
  return (
    <UiField id={id} label={props.label} optional={props.optional} hint={hint} error={props.error}>
      {type === 'password' ? (
        // A secret is never autofilled or corrected, whatever the caller passes (A7.8).
        <Input
          {...common}
          secret
          autocomplete="off"
          spellcheck={undefined}
          autocapitalize={undefined}
        />
      ) : (
        <Input
          {...common}
          type={type}
          mono={props.mono}
          value={props.value == null ? '' : props.value}
          min={conditional ? undefined : props.min}
          max={conditional ? undefined : props.max}
          step={conditional ? undefined : props.step}
          suggestions={props.suggestions}
        />
      )}
    </UiField>
  );
}

/** Multi-line text (ui Field + Textarea). `spellcheck={false}` means exact values: mono. */
export function TextArea(
  props: Omit<
    FieldProps,
    'type' | 'pattern' | 'inputmode' | 'min' | 'max' | 'step' | 'suggestions' | 'mono'
  > & {
    rows?: number;
  },
) {
  const id = props.id ?? fieldId(props.name);
  const conditional = props.conditional === true;
  return (
    <UiField
      id={id}
      label={props.label}
      optional={props.optional}
      hint={props.hint}
      error={props.error}
    >
      <Textarea
        name={props.name}
        rows={props.rows ?? 4}
        placeholder={props.example}
        required={!conditional && props.required ? true : undefined}
        maxlength={props.maxlength}
        mono={props.spellcheck === false}
        readonly={props.readonly}
        disabled={props.disabled}
        describedBy={idList(props.describedBy ?? [])}
        value={props.value == null ? '' : String(props.value)}
      />
    </UiField>
  );
}

export type IdKind =
  | 'github_repo'
  | 'github_owner_list'
  | 'gitlab_project'
  | 'gitlab_group_list'
  | 'vercel_project'
  | 'vercel_team';

const GITHUB_OWNER = '[A-Za-z0-9\\-]{1,39} \\([0-9]{1,20}\\)';
const GITLAB_GROUP = '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)* \\([0-9]{1,20}\\)';
const VERCEL_TEAM = '[a-z0-9][a-z0-9\\-]{0,47} \\(team_[A-Za-z0-9]{1,64}\\)';

/** The `name (ID)` formats of A7.8, as HTML patterns (compiled with the `v` flag by browsers). */
export const ID_PATTERNS: Readonly<Record<IdKind, string>> = {
  github_repo: '[A-Za-z0-9\\-]{1,39}/[A-Za-z0-9_.\\-]{1,100} \\([0-9]{1,20}\\)|[0-9]{1,20}',
  github_owner_list: `${GITHUB_OWNER}(?:, *${GITHUB_OWNER})*`,
  gitlab_project: '[A-Za-z0-9_.\\-]+(?:/[A-Za-z0-9_.\\-]+)+ \\([0-9]{1,20}\\)|[0-9]{1,20}',
  gitlab_group_list: `${GITLAB_GROUP}(?:, *${GITLAB_GROUP})*`,
  vercel_project: '[a-z0-9][a-z0-9._\\-]{0,99} \\(prj_[A-Za-z0-9]{1,64}\\)|prj_[A-Za-z0-9]{1,64}',
  vercel_team: `${VERCEL_TEAM}(?:, *${VERCEL_TEAM})*`,
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
  vercel_project: (command) => (
    <>
      Pick one used before, or run {command} in a linked directory, or copy the Project ID from
      Project Settings › General.
    </>
  ),
  vercel_team: (command) => (
    <>
      The slug is in the dashboard URL (vercel.com/acme); the Team ID is in Team Settings › General,
      or the output of {command} in a linked directory.
    </>
  ),
};

/**
 * An ID with a human label, typed as `name (ID)` (A7.8). The hint names the command whose
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
      mono
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
  /** Rendered as a first `<option value="">`, selected while there is no value. It stays selectable. */
  placeholder?: string;
  required?: boolean;
  hint?: Child;
  error?: string | null;
  conditional?: boolean;
}

/**
 * A labelled select (ui Field + Select). The placeholder is an ordinary first option, so a filter
 * can go back to "any" (ui disables its own placeholder once a value is set).
 */
export function Select(props: SelectProps) {
  const id = props.id ?? fieldId(props.name);
  const options: Array<SelectOption | { group: string; options: readonly SelectOption[] }> = [
    ...(props.placeholder !== undefined ? [{ value: '', label: props.placeholder }] : []),
    ...props.options,
  ];
  return (
    <UiField id={id} label={props.label} hint={props.hint} error={props.error}>
      <UiSelect
        name={props.name}
        options={options}
        value={props.value ?? ''}
        required={!props.conditional && props.required ? true : undefined}
      />
    </UiField>
  );
}

/**
 * A choice whose control follows the option count: 1 option is a fixed fact plus a hidden input
 * (nothing to decide), 2–6 are RadioCards, 7 or more a Select.
 */
export function Choice(props: SelectProps & { descriptions?: Record<string, Child> }) {
  const options = flatOptions(props.options);
  const [only] = options;
  if (options.length === 1 && only) {
    const id = props.id ?? fieldId(props.name);
    return (
      <div class="field" id={id}>
        <FixedBar label={props.label} name={only.label} />
        <input type="hidden" name={props.name} value={only.value} />
        {hasContent(props.descriptions?.[only.value]) ? (
          <span class="hint">{props.descriptions?.[only.value]}</span>
        ) : null}
        {hasContent(props.hint) ? (
          <span class="hint" id={`${id}-hint`}>
            {props.hint}
          </span>
        ) : null}
        {props.error ? (
          <p class="field-error" id={`${id}-error`}>
            <span aria-hidden="true">✕</span>
            <span class="vh">Error:</span> {props.error}
          </p>
        ) : null}
      </div>
    );
  }
  if (options.length >= 2 && options.length <= 6) {
    return (
      <RadioCards
        name={props.name}
        legend={props.label}
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
  /** A risky option: a "⚠ Risk" tag, and "Risk: …" after the description. */
  risk?: string;
  /**
   * Fields this option needs. Transitional: rendered after the cards and always shown (the
   * section stages move them into a ui LiveForm Reveal). Never holds native validation.
   */
  reveal?: Child;
}

/**
 * Radio options as cards (ui FieldSet + RadioCards). The fieldset has the field id and the radios
 * are `${id}-1`, `${id}-2` … An ErrorSummary link to the field lands on the first enabled radio
 * (FocusTargets), which is aria-invalid on an error. The group's hint and error describe the
 * fieldset.
 */
export function RadioCards(props: {
  name: string;
  legend: string;
  value?: string | null;
  idPrefix?: string;
  options: RadioOption[];
  hint?: Child;
  error?: string | null;
}) {
  const prefix = props.idPrefix ?? fieldId(props.name);
  const reveals = props.options.filter((option) => hasContent(option.reveal));
  useContext(FocusTargets)?.set(
    prefix,
    firstChoiceId(
      prefix,
      props.options.map((option) => ({ value: option.value, disabled: option.disabled })),
    ),
  );
  return (
    <FieldSet id={prefix} legend={props.legend} hint={props.hint} error={props.error}>
      <UiRadioCards
        name={props.name}
        invalid={props.error ? true : undefined}
        value={props.value ?? undefined}
        options={props.options.map((option) => ({
          value: option.value,
          title: option.title,
          disabled: option.disabled,
          risk: option.risk !== undefined,
          description:
            option.risk !== undefined ? (
              <>
                {option.description}
                {hasContent(option.description) ? ' ' : null}
                <strong>Risk:</strong> {option.risk}
              </>
            ) : (
              option.description
            ),
        }))}
      />
      {reveals.map((option) => (
        <div class="reveal">{option.reveal}</div>
      ))}
    </FieldSet>
  );
}

/**
 * Checkboxes sharing one name (ui FieldSet + Checkbox rows); the server reads the submitted values
 * as an array. The fieldset has the field id; the boxes are `${id}-1`, `${id}-2` … An ErrorSummary
 * link lands on the first enabled box, which is aria-invalid on an error.
 */
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
  const first = firstChoiceId(prefix, props.options);
  useContext(FocusTargets)?.set(prefix, first);
  return (
    <FieldSet id={prefix} legend={props.legend} hint={props.hint} error={props.error}>
      {props.options.map((option, index) => (
        <UiCheckbox
          id={`${prefix}-${index + 1}`}
          name={props.name}
          value={option.value}
          checked={option.checked}
          disabled={option.disabled}
          hint={hasContent(option.hint) ? option.hint : undefined}
          invalid={props.error && `${prefix}-${index + 1}` === first ? true : undefined}
        >
          {option.label}
        </UiCheckbox>
      ))}
    </FieldSet>
  );
}

/** One checkbox (ui Checkbox). It always sends `1` unless a value is given (servers read `1`). */
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
    <UiCheckbox
      id={id}
      name={props.name}
      value={props.value ?? '1'}
      checked={props.checked}
      required={props.required}
      hint={hasContent(props.hint) ? props.hint : undefined}
      error={props.error || undefined}
    >
      {props.label}
    </UiCheckbox>
  );
}

// ---------------------------------------------------------------------------------------------
// Messages

/**
 * "There is a problem" (ui ErrorSummary): focused on load, `role="group"` (no role=alert:
 * autofocus already announces it). Field errors link to their control (`target`, default fieldId;
 * renderPage passes focusTarget, so a group links to its first input); other errors are plain items.
 */
export function ErrorSummary(props: {
  errors: FieldError[];
  target?: (field: string) => string;
  title?: Child;
  description?: Child;
}) {
  const target = props.target ?? fieldId;
  return (
    <UiErrorSummary
      role="group"
      title={props.title}
      description={props.description}
      errors={props.errors.map((error) => ({
        target: error.field ? target(error.field) : undefined,
        message: error.message,
      }))}
    />
  );
}

/** A success notice after a POST-redirect-GET (notice.ts), focused on load unless errors are. */
export function NoticeView(props: { notice: NoticeData; csrf: string; autofocus?: boolean }) {
  const { notice } = props;
  const actions =
    notice.next || notice.undo ? (
      <>
        {notice.next ? (
          <Button href={notice.next.href} size="sm">
            {notice.next.label}
          </Button>
        ) : null}
        {notice.undo ? (
          <ActionForm
            action={notice.undo.action}
            size="sm"
            srSuffix={notice.undo.srSuffix}
            hidden={{ [CSRF_FIELD]: props.csrf, ...notice.undo.fields }}
          >
            {notice.undo.label}
          </ActionForm>
        ) : null}
      </>
    ) : undefined;
  return (
    <Notice
      title={notice.text}
      more={notice.more}
      actions={actions}
      autofocus={props.autofocus !== false}
    />
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
  /** What happens, one fact per item. */
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
 * A trigger button and its modal dialog (ui DialogTrigger + ConfirmDialog). `standalone` posts its
 * own form with `confirm=1`; `submits` submits another form (`formId`) and must be placed after
 * that form's default button in tree order.
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <>
      <ConfirmTrigger {...props} />
      <ConfirmBox {...props} />
    </>
  );
}

/** The trigger alone: `type="button"`, so it never submits a surrounding form. */
export function ConfirmTrigger(props: ConfirmDialogProps) {
  return (
    <DialogTrigger
      dialog={`dlg-${props.id}`}
      variant={props.danger ? 'danger' : 'secondary'}
      srSuffix={props.triggerContext}
    >
      {props.trigger}
    </DialogTrigger>
  );
}

/** The dialog alone (see ConfirmTrigger). The server requires `confirm` in both variants. */
export function ConfirmBox(props: ConfirmDialogProps) {
  const common = {
    id: `dlg-${props.id}`,
    title: props.title,
    description: props.body,
    consequences: props.affected,
    confirmLabel: props.confirmLabel,
    confirmVariant: props.danger ? ('danger-solid' as const) : ('primary' as const),
  };
  return props.variant === 'standalone' ? (
    <UiConfirmDialog
      {...common}
      action={props.action}
      hidden={{ ...hiddenFields(props.csrf, props.fields, props.returnTo), confirm: '1' }}
    />
  ) : (
    <UiConfirmDialog
      {...common}
      form={props.formId}
      name={props.name}
      value={props.value}
      formnovalidate={props.formnovalidate}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Navigation

/**
 * Views of one object or one list as tabs (ui Tabs; links, no ARIA tab roles). The current item
 * gets aria-current="page", or "true" when the page is below it. Never the section subnav: that
 * is the sidebar.
 */
export function Tabs(props: {
  label: string;
  items: Array<{ key: string; href: string; label: string; count?: number }>;
  current: string;
  class?: string;
  currentState?: 'page' | 'true';
}) {
  return (
    <UiTabs
      label={props.label}
      class={props.class}
      items={props.items.map((item) => ({
        label: item.label,
        href: item.href,
        count: item.count,
        current: item.key === props.current ? (props.currentState ?? 'page') : undefined,
      }))}
    />
  );
}

/** Newest, newer and older links of a keyset-paginated list (ui Pager with buttons). */
export function Pager(props: {
  newest?: string | null;
  newer?: string | null;
  older?: string | null;
  /** What is shown. Default "Times in UTC." */
  summary?: Child;
}) {
  if (!props.newest && !props.newer && !props.older) return null;
  return (
    <UiPager
      summary={props.summary ?? 'Times in UTC.'}
      newest={props.newest ?? undefined}
      newestLabel="Newest entries"
      newer={props.newer ?? undefined}
      newerLabel="Newer entries"
      older={props.older ?? undefined}
      olderLabel="Older entries"
      buttons
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Data display

/** A status in the admin vocabulary (status.ts) as a ui Badge; the word carries the meaning. */
export function StatusBadge(props: { status: StatusKey; detail?: string }) {
  const info = STATUS[props.status];
  return (
    <Badge tone={uiTone(info.tone)} glyph={info.glyph || undefined}>
      {statusLabel(props.status, props.detail)}
    </Badge>
  );
}

interface ChipProps {
  href?: string;
  text: string;
  secondary?: string;
  status?: StatusKey;
  statusDetail?: string;
  /** The full sentence a screen reader hears: "acme/api in production can use Slack bot: Active". */
  srText: string;
}

/**
 * A relationship chip (ui Chip). The visible name and the status glyph are hidden from assistive
 * technology; `srText` is what a screen reader hears.
 */
export function Chip(props: ChipProps) {
  const info = props.status ? STATUS[props.status] : null;
  const tone = info ? uiTone(info.tone) : undefined;
  return (
    <UiChip
      href={props.href}
      glyph={info?.glyph || undefined}
      glyphTone={tone === 'off' || tone === 'pending' ? undefined : tone}
    >
      <span aria-hidden="true">
        {props.text}
        {props.secondary ? <span class="meta"> {props.secondary}</span> : null}
      </span>
      <span class="vh">{props.srText}</span>
    </UiChip>
  );
}

/**
 * Nothing to list (ui EmptyState): `title` names what is missing; without one, the text is the
 * title. Heading level 2 by default, for a page with no tray heading above it.
 */
export function EmptyState(props: {
  title?: string;
  children: Child;
  action?: Child;
  headingLevel?: 2 | 3;
}) {
  return (
    <UiEmptyState
      title={props.title ?? props.children}
      description={props.title ? props.children : undefined}
      actions={hasContent(props.action) ? props.action : undefined}
      headingLevel={props.headingLevel ?? 2}
    />
  );
}

/** Facts of a detail page (ui KeyValue); each fact once. */
export function Details(props: { rows: Array<[string, Child]> }) {
  return <KeyValue items={props.rows.map(([label, value]) => ({ label, value }))} />;
}

/**
 * A moment (ui Time) in UTC: "13 Oct 2026, 15:00", or "3 min ago" when `relative`. The
 * `datetime` attribute keeps the exact ISO value with milliseconds.
 */
export function Time(props: { ms: number; relative?: boolean; now?: number }) {
  return (
    <UiTime datetime={new Date(props.ms).toISOString()}>
      {props.relative && props.now !== undefined ? relativeTime(props.ms, props.now) : undefined}
    </UiTime>
  );
}

// ---------------------------------------------------------------------------------------------
// Role-aware help

/**
 * Who can make a change the viewer cannot (ui AskSomeone), with the same wording on every page
 * (WCAG 3.2.4): "Only credential managers can add credentials. Ask A, B or C and 2 more." and one
 * mailto link to all of them. The people are active users whose role holds `permission`, owners
 * last, at most 3 named (ViewContext.askers). Every role can already see these emails on Users,
 * so this discloses nothing new. `lead={false}` leaves out the first sentence, where the page
 * already names the roles (the forbidden page).
 */
export function AskSomeone(props: {
  permission: Permission;
  ctx: ViewContext;
  /** What the permission lets them do, after "can": "add a credential". */
  verb?: string;
  lead?: boolean;
  /** Subject line of the email. */
  subject?: string;
}) {
  const [least] = rolesFor(props.permission).filter((role) => role !== 'viewer');
  const plural = least ? ROLE_INFO[least].plural : 'owners';
  const emails = props.ctx.askers(props.permission).map((person) => person.email);
  const lead =
    props.lead === false ? null : `Only ${plural} can ${props.verb ?? 'make this change'}.`;
  if (emails.length === 0) {
    return (
      <UiAskSomeone people={[]}>
        {lead === null ? 'Ask an owner.' : `${lead} Ask an owner.`}
      </UiAskSomeone>
    );
  }
  const subject = props.subject ? `?subject=${encodeURIComponent(props.subject)}` : '';
  return (
    <UiAskSomeone
      people={emails}
      more={props.ctx.askersMore(props.permission)}
      link={{ href: `mailto:${emails.join(',')}${subject}`, label: 'Email them' }}
    >
      {lead}
    </UiAskSomeone>
  );
}

// ---------------------------------------------------------------------------------------------
// Not found

export type NotFoundWhat = 'page' | 'token' | 'rule' | 'global' | 'user' | 'request';

const NOT_FOUND_TEXT: Readonly<Record<NotFoundWhat, string>> = {
  page: 'There is no page at this address.',
  token: 'There is no credential with this ID. It may have been deleted.',
  rule: 'There is no credential access rule with this ID. It may have been deleted.',
  global: 'There is no global access rule with this ID. It may have been deleted.',
  user: 'There is no user with this ID. They may have been deleted.',
  request: 'There is no request record with this ID. It may have been purged by data retention.',
};

/** The description of a not-found page header. Static text only. */
export function notFoundText(what: NotFoundWhat): string {
  return NOT_FOUND_TEXT[what];
}

/** The sections in the order of the sidebar (ADR 0022), with the pages each one holds. */
const SECTION_LINKS: readonly LinkCard[] = [
  {
    href: paths.overview(),
    title: 'Monitoring',
    description: 'Overview, requests, audit log and data retention',
  },
  {
    href: paths.tokens(),
    title: 'Credentials',
    description: 'Credentials, and credential and global access rules',
  },
  {
    href: paths.users(),
    title: 'Settings',
    description: 'Members, allowed hosts, encryption keys, appearance and the FAQ',
  },
];

/** A fact about the missing object: a bold first sentence and inline text. Phrasing only. */
export interface NotFoundHint {
  title: string;
  /** Inline content after the title (no blocks: it goes in the callout's paragraph). */
  text?: Child;
}

/** Where the parts of a moved page went: a titled tray of link cards. */
export interface NotFoundLinks {
  title: string;
  items: ReadonlyArray<{ href: string; title: string; description: string }>;
}

/**
 * The body of every not-found page, under a header that says what is missing (notFoundText) or
 * where the page went. An optional hint callout, the moved page's links, then the sections. Static
 * text only: the requested path is never echoed.
 */
export function NotFound(props: { hint?: NotFoundHint; links?: NotFoundLinks }) {
  const { hint, links } = props;
  return (
    <>
      {hint ? <Callout title={hint.title}>{hint.text}</Callout> : null}
      {links ? (
        <Tray id="nf-moved" title={links.title}>
          <Panel variant="pad">
            <LinkCards cards={links.items} />
          </Panel>
        </Tray>
      ) : null}
      <Tray id="nf-sections" title="Go to a section">
        <Panel variant="pad">
          <LinkCards cards={SECTION_LINKS} />
        </Panel>
      </Tray>
    </>
  );
}
