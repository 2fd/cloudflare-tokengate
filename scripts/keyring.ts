// Generates and checks TOKENGATE_KEK / TOKENGATE_KEYRING values outside Cloudflare, using the
// same parser as the Worker. Runs on Node 22.18+ (type stripping): `node scripts/keyring.ts check`.
// Secrets are read from stdin only, never from argv, so they stay out of shell history.
import { keyCheckValue, loadKeyring } from '../src/crypto/keyring.ts';

const USAGE = `usage:
  node scripts/keyring.ts generate
      Prints a new random 32-byte key (standard base64) on stdout and its KCV on stderr.
      Store it in your own vault first: a lost KEK means every stored credential is lost.
  node scripts/keyring.ts check < secret
      Reads a TOKENGATE_KEK value (bare base64) or a TOKENGATE_KEYRING value (JSON) from stdin,
      validates it like the Worker does and prints the active kid and each kid's KCV.
`;

async function generate(): Promise<number> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  process.stdout.write(`${Buffer.from(raw).toString('base64')}\n`);
  process.stderr.write(`kcv ${await keyCheckValue(raw)}\n`);
  return 0;
}

async function check(): Promise<number> {
  const input = (await readStdin()).trim();
  const isJson = input.startsWith('{');
  const result = await loadKeyring(
    isJson ? { TOKENGATE_KEYRING: input } : { TOKENGATE_KEK: input },
  );
  if (!result.ok) {
    process.stderr.write(
      `invalid ${isJson ? 'TOKENGATE_KEYRING' : 'TOKENGATE_KEK'}: ${result.error}\n`,
    );
    return 1;
  }
  const { keyring } = result;
  process.stdout.write(`source ${isJson ? 'TOKENGATE_KEYRING' : 'TOKENGATE_KEK'}\n`);
  process.stdout.write(`active ${keyring.activeKid}\n`);
  for (const kid of keyring.kids) process.stdout.write(`kid ${kid} kcv ${keyring.kcv[kid]}\n`);
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
