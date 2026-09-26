import { ActionError, networkReason } from './errors.ts';

export const EDGE_API = 'https://api.addons.microsoftedge.microsoft.com';
export const GUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

export interface PublishOptions {
  apiKey: string;
  clientId: string;
  productId: string;
  version: string;
  zip: Buffer;
  submit?: boolean;
  notes?: string;
  apiBase?: string;
  pollIntervalMs?: number;
  pollAttempts?: number;
  statusRetries?: number;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface PublishResult {
  result: 'submitted' | 'uploaded' | 'skipped';
  errorCode: string;
}

export class OperationError extends ActionError {
  readonly errorCode: string;

  constructor(message: string, details: string | undefined, errorCode: string) {
    super(message, details);
    this.name = 'OperationError';
    this.errorCode = errorCode;
  }
}

type Phase = 'upload' | 'publish';

interface Answer {
  status: number;
  line: string;
  text: string;
  location: string | null;
}

interface OperationBody {
  status?: unknown;
  message?: unknown;
  errorCode?: unknown;
  errors?: unknown;
}

interface Failure {
  text: string;
  hint?: string;
  quoted: boolean;
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const NOUN: Record<Phase, string> = { upload: 'upload', publish: 'submission' };
const OPERATION_LABEL: Record<Phase, string> = { upload: 'Upload operation', publish: 'Publish operation' };
const ROTATE_HINT =
  'Microsoft refused the API key: it is wrong, deleted or expired. Keys expire 72 days after they are created. Create a new key on the Publish API page in Partner Center (Microsoft Edge program), update the secret, then delete the old key; the README section "Rotating the API key" lists the steps. A client secret from the retired v1 API does not work as an API key.';
const CLIENT_ID_HINT =
  'Microsoft refused the client ID. Check that client-id is the client ID from the Publish API page of the account that owns this product. The same 403 has been reported for a correct client ID with a new key (MicrosoftDocs/edge-developer#3905); if the ID is right, report it at microsoft/MicrosoftEdge-Extensions. What an expired key answers is undocumented, so if the key is near its expiry date, rotate it too.';
const THROTTLE_HINT = 'Microsoft is throttling requests and publishes no quota. A throttled request was not processed. Re-run later.';
const STATUS_HINTS: Record<number, string> = { 401: ROTATE_HINT, 403: CLIENT_ID_HINT, 429: THROTTLE_HINT };
const PRODUCT_HINT =
  'Microsoft does not know this product for this account. Check product-id (the GUID on the Extension overview page in Partner Center, not the ID in the store address) and that the API credentials belong to the account that owns it.';
const RETIRED_HINT =
  'Microsoft answered as if the request used a retired API version. The action sends the v1.1 headers, so Microsoft has probably changed its authentication. Look for a newer release of this action.';
const UPLOAD_400_HINT = 'Microsoft answers 400 when the body is not a ZIP or the Content-Type is wrong. The action sends the file as application/zip, so check that zip is the extension ZIP.';
const UPLOAD_408_HINT = 'Microsoft timed out receiving the upload. Re-run the job.';
const UPLOAD_RERUN_HINT = 'Microsoft may have received the upload. Re-running the job is safe: the upload replaces the draft package.';
const UPLOAD_POLL_HINT = 'Microsoft may still process the upload into the draft. Re-running the job uploads the ZIP again.';
const NOTES_HINT =
  "Microsoft's documentation disagrees on the format of certification notes, and the action sends a form field named notes. Try once without certification-notes, and report the result in this action's issues.";
const NOTES_NOTICE =
  "Microsoft's documentation disagrees on the format of certification notes. The action sends a form field named notes. Check the submission in Partner Center the first time you use it.";
const CREATE_HINT = 'This product has never been published. Publish its first version in Partner Center, after which this action can update it. If it was published, check product-id.';
const UNPUBLISH_HINT = 'Wait until Partner Center shows the unpublish as finished, then decide there whether to make the extension available again. The API cannot.';
const MODULES_HINT =
  'Some sections of the submission are not valid. The API only changes the package, so fix the sections named above in Partner Center (Availability, Properties, Privacy and Store listings are edited there), then re-run this job.';
const VALIDATION_HINT =
  'Fix the errors above. If they concern the package, raise the version in manifest.json and release again. If they concern the listing, fix it in Partner Center and re-run this job.';
const PACKAGE_HINT = 'Fix the package and release again. Partner Center asks for a higher version in manifest.json with every package update.';
const INCIDENT_HINT = 'This has happened during Microsoft service incidents. Re-run later, and if it repeats, report it to Microsoft with the operation ID.';

const ambiguityHint = (version: string) =>
  `Microsoft may have created the submission. Check the product in Partner Center: if version ${version} is In review, the release is done, and until the review ends a re-run fails with InProgressSubmission, or ends skipped if Microsoft answers NoModulesUpdated. Otherwise re-run this job.`;

const lines = (...parts: Array<string | undefined>) => parts.filter(Boolean).join('\n');

const textOf = (value: unknown, limit: number) => (typeof value === 'string' ? value.slice(0, limit) : '');

export async function publishToEdge({
  apiKey,
  clientId,
  productId,
  version,
  zip,
  submit = true,
  notes = '',
  apiBase = EDGE_API,
  pollIntervalMs = 10_000,
  pollAttempts = 60,
  statusRetries = 2,
  requestTimeoutMs = 120_000,
  uploadTimeoutMs = 600_000,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  warn = () => {},
}: PublishOptions): Promise<PublishResult> {
  if (!GUID.test(productId)) throw new ActionError(`Product ID ${JSON.stringify(productId.slice(0, 100))} is not a GUID.`);
  const product = `/v1/products/${productId}`;

  async function send(method: string, path: string, init: RequestInit, timeoutMs: number): Promise<Answer> {
    let response: Response;
    try {
      response = await fetch(apiBase + path, {
        method,
        ...init,
        headers: { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId, ...(init.headers as Record<string, string> | undefined) },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ActionError(`${method} ${path} failed: ${networkReason(error)}`, undefined, { retryable: true });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ActionError(`${method} ${path} answered with a redirect (HTTP ${response.status}), which the action refuses to follow.`);
    }
    const reason = response.statusText.slice(0, 200);
    const line = `${method} ${path} returned HTTP ${response.status}${reason ? ` ${reason}` : ''}`;
    try {
      return { status: response.status, line, text: await response.text(), location: response.headers.get('location') };
    } catch (error) {
      const refused = (response.status < 200 || response.status >= 300) && !TRANSIENT_STATUSES.has(response.status);
      if (refused) return { status: response.status, line, text: '', location: response.headers.get('location') };
      throw new ActionError(`${line}, then failed while reading the response: ${networkReason(error)}`, undefined, { retryable: true });
    }
  }

  async function post(phase: Phase, path: string, init: RequestInit, timeoutMs: number): Promise<string> {
    const uncertain = phase === 'upload' ? UPLOAD_RERUN_HINT : ambiguityHint(version);
    let answer: Answer;
    try {
      answer = await send('POST', path, init, timeoutMs);
    } catch (error) {
      if (error instanceof ActionError && error.retryable) throw new ActionError(error.message, uncertain);
      throw error;
    }
    if (answer.status < 200 || answer.status >= 300) {
      const { status } = answer;
      let hint = STATUS_HINTS[status];
      if (retired(answer)) hint = RETIRED_HINT;
      else if (status === 400) hint = phase === 'upload' ? UPLOAD_400_HINT : notes ? NOTES_HINT : undefined;
      else if (status === 404) hint = PRODUCT_HINT;
      else if (status === 408) hint = phase === 'upload' ? UPLOAD_408_HINT : uncertain;
      else if (status >= 500) hint = uncertain;
      throw httpFailure(answer, hint);
    }
    const value = answer.location?.trim() ?? '';
    if (GUID.test(value)) return value;
    const shown = answer.location === null ? 'no Location header' : `Location: ${JSON.stringify(answer.location.slice(0, 200))}`;
    throw new ActionError(
      `Microsoft accepted the ${NOUN[phase]} but returned no operation ID (${shown}).`,
      phase === 'upload' ? 'The draft may still receive the package. Re-running the job uploads it again.' : uncertain,
    );
  }

  async function readOperation(phase: Phase, path: string, op: string): Promise<OperationBody> {
    const answer = await send('GET', path, {}, requestTimeoutMs);
    const { status } = answer;
    if (status >= 200 && status < 300) {
      if (status !== 200 && status !== 202) throw httpFailure(answer, 'The API documents 200 for a status check.');
      let body: unknown;
      try {
        body = JSON.parse(answer.text);
      } catch {
        body = undefined;
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new ActionError(`GET ${path} returned a response that is not JSON: ${answer.text.slice(0, 2000)}`);
      }
      return body as OperationBody;
    }
    if (TRANSIENT_STATUSES.has(status)) throw httpFailure(answer, undefined, true);
    if (status === 404) throw httpFailure(answer, `Microsoft does not know ${phase} operation ${op} for this product and account.`);
    throw httpFailure(answer, retired(answer) ? RETIRED_HINT : STATUS_HINTS[status]);
  }

  async function poll(phase: Phase, path: string, op: string): Promise<OperationBody> {
    const started = Date.now();
    const phaseHint = phase === 'upload' ? UPLOAD_POLL_HINT : ambiguityHint(version);
    const operationLine = `${OPERATION_LABEL[phase]}: ${op}`;
    let failures = 0;
    for (let check = 1; check <= pollAttempts; check++) {
      await sleep(pollIntervalMs);
      let body: OperationBody;
      try {
        body = await readOperation(phase, path, op);
      } catch (error) {
        if (!(error instanceof ActionError)) throw error;
        failures += 1;
        if (!error.retryable || failures > statusRetries) throw new ActionError(error.message, lines(error.details, phaseHint, operationLine));
        log(`Status check failed, trying again: ${error.message}`);
        continue;
      }
      failures = 0;
      if (statusOf(body) !== 'inprogress') return body;
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    if (phase === 'upload') {
      throw new ActionError(
        `Microsoft was still processing the upload of version ${version} after ${seconds} s. This run did not publish.`,
        lines('Microsoft may still finish it into the draft, or fail it. Re-running the job uploads the ZIP again.', operationLine),
      );
    }
    throw new ActionError(
      `Microsoft was still creating the submission for version ${version} after ${seconds} s.`,
      lines(
        'It may still enter certification. Check the product in Partner Center before releasing again: a re-run while it is in progress fails with InProgressSubmission, or ends skipped if Microsoft answers NoModulesUpdated.',
        operationLine,
      ),
    );
  }

  log(`Uploading it to the draft of product ${productId}.`);
  const uploadPath = `${product}/submissions/draft/package`;
  const uploadOp = await post('upload', uploadPath, { body: zip, headers: { 'Content-Type': 'application/zip' } }, uploadTimeoutMs);
  log(`Microsoft accepted the upload as operation ${uploadOp}. Checking every ${pollIntervalMs / 1000} s.`);
  const uploaded = await poll('upload', `${uploadPath}/operations/${uploadOp}`, uploadOp);
  if (statusOf(uploaded) !== 'succeeded') throw operationError('upload', uploaded, version, uploadOp);
  log(`Upload processed: ${textOf(uploaded.message, 1000) || 'no message'}`);
  if (!submit) return { result: 'uploaded', errorCode: '' };

  log(notes ? `Submitting the draft for certification, with notes (${[...notes].length} characters).` : 'Submitting the draft for certification, without notes.');
  if (notes) log(NOTES_NOTICE);
  const publishPath = `${product}/submissions`;
  const publishOp = await post('publish', publishPath, notes ? { body: new URLSearchParams({ notes }) } : {}, requestTimeoutMs);
  log(`Microsoft accepted the submission as operation ${publishOp}. Checking every ${pollIntervalMs / 1000} s.`);
  const published = await poll('publish', `${publishPath}/operations/${publishOp}`, publishOp);
  const status = statusOf(published);
  if (status === 'succeeded') {
    log(`Submission processed: ${textOf(published.message, 1000) || 'no message'}`);
    log(`Version ${version} is in certification, which can take up to 7 business days. Microsoft publishes it as soon as it is approved; the API cannot hold it.`);
    return { result: 'submitted', errorCode: '' };
  }
  if (status === 'failed' && published.errorCode === 'NoModulesUpdated') {
    warn(
      `Microsoft has nothing new to submit (NoModulesUpdated): the draft, which now holds this ZIP, matches the last submission, so version ${version} was submitted before. Nothing was submitted now. Partner Center shows whether that submission is in review, in the store or failed review. If you changed the extension, raise the version in manifest.json and release again.`,
    );
    return { result: 'skipped', errorCode: 'NoModulesUpdated' };
  }
  throw operationError('publish', published, version, publishOp);
}

function retired(answer: Answer): boolean {
  return answer.status === 410 || (answer.status === 400 && /Authorization Scheme/i.test(answer.text));
}

function httpFailure(answer: Answer, hint?: string, retryable = false): ActionError {
  let detail = answer.text.trim().slice(0, 2000);
  try {
    const message = (JSON.parse(answer.text) as { message?: unknown } | null)?.message;
    if (typeof message === 'string') detail = message.slice(0, 1000);
  } catch {}
  return new ActionError(`${answer.line}${detail ? `: ${detail}` : ''}`, hint, { retryable });
}

function statusOf(body: OperationBody): string {
  if (typeof body.status === 'string') return body.status.toLowerCase();
  if ((body.status === undefined || body.status === null) && typeof body.message === 'string') return 'missing';
  return 'unknown';
}

function errorLines(errors: unknown): string[] {
  const list: unknown[] = Array.isArray(errors) ? errors : errors === undefined || errors === null ? [] : [errors];
  return list.slice(0, 20).map((item) => {
    const message = (item as { message?: unknown } | null)?.message;
    return (typeof item === 'string' ? item : typeof message === 'string' ? message : JSON.stringify(item)).slice(0, 300);
  });
}

function operationError(phase: Phase, body: OperationBody, version: string, op: string): ActionError {
  const message = textOf(body.message, 1000);
  const operationLine = `${OPERATION_LABEL[phase]}: ${op}`;
  const status = statusOf(body);
  if (status === 'missing') {
    return phase === 'upload'
      ? new ActionError(`Microsoft could not process the upload: ${message}`, lines('Re-run later. If it repeats, contact Microsoft with the correlation ID in the message and the operation ID.', operationLine))
      : new ActionError(
          `Microsoft reports an unexpected failure: ${message}`,
          lines(
            'Re-run later. If a submission was created after all, the re-run fails with InProgressSubmission, or ends skipped if Microsoft answers NoModulesUpdated. If the failure repeats, contact Microsoft with the correlation ID in the message.',
            operationLine,
          ),
        );
  }
  if (status !== 'failed') {
    return new ActionError(
      `Microsoft reported ${NOUN[phase]} status ${JSON.stringify(body.status ?? null).slice(0, 200)}, which this version of the action does not know. The API may have changed. Nothing further was sent.`,
      lines(`Response: ${JSON.stringify(body).slice(0, 2000)}`, operationLine),
    );
  }
  const code = textOf(body.errorCode, 100);
  const errors = errorLines(body.errors);
  const failure = describeFailure(phase, code, message, errors.length > 0, version);
  const details = lines(!failure.quoted && message ? `Microsoft says: ${message}` : undefined, ...errors, failure.hint, operationLine);
  return code ? new OperationError(failure.text, details, code) : new ActionError(failure.text, details);
}

function describeFailure(phase: Phase, code: string, message: string, hasErrors: boolean, version: string): Failure {
  const upload = phase === 'upload';
  const noun = NOUN[phase];
  const quote = (prefix: string, hint?: string): Failure => ({ text: message ? `${prefix}: ${message}` : `${prefix}.`, hint, quoted: true });
  switch (code) {
    case 'InProgressSubmission':
      return upload
        ? {
            text: `Microsoft refused the upload: a submission for this product is already in progress (InProgressSubmission). Version ${version} was not uploaded.`,
            hint: `If an earlier run of this release submitted version ${version}, nothing is wrong: its review continues. Otherwise re-run this job when the review ends, or select Cancel submission in Partner Center and re-run it. The API cannot tell which version is in review, and cannot cancel it.`,
            quoted: false,
          }
        : {
            text: 'Microsoft refused the submission: a submission for this product is already in progress (InProgressSubmission).',
            hint: `If an earlier run of this release submitted version ${version}, nothing is wrong: its review continues, and this run changed nothing but the draft. Otherwise version ${version} now waits in the draft, not submitted: re-run this job when the review ends, or in Partner Center select Publish, which stops the current review and starts a new one with the draft, or Cancel submission. The API cannot tell which version is in review, and cannot cancel it.`,
            quoted: false,
          };
    case 'NoModulesUpdated':
      return {
        text: 'Microsoft reported NoModulesUpdated for the upload, a code its documentation lists only for the submission step. The draft may be unchanged.',
        hint: 'If the extension changed, raise the version in manifest.json and release again.',
        quoted: false,
      };
    case 'CreateNotAllowed':
      return { text: `Microsoft ${upload ? 'refused the upload: it ' : ''}cannot create a new extension through the API (CreateNotAllowed).`, hint: CREATE_HINT, quoted: false };
    case 'UnpublishInProgress':
      return { text: `Microsoft refused the ${noun}: the extension is being unpublished (UnpublishInProgress).`, hint: UNPUBLISH_HINT, quoted: false };
    case 'ModuleStateUnPublishable':
      return quote(`Microsoft refused the ${noun} (ModuleStateUnPublishable)`, upload ? MODULES_HINT : `${MODULES_HINT} The draft holds version ${version}.`);
    case 'SubmissionValidationError':
      return quote(`Microsoft refused the ${noun} (SubmissionValidationError)`, VALIDATION_HINT);
    case '':
      if (!upload) {
        return {
          text: `Microsoft reports an irrecoverable failure without a code: ${message || 'no message'}`,
          hint: `Re-run later. The draft holds version ${version}. If it repeats, report it to Microsoft with the operation ID.`,
          quoted: true,
        };
      }
      if (hasErrors) return quote('Microsoft refused the package', PACKAGE_HINT);
      return { text: `Microsoft reports that the upload of version ${version} failed and gives no reason: ${message || 'no message'}`, hint: INCIDENT_HINT, quoted: true };
    default:
      return upload ? quote(`Microsoft refused the package (${code})`, PACKAGE_HINT) : quote(`Microsoft refused the submission (${code})`);
  }
}
