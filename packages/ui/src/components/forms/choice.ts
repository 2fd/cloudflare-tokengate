// Internal: what every choice (radio card, row, pick, preset) shares, and its live-form attributes.

/** Fields every option of a choice group takes. */
export interface ChoiceBase {
  /** Submitted value. */
  value: string;
  checked?: boolean;
  disabled?: boolean;
  /**
   * Live-form option number (`data-o`), 1–12. Defaults to the position in the list (1-based), so
   * `.svN` / `.rvN` elements name options by position.
   */
  o?: number;
  /** A risky choice: inside a LiveForm, checking it shows the RiskAcceptance (`data-risk`). */
  risk?: boolean;
}

/** `data-o` / `data-risk` of option `index`, and its input id under the group prefix. */
export function choiceAttrs(option: ChoiceBase, index: number, idPrefix: string | undefined) {
  const o = option.o ?? index + 1;
  return {
    o: String(o),
    risk: option.risk ? true : undefined,
    inputId: idPrefix ? `${idPrefix}-${o}` : undefined,
  };
}

/** Whether option `option` is the checked one: its own flag, or the group's `value`. */
export function isChecked(option: ChoiceBase, value: string | readonly string[] | undefined) {
  if (option.checked !== undefined) return option.checked;
  if (value === undefined) return false;
  return typeof value === 'string' ? option.value === value : value.includes(option.value);
}
