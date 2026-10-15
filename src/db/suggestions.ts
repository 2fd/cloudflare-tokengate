// Autocomplete sources of the consumer access form: values that this consumer's own accesses and
// tenant pin already use (environments, branches, tags, PR bases, workflow pins, claim values),
// and the paths and rule sets of one token's accesses. Control-plane data only: never
// request_log (I-LOG-2) and never an outbound lookup. Every read is bounded.
import { canonicalJson, parseJson } from '../lib/json';
import type { Condition, Rule } from '../policy/types';
import type { CallerProvider } from './types';

/** Accesses read per consumer or token for suggestions. */
export const SUGGESTIONS_LIMIT = 200;
/** Values offered per datalist. */
export const SUGGESTIONS_SHOWN = 50;
/** Rule sets offered as "Used by other accesses of this token". */
export const RULE_SETS_SHOWN = 5;

export interface AccessShape {
  conditions: Condition[];
  rules: Rule[];
}

/** Conditions and rules of up to SUGGESTIONS_LIMIT accesses of one consumer, newest first. */
export async function consumerAccessShapes(
  db: D1Database,
  consumerId: string,
): Promise<AccessShape[]> {
  return shapes(db, 'caller_provider_id', consumerId);
}

/** Conditions and rules of up to SUGGESTIONS_LIMIT accesses of one token, newest first. */
export async function tokenAccessShapes(db: D1Database, tokenId: string): Promise<AccessShape[]> {
  return shapes(db, 'service_id', tokenId);
}

async function shapes(
  db: D1Database,
  column: 'caller_provider_id' | 'service_id',
  id: string,
): Promise<AccessShape[]> {
  const { results } = await db
    .prepare(
      `SELECT conditions, rules FROM grants WHERE ${column} = ? ORDER BY updated_at DESC, id LIMIT ?`,
    )
    .bind(id, SUGGESTIONS_LIMIT)
    .all<{ conditions: string; rules: string }>();
  return results.map((row) => ({
    conditions: arrayOf<Condition>(parseJson(row.conditions)),
    rules: arrayOf<Rule>(parseJson(row.rules)),
  }));
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Distinct values, most frequent first, then in first-seen order. */
function ranked(values: Iterable<string>): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SUGGESTIONS_SHOWN)
    .map(([value]) => value);
}

function positive(shapes: readonly AccessShape[], claim: string): string[] {
  return shapes.flatMap((shape) =>
    shape.conditions
      .filter((c) => c && c.claim === claim && c.negate !== true && Array.isArray(c.values))
      .flatMap((c) => c.values.filter((value): value is string => typeof value === 'string')),
  );
}

/** Names under a ref prefix (GitHub `refs/heads/`), or bare refs of that ref_type (GitLab). */
function refNames(shapes: readonly AccessShape[], prefix: string, refType: string): string[] {
  return shapes.flatMap((shape) => {
    const typed = shape.conditions.some(
      (c) => c?.claim === 'ref_type' && c.negate !== true && c.values?.includes(refType),
    );
    return positive([shape], 'ref').flatMap((ref) =>
      ref.startsWith(prefix)
        ? [ref.slice(prefix.length)]
        : !ref.startsWith('refs/') && typed
          ? [ref]
          : [],
    );
  });
}

export interface ConsumerSuggestions {
  environments: string[];
  branches: string[];
  tags: string[];
  baseRefs: string[];
  workflowRefs: string[];
  /** Values of one claim in this consumer's accesses and tenant pin (rows editor). */
  claimValues: (claim: string) => string[];
}

export function consumerSuggestions(
  shapes: readonly AccessShape[],
  provider: Pick<CallerProvider, 'tenant_pin'> | null,
): ConsumerSuggestions {
  return {
    environments: ranked(positive(shapes, 'environment')),
    branches: ranked(refNames(shapes, 'refs/heads/', 'branch')),
    tags: ranked(refNames(shapes, 'refs/tags/', 'tag')),
    baseRefs: ranked(positive(shapes, 'base_ref')),
    workflowRefs: ranked([
      ...positive(shapes, 'job_workflow_ref'),
      ...positive(shapes, 'ci_config_ref_uri'),
    ]),
    claimValues: (claim) =>
      ranked([
        ...positive(shapes, claim),
        ...(provider?.tenant_pin ?? []).filter((c) => c.claim === claim).flatMap((c) => c.values),
      ]),
  };
}

/** Distinct rule paths of one token's accesses, most used first. */
export function rulePathSuggestions(shapes: readonly AccessShape[]): string[] {
  return ranked(
    shapes.flatMap((shape) =>
      shape.rules
        .map((rule) => rule?.path)
        .filter((path): path is string => typeof path === 'string'),
    ),
  );
}

export interface RuleSet {
  /** Stable id of the set: `used:` plus a hash of its canonical JSON (the `op` value). */
  id: string;
  rules: Rule[];
  /** Accesses of the token that use exactly this set. */
  count: number;
}

/** The distinct rule sets of one token's accesses, most used first, at most RULE_SETS_SHOWN. */
export function ruleSets(shapes: readonly AccessShape[]): RuleSet[] {
  const sets = new Map<string, RuleSet>();
  for (const shape of shapes) {
    if (shape.rules.length === 0) continue;
    const key = ruleSetKey(shape.rules);
    const existing = sets.get(key);
    if (existing) existing.count++;
    else sets.set(key, { id: `used:${fnv1a(key)}`, rules: shape.rules, count: 1 });
  }
  return [...sets.values()].sort((a, b) => b.count - a.count).slice(0, RULE_SETS_SHOWN);
}

/** Order-insensitive identity of a rule set. */
export function ruleSetKey(rules: readonly Rule[]): string {
  return JSON.stringify(
    rules
      .map((rule) => canonicalJson({ methods: [...rule.methods].sort(), path: rule.path }))
      .sort(),
  );
}

/** 32-bit FNV-1a as 8 hex digits: a short, stable checkbox value (not a security hash). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
