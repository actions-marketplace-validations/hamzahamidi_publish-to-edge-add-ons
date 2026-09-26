import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { ActionError } from '../src/errors.ts';
import { OperationError, type PublishOptions, publishToEdge } from '../src/store.ts';
import { readManifest } from '../src/zip.ts';
import { type EdgeSimulator, type EdgeState, edgeSimulator, extensionZip, type Fault, irrecoverableFailure, type MockStore, operation, PRODUCT, packageId, type SimulatorOptions, startMockEdge, unexpectedFailure } from './helpers.ts';

const V1 = extensionZip('1.4.0');
const V1_CHANGED = extensionZip('1.4.0', { script: '// a change under the same version\n' });
const V2 = extensionZip('1.4.1');
const CANCELLED = 'job cancelled';

let store: MockStore;
before(async () => {
  store = await startMockEdge({ clientId: 'test-client' });
});
afterEach(() => store.reset());
after(() => store.close());

function simulate(options: SimulatorOptions = {}, initial: Partial<EdgeState> = {}): EdgeSimulator {
  const simulator = edgeSimulator(options, initial);
  store.handle(simulator.handler);
  return simulator;
}

type Step = 'upload' | 'upload-status' | 'publish' | 'publish-status';

interface Outcome {
  result?: string;
  errorCode?: string;
  error?: ActionError;
  steps: Step[];
  lines: string[];
  warnings: string[];
}

function stepOf(key: string): Step {
  const [method, path = ''] = key.split(' ');
  const base = `/v1/products/${PRODUCT}/submissions`;
  if (method === 'POST' && path === `${base}/draft/package`) return 'upload';
  if (method === 'POST' && path === base) return 'publish';
  if (method === 'GET' && path.startsWith(`${base}/draft/package/operations/`)) return 'upload-status';
  if (method === 'GET' && path.startsWith(`${base}/operations/`)) return 'publish-status';
  throw new Error(`the action sent a request outside the four endpoints: ${key}`);
}

async function run(zip: Buffer, options: Partial<PublishOptions> = {}): Promise<Outcome> {
  const first = store.requests.length;
  const lines: string[] = [];
  const warnings: string[] = [];
  const outcome: Outcome = { steps: [], lines, warnings };
  try {
    const { result, errorCode } = await publishToEdge({
      apiKey: 'test-key',
      clientId: 'test-client',
      productId: PRODUCT,
      version: readManifest(zip).version,
      zip,
      apiBase: store.base,
      pollIntervalMs: 0,
      pollAttempts: 3,
      sleep: async () => {},
      log: (line) => lines.push(line),
      warn: (line) => warnings.push(line),
      ...options,
    });
    Object.assign(outcome, { result, errorCode });
  } catch (error) {
    if (error instanceof ActionError) outcome.error = error;
    else if ((error as Error).message !== CANCELLED) throw error;
  }
  outcome.steps = store.requests.slice(first).map((request) => stepOf(request.key));
  return outcome;
}

function cancelAtSleep(call: number): Pick<PublishOptions, 'sleep'> {
  let calls = 0;
  return {
    sleep: async () => {
      calls += 1;
      if (calls === call) throw new Error(CANCELLED);
    },
  };
}

const cancelBeforePublish: Pick<PublishOptions, 'log'> = {
  log: (line) => {
    if (line.startsWith('Upload processed:')) throw new Error(CANCELLED);
  },
};

const FULL_RUN: Step[] = ['upload', 'upload-status', 'upload-status', 'publish', 'publish-status', 'publish-status'];

function submitted(outcome: Outcome) {
  assert.equal(outcome.error, undefined, outcome.error && `${outcome.error.message}\n${outcome.error.details}`);
  assert.equal(outcome.result, 'submitted');
}

function failedWith(outcome: Outcome, code: string | undefined, pattern: RegExp) {
  assert.ok(outcome.error, `expected a failure, got ${outcome.result}`);
  assert.match(`${outcome.error.message}\n${outcome.error.details ?? ''}`, pattern);
  if (code === undefined) assert.ok(!(outcome.error instanceof OperationError));
  else {
    assert.ok(outcome.error instanceof OperationError);
    assert.equal(outcome.error.errorCode, code);
  }
}

const inProgressAtPublish = /Microsoft refused the submission: a submission for this product is already in progress \(InProgressSubmission\)\.\nMicrosoft says: .*\nIf an earlier run of this release submitted version 1\.4\.0, nothing is wrong/;

describe('re-run and crash matrix (design 6.7)', () => {
  it('row 1: after a local check failed or the job was cancelled before any request, a re-run is a first run', async () => {
    const simulator = simulate();
    const rerun = await run(V1);
    submitted(rerun);
    assert.deepEqual(rerun.steps, FULL_RUN);
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  for (const status of [400, 401, 403, 404, 410, 429]) {
    it(`row 2: an upload answered ${status} changed nothing, fails the same way until fixed, then submits`, async () => {
      const simulator = simulate();
      simulator.faults.push({ at: 'upload', reply: { status, body: null } });
      const first = await run(V1);
      assert.ok(first.error);
      assert.match(first.error.message, new RegExp(`returned HTTP ${status}`));
      assert.deepEqual(first.steps, ['upload']);
      assert.equal(simulator.state.draft, undefined);

      simulator.faults.push({ at: 'upload', reply: { status, body: null } });
      const again = await run(V1);
      assert.deepEqual(again.steps, ['upload']);
      assert.equal(again.error?.message, first.error.message);

      const fixed = await run(V1);
      submitted(fixed);
      assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
    });
  }

  const lostUploads: Array<[string, Fault['reply'], Partial<PublishOptions>]> = [
    ['a reset connection', { destroy: true }, {}],
    ['the upload timeout', { delayMs: 300, status: 202 }, { uploadTimeoutMs: 50 }],
    ['HTTP 408', { status: 408, body: null }, {}],
    ['HTTP 500', { status: 500, body: null }, {}],
    ['HTTP 503', { status: 503, body: null }, {}],
    ['a 202 without Location', { status: 202, body: null }, {}],
  ];
  for (const [label, reply, options] of lostUploads) {
    for (const apply of [true, false]) {
      it(`row 3: after ${label} on the upload (${apply ? 'received' : 'not received'} by Microsoft), a re-run uploads again and submits`, async () => {
        const simulator = simulate();
        simulator.faults.push({ at: 'upload', reply, apply });
        const first = await run(V1, options);
        assert.ok(first.error);
        assert.match(first.error.details!, /Re-running the job|Re-run the job|uploads it again/);
        assert.deepEqual(first.steps, ['upload']);
        assert.equal(simulator.state.draft, apply ? packageId(V1) : undefined);

        simulator.finishProcessing();
        const rerun = await run(V1);
        submitted(rerun);
        assert.deepEqual(rerun.steps, FULL_RUN);
        assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
      });
    }
  }

  it('row 3: when Microsoft refuses a second upload while the first is still processing, the re-run names the code and a later one converges', async () => {
    const simulator = simulate({ secondUpload: 'refuse' });
    simulator.faults.push({ at: 'upload', reply: { destroy: true }, apply: true });
    const first = await run(V1);
    assert.ok(first.error);

    const racing = await run(V1);
    failedWith(racing, 'SimulatedUploadInProgress', /Microsoft refused the package \(SimulatedUploadInProgress\)/);
    assert.deepEqual(racing.steps, ['upload', 'upload-status', 'upload-status']);

    simulator.finishProcessing();
    submitted(await run(V1));
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 4: after the upload poll gave up, a re-run uploads again and submits', async () => {
    const simulator = simulate({ processingChecks: 5 });
    const first = await run(V1);
    failedWith(first, undefined, /Microsoft was still processing the upload of version 1\.4\.0/);
    assert.deepEqual(first.steps, ['upload', 'upload-status', 'upload-status', 'upload-status']);

    const rerun = await run(V1, { pollAttempts: 10 });
    submitted(rerun);
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 4: after the job was cancelled during the upload poll, a re-run uploads again and submits', async () => {
    const simulator = simulate();
    const first = await run(V1, cancelAtSleep(2));
    assert.equal(first.error, undefined);
    assert.equal(first.result, undefined);
    assert.deepEqual(first.steps, ['upload', 'upload-status']);

    submitted(await run(V1));
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 5: a refused package fails the same way on every re-run until it is fixed', async () => {
    const simulator = simulate();
    const refused = operation('Failed', { errorCode: 'PackageInvalid', message: 'The manifest is not valid.', errors: ['manifest.json: unknown key'] });
    for (let attempt = 0; attempt < 2; attempt++) {
      simulator.faults.push({ at: 'upload', final: refused });
      const outcome = await run(V1);
      failedWith(outcome, 'PackageInvalid', /Microsoft refused the package \(PackageInvalid\): The manifest is not valid\.\nmanifest\.json: unknown key\nFix the package and release again\./);
      assert.deepEqual(outcome.steps, ['upload', 'upload-status', 'upload-status']);
    }
    assert.equal(simulator.state.draft, undefined);
    submitted(await run(V2));
  });

  it('row 5: an upload that failed without a reason during an incident submits on a later re-run', async () => {
    const simulator = simulate();
    simulator.faults.push({ at: 'upload', final: operation('Failed', { errorCode: null, errors: null }) });
    failedWith(await run(V1), undefined, /gives no reason.*\nThis has happened during Microsoft service incidents/);
    submitted(await run(V1));
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 6: after the job stopped between the upload and the publish call, a re-run uploads the same ZIP again and submits', async () => {
    const simulator = simulate();
    const first = await run(V1, cancelBeforePublish);
    assert.deepEqual(first.steps, ['upload', 'upload-status', 'upload-status']);
    assert.equal(simulator.state.draft, packageId(V1));
    assert.deepEqual(simulator.state.submissions, []);

    const rerun = await run(V1);
    submitted(rerun);
    assert.deepEqual(rerun.steps, FULL_RUN);
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 7: an upload-only run is promoted by a re-run with publish true', async () => {
    const simulator = simulate();
    const draft = await run(V1, { submit: false });
    assert.equal(draft.result, 'uploaded');
    assert.deepEqual(draft.steps, ['upload', 'upload-status', 'upload-status']);
    assert.deepEqual(simulator.state.submissions, []);

    submitted(await run(V1));
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  const lostSubmissions: Array<[string, Fault['reply'], Partial<PublishOptions>]> = [
    ['a reset connection', { destroy: true }, {}],
    ['the request timeout', { delayMs: 2000, status: 202 }, { requestTimeoutMs: 500 }],
    ['HTTP 408', { status: 408, body: null }, {}],
    ['HTTP 500', { status: 500, body: null }, {}],
    ['a 202 without Location', { status: 202, body: null }, {}],
  ];
  for (const [label, reply, options] of lostSubmissions) {
    it(`row 8: after ${label} on a publish call Microsoft processed, the re-run fails with InProgressSubmission and says nothing is wrong`, async () => {
      const simulator = simulate();
      simulator.faults.push({ at: 'publish', reply, apply: true });
      const first = await run(V1, options);
      failedWith(first, undefined, /Microsoft may have created the submission/);
      assert.deepEqual(first.steps, ['upload', 'upload-status', 'upload-status', 'publish']);

      const rerun = await run(V1);
      failedWith(rerun, 'InProgressSubmission', inProgressAtPublish);
      assert.deepEqual(rerun.steps, FULL_RUN);
      assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
    });

    it(`row 8: after ${label} on a publish call Microsoft did not process, the re-run submits`, async () => {
      const simulator = simulate();
      simulator.faults.push({ at: 'publish', reply, apply: false });
      failedWith(await run(V1, options), undefined, /Microsoft may have created the submission/);
      submitted(await run(V1));
      assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
    });
  }

  it('row 8: when Microsoft refuses uploads during a review, the re-run fails at the upload and does not publish', async () => {
    const simulator = simulate({ uploadDuringReview: 'refuse' });
    simulator.faults.push({ at: 'publish', reply: { destroy: true }, apply: true });
    await run(V1);
    const rerun = await run(V1);
    failedWith(rerun, 'InProgressSubmission', /Microsoft refused the upload: a submission for this product is already in progress \(InProgressSubmission\)\. Version 1\.4\.0 was not uploaded\./);
    assert.deepEqual(rerun.steps, ['upload', 'upload-status', 'upload-status']);
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 9: after the publish poll gave up, the re-run fails with InProgressSubmission', async () => {
    const simulator = simulate({ processingChecks: 1 });
    simulator.faults.push({ at: 'publish-status', reply: operation('InProgress') }, { at: 'publish-status', reply: operation('InProgress') });
    const first = await run(V1, { pollAttempts: 2 });
    failedWith(first, undefined, /Microsoft was still creating the submission for version 1\.4\.0 after \d+ s\.\nIt may still enter certification/);

    failedWith(await run(V1), 'InProgressSubmission', inProgressAtPublish);
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 9: after the job was cancelled during the publish poll, the re-run fails with InProgressSubmission', async () => {
    const simulator = simulate();
    const first = await run(V1, cancelAtSleep(3));
    assert.deepEqual(first.steps, ['upload', 'upload-status', 'upload-status', 'publish']);
    failedWith(await run(V1), 'InProgressSubmission', inProgressAtPublish);
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  for (const [status, hint] of [
    [401, /Microsoft refused the API key/],
    [403, /Microsoft refused the client ID/],
    [404, /Microsoft does not know publish operation/],
  ] as const) {
    it(`row 9: after a ${status} on a publish status check, the re-run fails with InProgressSubmission`, async () => {
      const simulator = simulate();
      simulator.faults.push({ at: 'publish-status', reply: { status, body: null } });
      const first = await run(V1);
      failedWith(first, undefined, hint);
      assert.match(first.error!.details!, /Microsoft may have created the submission/);
      failedWith(await run(V1), 'InProgressSubmission', inProgressAtPublish);
      assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
    });
  }

  it('row 10: a deliberate re-run of a release in review fails with InProgressSubmission from the publish operation', async () => {
    const simulator = simulate();
    submitted(await run(V1));
    const rerun = await run(V1);
    failedWith(rerun, 'InProgressSubmission', inProgressAtPublish);
    assert.deepEqual(rerun.steps, FULL_RUN);
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 10: when Microsoft refuses uploads during a review, the deliberate re-run fails at the upload', async () => {
    simulate({ uploadDuringReview: 'refuse' });
    submitted(await run(V1));
    const rerun = await run(V1);
    failedWith(rerun, 'InProgressSubmission', /Microsoft refused the upload: a submission for this product is already in progress/);
    assert.deepEqual(rerun.steps, ['upload', 'upload-status', 'upload-status']);
  });

  it('row 10: when Microsoft answers NoModulesUpdated first, the deliberate re-run ends skipped with a warning', async () => {
    const simulator = simulate({ firstAnswer: 'no-modules' });
    submitted(await run(V1));
    const rerun = await run(V1);
    assert.equal(rerun.error, undefined);
    assert.equal(rerun.result, 'skipped');
    assert.equal(rerun.errorCode, 'NoModulesUpdated');
    assert.match(rerun.warnings[0]!, /version 1\.4\.0 was submitted before/);
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 11: a re-run of a live version ends skipped when Microsoft compares content', async () => {
    const simulator = simulate();
    submitted(await run(V1));
    simulator.approve();
    const rerun = await run(V1);
    assert.equal(rerun.result, 'skipped');
    assert.equal(rerun.errorCode, 'NoModulesUpdated');
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 11: a re-run of a live version fails at the upload when Microsoft requires a higher version', async () => {
    const simulator = simulate({ versionRule: 'higher' });
    submitted(await run(V1));
    simulator.approve();
    const rerun = await run(V1);
    failedWith(rerun, 'SimulatedVersionRule', /Microsoft refused the package \(SimulatedVersionRule\): Version 1\.4\.0 must be higher than 1\.4\.0\.\n.*\nFix the package and release again\. Partner Center asks for a higher version/);
    assert.deepEqual(rerun.steps, ['upload', 'upload-status', 'upload-status']);
    submitted(await run(V2));
  });

  it('row 11: a re-run of a live version fails with SubmissionValidationError when Microsoft validates the version', async () => {
    const simulator = simulate();
    submitted(await run(V1));
    simulator.approve();
    simulator.state.validationErrors = ['Version 1.4.0 is already in the store.'];
    failedWith(await run(V1), 'SubmissionValidationError', /Version 1\.4\.0 is already in the store\.\nFix the errors above\./);
  });

  it('row 11: a re-run of a live version starts a new review when identical bytes count as an update', async () => {
    const simulator = simulate({ identicalIsUpdate: true });
    submitted(await run(V1));
    simulator.approve();
    submitted(await run(V1));
    assert.deepEqual(simulator.state.submissions, [packageId(V1), packageId(V1)]);
  });

  it('row 12: a re-run after a failed review ends skipped, and a fixed, higher version submits', async () => {
    const simulator = simulate();
    submitted(await run(V1));
    simulator.failReview();
    const rerun = await run(V1);
    assert.equal(rerun.result, 'skipped');
    submitted(await run(V2));
    assert.deepEqual(simulator.state.submissions, [packageId(V1), packageId(V2)]);
  });

  it('row 12: a re-run after a failed review submits again when identical bytes count as an update', async () => {
    const simulator = simulate({ identicalIsUpdate: true });
    submitted(await run(V1));
    simulator.failReview();
    submitted(await run(V1));
    assert.deepEqual(simulator.state.submissions, [packageId(V1), packageId(V1)]);
  });

  it('row 12: a rebuild with changes under the same version is submitted when Microsoft compares content', async () => {
    const simulator = simulate();
    submitted(await run(V1));
    simulator.failReview();
    submitted(await run(V1_CHANGED));
    assert.deepEqual(simulator.state.submissions, [packageId(V1), packageId(V1_CHANGED)]);
  });

  it('row 13: a newer release held back by an older review waits in the draft and submits after that review', async () => {
    const simulator = simulate();
    submitted(await run(V1));
    const held = await run(V2);
    failedWith(held, 'InProgressSubmission', /Otherwise version 1\.4\.1 now waits in the draft, not submitted/);
    assert.equal(simulator.state.draft, packageId(V2));
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);

    simulator.approve();
    submitted(await run(V2));
    assert.deepEqual(simulator.state.submissions, [packageId(V1), packageId(V2)]);
  });

  it('row 14: SubmissionValidationError repeats until the listing is fixed in Partner Center', async () => {
    const simulator = simulate({}, { validationErrors: ['The privacy policy URL is required.'] });
    for (let attempt = 0; attempt < 2; attempt++) {
      failedWith(await run(V1), 'SubmissionValidationError', /The privacy policy URL is required\.\nFix the errors above/);
    }
    simulator.state.validationErrors = [];
    submitted(await run(V1));
    assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
  });

  it('row 14: ModuleStateUnPublishable repeats until the sections are fixed in Partner Center', async () => {
    const simulator = simulate({}, { invalidModules: ['Privacy'] });
    for (let attempt = 0; attempt < 2; attempt++) {
      failedWith(await run(V1), 'ModuleStateUnPublishable', /Invalid module : Privacy\nSome sections of the submission are not valid.*The draft holds version 1\.4\.0\./);
    }
    simulator.state.invalidModules = [];
    submitted(await run(V1));
  });

  it('row 15: CreateNotAllowed repeats until the first version is published in Partner Center', async () => {
    const simulator = simulate({}, { everPublished: false });
    for (let attempt = 0; attempt < 2; attempt++) {
      failedWith(await run(V1), 'CreateNotAllowed', /Microsoft cannot create a new extension through the API \(CreateNotAllowed\)\./);
    }
    simulator.state.everPublished = true;
    submitted(await run(V1));
  });

  it('row 16: UnpublishInProgress repeats while the unpublish runs', async () => {
    const simulator = simulate({}, { unpublishing: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      failedWith(await run(V1), 'UnpublishInProgress', /the extension is being unpublished \(UnpublishInProgress\)/);
    }
    assert.deepEqual(simulator.state.submissions, []);
  });

  for (const [label, final, pattern] of [
    ['a body without status', unexpectedFailure(), /Microsoft reports an unexpected failure: .*Correlation ID/],
    ['Failed without a code', irrecoverableFailure(), /Microsoft reports an irrecoverable failure without a code/],
  ] as const) {
    it(`row 17: after ${label} from the publish operation, the re-run submits`, async () => {
      const simulator = simulate();
      simulator.faults.push({ at: 'publish', final, apply: false });
      failedWith(await run(V1), undefined, pattern);
      submitted(await run(V1));
      assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
    });

    it(`row 17: after ${label} from the publish operation for a submission created after all, the re-run fails with InProgressSubmission`, async () => {
      const simulator = simulate();
      simulator.faults.push({ at: 'publish', final, apply: true });
      failedWith(await run(V1), undefined, pattern);
      failedWith(await run(V1), 'InProgressSubmission', inProgressAtPublish);
      assert.deepEqual(simulator.state.submissions, [packageId(V1)]);
    });
  }
});
