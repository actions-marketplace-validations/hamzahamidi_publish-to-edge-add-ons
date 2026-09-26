import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  accepted,
  extensionZip,
  happyPath,
  makeCrx,
  makeZip,
  type MockStore,
  operation,
  PRODUCT,
  PUBLISH,
  PUBLISH_OP,
  PUBLISH_STATUS,
  publishFailed,
  startMockEdge,
  UPLOAD,
  UPLOAD_OP,
  UPLOAD_STATUS,
  uploadSucceeded,
} from './helpers.ts';

const MAIN = resolve(import.meta.dirname, '../src/main.ts');
const KEY = 'edge-test-api-key-9f8e7d6c';
const CLIENT = 'edge-test-client-4c3b2a19';
const dir = mkdtempSync(join(tmpdir(), 'edge-action-'));
let store: MockStore;

before(async () => {
  store = await startMockEdge({ clientId: CLIENT });
});
afterEach(() => store.reset());
after(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function zipFile(version: string, name = `ext-${version}.zip`, content: Buffer = extensionZip(version)): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

interface ActionRun {
  code: number | null;
  stdout: string;
  outputs: Record<string, string>;
}

function runAction(inputs: Record<string, string>, env: Record<string, string> = {}): Promise<ActionRun> {
  const output = join(dir, `output-${Math.random().toString(16).slice(2)}`);
  writeFileSync(output, '');
  const inputEnv = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]));
  return new Promise((done) => {
    const child = spawn(process.execPath, [MAIN], {
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, EDGE_API_BASE: store.base, EDGE_POLL_INTERVAL_MS: '0', ...inputEnv, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => done({ code, stdout, outputs: parseOutputs(readFileSync(output, 'utf8')) }));
  });
}

function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const pattern = /^([\w-]+)<<(EOF_[\w-]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm;
  for (const match of text.matchAll(pattern)) if (match[1] !== undefined) outputs[match[1]] = match[3] ?? '';
  return outputs;
}

const baseInputs = (version = '1.4.0', extra: Record<string, string> = {}): Record<string, string> => ({
  'api-key': KEY,
  'client-id': CLIENT,
  'product-id': PRODUCT,
  zip: zipFile(version),
  ...extra,
});

const withoutMaskLines = (stdout: string) =>
  stdout
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('::add-mask::'))
    .join('\n');

function assertMasked(run: ActionRun, secrets: string[] = [KEY, CLIENT]) {
  for (const secret of secrets) {
    assert.ok(run.stdout.includes(`::add-mask::${secret}`), `expected ${secret} to be masked`);
    assert.ok(!withoutMaskLines(run.stdout).includes(secret), `${secret} leaked:\n${run.stdout}`);
  }
  const lines = run.stdout.split(/\r?\n/).filter(Boolean);
  const firstOther = lines.findIndex((line) => !line.startsWith('::add-mask::'));
  const lastMask = lines.findLastIndex((line) => line.startsWith('::add-mask::'));
  assert.ok(lastMask < firstOther, `every mask must come before any other line:\n${run.stdout}`);
}

describe('action', () => {
  it('uploads and submits, sets the outputs and never prints the credentials', async () => {
    happyPath(store);
    const run = await runAction(baseInputs());
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(run.outputs, { version: '1.4.0', result: 'submitted' });
    assert.deepEqual(
      store.requests.map((request) => request.key),
      [UPLOAD, UPLOAD_STATUS, PUBLISH, PUBLISH_STATUS],
    );
    assert.ok(store.requests.every((request) => request.auth === `ApiKey ${KEY}` && request.clientId === CLIENT));
    assert.match(run.stdout, /^The ZIP holds version 1\.4\.0 \(1 KB\)\.$/m);
    assert.match(run.stdout, /^Version 1\.4\.0 is in certification, which can take up to 7 business days\./m);
    assertMasked(run);
  });

  it('masks the credentials before a run that fails on a local check or with a 403', async () => {
    const local = await runAction(baseInputs('1.4.0', { 'product-id': 'nope' }));
    assert.equal(local.code, 1);
    assertMasked(local);

    const refused = await runAction(baseInputs('1.4.0', { 'client-id': 'another-client-id' }));
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /^::error::POST \/v1\/products\/.*\/submissions\/draft\/package returned HTTP 403 Client ID is Invalid%0AMicrosoft refused the client ID/m);
    assertMasked(refused, [KEY, 'another-client-id']);
  });

  it('uploads only when publish is false', async () => {
    happyPath(store, { publish: false });
    const run = await runAction(baseInputs('1.4.0', { publish: 'false' }));
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(run.outputs, { version: '1.4.0', result: 'uploaded' });
    assert.deepEqual(
      store.requests.map((request) => request.key),
      [UPLOAD, UPLOAD_STATUS],
    );
  });

  it('ends skipped with a warning annotation and the error code on NoModulesUpdated', async () => {
    happyPath(store);
    store.on(PUBLISH_STATUS, publishFailed('NoModulesUpdated'));
    const run = await runAction(baseInputs());
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(run.outputs, { version: '1.4.0', 'error-code': 'NoModulesUpdated', result: 'skipped' });
    assert.match(run.stdout, /^::warning::Microsoft has nothing new to submit \(NoModulesUpdated\)/m);
  });

  it('fails on InProgressSubmission with one annotation, the version and the error code, and no result', async () => {
    happyPath(store);
    store.on(PUBLISH_STATUS, publishFailed('InProgressSubmission'));
    const run = await runAction(baseInputs());
    assert.equal(run.code, 1);
    assert.deepEqual(run.outputs, { version: '1.4.0', 'error-code': 'InProgressSubmission' });
    const errors = run.stdout.split(/\r?\n/).filter((line) => line.startsWith('::error::'));
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /^::error::Microsoft refused the submission: a submission for this product is already in progress \(InProgressSubmission\)\.%0AMicrosoft says: .*%0AIf an earlier run of this release submitted version 1\.4\.0, nothing is wrong/);
    assert.match(errors[0]!, new RegExp(`%0APublish operation: ${PUBLISH_OP}$`));
  });

  it('checks the inputs and the ZIP on a dry run and sends nothing', async () => {
    const run = await runAction(baseInputs('1.4.0', { 'dry-run': 'true', 'certification-notes': 'Sign in as tester.' }));
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(run.outputs, { version: '1.4.0', result: 'dry-run' });
    assert.equal(store.requests.length, 0);
    assert.match(run.stdout, new RegExp(`^Dry run: a real run would upload version 1\\.4\\.0 \\(1 KB\\) to the draft of product ${PRODUCT} and submit it for certification with notes \\(18 characters\\)\\.$`, 'm'));
    assert.match(run.stdout, /^Dry run: nothing was sent to Microsoft\. A dry run checks the inputs and the ZIP only, so it does not check the API key, the client ID, the product ID or a review in progress\.$/m);
    assertMasked(run);
  });

  it('describes an upload-only run and a run without notes on a dry run', async () => {
    const draft = await runAction(baseInputs('1.4.0', { 'dry-run': 'true', publish: 'false' }));
    assert.equal(draft.code, 0, draft.stdout);
    assert.match(draft.stdout, /to the draft of product .* and leave it in the draft, because publish is false\.$/m);
    const plain = await runAction(baseInputs('1.4.0', { 'dry-run': 'TRUE' }));
    assert.match(plain.stdout, /and submit it for certification without notes\.$/m);
    assert.equal(store.requests.length, 0);
  });

  it('never prints the certification notes, only their length', async () => {
    const marker = 'password-7f3e2d1c';
    happyPath(store);
    const run = await runAction(baseInputs('1.4.0', { 'certification-notes': `Tester account: tester@example.com\nPassword: ${marker}` }));
    assert.equal(run.code, 0, run.stdout);
    assert.ok(!run.stdout.includes(marker));
    assert.match(run.stdout, /^Submitting the draft for certification, with notes \(\d+ characters\)\.$/m);
    assert.equal(new URLSearchParams(store.requests[2]!.body).get('notes'), `Tester account: tester@example.com\nPassword: ${marker}`);
  });

  const crx = (magic: string) => zipFile('1.4.0', `${magic}.zip`, makeCrx(extensionZip('1.4.0'), magic));
  const nested = () => zipFile('1.4.0', 'nested.zip', makeZip([{ name: 'dist/manifest.json', data: '{"version":"1.4.0"}' }]));
  const badVersion = () => zipFile('1.4.0', 'bad-version.zip', makeZip([{ name: 'manifest.json', data: '{"version":"1.4.0-beta"}' }]));
  const zip64 = () => {
    const zip = extensionZip('1.4.0');
    zip.writeUInt16LE(0xffff, zip.length - 12);
    return zipFile('1.4.0', 'zip64.zip', zip);
  };
  const folder = () => {
    const path = join(dir, 'folder.zip');
    mkdirSync(path, { recursive: true });
    return path;
  };
  const invalid: Array<[string, () => Record<string, string>, RegExp]> = [
    ['no api-key', () => ({ 'api-key': '' }), /^::error::Input api-key is required\.$/m],
    ['no client-id', () => ({ 'client-id': '' }), /^::error::Input client-id is required\.$/m],
    ['no product-id', () => ({ 'product-id': '' }), /^::error::Input product-id is required\.$/m],
    ['a product-id that is not a GUID', () => ({ 'product-id': 'my-extension' }), /Input product-id must be the product ID from the Extension overview page in Partner Center, a GUID such as/],
    ['a store extension ID as product-id', () => ({ 'product-id': 'abcdefghijklmnopabcdefghijklmnop' }), /Input product-id is the extension ID from the Edge Add-ons store address\. The API needs the product ID/],
    ['a product-id equal to client-id', () => ({ 'client-id': PRODUCT }), /Inputs product-id and client-id are the same value\./],
    ['an api-key with the ApiKey scheme', () => ({ 'api-key': `ApiKey ${KEY}` }), /Input api-key starts with "ApiKey "\. Pass only the key; the action adds the scheme\./],
    ['an api-key with the scheme in lower case', () => ({ 'api-key': `apikey\t${KEY}` }), /Input api-key starts with "ApiKey "/],
    ['an api-key holding a line break', () => ({ 'api-key': 'first-half\nsecond-half' }), /Input api-key contains spaces or control characters\. Pass only the API key from the Publish API page in Partner Center\./],
    ['a client-id holding a line break', () => ({ 'client-id': 'client\r\nX-Injected: 1' }), /Input client-id contains spaces or control characters\. Pass the client ID from the Publish API page/],
    ['a client-id holding a JSON object', () => ({ 'client-id': '{"clientId": "abc", "apiKey": "def"}' }), /Input client-id looks like JSON\. Store the client ID alone as its own secret/],
    ['an api-key holding a JSON string', () => ({ 'api-key': '"quoted-key"' }), /Input api-key looks like JSON\. Store the API key alone as its own secret/],
    ['an api-key equal to client-id', () => ({ 'api-key': CLIENT }), /Inputs api-key and client-id are the same value\./],
    ['a publish value that is not boolean', () => ({ publish: 'yes' }), /Input publish must be true or false, got "yes"\./],
    ['a dry-run value that is not boolean', () => ({ 'dry-run': 'maybe' }), /Input dry-run must be true or false, got "maybe"\./],
    ['certification notes with publish false', () => ({ publish: 'false', 'certification-notes': 'x' }), /Input certification-notes needs publish: true, because the notes travel with the submission\./],
    ['certification notes with publish false on a dry run', () => ({ publish: 'false', 'dry-run': 'true', 'certification-notes': 'x' }), /Input certification-notes needs publish: true/],
    ['an empty zip', () => ({ zip: '' }), /^::error::Input zip is required\.$/m],
    ['an empty zip on a dry run', () => ({ zip: '', 'dry-run': 'true' }), /^::error::Input zip is required\.$/m],
    ['a missing file', () => ({ zip: 'nope/ext.zip' }), /Cannot read "nope\/ext\.zip": no such file\./],
    ['a folder', () => ({ zip: folder() }), /folder\.zip" is not a regular file\./],
    ['a CRX', () => ({ zip: crx('Cr24') }), /Cr24\.zip" is a CRX package, not a ZIP\. Edge Add-ons takes the ZIP\./],
    ['a differential CRX', () => ({ zip: crx('CrOD') }), /CrOD\.zip" is a CRX package, not a ZIP\. Edge Add-ons takes the ZIP\./],
    ['a ZIP with a nested manifest', () => ({ zip: nested() }), /has no manifest\.json at its root, only "dist\/manifest\.json"\. Zip the contents of the extension folder/],
    ['an invalid version', () => ({ zip: badVersion() }), /has version "1\.4\.0-beta", which is not a valid extension version\./],
    ['a ZIP64 archive', () => ({ zip: zip64() }), /is a ZIP64 archive, which is not supported\./],
  ];
  for (const [label, override, pattern] of invalid) {
    it(`stops before any request on ${label}`, async () => {
      const run = await runAction(baseInputs('1.4.0', override()));
      assert.equal(run.code, 1, run.stdout);
      assert.match(run.stdout, pattern);
      assert.equal(store.requests.length, 0);
      assert.ok(!run.stdout.includes('holds version'));
      assert.deepEqual(run.outputs, {});
      assert.ok(!withoutMaskLines(run.stdout).includes(KEY));
      assert.ok(!withoutMaskLines(run.stdout).includes('second-half'));
      assert.ok(!withoutMaskLines(run.stdout).includes('X-Injected'));
    });
  }

  it('refuses a package larger than 2 GiB without reading it', { skip: process.platform === 'win32' && 'sparse files' }, async () => {
    const zip = zipFile('1.4.0', 'huge.zip', Buffer.alloc(0));
    truncateSync(zip, 2 * 1024 ** 3 + 1);
    const run = await runAction(baseInputs('1.4.0', { zip }));
    assert.equal(run.code, 1);
    assert.match(run.stdout, /huge\.zip" is larger than 2 GiB, the largest package this action reads\./);
    assert.equal(store.requests.length, 0);
  });

  it('refuses a device as zip before reading it', { skip: process.platform === 'win32' && 'no /dev/null' }, async () => {
    const run = await runAction(baseInputs('1.4.0', { zip: '/dev/null' }));
    assert.equal(run.code, 1);
    assert.match(run.stdout, /^::error::"\/dev\/null" is not a regular file\.$/m);
    assert.equal(store.requests.length, 0);
    assert.deepEqual(run.outputs, {});
  });

  it('keeps hostile text from Microsoft from starting workflow commands', async () => {
    const hostile = 'bad\n::error::owned\r::add-mask::x %0A \u2028::warning::spoof ##[group]g';
    const phrase = ' ::error::owned %0A ##[group]g';
    store.on(UPLOAD, { status: 400, statusText: phrase, body: { message: hostile } });
    const refused = await runAction(baseInputs());

    store.reset();
    store.on(UPLOAD, accepted(UPLOAD_OP));
    store.on(UPLOAD_STATUS, operation('Failed', { errorCode: 'X', message: hostile, errors: [hostile, { message: hostile }] }));
    const failed = await runAction(baseInputs());

    store.reset();
    store.on(UPLOAD, { status: 202, headers: { Location: '::add-mask::x ##[group]g' }, body: null });
    const location = await runAction(baseInputs());

    store.reset();
    happyPath(store);
    store.on(UPLOAD_STATUS, operation('Succeeded', { message: hostile }));
    store.on(PUBLISH_STATUS, operation('Succeeded', { message: `::warning::spoof\n##[group]g` }));
    const logged = await runAction(baseInputs());
    assert.equal(logged.code, 0, logged.stdout);

    for (const run of [refused, failed, location, logged]) {
      const lines = run.stdout.split(/\r?\n/);
      assert.ok(!lines.some((line) => /^[\s\u0085\u2028]*::(error::owned|add-mask::x|warning::spoof)/.test(line)), run.stdout);
      assert.ok(!lines.some((line) => /^[\s\u0085\u2028]*##\[group\]/.test(line)), run.stdout);
      assert.ok(!lines.some((line) => /##\[group\]/.test(line) && !line.startsWith('::error::')), run.stdout);
    }
    assert.match(refused.stdout, /^::error::POST .* returned HTTP 400 .*: bad%0A::error::owned%0D::add-mask::x %250A/m);
    assert.match(failed.stdout, /^::error::Microsoft refused the package \(X\): bad%0A::error::owned/m);
    assert.match(location.stdout, /^::error::Microsoft accepted the upload but returned no operation ID \(Location: "::add-mask::x ##\[group\]g"\)\./m);
    assert.match(logged.stdout, /^Upload processed: bad ::error::owned ::add-mask::x %0A  ::warning::spoof ##\[\\group\]g$/m);
    assert.match(logged.stdout, /^Submission processed: ::warning::spoof ##\[\\group\]g$/m);
  });

  it('writes no error-code output for a code that is not a plain identifier, but shows it escaped', async () => {
    happyPath(store);
    store.on(PUBLISH_STATUS, operation('Failed', { errorCode: 'Bad\nCode', message: 'odd' }));
    const run = await runAction(baseInputs());
    assert.equal(run.code, 1);
    assert.deepEqual(run.outputs, { version: '1.4.0' });
    assert.match(run.stdout, /^::error::Microsoft refused the submission \(Bad%0ACode\): odd%0APublish operation: /m);

    store.reset();
    happyPath(store);
    store.on(PUBLISH_STATUS, operation('Failed', { errorCode: 'Two words', message: 'odd' }));
    const spaced = await runAction(baseInputs());
    assert.deepEqual(spaced.outputs, { version: '1.4.0' });
  });

  it('refuses to send the credentials anywhere but Microsoft or a loopback test server', async () => {
    for (const url of ['https://example.com', 'http://10.0.0.1:8080', 'http://localhost.example.com', 'https://127.0.0.1']) {
      const run = await runAction(baseInputs(), { EDGE_API_BASE: url });
      assert.equal(run.code, 1);
      assert.match(run.stdout, /EDGE_API_BASE is a test setting and may only point to http:\/\/127\.0\.0\.1, http:\/\/localhost or http:\/\/\[::1\]\./);
    }
    const notUrl = await runAction(baseInputs(), { EDGE_API_BASE: 'not a url' });
    assert.match(notUrl.stdout, /EDGE_API_BASE is not a URL\./);
    assert.equal(store.requests.length, 0);
  });

  it('accepts a poll interval only as a test setting next to a loopback base', async () => {
    const alone = await runAction(baseInputs('1.4.0', { 'product-id': 'stops-before-any-request' }), { EDGE_API_BASE: '' });
    assert.equal(alone.code, 1);
    assert.match(alone.stdout, /^::error::EDGE_POLL_INTERVAL_MS is a test setting and only works together with EDGE_API_BASE\.$/m);
    for (const value of ['-1', '1.5', '10001', 'soon']) {
      const run = await runAction(baseInputs(), { EDGE_POLL_INTERVAL_MS: value });
      assert.equal(run.code, 1);
      assert.match(run.stdout, /EDGE_POLL_INTERVAL_MS must be a whole number of milliseconds from 0 to 10000\./);
    }
    assert.equal(store.requests.length, 0);

    store.on(UPLOAD, accepted(UPLOAD_OP));
    store.on(UPLOAD_STATUS, operation('InProgress'), uploadSucceeded());
    const started = Date.now();
    const waited = await runAction(baseInputs('1.4.0', { publish: 'false' }), { EDGE_POLL_INTERVAL_MS: '300' });
    assert.equal(waited.code, 0, waited.stdout);
    assert.match(waited.stdout, /Checking every 0\.3 s\./);
    assert.ok(Date.now() - started >= 600);
    assert.ok(store.requests[2]!.time - store.requests[1]!.time >= 250);
  });

  it('accepts a loopback base with a trailing slash', async () => {
    happyPath(store, { publish: false });
    const run = await runAction(baseInputs('1.4.0', { publish: 'false' }), { EDGE_API_BASE: `${store.base.replace('127.0.0.1', 'localhost')}/` });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(store.requests[0]!.key, UPLOAD);
  });

  it('reports an upload that fails without a code and sets no error code', async () => {
    store.on(UPLOAD, accepted(UPLOAD_OP));
    store.on(UPLOAD_STATUS, operation('Failed', { errorCode: null, errors: null, message: null }));
    const run = await runAction(baseInputs());
    assert.equal(run.code, 1);
    assert.deepEqual(run.outputs, { version: '1.4.0' });
    assert.match(run.stdout, /^::error::Microsoft reports that the upload of version 1\.4\.0 failed and gives no reason: no message%0AThis has happened during Microsoft service incidents/m);
  });

  it('trims inputs, as the runner passes them', async () => {
    store.on(UPLOAD, accepted(UPLOAD_OP));
    store.on(UPLOAD_STATUS, uploadSucceeded());
    const run = await runAction({ ...baseInputs('1.4.0', { publish: ' false ' }), 'api-key': `  ${KEY}\n`, 'product-id': ` ${PRODUCT} ` });
    assert.equal(run.code, 0, run.stdout);
    assert.equal(store.requests[0]!.auth, `ApiKey ${KEY}`);
  });
});
