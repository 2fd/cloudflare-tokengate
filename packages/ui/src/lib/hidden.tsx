// Hidden form fields. Every component that renders its own `<form>` takes them the same way, as
// `hidden: { _csrf: token, id: 'usr_…' }`, and renders one `input type="hidden"` per entry at the
// top of the form. The gateway refuses an unsafe request without its `_csrf` field.

/** Hidden fields of a form: name → value. */
export type HiddenFields = Readonly<Record<string, string>>;

/** One `input type="hidden"` per entry, in order. */
export function Hidden(props: { fields?: HiddenFields | undefined }) {
  const entries = Object.entries(props.fields ?? {});
  return entries.length > 0 ? (
    <>
      {entries.map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
    </>
  ) : null;
}
