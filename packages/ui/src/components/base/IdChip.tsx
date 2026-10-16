import { cx } from '../../lib/cx';

export interface IdChipProps {
  /**
   * What the ID identifies: "Token", "Consumer", "Access", "User", "Request". Shown as the tooltip
   * "Token ID".
   */
  kind?: string;
  class?: string;
  /** The full ID (`svc_01JB8Y2K…`). Never shorten it here: CSS ellipsis handles narrow widths. */
  children: string;
}

/**
 * A full object ID in a mono chip (`.idchip`). It is the copy source: one click selects the whole
 * ID (`user-select: all`), and CSS ends it with an ellipsis when it does not fit.
 */
export function IdChip({ kind, class: className, children }: IdChipProps) {
  return (
    <span class={cx('idchip', className)} title={kind ? `${kind} ID` : undefined}>
      {children}
    </span>
  );
}
