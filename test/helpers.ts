import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateRawSync } from 'node:zlib';
import { compareVersions, readManifest } from '../src/zip.ts';

export interface ZipFile {
  name: string;
  data: string;
  method?: number;
  flags?: number;
  crc?: number;
}

export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data);
    const method = file.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const flags = file.flags ?? 0x0800;
    const crc = file.crc ?? crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function extensionZip(version: string, { method, script = '' }: { method?: number; script?: string } = {}): Buffer {
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'Test extension', version }), method },
    { name: 'background.js', data: `chrome.runtime.onInstalled.addListener(() => {});\n${script}`, method },
  ]);
}

export function makeCrx(archive: Buffer, magic = 'Cr24'): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.write(magic, 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(4, 8);
  return Buffer.concat([prefix, Buffer.from('sign'), archive]);
}

export const PRODUCT = '0f5c3b2a-7e1d-4a6b-9c8d-2e3f4a5b6c7d';
export const UPLOAD_OP = '7b0e4c1a-2f7d-4c55-9a51-0d3c2a1f9e10';
export const PUBLISH_OP = '0c9d3f5e-6a1b-4e2f-8d7c-5b4a3e2f1d0c';
export const PRODUCT_PATH = `/v1/products/${PRODUCT}`;
export const UPLOAD = `POST ${PRODUCT_PATH}/submissions/draft/package`;
export const UPLOAD_STATUS = `GET ${PRODUCT_PATH}/submissions/draft/package/operations/${UPLOAD_OP}`;
export const PUBLISH = `POST ${PRODUCT_PATH}/submissions`;
export const PUBLISH_STATUS = `GET ${PRODUCT_PATH}/submissions/operations/${PUBLISH_OP}`;
export const DEPRECATED_MESSAGE = 'The API version you are currently using is deprecated and no longer available.';
export const SCHEME_MESSAGE = 'The value of Authorization Scheme does not match the expected value ApiKey.';

export interface Reply {
  status?: number;
  statusText?: string;
  body?: unknown;
  headers?: Record<string, string>;
  partial?: boolean;
  destroy?: boolean;
  delayMs?: number;
}

export interface RecordedRequest {
  key: string;
  auth: string | undefined;
  clientId: string | undefined;
  contentType: string | undefined;
  contentLength: string | undefined;
  size: number;
  body: string;
  bytes: Buffer;
  time: number;
}

export type Handler = (request: RecordedRequest) => Reply | undefined;

export interface MockStore {
  base: string;
  requests: RecordedRequest[];
  on(key: string, ...replies: Reply[]): void;
  handle(handler: Handler | undefined): void;
  reset(): void;
  close(): Promise<void>;
}

interface MockOptions {
  microsoft?: boolean;
  clientId?: string;
  onRequest?: (request: RecordedRequest, requests: RecordedRequest[]) => void;
}

const UPLOAD_ROUTE = /^POST \/v1\/products\/[^/]+\/submissions\/draft\/package$/;

function microsoftDefaults(request: RecordedRequest, clientId: string | undefined): Reply | undefined {
  if (!request.clientId) return { status: 410, statusText: 'Gone', body: { message: DEPRECATED_MESSAGE } };
  if (!request.auth?.startsWith('ApiKey ')) return { status: 400, statusText: 'Bad Request', body: SCHEME_MESSAGE };
  if (clientId && request.clientId !== clientId) return { status: 403, statusText: 'Client ID is Invalid', body: null };
  if (UPLOAD_ROUTE.test(request.key) && request.contentType !== 'application/zip') return { status: 400, statusText: 'Bad Request', body: null };
  return undefined;
}

export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

export async function startMockStore({ microsoft = false, clientId, onRequest }: MockOptions = {}): Promise<MockStore> {
  const routes = new Map<string, Reply[]>();
  const requests: RecordedRequest[] = [];
  let handler: Handler | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const request: RecordedRequest = {
        key: `${req.method} ${req.url}`,
        auth: req.headers.authorization,
        clientId: req.headers['x-clientid'] as string | undefined,
        contentType: req.headers['content-type'],
        contentLength: req.headers['content-length'],
        size: bytes.length,
        body: bytes.toString(),
        bytes,
        time: Date.now(),
      };
      requests.push(request);
      onRequest?.(request, requests);
      const queue = routes.get(request.key);
      const fallback: Reply = microsoft ? { status: 404, statusText: 'Resource Not Found', body: null } : { status: 404, body: { error: { code: 404, message: `no mock route for ${request.key}` } } };
      const reply: Reply =
        (microsoft ? microsoftDefaults(request, clientId) : undefined) ?? (queue && (queue.length > 1 ? queue.shift() : queue[0])) ?? handler?.(request) ?? fallback;
      if (reply.destroy) {
        req.socket.destroy();
        return;
      }
      const answer = () => {
        if (res.destroyed) return;
        const status = reply.status ?? 200;
        if (reply.partial) {
          res.writeHead(status, reply.statusText, { 'Content-Type': 'application/json', 'Content-Length': '1000', ...reply.headers });
          res.write('{"sta');
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        const body = reply.body === null || reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        const type = reply.body === null || reply.body === undefined ? {} : { 'Content-Type': typeof reply.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' };
        res.writeHead(status, reply.statusText, { ...type, 'Content-Length': String(Buffer.byteLength(body)), ...reply.headers });
        res.end(body);
      };
      if (reply.delayMs) setTimeout(answer, reply.delayMs);
      else answer();
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    on(key, ...replies) {
      routes.set(key, replies);
    },
    handle(next) {
      handler = next;
    },
    reset() {
      routes.clear();
      requests.length = 0;
      handler = undefined;
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

export function startMockEdge(options: Omit<MockOptions, 'microsoft'> = {}): Promise<MockStore> {
  return startMockStore({ ...options, microsoft: true });
}

export function accepted(op: string): Reply {
  return { status: 202, statusText: 'Accepted', headers: { Location: op }, body: null };
}

export function operation(status: unknown, fields: Record<string, unknown> = {}): Reply {
  return {
    body: {
      id: fields.id ?? randomUUID(),
      createdTime: '2026-09-26T10:00:00Z',
      lastUpdatedTime: '2026-09-26T10:00:05Z',
      ...(status === undefined ? {} : { status }),
      message: null,
      errorCode: null,
      errors: null,
      ...fields,
    },
  };
}

export const inProgress = (): Reply => operation('InProgress');
export const uploadSucceeded = (): Reply => operation('Succeeded', { message: 'Successfully updated package to extension.zip', errorCode: '' });
export const publishSucceeded = (): Reply => operation('Succeeded', { message: 'Successfully created submission with ID 5f0a0c6e-3b1d-4c1e-9a0f-6d2b8c7e4a11', errorCode: '' });

export const PUBLISH_FAILURES: Record<string, { message: string | null; errors: unknown }> = {
  CreateNotAllowed: { message: "Can't create new extension.", errors: null },
  NoModulesUpdated: { message: "Can't publish extension since there are no updates, please try again after updating the package.", errors: null },
  InProgressSubmission: { message: "Can't publish extension as your extension submission is in progress. Please try again later.", errors: null },
  UnpublishInProgress: { message: "Can't publish extension as your extension is being unpublished. Please try after you've unpublished.", errors: null },
  ModuleStateUnPublishable: {
    message: "Can't publish extension as your extension has modules that are not valid. Fix the modules with errors and try to publish again.",
    errors: [{ message: 'Invalid module : Store listings' }],
  },
  SubmissionValidationError: {
    message: "Extension can't be published as there are submission validation failures. Fix these errors and try again later.",
    errors: ['The privacy policy URL is required.', 'The description is too short.'],
  },
};

export function publishFailed(code: string): Reply {
  const failure = PUBLISH_FAILURES[code];
  if (!failure) throw new Error(`no documented body for ${code}`);
  return operation('Failed', { errorCode: code, ...failure });
}

export const irrecoverableFailure = (): Reply => operation('Failed', { message: 'An error occurred while performing the operation', errorCode: null });

export function unexpectedFailure(id = PUBLISH_OP): Reply {
  return { body: { id, message: `An error occurred while processing the request. Please contact support Correlation ID: ${id} Timestamp: 2026-09-26T10:00:05Z` } };
}

export function happyPath(store: MockStore, { publish = true }: { publish?: boolean } = {}): void {
  store.on(UPLOAD, accepted(UPLOAD_OP));
  store.on(UPLOAD_STATUS, uploadSucceeded());
  if (!publish) return;
  store.on(PUBLISH, accepted(PUBLISH_OP));
  store.on(PUBLISH_STATUS, publishSucceeded());
}

export type Step = 'upload' | 'upload-status' | 'publish' | 'publish-status';

export interface Fault {
  at: Step;
  reply?: Reply;
  apply?: boolean;
  final?: Reply;
}

export interface EdgeState {
  everPublished: boolean;
  unpublishing: boolean;
  invalidModules: string[];
  validationErrors: string[];
  draft: string | undefined;
  lastSubmitted: string | undefined;
  inReview: string | undefined;
  live: string | undefined;
  liveVersion: string | undefined;
  submissions: string[];
}

export interface SimulatorOptions {
  uploadDuringReview?: 'accept' | 'refuse';
  firstAnswer?: 'in-progress' | 'no-modules';
  identicalIsUpdate?: boolean;
  versionRule?: 'none' | 'higher';
  secondUpload?: 'accept' | 'refuse';
  processingChecks?: number;
}

interface PendingOperation {
  step: Step;
  checksLeft: number;
  final: Reply;
}

export interface EdgeSimulator {
  state: EdgeState;
  faults: Fault[];
  handler: Handler;
  approve(): void;
  failReview(): void;
  finishProcessing(): void;
}

export const packageId = (zip: Buffer) => createHash('sha256').update(zip).digest('hex').slice(0, 12);

export function edgeSimulator(options: SimulatorOptions = {}, initial: Partial<EdgeState> = {}): EdgeSimulator {
  const { uploadDuringReview = 'accept', firstAnswer = 'in-progress', identicalIsUpdate = false, versionRule = 'none', secondUpload = 'accept', processingChecks = 1 } = options;
  const state: EdgeState = {
    everPublished: true,
    unpublishing: false,
    invalidModules: [],
    validationErrors: [],
    draft: undefined,
    lastSubmitted: undefined,
    inReview: undefined,
    live: undefined,
    liveVersion: undefined,
    submissions: [],
    ...initial,
  };
  const faults: Fault[] = [];
  const operations = new Map<string, PendingOperation>();
  const versions = new Map<string, string>();

  const takeFault = (step: Step) => {
    const index = faults.findIndex((fault) => fault.at === step);
    return index === -1 ? undefined : faults.splice(index, 1)[0];
  };
  const failed = (errorCode: string, message: string, errors: unknown = null): Reply => operation('Failed', { errorCode, message, errors });

  function uploadOutcome(zip: Buffer): { final: Reply; apply: () => void } {
    const id = packageId(zip);
    const version = readManifest(zip).version;
    versions.set(id, version);
    const processing = [...operations.values()].some((pending) => pending.step === 'upload-status' && pending.checksLeft > 0);
    if (state.inReview && uploadDuringReview === 'refuse') return { final: failed('InProgressSubmission', PUBLISH_FAILURES.InProgressSubmission!.message!), apply: () => {} };
    if (processing && secondUpload === 'refuse') return { final: failed('SimulatedUploadInProgress', 'Another upload is being processed.'), apply: () => {} };
    if (versionRule === 'higher' && state.liveVersion && compareVersions(version, state.liveVersion) <= 0) {
      return { final: failed('SimulatedVersionRule', `Version ${version} must be higher than ${state.liveVersion}.`, ['manifest.json version is not higher than the published version.']), apply: () => {} };
    }
    return {
      final: uploadSucceeded(),
      apply: () => {
        state.draft = id;
      },
    };
  }

  function publishOutcome(): { final: Reply; apply: () => void } {
    const none = () => {};
    const unchanged = state.draft === state.lastSubmitted && !identicalIsUpdate;
    if (!state.everPublished) return { final: publishFailed('CreateNotAllowed'), apply: none };
    if (state.unpublishing) return { final: publishFailed('UnpublishInProgress'), apply: none };
    if (state.inReview) return { final: publishFailed(firstAnswer === 'no-modules' && unchanged ? 'NoModulesUpdated' : 'InProgressSubmission'), apply: none };
    if (state.invalidModules.length > 0) return { final: failed('ModuleStateUnPublishable', PUBLISH_FAILURES.ModuleStateUnPublishable!.message!, state.invalidModules.map((name) => ({ message: `Invalid module : ${name}` }))), apply: none };
    if (state.validationErrors.length > 0) return { final: failed('SubmissionValidationError', PUBLISH_FAILURES.SubmissionValidationError!.message!, state.validationErrors), apply: none };
    if (unchanged) return { final: publishFailed('NoModulesUpdated'), apply: none };
    return {
      final: publishSucceeded(),
      apply: () => {
        state.lastSubmitted = state.draft;
        state.inReview = state.draft;
        state.submissions.push(state.draft ?? 'empty draft');
      },
    };
  }

  const handler: Handler = (request) => {
    const [method, path = ''] = request.key.split(' ');
    const match = /^\/v1\/products\/([^/]+)\/submissions(\/draft\/package)?(?:\/operations\/([^/]+))?$/.exec(path);
    if (!match) return undefined;
    const [, , draft, op] = match;
    if (op) {
      const pending = operations.get(op);
      if (!pending || method !== 'GET' || pending.step !== (draft ? 'upload-status' : 'publish-status')) return undefined;
      const fault = takeFault(pending.step);
      if (fault?.reply) return fault.reply;
      if (pending.checksLeft > 0) {
        pending.checksLeft -= 1;
        return inProgress();
      }
      return pending.final;
    }
    if (method !== 'POST') return undefined;
    const step: Step = draft ? 'upload' : 'publish';
    const fault = takeFault(step);
    const outcome = draft ? uploadOutcome(request.bytes) : publishOutcome();
    if (fault?.reply) {
      if (fault.apply) {
        outcome.apply();
        operations.set(randomUUID(), { step: `${step}-status`, checksLeft: processingChecks, final: outcome.final });
      }
      return fault.reply;
    }
    if (fault?.final) {
      if (fault.apply) outcome.apply();
      const op = randomUUID();
      operations.set(op, { step: `${step}-status`, checksLeft: processingChecks, final: fault.final });
      return accepted(op);
    }
    outcome.apply();
    const id = randomUUID();
    operations.set(id, { step: `${step}-status`, checksLeft: processingChecks, final: outcome.final });
    return accepted(id);
  };

  return {
    state,
    faults,
    handler,
    approve() {
      state.live = state.inReview;
      state.liveVersion = state.inReview ? versions.get(state.inReview) : state.liveVersion;
      state.inReview = undefined;
    },
    failReview() {
      state.inReview = undefined;
    },
    finishProcessing() {
      for (const pending of operations.values()) pending.checksLeft = 0;
    },
  };
}
