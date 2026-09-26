import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { extensionZip, happyPath, PUBLISH, PUBLISH_STATUS, publishFailed, type RecordedRequest, startMockEdge, UPLOAD, UPLOAD_STATUS } from './helpers.ts';

const ZIP = 'self-test.zip';
const REQUESTS = 'self-test-requests.json';
const PORT = 'self-test-port';
const VERSION = '1.2.3';
const API_KEY = 'self-test-key';
const CLIENT_ID = 'self-test-client';

type Scenario = 'submitted' | 'uploaded' | 'in-review' | 'dry-run';
type Recorded = Omit<RecordedRequest, 'bytes'>;

const EXPECTED: Record<Scenario, { keys: string[]; outcome: string; result: string; errorCode: string }> = {
  submitted: { keys: [UPLOAD, UPLOAD_STATUS, PUBLISH, PUBLISH_STATUS], outcome: 'success', result: 'submitted', errorCode: '' },
  uploaded: { keys: [UPLOAD, UPLOAD_STATUS], outcome: 'success', result: 'uploaded', errorCode: '' },
  'in-review': { keys: [UPLOAD, UPLOAD_STATUS, PUBLISH, PUBLISH_STATUS], outcome: 'failure', result: '', errorCode: 'InProgressSubmission' },
  'dry-run': { keys: [], outcome: 'success', result: 'dry-run', errorCode: '' },
};

const USAGE = `Usage: node test/self-test.ts start|serve|verify ${Object.keys(EXPECTED).join('|')}`;
const [command, name = ''] = process.argv.slice(2);
if (!Object.hasOwn(EXPECTED, name)) {
  console.error(USAGE);
  process.exit(2);
}
const scenario = name as Scenario;

if (command === 'start') {
  rmSync(PORT, { force: true });
  const log = openSync('self-test-server.log', 'w');
  spawn(process.execPath, [import.meta.filename, 'serve', scenario], { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 50 && !existsSync(PORT); i++) await sleep(100);
  if (!existsSync(PORT)) {
    console.error(readFileSync('self-test-server.log', 'utf8'));
    console.error('The mock API did not start within 5 s.');
    process.exit(1);
  }
  const base = `http://127.0.0.1:${readFileSync(PORT, 'utf8')}`;
  appendFileSync(process.env.GITHUB_ENV ?? '/dev/stdout', `EDGE_API_BASE=${base}\nEDGE_POLL_INTERVAL_MS=0\n`);
  console.log(`Mock Edge Add-ons API for the ${scenario} scenario listening on ${base}.`);
} else if (command === 'serve') {
  writeFileSync(ZIP, extensionZip(VERSION));
  writeFileSync(REQUESTS, '[]');
  const store = await startMockEdge({
    clientId: CLIENT_ID,
    onRequest: (_, requests) => writeFileSync(REQUESTS, JSON.stringify(requests.map(({ bytes: _bytes, ...request }) => request), null, 2)),
  });
  happyPath(store, { publish: scenario !== 'uploaded' });
  if (scenario === 'in-review') store.on(PUBLISH_STATUS, publishFailed('InProgressSubmission'));
  writeFileSync(`${PORT}.tmp`, new URL(store.base).port);
  renameSync(`${PORT}.tmp`, PORT);
} else if (command === 'verify') {
  const expected = EXPECTED[scenario];
  assert.deepEqual(
    { outcome: process.env.OUTCOME, result: process.env.RESULT, version: process.env.VERSION, errorCode: process.env.ERROR_CODE },
    { outcome: expected.outcome, result: expected.result, version: VERSION, errorCode: expected.errorCode },
  );
  const requests = JSON.parse(readFileSync(REQUESTS, 'utf8')) as Recorded[];
  assert.deepEqual(
    requests.map((request) => request.key),
    expected.keys,
  );
  for (const request of requests) {
    assert.equal(request.auth, `ApiKey ${API_KEY}`);
    assert.equal(request.clientId, CLIENT_ID);
  }
  if (requests[0]) {
    assert.equal(requests[0].contentType, 'application/zip');
    assert.equal(requests[0].size, readFileSync(ZIP).length);
  }
  const publish = requests[2];
  if (scenario === 'submitted') {
    const notes = process.env.NOTES ?? '';
    assert.match(notes, /\n/);
    assert.match(notes, /&/);
    assert.ok(publish);
    assert.equal(publish.contentType, 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.equal(new URLSearchParams(publish.body).get('notes'), notes);
  }
  if (scenario === 'in-review') {
    assert.ok(publish);
    assert.equal(publish.contentType, undefined);
    assert.equal(publish.contentLength, '0');
  }
  console.log(`The ${scenario} scenario made the expected ${requests.length} requests and set the expected outputs.`);
} else {
  console.error(USAGE);
  process.exit(2);
}
