/** Joins class names, dropping empty and false parts: `cx('btn', primary && 'primary', props.class)`. */
export function cx(...parts: Array<string | false | null | undefined>): string | undefined {
  const out = parts.filter((part): part is string => typeof part === 'string' && part !== '');
  return out.length > 0 ? out.join(' ') : undefined;
}

/**
 * The value of an id-list attribute (`aria-describedby`, `aria-labelledby`) from the ids that are
 * rendered; undefined when none is, so the attribute is left out instead of pointing at nothing.
 */
export function idList(...ids: Array<string | false | null | undefined>): string | undefined {
  return cx(...ids);
}
