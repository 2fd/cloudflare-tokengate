// Visually hidden text that completes an accessible name. Every component spells it the same way:
// `srPrefix` is read before the visible text, `srSuffix` after it, and the separating space is
// added here (a suffix that starts with punctuation, ": 2 accesses", gets none).

/** `srSuffix` text with its leading space: " acme/api → Slack", ": 2 accesses". */
export function suffixText(text: string): string {
  const trimmed = text.trim();
  return /^[,.:;)!?]/.test(trimmed) ? trimmed : ` ${trimmed}`;
}

/** `srPrefix` text with its trailing space: "Secret ending in ". */
export function prefixText(text: string): string {
  return `${text.trim()} `;
}

/** The hidden suffix (`span.vh`), or nothing. */
export function SrSuffix(props: { text?: string | undefined }) {
  return props.text && props.text.trim() !== '' ? (
    <span class="vh">{suffixText(props.text)}</span>
  ) : null;
}

/** The hidden prefix (`span.vh`), or nothing. */
export function SrPrefix(props: { text?: string | undefined }) {
  return props.text && props.text.trim() !== '' ? (
    <span class="vh">{prefixText(props.text)}</span>
  ) : null;
}
