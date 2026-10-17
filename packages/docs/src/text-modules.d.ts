// `import text from './x.css'` is the file contents as a string. The gateway bundles CSS with a
// wrangler `Text` module rule and `wrangler types` declares `*.css` there; this file declares it
// for this package's own typecheck. Vitest gets the same string from @tokengate/ui/vite-css-text.
declare module '*.css' {
  const value: string;
  export default value;
}
