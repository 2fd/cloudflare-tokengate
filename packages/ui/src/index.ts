// @tokengate/ui: server-rendered Hono JSX components for design system D. One barrel per group;
// each group owns its folder (README "Groups"). Do not add exports here: add them to the group's
// index.ts. The stylesheet is a separate entry, `@tokengate/ui/css`, so importing components never
// pulls the CSS text into a bundle that does not serve it.
export * from './components/base';
export * from './components/data';
export * from './components/forms';
export * from './components/layout';
export * from './components/viz';
export * from './lib';
