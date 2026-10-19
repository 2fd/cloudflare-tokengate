// The Add credential catalog (A13.2): a ui TypeCatalog with one exclusive TypeCard per template plus
// Custom API, each holding its own form, so only the open card's fields can be submitted and the
// native `required`/`pattern` of its secret always apply to a visible control. A template card
// posts the secret and display fields only; everything else comes from SERVICE_TEMPLATES.
import {
  Badge,
  Button,
  Callout,
  CatalogGroup,
  CodeBlock,
  Entity,
  Field,
  Input,
  Or,
  Slug,
  SubBox,
  TypeCard,
  TypeCatalog,
} from '@tokengate/ui';
import { upstreamHostAllowed } from '../../config';
import type { KeyringError } from '../../crypto/keyring';
import type { Service } from '../../db/types';
import { freeNameAmong, freeSlugAmong, slugBaseFor } from '../ops/credentials';
import { KEYRING_ERROR_TEXT } from '../ops/keyring';
import { paths } from '../paths';
import type { ViewContext } from '../render';
import { getServiceTemplate, SERVICE_TEMPLATES, type ServiceTemplate } from '../service-templates';
import { AskSomeone, Checkbox } from './components';
import { formatTime } from './format';
import {
  AdvancedFields,
  allowlistPattern,
  baseUrlSuggestions,
  CheckResult,
  checkTitle,
  EMPTY_VALUES,
  FormIds,
  type FormState,
  InjectionFields,
  OptionalFields,
  SecretField,
  SecretSubmits,
  type TokenFormValues,
} from './token-forms';
import { templateLogo, upstreamShort } from './token-ui';

export const CUSTOM = 'custom';

export const CUSTOM_SECRET = {
  label: 'Secret',
  placeholder: 'XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  hint: 'Exactly as the API issued it. Basic without a username: username:password. URL path: the segments after the base URL, e.g. T000/B000/XXXX.',
} as const;

const KEPT_HINT = 'Only the last 4 characters are kept for display.';

export interface CardsData {
  tokens: readonly Service[];
  /** The upstream host allowlist; null = any public https host. */
  allowlist: string[] | null;
  keyringError: KeyringError | null;
  /** The key id new secrets are sealed with; null while the keyring does not load. */
  activeKid: string | null;
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

/** The vendor of a template, as a sentence names it: "Slack", "OpenAI". */
export function vendor(template: ServiceTemplate): string {
  return template.label.split(' ')[0] ?? template.label;
}

/**
 * "Secrets cannot be stored: …" while the keyring does not load: no card, so no secret field, and
 * the way to the fix (the list page shows the same callout).
 */
export function KeyringGate(props: { error: KeyringError }) {
  return (
    <Callout
      tone="bad"
      title={`Secrets cannot be stored: ${KEYRING_ERROR_TEXT[props.error]}`}
      more="No secret can be used or changed until the encryption keys load."
      actions={
        <Button size="sm" href={paths.tokenKeys()}>
          Open encryption keys
        </Button>
      }
    />
  );
}

export function TokenTypeCards(props: {
  ctx: ViewContext;
  data: CardsData;
  /** The card named by `?template=`. */
  open: string | null;
  failed: FailedCard | null;
}) {
  const { ctx, data } = props;
  if (data.keyringError !== null) return <KeyringGate error={data.keyringError} />;
  const openId = props.failed?.template ?? props.open;
  return (
    <>
      <TypeCatalog
        id="types"
        title="Choose an application and access type"
        description="Start with an API credential, then limit each consumer’s access in tokengate. Webhooks already have a narrow scope."
      >
        {['Slack', 'GitHub', 'OpenAI', 'Anthropic', 'Discord'].map((app) => (
          <>
            <CatalogGroup>{app}</CatalogGroup>
            {SERVICE_TEMPLATES.filter((template) => template.app === app).map((template) => (
              <TemplateCard
                ctx={ctx}
                data={data}
                template={template}
                open={openId === template.id}
                failed={props.failed?.template === template.id ? props.failed : null}
              />
            ))}
          </>
        ))}
        <Or />
        <CustomCard
          ctx={ctx}
          data={data}
          open={openId === CUSTOM}
          failed={props.failed?.template === CUSTOM ? props.failed : null}
        />
      </TypeCatalog>
      {data.allowlist !== null && data.allowlist.length > 0 ? (
        <p class="hint">
          Tokens may point only at:{' '}
          {data.allowlist.map((host, index) => (
            <>
              {index > 0 ? ', ' : null}
              <code>{host}</code>
            </>
          ))}
          .{' '}
          {ctx.can('settings:write') ? <a href={paths.tokenHosts()}>Change allowed hosts</a> : null}
        </p>
      ) : (
        <p class="hint">
          Tokens may point at any public https host.{' '}
          {ctx.can('settings:write') ? <a href={paths.tokenHosts()}>Limit allowed hosts</a> : null}
        </p>
      )}
    </>
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
  const common = {
    name: 'token-type',
    id: `type-${template.id}`,
    logo: templateLogo(template),
    title: template.access_label,
    description: `${template.card_summary}${blocked ? ` · ${host} is not an allowed host` : ''}`,
    open: props.open,
  };
  if (blocked && !canAllow) {
    return (
      <TypeCard {...common} layout="fields">
        <p>{host} is not an allowed host.</p>
        <AskSomeone permission="settings:write" ctx={ctx} verb={`allow ${host}`} />
      </TypeCard>
    );
  }
  const ids = new FormIds(template.id, failed?.state.errors ?? []);
  const values: TokenFormValues = failed?.state.values ?? {
    ...EMPTY_VALUES,
    template: template.id,
  };
  const slug = freeSlugAmong(
    template.slug,
    data.tokens.map((token) => token.slug),
  );
  const name = freeNameAmong(
    template.name,
    data.tokens.map((token) => token.name),
  );
  const verify = failed?.state.verify ?? null;
  const failedCheck = verify !== null;
  const actionsId = `${ids.prefix}-actions`;
  const docs = (
    <a href={template.docs_url}>
      {template.label} documentation<span class="vh"> ({vendor(template)} docs)</span>
    </a>
  );
  return (
    <TypeCard
      {...common}
      action="/admin/credentials"
      hidden={ctx.hidden({ template: template.id })}
      layout="form-layout"
    >
      <div class="fields">
        <SecretField
          ids={ids}
          label={template.secret.label}
          placeholder={template.secret.placeholder}
          hint={`${template.secret.hint} ${KEPT_HINT}`}
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
        {failedCheck ? (
          <SecretSubmits label={saveLabel(template)} failedCheck id={actionsId} extra={docs} />
        ) : null}
        {template.id === 'github' ? (
          <AlsoUploads ctx={ctx} data={data} ids={ids} values={values} />
        ) : null}
        <OptionalFields
          ids={ids}
          values={values}
          slugPlaceholder={slug}
          namePlaceholder={name}
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
            hint="Required: this type's host is not allowed yet."
            error={ids.error('allow_host')}
          />
        ) : null}
        {template.notes ? <p class="hint">{template.notes}</p> : null}
        {failedCheck ? null : (
          <SecretSubmits
            label={saveLabel(template)}
            failedCheck={false}
            id={actionsId}
            extra={docs}
          />
        )}
      </div>
      {verify ? (
        <SubBox as="aside" labelledBy={`${ids.prefix}-answer`}>
          <h3 id={`${ids.prefix}-answer`}>
            What {vendor(template)} answered{' '}
            <Badge tone="bad" glyph="✕">
              Check failed
            </Badge>
          </h3>
          <p>{checkTitle(verify)}</p>
          {verify.bodyPreview ? (
            <CodeBlock
              label={`${vendor(template)} response`}
              caption="Start of the upstream response (any copy of the secret is masked)"
            >
              {verify.bodyPreview}
            </CodeBlock>
          ) : null}
          {verify.expiresAt !== null ? (
            <p>The upstream reports that this secret expires {formatTime(verify.expiresAt)}.</p>
          ) : null}
        </SubBox>
      ) : (
        <SubBox as="aside" labelledBy={`${ids.prefix}-next`}>
          <h3 id={`${ids.prefix}-next`}>When you save</h3>
          <Entity
            logo={templateLogo(template)}
            name={name}
            meta={
              <>
                <Slug>{slug}</Slug> · {upstreamShort(template.base_url)}
              </>
            }
          />
          <ol>
            {template.verify ? (
              <li>
                <b>tokengate calls {vendor(template)}</b>{' '}
                <code>
                  {template.verify.method} {template.verify.path}
                </code>{' '}
                with the secret and expects HTTP {template.verify.expect_status}
                {template.verify.expect_ok_field ? (
                  <>
                    {' '}
                    and <code>"ok": true</code>
                  </>
                ) : null}
                .
              </li>
            ) : (
              <li>
                <b>There is no check</b> for this type: the secret is saved as pasted.
              </li>
            )}
            <li>
              <b>The secret is sealed</b>
              {data.activeKid ? (
                <>
                  {' '}
                  with key <code>{data.activeKid}</code>
                </>
              ) : null}{' '}
              and never shown again.
            </li>
            <li>
              <b>Loading a credential gives nobody access.</b> Credential access rules do.
            </li>
          </ol>
          <p class="hint">
            Consumers will call <code>{`/proxy/${slug}`}</code>
          </p>
        </SubBox>
      )}
    </TypeCard>
  );
}

/**
 * The GitHub card's "also add uploads" box. When the allowlist blocks uploads.github.com, an owner
 * gets one box that also allows it (`allow_host=uploads.github.com`, the field permission), so the
 * pair is still one submit; anyone else gets no box, only the reason and whom to ask.
 */
function AlsoUploads(props: {
  ctx: ViewContext;
  data: CardsData;
  ids: FormIds;
  values: TokenFormValues;
}) {
  const { ctx, data, ids, values } = props;
  const uploads = getServiceTemplate('github-uploads');
  if (!uploads) return null;
  const host = templateHost(uploads);
  const label = `Also add release asset uploads (${host}) with the same token`;
  const hint = `Creates a second token for ${host} with the same secret.`;
  const error = ids.error('also_uploads');
  if (upstreamHostAllowed(host, data.allowlist)) {
    return (
      <Checkbox
        name="also_uploads"
        id={ids.id('also_uploads')}
        label={label}
        hint={hint}
        checked={values.also_uploads}
        error={error}
      />
    );
  }
  if (!ctx.can('settings:write')) {
    return (
      <div class="stack-sm">
        <p class="hint">
          {host} is not an allowed host, so the release asset uploads token cannot be added with
          this one.
        </p>
        <AskSomeone permission="settings:write" ctx={ctx} verb={`allow ${host}`} />
      </div>
    );
  }
  return (
    <Checkbox
      name="allow_host"
      id={ids.id('also_uploads')}
      value={host}
      label={`${label}, and allow ${host} in Allowed hosts (applies to every token)`}
      hint={`${hint} ${host} is not an allowed host yet; ticking this also allows it, for every token.`}
      checked={values.also_uploads}
      error={error}
    />
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
  const verify = failed?.state.verify ?? null;
  const baseError = ids.error('base_url');
  return (
    <TypeCard
      name="token-type"
      id="type-custom"
      class="lform"
      logo="custom"
      title="Custom API"
      description="Any HTTPS API. You set the base URL and how the secret is sent: bearer, header, basic, path or query."
      open={props.open}
      action="/admin/credentials"
      hidden={ctx.hidden({ template: CUSTOM })}
    >
      <Field
        id={ids.id('base_url')}
        label="Base URL"
        hint={
          <>
            https only, no query string. Consumers can only reach paths under it.
            {listed ? <> Allowed hosts: {allowlist.join(', ')}.</> : null}
          </>
        }
        error={baseError ?? undefined}
      >
        <Input
          name="base_url"
          type="url"
          mono
          required
          value={values.base_url}
          placeholder="https://api.example.com/v1"
          suggestions={baseUrlSuggestions(allowlist, data.tokens)}
          // Not generated when the owner may tick allow_host: the field must not look wrong first.
          pattern={listed && !canAllow ? allowlistPattern(allowlist) : undefined}
        />
      </Field>
      <InjectionFields ids={ids} values={values} tokens={data.tokens} />
      <SecretField
        ids={ids}
        label={CUSTOM_SECRET.label}
        placeholder={CUSTOM_SECRET.placeholder}
        hint={CUSTOM_SECRET.hint}
        draft={failed?.state.draft ?? null}
      />
      {verify ? <CheckResult verify={verify} /> : null}
      {listed && canAllow ? (
        <Checkbox
          name="allow_host"
          id={ids.id('allow_host')}
          value="1"
          checked={values.allow_host !== ''}
          label="Also add this host to Allowed hosts"
          hint="Only when the base URL's host is not allowed yet. Applies to every credential."
          error={ids.error('allow_host')}
        />
      ) : null}
      <OptionalFields
        ids={ids}
        values={values}
        slugPlaceholder={slug}
        namePlaceholder={slug}
        expiry
        today={data.today}
        derived={{
          slug: "Leave empty to use the API host's name, e.g. stripe for https://api.stripe.com/v1.",
          name: 'Leave empty to use the slug.',
        }}
      />
      <AdvancedFields ids={ids} values={values} tokens={data.tokens} />
      <SecretSubmits label="Save custom token" failedCheck={verify !== null} id="custom-actions" />
    </TypeCard>
  );
}
