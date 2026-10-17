import type { Child } from 'hono/jsx';
import type { HeadingLevel } from '../../lib/heading';
import type { HiddenFields } from '../../lib/hidden';
import { Button } from '../base/Button';
import { Dialog, DialogClose } from './Dialog';

export interface ConfirmText {
  /** The exact text to type: the object's slug or name ("slack"). Matched literally. */
  value: string;
  /** Field label. Default: Type `value` to confirm. */
  label?: Child;
  /** Hint under the label ("The slug of this token, in lower case."). */
  hint?: Child;
  /** Form field name. Default `confirm_text`. */
  name?: string;
}

export interface ConfirmDialogProps {
  /** Id of the dialog (see `Dialog`); the confirm field gets `${id}-confirm`. */
  id: string;
  /** The question with the object and the count ("Delete Slack and its 3 consumer accesses?"). */
  title: Child;
  /** "This cannot be undone." plus what stops working. */
  description?: Child;
  /** Where the confirm button posts. */
  action: string;
  /** The confirm button: the outcome, without "…" ("Delete Slack"). */
  confirmLabel: string;
  /** Variant of the confirm button: `danger-solid` (default), or `primary` for a non-destructive confirm. */
  confirmVariant?: 'danger-solid' | 'primary';
  /** What happens, one fact per item, with counts and links (`ul.conseq`). */
  consequences?: readonly Child[];
  /** The affected objects as a bordered list (`ul.dlg-list`): logo + name + meta per item. */
  affected?: readonly Child[];
  /** Type-to-confirm field, only for irreversible cascades. */
  confirmText?: ConfirmText;
  /** Hidden fields of the form (`_csrf`, ids), one `input type="hidden"` each. */
  hidden?: HiddenFields;
  /** Level of the title (see `Dialog`). */
  headingLevel?: HeadingLevel;
  /** More body content after the lists, before the confirm field (a `Callout` with an alternative). */
  children?: Child;
  /** Cancel label. Default "Cancel". */
  cancelLabel?: string;
  /** Render it open in the page flow (see `Dialog.open`). */
  open?: boolean;
  /** With `open`: Cancel is a link back to this URL instead of a close button. */
  cancelHref?: string;
  wide?: boolean;
  class?: string;
}

/** Escapes a literal for the `pattern` attribute (compiled with the `v` flag). */
function literalPattern(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * Confirm dialog for a destructive action: the question, the consequences, an optional
 * type-to-confirm field, then Cancel and the solid danger button. Focus starts in the confirm
 * field, or on Cancel when there is none, never on the destructive button. Opened by a `DialogTrigger`
 * with `variant="danger"` on the page (`Delete Slack…`).
 */
export function ConfirmDialog(props: ConfirmDialogProps) {
  const confirmId = `${props.id}-confirm`;
  const hintId = `${confirmId}-hint`;
  const consequences = props.consequences ?? [];
  const affected = props.affected ?? [];
  const confirm = props.confirmText;
  const hasBody =
    consequences.length > 0 || affected.length > 0 || props.children !== undefined || confirm;
  const cancelLabel = props.cancelLabel ?? 'Cancel';
  return (
    <Dialog
      id={props.id}
      title={props.title}
      description={props.description}
      action={props.action}
      hidden={props.hidden}
      headingLevel={props.headingLevel}
      wide={props.wide}
      open={props.open}
      class={props.class}
      footer={
        <>
          {props.open && props.cancelHref ? (
            <a class="btn secondary" href={props.cancelHref}>
              {cancelLabel}
            </a>
          ) : (
            <DialogClose dialog={props.id} autofocus={!props.open && !confirm}>
              {cancelLabel}
            </DialogClose>
          )}
          <Button variant={props.confirmVariant ?? 'danger-solid'} type="submit">
            {props.confirmLabel}
          </Button>
        </>
      }
    >
      {hasBody ? (
        <>
          {consequences.length > 0 ? (
            <ul class="conseq">
              {consequences.map((item) => (
                <li>{item}</li>
              ))}
            </ul>
          ) : null}
          {affected.length > 0 ? (
            <ul class="dlg-list">
              {affected.map((item) => (
                <li>{item}</li>
              ))}
            </ul>
          ) : null}
          {props.children}
          {confirm ? (
            <div class="field">
              <label for={confirmId}>
                {confirm.label ?? (
                  <>
                    Type <code>{confirm.value}</code> to confirm
                  </>
                )}
              </label>
              {confirm.hint !== undefined ? (
                <span class="hint" id={hintId}>
                  {confirm.hint}
                </span>
              ) : null}
              <input
                class="input mono"
                type="text"
                id={confirmId}
                name={confirm.name ?? 'confirm_text'}
                required
                pattern={literalPattern(confirm.value)}
                autocomplete="off"
                spellcheck={false}
                autocapitalize="none"
                aria-describedby={confirm.hint !== undefined ? hintId : undefined}
                autofocus={props.open ? undefined : true}
              />
            </div>
          ) : null}
        </>
      ) : undefined}
    </Dialog>
  );
}
