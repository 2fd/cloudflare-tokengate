// Display labels for numeric claim IDs (`claim_labels`), per access rule (ADR 0021, ADR 0026): repository_id
// 987654321 reads as "acme/api". Display and form derivation only; src/policy/* never reads them,
// so a label can never change what an access rule allows. Written only by access rule saves.
import type { ClaimLabel, LabelledClaim } from './types';

export const LABELLED_CLAIMS: readonly LabelledClaim[] = [
  'repository_owner_id',
  'repository_id',
  'namespace_id',
  'project_id',
];

/** Upper bound of every label read, so a page never loads an unbounded list. */
export const CLAIM_LABELS_LIMIT = 1000;

/** Repository options for a datalist: GitHub repositories and GitLab projects. */
export const REPOSITORY_OPTIONS_LIMIT = 200;

/** Labels of one access rule (a primary-key prefix read), or of all of them. */
export async function listClaimLabels(db: D1Database, ruleId?: string): Promise<ClaimLabel[]> {
  const statement =
    ruleId === undefined
      ? db
          .prepare('SELECT * FROM claim_labels ORDER BY access_rule_id, claim, value LIMIT ?')
          .bind(CLAIM_LABELS_LIMIT)
      : db
          .prepare(
            'SELECT * FROM claim_labels WHERE access_rule_id = ? ORDER BY claim, value LIMIT ?',
          )
          .bind(ruleId, CLAIM_LABELS_LIMIT);
  const { results } = await statement.all<Record<string, unknown>>();
  return results.map(claimLabelFromRow);
}

/** The label of `value` for `claim`, or null. `labels` should come from one access rule. */
export function labelFor(
  labels: readonly ClaimLabel[],
  claim: string,
  value: string,
): string | null {
  return labels.find((label) => label.claim === claim && label.value === value)?.label ?? null;
}

export interface RepositoryLabelOption {
  access_rule_id: string;
  claim: 'repository_id' | 'project_id';
  value: string;
  label: string;
  /** `name (ID)`, the format ID inputs accept. */
  text: string;
}

/** Labelled repositories and projects, by label, of one access rule or of all of them. */
export async function repositoryLabelOptions(
  db: D1Database,
  ruleId?: string,
): Promise<RepositoryLabelOption[]> {
  const scope = ruleId === undefined ? '' : ' AND access_rule_id = ?';
  const { results } = await db
    .prepare(
      `SELECT * FROM claim_labels WHERE claim IN ('repository_id', 'project_id')${scope}
       ORDER BY label, value LIMIT ?`,
    )
    .bind(...(ruleId === undefined ? [] : [ruleId]), REPOSITORY_OPTIONS_LIMIT)
    .all<Record<string, unknown>>();
  return results.map((row) => {
    const label = claimLabelFromRow(row);
    return {
      access_rule_id: label.access_rule_id,
      claim: label.claim as 'repository_id' | 'project_id',
      value: label.value,
      label: label.label,
      text: `${label.label} (${label.value})`,
    };
  });
}

/** A typed numeric ID with its optional label. The ID stays a string (IDs can exceed 2^53). */
export interface IdWithLabel {
  id: string;
  label: string | null;
}

const ID_DIGITS = '([0-9]{1,20})';
// Suffix-only patterns: the label is whatever precedes the match. A `^(.+?)\s*` prefix would
// backtrack quadratically on a long run of spaces (form bodies reach 64 KiB).
const PAREN_SUFFIX = new RegExp(`\\(${ID_DIGITS}\\)$`);
const HASH_SUFFIX = new RegExp(`\\s#${ID_DIGITS}$`);
const BARE = new RegExp(`^#?${ID_DIGITS}$`);

/**
 * Parses the ID input format (A7.8): `acme/api (987654321)`, also `acme/api #987654321` and the
 * bare `987654321`. A bare ID has no label; callers accept it only when `claim_labels` already
 * has a label for it (resolveIdWithLabel). Null when the text is none of these.
 */
export function parseIdWithLabel(raw: string): IdWithLabel | null {
  const text = raw.trim();
  const bare = BARE.exec(text);
  if (bare) return { id: bare[1] as string, label: null };
  const labelled = PAREN_SUFFIX.exec(text) ?? HASH_SUFFIX.exec(text);
  if (!labelled) return null;
  const label = text.slice(0, labelled.index).trim();
  return label === '' ? null : { id: labelled[1] as string, label };
}

/** A comma-separated list of parseIdWithLabel entries; null when any entry is invalid. */
export function parseIdWithLabelList(raw: string): IdWithLabel[] | null {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const parsed = entries.map(parseIdWithLabel);
  return parsed.every((entry) => entry !== null) ? (parsed as IdWithLabel[]) : null;
}

/**
 * A parsed ID with its label filled from the stored labels of the access rule: a bare ID needs an
 * existing label for (claim, id), otherwise null. A typed label wins over the stored one.
 */
export function resolveIdWithLabel(
  parsed: IdWithLabel,
  labels: readonly ClaimLabel[],
  claim: string,
): { id: string; label: string } | null {
  const label = parsed.label ?? labelFor(labels, claim, parsed.id);
  return label === null ? null : { id: parsed.id, label };
}

/** The input format of an ID: `name (ID)`, or the bare ID without a label. */
export function idWithLabelText(id: string, label: string | null): string {
  return label ? `${label} (${id})` : id;
}

/** Boolean SQL expression plus its binds; evaluated as `... AND (sql)`. */
type SqlGuard = { sql: string; binds: unknown[] };

/** A label to store: what access rule saves write. */
export type ClaimLabelInput = Pick<ClaimLabel, 'access_rule_id' | 'claim' | 'value' | 'label'>;

/**
 * Inserts or replaces one label while `guard` holds, in the batch of the save that typed it, so
 * the label and the save's audit row commit together (I-AUDIT-1).
 */
export function upsertClaimLabelStatement(
  db: D1Database,
  label: ClaimLabelInput,
  now: number,
  actor: string | null,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO claim_labels (access_rule_id, claim, value, label, updated_at, updated_by)
       SELECT ?, ?, ?, ?, ?, ? WHERE (${guard.sql})
       ON CONFLICT (access_rule_id, claim, value)
       DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .bind(label.access_rule_id, label.claim, label.value, label.label, now, actor, ...guard.binds);
}

/** Deletes every label of one access rule while `guard` holds. */
export function deleteClaimLabelsStatement(
  db: D1Database,
  ruleId: string,
  guard: SqlGuard,
): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM claim_labels WHERE access_rule_id = ? AND (${guard.sql})`)
    .bind(ruleId, ...guard.binds);
}

/** The labels of `next` that are new or differ from `current` (what a save must write). */
export function changedLabels(
  current: readonly ClaimLabel[],
  next: readonly ClaimLabelInput[],
): Array<{ input: ClaimLabelInput; before: string | null }> {
  const out: Array<{ input: ClaimLabelInput; before: string | null }> = [];
  const seen = new Set<string>();
  for (const input of next) {
    const key = `${input.access_rule_id}\u0000${input.claim}\u0000${input.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const before =
      current.find(
        (label) =>
          label.access_rule_id === input.access_rule_id &&
          label.claim === input.claim &&
          label.value === input.value,
      )?.label ?? null;
    if (before !== input.label) out.push({ input, before });
  }
  return out;
}

function claimLabelFromRow(row: Record<string, unknown>): ClaimLabel {
  return {
    access_rule_id: String(row.access_rule_id),
    claim: String(row.claim) as LabelledClaim,
    value: String(row.value),
    label: String(row.label),
    updated_at: Number(row.updated_at),
    updated_by: typeof row.updated_by === 'string' ? row.updated_by : null,
  };
}
