import { readFileSync, statSync } from 'node:fs';
import { ActionError } from './errors.ts';
import { error, getBooleanInput, getInput, info, mask, setOutput, warning } from './runner.ts';
import { EDGE_API, GUID, OperationError, publishToEdge } from './store.ts';
import { readManifest } from './zip.ts';

const STORE_ID = /^[a-p]{32}$/;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const JSON_LIKE = /^[{["]/;
const API_KEY_SCHEME = /^apikey\s/i;
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const CRX_MAGIC = ['Cr24', 'CrOD'];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_PACKAGE_BYTES = 2 * 1024 ** 3;

async function main(): Promise<void> {
  const apiKey = getInput('api-key');
  const clientId = getInput('client-id');
  mask(apiKey);
  mask(clientId);

  const apiBase = testEndpoint('EDGE_API_BASE', EDGE_API);
  const pollIntervalMs = testPollInterval(apiBase !== EDGE_API);
  checkCredential('api-key', 'API key', apiKey, 'Pass only the API key from the Publish API page in Partner Center.');
  checkCredential('client-id', 'client ID', clientId, 'Pass the client ID from the Publish API page in Partner Center.');
  if (apiKey === clientId) throw new ActionError('Inputs api-key and client-id are the same value. The Publish API page shows the client ID and the API key separately.');

  const productId = getInput('product-id', { required: true });
  if (productId === clientId) {
    throw new ActionError('Inputs product-id and client-id are the same value. The product ID is on the Extension overview page, the client ID on the Publish API page.');
  }
  if (STORE_ID.test(productId)) {
    throw new ActionError('Input product-id is the extension ID from the Edge Add-ons store address. The API needs the product ID, the GUID on the Extension overview page in Partner Center.');
  }
  if (!GUID.test(productId)) {
    throw new ActionError('Input product-id must be the product ID from the Extension overview page in Partner Center, a GUID such as d34f98f5-f9b7-42b1-bebb-98707202b21d.');
  }

  const submit = getBooleanInput('publish', true);
  const dryRun = getBooleanInput('dry-run', false);
  const notes = getInput('certification-notes');
  if (notes && !submit) throw new ActionError('Input certification-notes needs publish: true, because the notes travel with the submission.');

  const zipPath = getInput('zip', { required: true });
  const label = JSON.stringify(zipPath);
  let zip: Buffer;
  try {
    if (statSync(zipPath).size > MAX_PACKAGE_BYTES) throw new ActionError(`${label} is larger than 2 GiB, the largest package this action reads.`);
    zip = readFileSync(zipPath);
  } catch (cause) {
    if (cause instanceof ActionError) throw cause;
    const { code, message } = cause as NodeJS.ErrnoException;
    throw new ActionError(`Cannot read ${label}: ${code === 'ENOENT' ? 'no such file' : message}.`);
  }
  if (zip.length >= 4 && CRX_MAGIC.includes(zip.toString('latin1', 0, 4))) throw new ActionError(`${label} is a CRX package, not a ZIP. Edge Add-ons takes the ZIP.`);
  const { version } = readManifest(zip, label);
  const size = `${Math.ceil(zip.length / 1024)} KB`;
  info(`The ZIP holds version ${version} (${size}).`);
  setOutput('version', version);

  if (dryRun) {
    const plan = !submit
      ? 'and leave it in the draft, because publish is false'
      : `and submit it for certification ${notes ? `with notes (${[...notes].length} characters)` : 'without notes'}`;
    info(`Dry run: a real run would upload version ${version} (${size}) to the draft of product ${productId} ${plan}.`);
    info('Dry run: nothing was sent to Microsoft. A dry run checks the inputs and the ZIP only, so it does not check the API key, the client ID, the product ID or a review in progress.');
    setOutput('result', 'dry-run');
    return;
  }

  const { result, errorCode } = await publishToEdge({ apiKey, clientId, productId, version, zip, submit, notes, apiBase, pollIntervalMs, log: info, warn: warning });
  if (ERROR_CODE.test(errorCode)) setOutput('error-code', errorCode);
  setOutput('result', result);
}

function checkCredential(name: string, noun: string, value: string, advice: string): void {
  if (!value) throw new ActionError(`Input ${name} is required.`);
  if (name === 'api-key' && API_KEY_SCHEME.test(value)) throw new ActionError('Input api-key starts with "ApiKey ". Pass only the key; the action adds the scheme.');
  if (JSON_LIKE.test(value)) {
    throw new ActionError(`Input ${name} looks like JSON. Store the ${noun} alone as its own secret: GitHub cannot reliably redact values taken out of a structured secret.`);
  }
  if (!HEADER_SAFE.test(value)) throw new ActionError(`Input ${name} contains spaces or control characters. ${advice}`);
}

function testEndpoint(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ActionError(`${name} is not a URL.`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ActionError(`${name} is a test setting and may only point to http://127.0.0.1, http://localhost or http://[::1].`);
  }
  return value.replace(/\/+$/, '');
}

function testPollInterval(testing: boolean): number | undefined {
  const value = process.env.EDGE_POLL_INTERVAL_MS;
  if (!value) return undefined;
  if (!testing) throw new ActionError('EDGE_POLL_INTERVAL_MS is a test setting and only works together with EDGE_API_BASE.');
  if (!/^\d{1,5}$/.test(value) || Number(value) > 10_000) throw new ActionError('EDGE_POLL_INTERVAL_MS must be a whole number of milliseconds from 0 to 10000.');
  return Number(value);
}

main().catch((cause: unknown) => {
  if (cause instanceof OperationError && ERROR_CODE.test(cause.errorCode)) setOutput('error-code', cause.errorCode);
  if (cause instanceof ActionError) error(cause.details ? `${cause.message}\n${cause.details}` : cause.message);
  else error(`Unexpected failure: ${(cause as Error | undefined)?.stack ?? cause}`);
  process.exitCode = 1;
});
