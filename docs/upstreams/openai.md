# OpenAI API

This page shows admins how to set up an OpenAI service and shows workflow authors how to point the OpenAI SDKs at the gateway.

## Service template

In the admin UI, open **Credentials**, select **Add a token** and open the **OpenAI API** card. Paste the API key and select **Check and save OpenAI**. Everything in the table comes from the template (`apps/gateway/src/admin/service-templates.ts`); the form does not ask for it. Name and slug are optional: when empty, the gateway uses `OpenAI` and the slug below, or the next free one (`openai-2`).

| Field | Template value |
|---|---|
| Slug | `openai` |
| Base URL | `https://api.openai.com/v1` |
| How the secret is sent | Bearer token (`Authorization: Bearer <credential>`) |
| Extra headers consumers may send | `openai-organization`, `openai-project`, `openai-beta` |
| Timeout (milliseconds) | `600000` |
| Secret check | `GET /models`, expect `200` |
| Suggested grant rules | `POST /responses`, `POST /chat/completions`, `GET /models` |
| Host for the upstream host allowlist | `api.openai.com` |

If **Credentials › Allowed hosts** is set and does not include `api.openai.com`, the card says so before you type anything. An owner ticks **Also allow api.openai.com in Allowed hosts** in the same form; anyone else asks an owner ([configuration](../configuration.md#upstream-host-allowlist)).

Use a project API key (`sk-proj-REDACTED`). Reference: <https://platform.openai.com/docs/api-reference/authentication>.

## Call it

The examples read the caller token in one of two ways. `$(tokengate-token)` works only in GitHub Actions jobs that ran the [get-token action](../callers/github-actions.md#2-mint-the-token-with-the-composite-action).
`TOKENGATE_TOKEN` is a variable that holds a caller token. In GitHub Actions, set it from `steps.<id>.outputs.token`. In GitLab CI, name the `id_tokens` entry `TOKENGATE_TOKEN`.

The SDK base URL is `<gateway>/proxy/openai`. The SDKs append paths such as `/chat/completions`, so `/proxy/openai/chat/completions` reaches `https://api.openai.com/v1/chat/completions`.

### curl

```bash
curl -sS --fail-with-body "$TOKENGATE_URL/proxy/openai/responses" \
  -H "x-tokengate-token: $(tokengate-token)" \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5","input":"Summarize the release notes."}'
```

### Node.js (`openai`)

Pass the caller token as the API key. The SDK sends it as `Authorization: Bearer`, which the gateway reads as the caller token and never forwards ([I-TOK-1](../threat-model.md#i-tok-1)).

```js
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.TOKENGATE_TOKEN,
  baseURL: `${process.env.TOKENGATE_URL}/proxy/openai`,
});
const response = await openai.responses.create({ model: 'gpt-5', input: 'Hello' });
```

### Python (`openai`)

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ["TOKENGATE_TOKEN"],
    base_url=f"{os.environ['TOKENGATE_URL']}/proxy/openai",
)
response = client.responses.create(model="gpt-5", input="Hello")
```

Both SDKs also read `OPENAI_BASE_URL` and `OPENAI_API_KEY` from the environment.

## Caller token header

| Client | Header |
|---|---|
| curl | `x-tokengate-token` |
| OpenAI SDKs | `Authorization: Bearer` (the SDK API key) |

The gateway replaces `Authorization` with the service credential ([I-INJ-1](../threat-model.md#i-inj-1)).

## Starter rules

Rules are relative to the base URL (`https://api.openai.com/v1`). Start from the template and add only what the job uses:

```text
POST /responses
POST /chat/completions
GET /models
```

Every grant also needs conditions. To let every repository call OpenAI only through one central reusable workflow, see [github-actions.md](../callers/github-actions.md#central-reusable-workflow-for-the-organization). Syntax: [policies.md](../policies.md).

## Gotchas

- **Headers.** Only common headers (`accept`, `content-type`, `user-agent`, `idempotency-key`, …) and the three template headers reach OpenAI. The SDK's other headers (for example `x-stainless-*`) are dropped. To send another header, add it to **Extra headers callers may send (optional)**.
- **Project and organization headers.** If the SDK sets `organization` or `project`, the values must fit the stored key, or OpenAI refuses the call.
- **Streaming.** Responses stream through unchanged. **Timeout (milliseconds)** limits only the wait for response headers; a long stream is not cut.
- **Wide rules.** `POST /**` lets the caller create files, fine-tuning jobs, batches and vector stores on your account. List paths instead.
- **Response bodies are not filtered.** Whatever OpenAI returns reaches the caller ([threat-model.md](../threat-model.md#credentials-and-responses)).
- **Long jobs.** GitHub caller tokens expire after about 5 minutes. Create a new client with a fresh token for each group of calls. See [github-actions.md](../callers/github-actions.md#long-jobs).
- **Credential rotation.** See [credential-rotation.md](../operations/credential-rotation.md).
