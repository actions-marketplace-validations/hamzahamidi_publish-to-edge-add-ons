import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { ActionError } from '../src/errors.ts';
import { OperationError, type PublishOptions, type PublishResult, publishToEdge } from '../src/store.ts';
import {
  accepted,
  closedPort,
  DEPRECATED_MESSAGE,
  extensionZip,
  happyPath,
  inProgress,
  irrecoverableFailure,
  type MockStore,
  operation,
  PRODUCT,
  PRODUCT_PATH,
  PUBLISH,
  PUBLISH_OP,
  PUBLISH_STATUS,
  publishFailed,
  publishSucceeded,
  SCHEME_MESSAGE,
  startMockEdge,
  unexpectedFailure,
  UPLOAD,
  UPLOAD_OP,
  UPLOAD_STATUS,
  uploadSucceeded,
} from './helpers.ts';

const ZIP = extensionZip('1.4.0');
let store: MockStore;
before(async () => {
  store = await startMockEdge({ clientId: 'test-client' });
});
afterEach(() => store.reset());
after(() => store.close());

function publish(options: Partial<PublishOptions> = {}) {
  const lines: string[] = [];
  const warnings: string[] = [];
  const waits: number[] = [];
  const promise = publishToEdge({
    apiKey: 'test-key',
    clientId: 'test-client',
    productId: PRODUCT,
    version: '1.4.0',
    zip: ZIP,
    apiBase: store.base,
    pollIntervalMs: 0,
    pollAttempts: 3,
    sleep: async (ms) => {
      waits.push(ms);
    },
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    ...options,
  });
  return Object.assign(promise, { lines, warnings, waits });
}

const calls = () => store.requests.map((request) => request.key);

async function rejection(promise: Promise<PublishResult>): Promise<ActionError> {
  const error: unknown = await promise.then(
    () => assert.fail('expected the call to fail'),
    (error: unknown) => error,
  );
  assert.ok(error instanceof ActionError, `expected ActionError, got ${error}`);
  return error;
}

const text = (error: ActionError) => `${error.message}\n${error.details ?? ''}`;

function uploadAnd(...statuses: Parameters<MockStore['on']>[1][]) {
  store.on(UPLOAD, accepted(UPLOAD_OP));
  store.on(UPLOAD_STATUS, ...statuses);
}

function publishAnd(...statuses: Parameters<MockStore['on']>[1][]) {
  uploadAnd(uploadSucceeded());
  store.on(PUBLISH, accepted(PUBLISH_OP));
  store.on(PUBLISH_STATUS, ...statuses);
}

describe('publishToEdge: normal runs', () => {
  it('uploads, waits for the upload, submits and waits for the submission', async () => {
    uploadAnd(inProgress(), inProgress(), uploadSucceeded());
    store.on(PUBLISH, accepted(PUBLISH_OP));
    store.on(PUBLISH_STATUS, publishSucceeded());
    const run = publish();
    assert.deepEqual(await run, { result: 'submitted', errorCode: '' });
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, UPLOAD_STATUS, UPLOAD_STATUS, PUBLISH, PUBLISH_STATUS]);
    assert.ok(store.requests.every((request) => request.auth === 'ApiKey test-key' && request.clientId === 'test-client'));
    assert.equal(store.requests[0]!.contentType, 'application/zip');
    assert.ok(store.requests[0]!.bytes.equals(ZIP));
    assert.ok(run.lines.includes('Upload processed: Successfully updated package to extension.zip'));
    assert.ok(run.lines.includes('Submission processed: Successfully created submission with ID 5f0a0c6e-3b1d-4c1e-9a0f-6d2b8c7e4a11'));
    assert.ok(run.lines.includes(`Microsoft accepted the upload as operation ${UPLOAD_OP}. Checking every 0 s.`));
    assert.ok(run.lines.includes(`Microsoft accepted the submission as operation ${PUBLISH_OP}. Checking every 0 s.`));
    assert.ok(run.lines.includes(`Uploading it to the draft of product ${PRODUCT}.`));
  });

  it('sends the publish call without a body or content type when there are no notes', async () => {
    happyPath(store);
    const run = publish();
    await run;
    const submission = store.requests[2]!;
    assert.equal(submission.key, PUBLISH);
    assert.equal(submission.size, 0);
    assert.equal(submission.contentLength, '0');
    assert.equal(submission.contentType, undefined);
    assert.ok(run.lines.includes('Submitting the draft for certification, without notes.'));
  });

  it('sends certification notes as a form field named notes and logs only their length', async () => {
    const notes = 'Line 1: sign in as tester\nLine 2: a & b = 100% café 🙂';
    happyPath(store);
    const run = publish({ notes });
    await run;
    const submission = store.requests[2]!;
    assert.equal(submission.contentType, 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.equal(new URLSearchParams(submission.body).get('notes'), notes);
    assert.deepEqual([...new URLSearchParams(submission.body).keys()], ['notes']);
    assert.ok(run.lines.includes(`Submitting the draft for certification, with notes (${[...notes].length} characters).`));
    assert.ok(run.lines.some((line) => line.includes('Check the submission in Partner Center the first time you use it.')));
    assert.ok(!run.lines.some((line) => line.includes('sign in as tester')));
  });

  it('uploads into the draft only when submit is false', async () => {
    happyPath(store, { publish: false });
    assert.deepEqual(await publish({ submit: false }), { result: 'uploaded', errorCode: '' });
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  it('reads status answers sent with HTTP 202 like those sent with 200', async () => {
    uploadAnd({ ...uploadSucceeded(), status: 202 });
    store.on(PUBLISH, accepted(PUBLISH_OP));
    store.on(PUBLISH_STATUS, { ...inProgress(), status: 202 }, { ...publishSucceeded(), status: 202 });
    assert.equal((await publish()).result, 'submitted');
  });

  it('compares status values without regard to case', async () => {
    uploadAnd(operation('inprogress'), operation('SUCCEEDED'));
    store.on(PUBLISH, accepted(PUBLISH_OP));
    store.on(PUBLISH_STATUS, operation('succeeded'));
    assert.equal((await publish()).result, 'submitted');
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, UPLOAD_STATUS, PUBLISH, PUBLISH_STATUS]);
  });

  it('accepts a POST answered with 200 and a Location', async () => {
    happyPath(store);
    store.on(UPLOAD, { status: 200, headers: { Location: UPLOAD_OP }, body: { ignored: true } });
    store.on(PUBLISH, { status: 201, headers: { Location: PUBLISH_OP }, body: 'not json' });
    assert.equal((await publish()).result, 'submitted');
  });

  it('waits one interval before each check and counts checks toward the cap', async () => {
    uploadAnd(inProgress(), uploadSucceeded());
    store.on(PUBLISH, accepted(PUBLISH_OP));
    store.on(PUBLISH_STATUS, publishSucceeded());
    const run = publish({ pollIntervalMs: 1234 });
    await run;
    assert.deepEqual(run.waits, [1234, 1234, 1234]);

    store.reset();
    uploadAnd(inProgress());
    const capped = publish({ pollIntervalMs: 50, pollAttempts: 4 });
    await rejection(capped);
    assert.deepEqual(capped.waits, [50, 50, 50, 50]);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, UPLOAD_STATUS, UPLOAD_STATUS, UPLOAD_STATUS]);
  });

  it('refuses a product ID that is not a GUID before any request', async () => {
    const error = await rejection(publish({ productId: '../../x' }));
    assert.match(error.message, /Product ID "\.\.\/\.\.\/x" is not a GUID\./);
    assert.equal(store.requests.length, 0);
  });
});

describe('publishToEdge: the Location header', () => {
  it('accepts an uppercase operation ID and uses it as given', async () => {
    const op = UPLOAD_OP.toUpperCase();
    store.on(UPLOAD, accepted(op));
    store.on(`GET ${PRODUCT_PATH}/submissions/draft/package/operations/${op}`, uploadSucceeded());
    assert.equal((await publish({ submit: false })).result, 'uploaded');
    assert.equal(store.requests[1]!.key, `GET ${PRODUCT_PATH}/submissions/draft/package/operations/${op}`);
  });

  it('trims spaces around the operation ID', async () => {
    happyPath(store, { publish: false });
    store.on(UPLOAD, { status: 202, headers: { Location: `  ${UPLOAD_OP} ` }, body: null });
    assert.equal((await publish({ submit: false })).result, 'uploaded');
  });

  it('fails after one request when the upload is accepted without a Location', async () => {
    store.on(UPLOAD, { status: 202, statusText: 'Accepted', body: null });
    const error = await rejection(publish());
    assert.equal(error.message, 'Microsoft accepted the upload but returned no operation ID (no Location header).');
    assert.match(error.details!, /Re-running the job uploads it again\./);
    assert.deepEqual(calls(), [UPLOAD]);
  });

  for (const location of ['https://evil.test/x', `/v1/products/x/operations/${UPLOAD_OP}`, '../x', `${UPLOAD_OP}?a=b`, `{${UPLOAD_OP}}`, `${UPLOAD_OP}/..`, '']) {
    it(`never follows or parses a Location of ${JSON.stringify(location)}`, async () => {
      store.on(UPLOAD, { status: 202, headers: { Location: location }, body: null });
      const error = await rejection(publish());
      assert.equal(error.message, `Microsoft accepted the upload but returned no operation ID (Location: ${JSON.stringify(location)}).`);
      assert.deepEqual(calls(), [UPLOAD]);
    });
  }

  it('cuts a long Location to 200 characters in the message', async () => {
    store.on(UPLOAD, { status: 202, headers: { Location: 'x'.repeat(500) }, body: null });
    const error = await rejection(publish());
    assert.ok(error.message.includes(`"${'x'.repeat(200)}"`));
    assert.ok(!error.message.includes('x'.repeat(201)));
  });

  it('gives the publish ambiguity hint when the submission is accepted without a Location', async () => {
    uploadAnd(uploadSucceeded());
    store.on(PUBLISH, { status: 202, body: null });
    const error = await rejection(publish());
    assert.equal(error.message, 'Microsoft accepted the submission but returned no operation ID (no Location header).');
    assert.match(error.details!, /Microsoft may have created the submission\. Check the product in Partner Center: if version 1\.4\.0 is In review/);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, PUBLISH]);
  });
});

describe('publishToEdge: the upload request', () => {
  it('keeps the reason phrase of a 403 with an empty body and names the client ID', async () => {
    const error = await rejection(publish({ clientId: 'wrong-client' }));
    assert.equal(error.message, `POST ${PRODUCT_PATH}/submissions/draft/package returned HTTP 403 Client ID is Invalid`);
    assert.match(error.details!, /Microsoft refused the client ID\. Check that client-id is the client ID from the Publish API page/);
    assert.match(error.details!, /MicrosoftDocs\/edge-developer#3905/);
    assert.equal(store.requests.length, 1);
    assert.equal(store.requests[0]!.clientId, 'wrong-client');
  });

  it('falls back to the status code when the reason phrase is empty', async () => {
    store.on(UPLOAD, { status: 403, statusText: '', body: null });
    const error = await rejection(publish());
    assert.equal(error.message, `POST ${PRODUCT_PATH}/submissions/draft/package returned HTTP 403`);
    assert.match(error.details!, /Microsoft refused the client ID/);
  });

  it('explains a 401 with the 72-day expiry and the rotation steps', async () => {
    store.on(UPLOAD, { status: 401, statusText: 'Unauthorized', body: null });
    const error = await rejection(publish());
    assert.match(error.message, /returned HTTP 401 Unauthorized$/);
    assert.match(error.details!, /Keys expire 72 days after they are created\. Create a new key on the Publish API page in Partner Center/);
    assert.match(error.details!, /then delete the old key/);
    assert.equal(store.requests.length, 1);
  });

  it('names the product ID on a 404 Resource Not Found', async () => {
    const other = '11111111-2222-4333-8444-555555555555';
    const error = await rejection(publish({ productId: other }));
    assert.equal(error.message, `POST /v1/products/${other}/submissions/draft/package returned HTTP 404 Resource Not Found`);
    assert.match(error.details!, /Microsoft does not know this product for this account\. Check product-id/);
  });

  it('explains a 400 on the upload, and a 400 that names the Authorization Scheme', async () => {
    store.on(UPLOAD, { status: 400, statusText: 'Bad Request', body: null });
    const plain = await rejection(publish());
    assert.match(plain.details!, /Microsoft answers 400 when the body is not a ZIP or the Content-Type is wrong/);

    store.reset();
    store.on(UPLOAD, { status: 400, statusText: 'Bad Request', body: SCHEME_MESSAGE });
    const scheme = await rejection(publish());
    assert.equal(scheme.message, `POST ${PRODUCT_PATH}/submissions/draft/package returned HTTP 400 Bad Request: ${SCHEME_MESSAGE}`);
    assert.match(scheme.details!, /retired API version/);
  });

  it('reads the message of the JSON 410 that Microsoft sends without a client ID header', async () => {
    const error = await rejection(publish({ clientId: '' }));
    assert.equal(error.message, `POST ${PRODUCT_PATH}/submissions/draft/package returned HTTP 410 Gone: ${DEPRECATED_MESSAGE}`);
    assert.match(error.details!, /Microsoft answered as if the request used a retired API version\. The action sends the v1\.1 headers/);
  });

  const once: Array<[number, string, RegExp]> = [
    [408, 'Request Timeout', /Microsoft timed out receiving the upload\. Re-run the job\./],
    [429, 'Too Many Requests', /Microsoft is throttling requests and publishes no quota\. A throttled request was not processed\. Re-run later\./],
    [503, 'Service Unavailable', /Microsoft may have received the upload\. Re-running the job is safe: the upload replaces the draft package\./],
    [500, 'Internal Server Error', /Microsoft may have received the upload/],
    [418, "I'm a Teapot", /^$/],
  ];
  for (const [status, statusText, hint] of once) {
    it(`sends the upload once on HTTP ${status}`, async () => {
      store.on(UPLOAD, { status, statusText, body: { message: 'from Microsoft' } });
      const error = await rejection(publish());
      assert.equal(error.message, `POST ${PRODUCT_PATH}/submissions/draft/package returned HTTP ${status} ${statusText}: from Microsoft`);
      assert.match(error.details ?? '', hint);
      assert.deepEqual(calls(), [UPLOAD]);
    });
  }

  it('prints a text body that is not JSON', async () => {
    store.on(UPLOAD, { status: 418, statusText: 'Teapot', body: '  <html>short and stout</html>  ' });
    const error = await rejection(publish());
    assert.match(error.message, /returned HTTP 418 Teapot: <html>short and stout<\/html>$/);
  });

  it('sends the upload once when the connection is reset', async () => {
    store.on(UPLOAD, { destroy: true });
    const error = await rejection(publish());
    assert.match(error.message, new RegExp(`^POST ${PRODUCT_PATH}/submissions/draft/package failed: \\S`));
    assert.match(error.details!, /Microsoft may have received the upload/);
    assert.deepEqual(calls(), [UPLOAD]);
  });

  it('reports a closed port with its cause', async () => {
    const error = await rejection(publish({ apiBase: `http://127.0.0.1:${await closedPort()}` }));
    assert.match(error.message, /failed: .*ECONNREFUSED/);
    assert.match(error.details!, /Microsoft may have received the upload/);
  });

  it('gives up on a slow upload after the upload timeout, once', async () => {
    store.on(UPLOAD, { ...accepted(UPLOAD_OP), delayMs: 1000 });
    const error = await rejection(publish({ uploadTimeoutMs: 50 }));
    assert.match(error.message, /failed: .*(timeout|aborted)/i);
    assert.match(error.details!, /Microsoft may have received the upload/);
    assert.deepEqual(calls(), [UPLOAD]);
  });

  it('reports a response cut off after a 202 as a possible upload', async () => {
    store.on(UPLOAD, { ...accepted(UPLOAD_OP), partial: true });
    const error = await rejection(publish());
    assert.match(error.message, /returned HTTP 202 Accepted, then failed while reading the response/);
    assert.match(error.details!, /Microsoft may have received the upload/);
    assert.deepEqual(calls(), [UPLOAD]);
  });

  it('keeps the status hint of a refused upload whose body is cut off', async () => {
    store.on(UPLOAD, { status: 401, statusText: 'Unauthorized', partial: true });
    const error = await rejection(publish());
    assert.equal(error.message, `POST ${PRODUCT_PATH}/submissions/draft/package returned HTTP 401 Unauthorized`);
    assert.match(error.details!, /^Microsoft refused the API key/);
    assert.ok(!error.details!.includes('may have received'));
    assert.deepEqual(calls(), [UPLOAD]);
  });

  it('refuses a redirect and never requests its Location', async () => {
    store.on(UPLOAD, { status: 307, headers: { Location: `${store.base}/elsewhere` } });
    const error = await rejection(publish());
    assert.match(error.message, /answered with a redirect \(HTTP 307\), which the action refuses to follow\./);
    assert.deepEqual(calls(), [UPLOAD]);
  });
});

describe('publishToEdge: the upload operation', () => {
  it('prints the message, the errors and the code of an undocumented failure', async () => {
    uploadAnd(operation('Failed', { errorCode: 'PackageInvalid', message: 'The package is not valid.', errors: ['manifest.json: bad key', 'icons missing'] }));
    const error = await rejection(publish());
    assert.ok(error instanceof OperationError);
    assert.equal(error.errorCode, 'PackageInvalid');
    assert.equal(error.message, 'Microsoft refused the package (PackageInvalid): The package is not valid.');
    assert.match(error.details!, /^manifest\.json: bad key\nicons missing\nFix the package and release again\./);
    assert.match(error.details!, new RegExp(`Upload operation: ${UPLOAD_OP}$`));
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  it('prints object errors through their message, and other items as JSON', async () => {
    uploadAnd(operation('Failed', { errorCode: 'X', message: null, errors: [{ message: 'Invalid module : Package' }, { code: 7 }, 42] }));
    const error = await rejection(publish());
    assert.equal(error.message, 'Microsoft refused the package (X).');
    assert.match(error.details!, /^Invalid module : Package\n\{"code":7\}\n42\n/);
  });

  it('prints a single string in errors as one line', async () => {
    uploadAnd(operation('Failed', { errorCode: null, message: 'Refused.', errors: 'one error' }));
    const error = await rejection(publish());
    assert.ok(!(error instanceof OperationError));
    assert.equal(error.message, 'Microsoft refused the package: Refused.');
    assert.match(error.details!, /^one error\nFix the package/);
  });

  it('explains a failure with no code and no errors as a possible service incident', async () => {
    uploadAnd(operation('Failed', { errorCode: null, errors: null, message: null }));
    const error = await rejection(publish());
    assert.equal(error.message, 'Microsoft reports that the upload of version 1.4.0 failed and gives no reason: no message');
    assert.match(error.details!, /This has happened during Microsoft service incidents\. Re-run later/);

    store.reset();
    uploadAnd(operation('Failed', { errorCode: '', errors: [], message: 'Error Message.' }));
    const empty = await rejection(publish());
    assert.equal(empty.message, 'Microsoft reports that the upload of version 1.4.0 failed and gives no reason: Error Message.');
  });

  it('reports InProgressSubmission on the upload in upload wording and does not publish', async () => {
    uploadAnd(publishFailed('InProgressSubmission'));
    const error = await rejection(publish());
    assert.ok(error instanceof OperationError);
    assert.equal(error.errorCode, 'InProgressSubmission');
    assert.equal(error.message, 'Microsoft refused the upload: a submission for this product is already in progress (InProgressSubmission). Version 1.4.0 was not uploaded.');
    assert.match(error.details!, /^Microsoft says: Can't publish extension as your extension submission is in progress/);
    assert.match(error.details!, /If an earlier run of this release submitted version 1\.4\.0, nothing is wrong: its review continues\. Otherwise re-run this job when the review ends, or select Cancel submission in Partner Center/);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  it('fails on NoModulesUpdated from the upload instead of skipping', async () => {
    uploadAnd(publishFailed('NoModulesUpdated'));
    const error = await rejection(publish());
    assert.ok(error instanceof OperationError);
    assert.equal(error.errorCode, 'NoModulesUpdated');
    assert.match(error.message, /Microsoft reported NoModulesUpdated for the upload, a code its documentation lists only for the submission step\. The draft may be unchanged\./);
    assert.match(error.details!, /raise the version in manifest\.json and release again/);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  const uploadWording: Array<[string, RegExp, RegExp]> = [
    ['CreateNotAllowed', /^Microsoft refused the upload: it cannot create a new extension through the API \(CreateNotAllowed\)\.$/, /This product has never been published\. Publish its first version in Partner Center/],
    ['UnpublishInProgress', /^Microsoft refused the upload: the extension is being unpublished \(UnpublishInProgress\)\.$/, /Wait until Partner Center shows the unpublish as finished/],
    ['ModuleStateUnPublishable', /^Microsoft refused the upload \(ModuleStateUnPublishable\): Can't publish extension/, /^Invalid module : Store listings\nSome sections of the submission are not valid\..*then re-run this job\.\n/],
    ['SubmissionValidationError', /^Microsoft refused the upload \(SubmissionValidationError\): Extension can't be published/, /The privacy policy URL is required\.\nThe description is too short\.\nFix the errors above\./],
  ];
  for (const [code, message, details] of uploadWording) {
    it(`reports ${code} on the upload in upload wording`, async () => {
      uploadAnd(publishFailed(code));
      const error = await rejection(publish());
      assert.ok(error instanceof OperationError);
      assert.equal(error.errorCode, code);
      assert.match(error.message, message);
      assert.match(error.details!, details);
      assert.ok(!error.details!.includes('The draft holds version'));
      assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
    });
  }

  it('quotes the correlation ID of a body without status, after one status request', async () => {
    uploadAnd(unexpectedFailure(UPLOAD_OP));
    const error = await rejection(publish());
    assert.equal(error.message, `Microsoft could not process the upload: An error occurred while processing the request. Please contact support Correlation ID: ${UPLOAD_OP} Timestamp: 2026-09-26T10:00:05Z`);
    assert.match(error.details!, /contact Microsoft with the correlation ID in the message and the operation ID/);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  for (const [label, status] of [
    ['an unknown status', 'Queued'],
    ['a numeric status', 5],
    ['a null status without a message', null],
  ] as const) {
    it(`stops on ${label}`, async () => {
      uploadAnd(operation(status, { message: status === null ? null : 'x' }));
      const error = await rejection(publish());
      assert.equal(error.message, `Microsoft reported upload status ${JSON.stringify(status)}, which this version of the action does not know. The API may have changed. Nothing further was sent.`);
      assert.match(error.details!, /^Response: \{/);
      assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
    });
  }

  it('fails on a status answer that is not JSON, without retrying', async () => {
    uploadAnd({ body: '<html>maintenance</html>' });
    const error = await rejection(publish());
    assert.equal(error.message, `GET ${PRODUCT_PATH}/submissions/draft/package/operations/${UPLOAD_OP} returned a response that is not JSON: <html>maintenance</html>`);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  it('fails on a JSON array and on an empty status body', async () => {
    uploadAnd({ body: [] });
    assert.match((await rejection(publish())).message, /returned a response that is not JSON: \[\]$/);
    store.reset();
    uploadAnd({ body: null });
    assert.match((await rejection(publish())).message, /returned a response that is not JSON: $/);
  });

  it('fails on a 2xx status answer other than 200 and 202', async () => {
    uploadAnd({ status: 204, body: null });
    const error = await rejection(publish());
    assert.match(error.message, /returned HTTP 204 No Content$/);
    assert.match(error.details!, /The API documents 200 for a status check\./);
  });

  it('keeps checking after transient failures, and counts each one as a check', async () => {
    uploadAnd({ status: 503, statusText: 'Service Unavailable', body: null }, { destroy: true }, uploadSucceeded());
    const run = publish({ submit: false });
    assert.equal((await run).result, 'uploaded');
    assert.equal(run.lines.filter((line) => line.startsWith('Status check failed, trying again: ')).length, 2);

    store.reset();
    uploadAnd({ status: 429, body: null }, { status: 502, body: null }, uploadSucceeded());
    const capped = await rejection(publish({ submit: false, pollAttempts: 2 }));
    assert.match(capped.message, /^Microsoft was still processing the upload of version 1\.4\.0 after \d+ s\. This run did not publish\.$/);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, UPLOAD_STATUS]);
  });

  it('fails with the last error on the third transient failure in a row', async () => {
    uploadAnd({ status: 503, body: null }, { status: 500, body: null }, { status: 429, statusText: 'Too Many Requests', body: null }, uploadSucceeded());
    const error = await rejection(publish({ pollAttempts: 10 }));
    assert.match(error.message, /returned HTTP 429 Too Many Requests$/);
    assert.match(error.details!, /Microsoft may still process the upload into the draft\. Re-running the job uploads the ZIP again\.\nUpload operation: /);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, UPLOAD_STATUS, UPLOAD_STATUS]);
  });

  it('treats a status body cut off while read as transient', async () => {
    uploadAnd({ partial: true }, uploadSucceeded());
    const run = publish({ submit: false });
    assert.equal((await run).result, 'uploaded');
    assert.match(run.lines.join('\n'), /Status check failed, trying again: .*then failed while reading the response/);
  });

  it('stops at once on a 401 status answer whose body is cut off', async () => {
    uploadAnd({ status: 401, statusText: 'Unauthorized', partial: true }, uploadSucceeded());
    const run = publish({ submit: false });
    const error = await rejection(run);
    assert.equal(error.message, `GET ${PRODUCT_PATH}/submissions/draft/package/operations/${UPLOAD_OP} returned HTTP 401 Unauthorized`);
    assert.match(error.details!, /^Microsoft refused the API key/);
    assert.ok(!run.lines.some((line) => line.startsWith('Status check failed')));
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  it('gives up on a slow status check after the request timeout and counts it as transient', async () => {
    uploadAnd({ ...uploadSucceeded(), delayMs: 2000 }, uploadSucceeded());
    const run = publish({ submit: false, requestTimeoutMs: 500 });
    assert.equal((await run).result, 'uploaded');
    assert.match(run.lines.join('\n'), /Status check failed, trying again: GET .* failed: /);
  });

  it('stops at once on a 401, a 403 or a 410 from the status endpoint', async () => {
    uploadAnd({ status: 401, statusText: 'Unauthorized', body: null }, uploadSucceeded());
    const expired = await rejection(publish());
    assert.match(expired.details!, /^Microsoft refused the API key/);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);

    store.reset();
    uploadAnd({ status: 403, statusText: 'Client ID is Invalid', body: null });
    assert.match((await rejection(publish())).details!, /^Microsoft refused the client ID/);

    store.reset();
    uploadAnd({ status: 410, statusText: 'Gone', body: { message: DEPRECATED_MESSAGE } });
    assert.match((await rejection(publish())).details!, /^Microsoft answered as if the request used a retired API version/);

    store.reset();
    uploadAnd({ status: 400, statusText: 'Bad Request', body: SCHEME_MESSAGE });
    assert.match((await rejection(publish())).details!, /^Microsoft answered as if the request used a retired API version/);
  });

  it('stops at once on a 404 and names the unknown operation', async () => {
    store.on(UPLOAD, accepted(UPLOAD_OP));
    const error = await rejection(publish());
    assert.equal(error.message, `GET ${PRODUCT_PATH}/submissions/draft/package/operations/${UPLOAD_OP} returned HTTP 404 Resource Not Found`);
    assert.match(error.details!, new RegExp(`^Microsoft does not know upload operation ${UPLOAD_OP} for this product and account\\.\\nMicrosoft may still process the upload`));
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  it('stops on any other status code from the status endpoint', async () => {
    uploadAnd({ status: 418, statusText: 'Teapot', body: { message: 'short and stout' } });
    const error = await rejection(publish());
    assert.match(error.message, /returned HTTP 418 Teapot: short and stout$/);
    assert.match(error.details!, /^Microsoft may still process the upload into the draft/);
  });

  it('gives up when the upload is still processing after the last check, without publishing', async () => {
    uploadAnd(inProgress());
    const error = await rejection(publish());
    assert.match(error.message, /^Microsoft was still processing the upload of version 1\.4\.0 after \d+ s\. This run did not publish\.$/);
    assert.match(error.details!, /Microsoft may still finish it into the draft, or fail it\. Re-running the job uploads the ZIP again\.\nUpload operation: /);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, UPLOAD_STATUS, UPLOAD_STATUS]);
  });

  it('refuses a redirect from the status endpoint', async () => {
    uploadAnd({ status: 302, headers: { Location: `${store.base}/elsewhere` } });
    const error = await rejection(publish());
    assert.match(error.message, /answered with a redirect \(HTTP 302\)/);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS]);
  });

  it('prints at most 20 errors of at most 300 characters each', async () => {
    const errors = Array.from({ length: 25 }, (_, index) => `${String(index).padStart(2, '0')}${'e'.repeat(998)}`);
    uploadAnd(operation('Failed', { errorCode: 'Many', message: 'm'.repeat(3000), errors }));
    const error = await rejection(publish());
    const lines = error.details!.split('\n').filter((line) => /^\d\de+$/.test(line));
    assert.equal(lines.length, 20);
    assert.ok(lines.every((line) => line.length === 300));
    assert.equal(error.message, `Microsoft refused the package (Many): ${'m'.repeat(1000)}`);
  });
});

describe('publishToEdge: the publish request', () => {
  it('gives the notes hint for a 400 only when notes were sent', async () => {
    uploadAnd(uploadSucceeded());
    store.on(PUBLISH, { status: 400, statusText: 'Bad Request', body: null });
    const withNotes = await rejection(publish({ notes: 'hello' }));
    assert.match(withNotes.details!, /Try once without certification-notes/);

    store.reset();
    uploadAnd(uploadSucceeded());
    store.on(PUBLISH, { status: 400, statusText: 'Bad Request', body: null });
    const without = await rejection(publish());
    assert.equal(without.details, undefined);

    store.reset();
    uploadAnd(uploadSucceeded());
    store.on(PUBLISH, { status: 400, statusText: 'Bad Request', body: SCHEME_MESSAGE });
    assert.match((await rejection(publish({ notes: 'x' }))).details!, /retired API version/);
  });

  it('sends the publish call once on a 429', async () => {
    uploadAnd(uploadSucceeded());
    store.on(PUBLISH, { status: 429, statusText: 'Too Many Requests', body: null }, accepted(PUBLISH_OP));
    const error = await rejection(publish());
    assert.match(error.details!, /A throttled request was not processed\. Re-run later\./);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, PUBLISH]);
  });

  for (const [label, reply] of [
    ['a 500', { status: 500, statusText: 'Internal Server Error', body: null }],
    ['a 408', { status: 408, statusText: 'Request Timeout', body: null }],
    ['a reset connection', { destroy: true }],
    ['a response cut off', { ...accepted(PUBLISH_OP), partial: true }],
  ] as const) {
    it(`sends the publish call once on ${label} and says the submission may exist`, async () => {
      uploadAnd(uploadSucceeded());
      store.on(PUBLISH, reply, accepted(PUBLISH_OP));
      const error = await rejection(publish());
      assert.match(error.details!, /^Microsoft may have created the submission\. Check the product in Partner Center: if version 1\.4\.0 is In review, the release is done, and a re-run fails with InProgressSubmission until the review ends\. Otherwise re-run this job\.$/);
      assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, PUBLISH]);
    });
  }

  it('gives the client ID hint, not the ambiguity hint, to a 403 on the publish call whose body is cut off', async () => {
    uploadAnd(uploadSucceeded());
    store.on(PUBLISH, { status: 403, statusText: 'Client ID is Invalid', partial: true });
    const error = await rejection(publish());
    assert.equal(error.message, `POST ${PRODUCT_PATH}/submissions returned HTTP 403 Client ID is Invalid`);
    assert.match(error.details!, /^Microsoft refused the client ID/);
    assert.ok(!error.details!.includes('may have created'));
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, PUBLISH]);
  });

  it('gives up on a slow publish call after the request timeout, once', async () => {
    uploadAnd(uploadSucceeded());
    store.on(PUBLISH, { ...accepted(PUBLISH_OP), delayMs: 2000 });
    const error = await rejection(publish({ requestTimeoutMs: 500 }));
    assert.match(error.message, /^POST .*\/submissions failed: /);
    assert.match(error.details!, /Microsoft may have created the submission/);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, PUBLISH]);
  });

  for (const [status, statusText, hint] of [
    [401, 'Unauthorized', /Keys expire 72 days after they are created/],
    [403, 'Client ID is Invalid', /Microsoft refused the client ID/],
    [404, 'Resource Not Found', /Microsoft does not know this product for this account/],
    [307, 'Temporary Redirect', /^$/],
  ] as const) {
    it(`explains HTTP ${status} on the publish call`, async () => {
      uploadAnd(uploadSucceeded());
      store.on(PUBLISH, { status, statusText, body: null, headers: status === 307 ? { Location: '/elsewhere' } : {} });
      const error = await rejection(publish());
      assert.match(error.details ?? '', hint);
      assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, PUBLISH]);
    });
  }
});

describe('publishToEdge: the publish operation', () => {
  it('reports a submission in certification that Microsoft publishes on approval', async () => {
    publishAnd(inProgress(), publishSucceeded());
    const run = publish();
    assert.deepEqual(await run, { result: 'submitted', errorCode: '' });
    assert.ok(run.lines.includes('Version 1.4.0 is in certification, which can take up to 7 business days. Microsoft publishes it as soon as it is approved; the API cannot hold it.'));
    assert.deepEqual(run.warnings, []);
  });

  it('logs a success without a message', async () => {
    publishAnd(operation('Succeeded', { message: null }));
    uploadAnd(operation('Succeeded', { message: null }));
    const run = publish();
    await run;
    assert.ok(run.lines.includes('Upload processed: no message'));
    assert.ok(run.lines.includes('Submission processed: no message'));
  });

  it('ends skipped with a warning on NoModulesUpdated', async () => {
    publishAnd(publishFailed('NoModulesUpdated'));
    const run = publish();
    assert.deepEqual(await run, { result: 'skipped', errorCode: 'NoModulesUpdated' });
    assert.equal(run.warnings.length, 1);
    assert.match(run.warnings[0]!, /^Microsoft has nothing new to submit \(NoModulesUpdated\): the draft, which now holds this ZIP, matches the last submission, so version 1\.4\.0 was submitted before\. Nothing was submitted now\./);
    assert.match(run.warnings[0]!, /If you changed the extension, raise the version in manifest\.json and release again\.$/);
  });

  it('fails on InProgressSubmission and names both cases, Publish and Cancel submission', async () => {
    publishAnd(publishFailed('InProgressSubmission'));
    const error = await rejection(publish());
    assert.ok(error instanceof OperationError);
    assert.equal(error.errorCode, 'InProgressSubmission');
    assert.equal(error.message, 'Microsoft refused the submission: a submission for this product is already in progress (InProgressSubmission).');
    assert.match(error.details!, /If an earlier run of this release submitted version 1\.4\.0, nothing is wrong: its review continues, and this run changed nothing but the draft\./);
    assert.match(error.details!, /Otherwise version 1\.4\.0 now waits in the draft, not submitted: re-run this job when the review ends, or in Partner Center select Publish, which stops the current review and starts a new one with the draft, or Cancel submission\./);
    assert.match(error.details!, new RegExp(`\\nPublish operation: ${PUBLISH_OP}$`));
  });

  it('explains CreateNotAllowed as a product never published', async () => {
    publishAnd(publishFailed('CreateNotAllowed'));
    const error = await rejection(publish());
    assert.equal(error.message, 'Microsoft cannot create a new extension through the API (CreateNotAllowed).');
    assert.match(error.details!, /^Microsoft says: Can't create new extension\.\nThis product has never been published\. Publish its first version in Partner Center, after which this action can update it\. If it was published, check product-id\./);
  });

  it('explains UnpublishInProgress', async () => {
    publishAnd(publishFailed('UnpublishInProgress'));
    const error = await rejection(publish());
    assert.equal(error.message, 'Microsoft refused the submission: the extension is being unpublished (UnpublishInProgress).');
    assert.match(error.details!, /Wait until Partner Center shows the unpublish as finished, then decide there whether to make the extension available again\. The API cannot\./);
  });

  it('prints the invalid modules of ModuleStateUnPublishable and points to Partner Center', async () => {
    publishAnd(publishFailed('ModuleStateUnPublishable'));
    const error = await rejection(publish());
    assert.match(error.message, /^Microsoft refused the submission \(ModuleStateUnPublishable\): Can't publish extension as your extension has modules that are not valid\./);
    assert.match(error.details!, /^Invalid module : Store listings\nSome sections of the submission are not valid\. The API only changes the package, so fix the sections named above in Partner Center \(Availability, Properties, Privacy and Store listings are edited there\), then re-run this job\. The draft holds version 1\.4\.0\.\n/);
  });

  it('prints the errors of SubmissionValidationError with its hint', async () => {
    publishAnd(publishFailed('SubmissionValidationError'));
    const error = await rejection(publish());
    assert.equal(error.message, "Microsoft refused the submission (SubmissionValidationError): Extension can't be published as there are submission validation failures. Fix these errors and try again later.");
    assert.match(error.details!, /^The privacy policy URL is required\.\nThe description is too short\.\nFix the errors above\. If they concern the package, raise the version in manifest\.json and release again\. If they concern the listing, fix it in Partner Center and re-run this job\.\nPublish operation: /);
  });

  it('explains a failure without a code, an undocumented code and a body without status', async () => {
    publishAnd(irrecoverableFailure());
    const irrecoverable = await rejection(publish());
    assert.ok(!(irrecoverable instanceof OperationError));
    assert.equal(irrecoverable.message, 'Microsoft reports an irrecoverable failure without a code: An error occurred while performing the operation');
    assert.match(irrecoverable.details!, /^Re-run later\. The draft holds version 1\.4\.0\. If it repeats, report it to Microsoft with the operation ID\.\nPublish operation: /);

    store.reset();
    publishAnd(operation('Failed', { errorCode: null, message: null }));
    assert.equal((await rejection(publish())).message, 'Microsoft reports an irrecoverable failure without a code: no message');

    store.reset();
    publishAnd(operation('Failed', { errorCode: 'BrandNewCode', message: 'Something new.', errors: ['detail'] }));
    const undocumented = await rejection(publish());
    assert.ok(undocumented instanceof OperationError);
    assert.equal(undocumented.errorCode, 'BrandNewCode');
    assert.equal(undocumented.message, 'Microsoft refused the submission (BrandNewCode): Something new.');
    assert.equal(undocumented.details, `detail\nPublish operation: ${PUBLISH_OP}`);

    store.reset();
    publishAnd(unexpectedFailure());
    const unexpected = await rejection(publish());
    assert.match(unexpected.message, new RegExp(`^Microsoft reports an unexpected failure: An error occurred while processing the request\\. Please contact support Correlation ID: ${PUBLISH_OP}`));
    assert.match(unexpected.details!, /^Re-run later\. A re-run ends with InProgressSubmission if a submission was created after all\. If the failure repeats, contact Microsoft with the correlation ID in the message\./);
  });

  it('reports an unknown submission status', async () => {
    publishAnd(operation('Cancelled'));
    const error = await rejection(publish());
    assert.match(error.message, /^Microsoft reported submission status "Cancelled", which this version of the action does not know\./);
    assert.match(error.details!, new RegExp(`Publish operation: ${PUBLISH_OP}$`));
  });

  it('adds the publish ambiguity hint to a 404 from the publish status endpoint', async () => {
    uploadAnd(uploadSucceeded());
    store.on(PUBLISH, accepted(PUBLISH_OP));
    const error = await rejection(publish());
    assert.match(error.message, /returned HTTP 404 Resource Not Found$/);
    assert.match(error.details!, new RegExp(`^Microsoft does not know publish operation ${PUBLISH_OP} for this product and account\\.\\nMicrosoft may have created the submission\\.`));
  });

  it('adds the publish ambiguity hint to a 401 and to transient failures during the publish poll', async () => {
    publishAnd({ status: 401, statusText: 'Unauthorized', body: null });
    const expired = await rejection(publish());
    assert.match(expired.details!, /^Microsoft refused the API key.*\nMicrosoft may have created the submission\./s);

    store.reset();
    publishAnd({ status: 500, body: null }, { destroy: true }, { status: 503, body: null });
    const flaky = await rejection(publish({ pollAttempts: 5 }));
    assert.match(flaky.message, /returned HTTP 503 Service Unavailable$/);
    assert.match(flaky.details!, /^Microsoft may have created the submission\./);
  });

  it('gives up when the submission is still being created after the last check', async () => {
    publishAnd(inProgress());
    const error = await rejection(publish());
    assert.match(error.message, /^Microsoft was still creating the submission for version 1\.4\.0 after \d+ s\.$/);
    assert.match(error.details!, /^It may still enter certification\. Check the product in Partner Center before releasing again: a re-run while it is in progress ends with InProgressSubmission\.\nPublish operation: /);
    assert.deepEqual(calls(), [UPLOAD, UPLOAD_STATUS, PUBLISH, PUBLISH_STATUS, PUBLISH_STATUS, PUBLISH_STATUS]);
  });
});
