/**
 * The SVG fill patterns the charts reference from ui.css: `#hatch` (denied) and `#dots` (errors).
 * Render it once per page that shows a `Chart` or a `ReasonBar`, anywhere in the body (the app
 * shell is a good place). The ids are fixed because the stylesheet uses `url(#hatch)`.
 */
export function ChartPatterns() {
  return (
    <svg class="vh" aria-hidden="true" focusable="false">
      <defs>
        <pattern
          id="hatch"
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect class="hatch-bg" width="4" height="4" />
          <line class="hatch-ln" x1="0" y1="0" x2="0" y2="4" />
        </pattern>
        <pattern id="dots" width="4" height="4" patternUnits="userSpaceOnUse">
          <rect class="dots-bg" width="4" height="4" />
          <circle class="dots-dot" cx="2" cy="2" r=".8" />
        </pattern>
      </defs>
    </svg>
  );
}
