// The "Add a token" accordion (A13.2): one `<details name="token-type">` card per template plus
// Custom API, each holding its own form, so only the open card's fields can be submitted and the
// native `required`/`pattern` of its secret always apply to a visible control. A template card
// posts the secret and display fields only; everything else comes from SERVICE_TEMPLATES.
import { upstreamHostAllowed } from '../../config';
import type { KeyringError } from '../../crypto/keyring';
import type { Service } from '../../db/types';
import { KEYRING_ERROR_TEXT } from '../ops/keyring';
import { freeNameAmong, freeSlugAmong, slugBaseFor } from '../ops/services';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { SERVICE_TEMPLATES, type ServiceTemplate } from '../service-templates';
import { AskSomeone, Checkbox, Field, PostForm } from './components';
import {
  AdvancedFields,
  allowlistPattern,
  baseUrlSuggestions,
  EMPTY_VALUES,
  FormIds,
  type FormState,
  InjectionFields,
  OptionalFields,
  SecretField,
  SecretSubmits,
  type TokenFormValues,
  VerifyResult,
} from './token-forms';

export const CUSTOM = 'custom';

export const CUSTOM_SECRET = {
  label: 'Secret',
  placeholder: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  hint: 'Exactly as the API issued it. Basic without a username: username:password. URL path: the segments after the base URL, e.g. T000/B000/XXXX.',
} as const;

export interface CardsData {
  tokens: readonly Service[];
  /** The upstream host allowlist; null = any public https host. */
  allowlist: string[] | null;
  keyringError: KeyringError | null;
  /** `https://<gateway host>`, for the proxy URL in hints. */
  proxyOrigin: string;
  /** Today in UTC, `YYYY-MM-DD` (the expiry `min`). */
  today: string;
}

/** A card whose POST failed: re-rendered open with its values, errors and draft. */
export interface FailedCard {
  template: string;
  state: FormState;
  /** The template the pasted secret seems to belong to (wrong-type guard). */
  likely: string | null;
}

export function templateHost(template: ServiceTemplate): string {
  return new URL(template.base_url).host;
}

/** "Check and save Slack", or "Save Slack" for a template without a check. */
export function saveLabel(template: ServiceTemplate): string {
  return `${template.verify ? 'Check and save' : 'Save'} ${template.name}`;
}

/** The vendor named in a template's docs link text: "(Slack docs)". */
function vendor(template: ServiceTemplate): string {
  return template.label.split(' ')[0] ?? template.label;
}

export function TokenTypeCards(props: {
  ctx: ViewContext;
  data: CardsData;
  /** The card named by `?template=`. */
  open: string | null;
  failed: FailedCard | null;
}) {
  const { ctx, data } = props;
  if (data.keyringError !== null) {
    return (
      <p class="keyring-gate">
        <strong>Error:</strong> Secrets cannot be stored: {KEYRING_ERROR_TEXT[data.keyringError]}{' '}
        <a href={paths.tokenKeys()}>Open encryption keys</a>
      </p>
    );
  }
  const openId = props.failed?.template ?? props.open;
  return (
    <section aria-labelledby="types-h" class="token-types">
      <h2 id="types-h">Which API does this token unlock?</h2>
      {SERVICE_TEMPLATES.map((template) => (
        <TemplateCard
          ctx={ctx}
          data={data}
          template={template}
          open={openId === template.id}
          failed={props.failed?.template === template.id ? props.failed : null}
        />
      ))}
      <CustomCard
        ctx={ctx}
        data={data}
        open={openId === CUSTOM}
        failed={props.failed?.template === CUSTOM ? props.failed : null}
      />
      {data.allowlist !== null && data.allowlist.length > 0 ? (
        <p class="hint">
          Tokens may point only at: {data.allowlist.join(', ')}.{' '}
          {ctx.can('settings:write') ? <a href={paths.tokenHosts()}>Change allowed hosts</a> : null}
        </p>
      ) : null}
    </section>
  );
}

function TemplateCard(props: {
  ctx: ViewContext;
  data: CardsData;
  template: ServiceTemplate;
  open: boolean;
  failed: FailedCard | null;
}) {
  const { ctx, data, template, failed } = props;
  const host = templateHost(template);
  const blocked = !upstreamHostAllowed(host, data.allowlist);
  const canAllow = ctx.can('settings:write');
  const ids = new FormIds(template.id, failed?.state.errors ?? []);
  const values: TokenFormValues = failed?.state.values ?? {
    ...EMPTY_VALUES,
    template: template.id,
  };
  const slugs = data.tokens.map((token) => token.slug);
  const names = data.tokens.map((token) => token.name);
  return (
    <details name="token-type" class="type-card" id={`type-${template.id}`} open={props.open}>
      <summary>
        <b>{template.label}</b>{' '}
        <span class="muted">
          {template.card_summary}
          {blocked ? ` · ${host} is not an allowed host` : ''}
        </span>
      </summary>
      {blocked && !canAllow ? (
        <div class="card-body">
          <p>{host} is not an allowed host.</p>
          <AskSomeone permission="settings:write" ctx={ctx} verb={`allow ${host}`} />
        </div>
      ) : (
        <PostForm action="/admin/tokens" csrf={ctx.csrf} class="stack card-body">
          <input type="hidden" name="template" value={template.id} />
          <SecretField
            ids={ids}
            label={template.secret.label}
            placeholder={template.secret.placeholder}
            hint={template.secret.hint}
            pattern={template.secret.pattern}
            draft={failed?.state.draft ?? null}
          />
          {failed?.likely ? (
            <p class="hint">
              <a href={paths.tokenNew({ template: failed.likely })}>
                Open {SERVICE_TEMPLATES.find((t) => t.id === failed.likely)?.label}
              </a>
            </p>
          ) : null}
          {failed?.state.verify ? <VerifyResult verify={failed.state.verify} /> : null}
          {template.id === 'github' ? (
            <Checkbox
              name="also_uploads"
              id={ids.id('also_uploads')}
              label="Also add release asset uploads (uploads.github.com) with the same token"
              hint="Creates a second token for uploads.github.com with the same secret."
              checked={values.also_uploads}
            />
          ) : null}
          <OptionalFields
            ids={ids}
            values={values}
            slugPlaceholder={freeSlugAmong(template.slug, slugs)}
            namePlaceholder={freeNameAmong(template.name, names)}
            proxyOrigin={data.proxyOrigin}
            expiry={!template.expiry_from_check}
            today={data.today}
          />
          {blocked ? (
            <Checkbox
              name="allow_host"
              id={ids.id('allow_host')}
              value={host}
              required
              checked={values.allow_host === host}
              label={`Also allow ${host} in Allowed hosts (applies to every token)`}
              hint={`Also allows ${host} in Allowed hosts, for every token.`}
              error={ids.error('allow_host')}
            />
          ) : null}
          <p class="hint">
            {template.notes}{' '}
            <a href={template.docs_url}>
              {template.label} documentation ({vendor(template)} docs)
            </a>
          </p>
          <SecretSubmits label={saveLabel(template)} failedCheck={!!failed?.state.verify} />
        </PostForm>
      )}
    </details>
  );
}

function CustomCard(props: {
  ctx: ViewContext;
  data: CardsData;
  open: boolean;
  failed: FailedCard | null;
}) {
  const { ctx, data, failed } = props;
  const ids = new FormIds(CUSTOM, failed?.state.errors ?? []);
  const values: TokenFormValues = failed?.state.values ?? { ...EMPTY_VALUES, template: CUSTOM };
  const canAllow = ctx.can('settings:write');
  const allowlist = data.allowlist;
  const listed = allowlist !== null && allowlist.length > 0;
  const slugBase = values.base_url.trim() === '' ? 'example' : slugBaseFor(values.base_url);
  const slug = freeSlugAmong(
    slugBase,
    data.tokens.map((token) => token.slug),
  );
  return (
    <details name="token-type" class="type-card" id="type-custom" open={props.open}>
      <summary>
        <b>Custom API</b> <span class="muted">any HTTPS API · you set the base URL and auth</span>
      </summary>
      <PostForm action="/admin/tokens" csrf={ctx.csrf} class="stack card-body">
        <input type="hidden" name="template" value={CUSTOM} />
        <Field
          name="base_url"
          id={ids.id('base_url')}
          label="Base URL"
          type="url"
          required
          autocomplete="off"
          spellcheck={false}
          autocapitalize="none"
          value={values.base_url}
          example="https://api.example.com/v1"
          suggestions={baseUrlSuggestions(allowlist, data.tokens)}
          // Not generated when the owner may tick allow_host: the field must not look wrong first.
          pattern={listed && !canAllow ? allowlistPattern(allowlist) : undefined}
          hint={
            <>
              https only, no query string. Consumers can only reach paths under it.
              {listed ? <> Allowed hosts: {allowlist.join(', ')}.</> : null}
            </>
          }
          error={ids.error('base_url')}
        />
        <InjectionFields ids={ids} values={values} tokens={data.tokens} />
        <SecretField
          ids={ids}
          label={CUSTOM_SECRET.label}
          placeholder={CUSTOM_SECRET.placeholder}
          hint={CUSTOM_SECRET.hint}
          draft={failed?.state.draft ?? null}
        />
        {failed?.state.verify ? <VerifyResult verify={failed.state.verify} /> : null}
        {listed && canAllow ? (
          <Checkbox
            name="allow_host"
            id={ids.id('allow_host')}
            value="1"
            checked={values.allow_host !== ''}
            label="Also add this host to Allowed hosts"
            hint="Only when the base URL's host is not allowed yet. Applies to every token."
            error={ids.error('allow_host')}
          />
        ) : null}
        <OptionalFields
          ids={ids}
          values={values}
          slugPlaceholder={slug}
          namePlaceholder={slug}
          proxyOrigin={data.proxyOrigin}
          expiry
          today={data.today}
        />
        <AdvancedFields ids={ids} values={values} tokens={data.tokens} />
        <SecretSubmits label="Save custom token" failedCheck={!!failed?.state.verify} />
      </PostForm>
    </details>
  );
}
