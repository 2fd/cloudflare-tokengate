// Display labels for numeric claim IDs (`claim_labels`), per caller provider: repository_id
// 987654321 reads as "acme/api". Display and form derivation only; src/policy/* never reads them,
// so a label can never change what a grant allows. Written only by consumer and access saves.
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

/** Labels of one caller provider (a primary-key prefix read), or of all of them. */
export async function listClaimLabels(db: D1Database, providerId?: string): Promise<ClaimLabel[]> {
  const statement =
    providerId === undefined
      ? db
          .prepare('SELECT * FROM claim_labels ORDER BY caller_provider_id, claim, value LIMIT ?')
          .bind(CLAIM_LABELS_LIMIT)
      : db
          .prepare(
            'SELECT * FROM claim_labels WHERE caller_provider_id = ? ORDER BY claim, value LIMIT ?',
          )
          .bind(providerId, CLAIM_LABELS_LIMIT);
  const { results } = await statement.all<Record<string, unknown>>();
  return results.map(claimLabelFromRow);
}

/** The label of `value` for `claim`, or null. `labels` should come from one caller provider. */
export function labelFor(
  labels: readonly ClaimLabel[],
  claim: string,
  value: string,
): string | null {
  return labels.find((label) => label.claim === claim && label.value === value)?.label ?? null;
}

export interface RepositoryLabelOption {
  caller_provider_id: string;
  claim: 'repository_id' | 'project_id';
  value: string;
  label: string;
  /** `name (ID)`, the format ID inputs accept. */
  text: string;
}

/** Labelled repositories and projects, by label, of one caller provider or of all of them. */
export async function repositoryLabelOptions(
  db: D1Database,
  providerId?: string,
): Promise<RepositoryLabelOption[]> {
  const scope = providerId === undefined ? '' : ' AND caller_provider_id = ?';
  const { results } = await db
    .prepare(
      `SELECT * FROM claim_labels WHERE claim IN ('repository_id', 'project_id')${scope}
       ORDER BY label, value LIMIT ?`,
    )
    .bind(...(providerId === undefined ? [] : [providerId]), REPOSITORY_OPTIONS_LIMIT)
    .all<Record<string, unknown>>();
  return results.map((row) => {
    const label = claimLabelFromRow(row);
    return {
      caller_provider_id: label.caller_provider_id,
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
const LABELLED_PAREN = new RegExp(`^(.+?)\\s*\\(${ID_DIGITS}\\)$`);
const LABELLED_HASH = new RegExp(`^(.+?)\\s+#${ID_DIGITS}$`);
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
  const labelled = LABELLED_PAREN.exec(text) ?? LABELLED_HASH.exec(text);
  if (!labelled) return null;
  const label = (labelled[1] as string).trim();
  return label === '' ? null : { id: labelled[2] as string, label };
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
 * A parsed ID with its label filled from the stored labels of the consumer: a bare ID needs an
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

function claimLabelFromRow(row: Record<string, unknown>): ClaimLabel {
  return {
    caller_provider_id: String(row.caller_provider_id),
    claim: String(row.claim) as LabelledClaim,
    value: String(row.value),
    label: String(row.label),
    updated_at: Number(row.updated_at),
    updated_by: typeof row.updated_by === 'string' ? row.updated_by : null,
  };
}
