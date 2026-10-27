// Generates and checks TOKENGATE_KEK / TOKENGATE_KEYRING values outside Cloudflare, using the
// same checks as the Worker (ADR 0027). Runs on Node 22.18+ (type stripping):
// `node scripts/keyring.ts check`. Secrets are read from stdin only, never from argv, so they stay
// out of shell history. Key ids depend on the login variables (I-CRED-3), read from the
// environment like the Worker does.
import {
  boundKey,
  checkNextKey,
  kekBindingInfo,
  type KeyringEnv,
  keyCheckValue,
  loadKeyring,
} from '../src/crypto/keyring.ts';

const USAGE = `usage:
  node scripts/keyring.ts generate
      Prints a new random 32-byte key (standard base64) on stdout and its key id on stderr.
      Set it as TOKENGATE_KEYRING to start a rotation (Settings › Rotate encryption).
  node scripts/keyring.ts check < secret
      Reads one key (bare base64) from stdin, checks it like the Worker checks TOKENGATE_KEYRING
      and prints its key id.

Key ids depend on AUTH_ACCESS_TEAM_DOMAIN, AUTH_ACCESS_AUD and AUTH_ACCESS_DEVELOPMENT.
Set them in the environment to the Worker's values to compare with Settings.
`;

function loginEnv(): KeyringEnv {
  return {
    AUTH_ACCESS_TEAM_DOMAIN: process.env.AUTH_ACCESS_TEAM_DOMAIN,
    AUTH_ACCESS_AUD: process.env.AUTH_ACCESS_AUD,
    AUTH_ACCESS_DEVELOPMENT: process.env.AUTH_ACCESS_DEVELOPMENT,
  };
}

async function generate(): Promise<number> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  process.stdout.write(`${Buffer.from(raw).toString('base64')}\n`);
  const bound = await boundKey(raw, kekBindingInfo(loginEnv()));
  process.stderr.write(`kid ${await keyCheckValue(bound)}\n`);
  return 0;
}

async function check(): Promise<number> {
  const input = (await readStdin()).trim();
  const problem = checkNextKey(input);
  if (problem) {
    process.stderr.write(`invalid key: ${problem}\n`);
    return 1;
  }
  const result = await loadKeyring({ ...loginEnv(), TOKENGATE_KEYRING: input });
  if (!result.ok) {
    process.stderr.write(`invalid key: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(`kid ${result.keyring.activeKid}\n`);
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(command: string | undefined): Promise<number> {
  if (command === 'generate') return generate();
  if (command === 'check') return check();
  process.stderr.write(USAGE);
  return 2;
}

process.exitCode = await main(process.argv[2]);
