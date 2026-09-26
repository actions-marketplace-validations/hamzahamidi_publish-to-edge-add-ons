# Publish to Edge Add-ons

[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-2ea44f)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Publish updates to a Microsoft Edge extension from GitHub Actions through the Edge Add-ons API.

- **Two secrets, one of which expires.** Edge accepts only an API key and a client ID, and Microsoft expires the key 72 days after it is created. [Rotating the API key](#rotating-the-api-key) replaces it before a release fails. No secretless route exists today.
- **Reports only what Microsoft answered.** The API has no endpoint that reads the product or its review, so the action decides from the answers to its own requests and says what it could not check.
- **Safe to re-run.** It never repeats a POST within a run and never cancels or replaces a submission in review. A re-run during a review fails with a message that says which case means nothing is wrong.
- **Auditable.** About 680 lines of TypeScript with no runtime dependencies and no build step, sending credentials to one Microsoft host.
- **Same shape as the Chrome action.** `zip`, `publish`, `dry-run` and the outputs `result` and `version` mean what they mean in [publish-to-chrome-web-store](https://github.com/hamzahamidi/publish-to-chrome-web-store), so the two jobs sit side by side.

## Quick start

After [creating the API credentials](#credentials) in Partner Center and storing them in an `edge-add-ons` environment, add this job to a workflow that runs when you push a release tag:

```yaml
edge:
  needs: build
  runs-on: ubuntu-latest
  environment: edge-add-ons
  permissions: {}
  timeout-minutes: 40
  concurrency:
    group: edge-add-ons
    cancel-in-progress: false
  steps:
    - uses: actions/download-artifact@v8
      with:
        name: extension
    - uses: hamzahamidi/publish-to-edge-add-ons@v1
      with:
        api-key: ${{ secrets.EDGE_API_KEY }}
        client-id: ${{ secrets.EDGE_CLIENT_ID }}
        product-id: d34f98f5-f9b7-42b1-bebb-98707202b21d
        zip: extension.zip
```

The ZIP comes from a `build` job without secrets, shown in full [next to the Chrome job](#next-to-the-chrome-action). Add `dry-run: true` to the last step for a first run that checks the inputs and the ZIP and sends nothing to Microsoft.

## Why this action

- **Errors keep Microsoft's reason phrase.** Some failures carry their only detail in the HTTP status line and arrive with an empty body, such as `403 Client ID is Invalid`. Every failed request is reported with its reason phrase, and each error code Microsoft documents gets its own hint.
- **The API leaves the checks to you.** The publish call submits whatever the draft holds and returns nothing to read back. The action always uploads first, waits until Microsoft has processed each step, and handles `InProgressSubmission` and `NoModulesUpdated` explicitly. See [Re-running a release](#re-running-a-release).
- **Narrow by construction.** One fixed host, redirects refused, the operation ID in `Location` accepted only as a bare GUID and never requested as a URL, no runtime packages, and the code Node runs is the code in `src/`.

Not affiliated with or endorsed by Microsoft. Microsoft Edge is a trademark of Microsoft Corporation.

## Before you start

- The extension must already be published once through [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/public/login?ref=dd). The API cannot create a product, and a publish for a product that was never published fails with `CreateNotAllowed`.
- The product ID is the GUID on the Extension overview page in Partner Center, also in the address bar between `microsoftedge/` and `/packages`. It is not the 32-letter extension ID in the store address; the action recognizes that ID and says which one it needs.
- The ZIP holds the contents of your extension folder, with `manifest.json` at its root, not the folder itself.
- One writer per product. The publish call submits the current draft: whatever was uploaded last, by anyone, plus any listing edits saved in Partner Center. Nothing else should change the draft while a run is going.
- Certification can take up to 7 business days, and Microsoft publishes an approved version automatically. There is no hold, no staged rollout and no way to skip review.
- Raise the `version` in `manifest.json` for every release, as [Partner Center asks](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/update-extension). The action cannot compare it with the published version, because the API does not return that version.

## Credentials

The Edge Add-ons API accepts one kind of credential: an API key plus a client ID, sent as `Authorization: ApiKey <key>` and `X-ClientID: <client id>` on every request. Microsoft offers no OIDC, Entra ID, workload identity federation or trusted publisher route, and its earlier OAuth client secret flow is shut down: a request in that form gets `410 Gone`. So unlike the Chrome action, this action needs two stored secrets.

### Creating them

These are the steps of Microsoft's [Enable the Update REST API at Partner Center](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api?tabs=v1-1#enable-the-update-rest-api-at-partner-center):

1. Sign in to Partner Center with the account that published the extension.
2. Under the Microsoft Edge program, select Publish API.
3. If the page shows the message "enable the new experience", click Enable next to it.
4. Click Create API credentials. The page then shows the client ID, the API key and the key's expiry date.

### Storing them

Store both values as secrets of a GitHub environment that only the Edge job uses:

```bash
gh secret set EDGE_API_KEY --env edge-add-ons --repo OWNER/REPO
gh secret set EDGE_CLIENT_ID --env edge-add-ons --repo OWNER/REPO
```

- Give `edge-add-ons` a required reviewer and a deployment rule that only allows your release tags, such as `v*`. Keep the build job and the Chrome job out of it, so they never see these secrets. Use environment secrets rather than repository secrets: anyone with write access can read repository secrets from any branch.
- Store two secrets, not one JSON secret. GitHub redacts values taken out of a structured secret poorly, and the runner prints a step's inputs before the action can mask anything. The action refuses a value that looks like JSON.
- Pass the client ID from a secret too. It cannot publish on its own, but the runner lists a step's `with:` values at the top of the step log and redacts only values that come from secrets. The action masks both values as its first act, which covers everything it prints itself.
- **The credentials are most likely account-wide.** They are created on the account's Publish API page, not on a product, so they most likely let whoever holds them publish updates to every extension of that Partner Center account. This is an inference from where the page sits; Microsoft does not document the scope. Treat them as a publishing credential for the whole account.

### Rotating the API key

API keys expire 72 days after they are created, according to the Microsoft Edge blog post of 30 September 2024 that announced API keys. No API creates or refreshes a key, so after 72 days without rotation every run fails at its first request with HTTP 401. The blog promises reminder emails before expiry, but a developer reports receiving none ([microsoft/MicrosoftEdge-Extensions#272](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/272)), so set your own reminder instead of waiting for one.

The Publish API page lists several keys at once, each with its own expiry date, so the new key can be created before the old one expires:

1. In Partner Center, open Microsoft Edge, Publish API, and create a new API key. Note its expiry date.
2. Replace the secret: run `gh secret set EDGE_API_KEY --env edge-add-ons --repo OWNER/REPO` and paste the new key.
3. Keep the old key until a run has used the new one: the next release, or a run with `publish: false`, which uploads the ZIP into the draft and submits nothing. A dry run sends no request, so it cannot check a key, and the API has no request that checks one without writing to the draft. If that run fails with 401, the old key is still listed and can go back into the secret while you look into it.
4. Delete the old key on the Publish API page.
5. Set a reminder for about 60 days after the new key's creation date.

Microsoft does not document whether two keys authenticate at the same time; the overlap rests on the page listing both with separate expiry dates. After a leak, the same steps revoke the leaked key: create a new key, update the secret, and delete the leaked key at once instead of waiting in step 3.

## Usage

### Next to the Chrome action

A maintainer who already runs [publish-to-chrome-web-store](https://github.com/hamzahamidi/publish-to-chrome-web-store) adds one job next to it, fed by the same build artifact:

```yaml
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      # ... build your extension into dist/ ...
      - run: cd dist && zip -qr ../extension.zip .
      - uses: actions/upload-artifact@v7
        with:
          name: extension
          path: extension.zip

  edge:
    needs: build
    runs-on: ubuntu-latest
    environment: edge-add-ons
    permissions: {}
    timeout-minutes: 40
    concurrency:
      group: edge-add-ons
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension
      - uses: hamzahamidi/publish-to-edge-add-ons@v1
        with:
          api-key: ${{ secrets.EDGE_API_KEY }}
          client-id: ${{ secrets.EDGE_CLIENT_ID }}
          product-id: d34f98f5-f9b7-42b1-bebb-98707202b21d
          zip: extension.zip

  chrome:
    needs: build
    runs-on: ubuntu-latest
    environment: chrome-web-store
    permissions:
      id-token: write
    concurrency:
      group: chrome-web-store
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension
      - id: auth
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: ${{ vars.CWS_WIF_PROVIDER }}
          service_account: ${{ vars.CWS_SERVICE_ACCOUNT }}
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/chromewebstore
          access_token_lifetime: 1800s
          create_credentials_file: false
          export_environment_variables: false
      - uses: hamzahamidi/publish-to-chrome-web-store@v1
        with:
          access-token: ${{ steps.auth.outputs.access_token }}
          publisher-id: your-publisher-id
          item-id: abcdefghijklmnopabcdefghijklmnop
          zip: extension.zip
```

The two store jobs share nothing but the ZIP. Each has its own environment holding only its own credentials, and either can fail without affecting the other. The build runs in its own job, so build tools never run next to a store credential.

- `permissions: {}` is enough for the Edge job: the action talks only to Microsoft, with the two secrets, and needs no GitHub token and no `id-token`.
- The concurrency group keeps two releases from writing to the same draft at once. That matters more than for Chrome, because the publish call submits whatever the draft holds and the action cannot read the draft to notice a competing upload.
- `timeout-minutes: 40` covers the longest run while Microsoft answers promptly: 10 minutes for the upload request, about 10 minutes of upload checks, 2 minutes for the publish request and about 10 minutes of publish checks. A job stopped by its timeout leaves a state the next run handles (see [Re-running a release](#re-running-a-release)).

Coming from the Chrome action's inputs:

| Chrome action | This action | Why |
| --- | --- | --- |
| `access-token`, or `client-id` + `client-secret` + `refresh-token` | `api-key` + `client-id` | Edge accepts only `Authorization: ApiKey` plus `X-ClientID`. `client-id` here is the Partner Center client ID, not an OAuth client ID |
| `publisher-id` | none | The credentials belong to the Partner Center account |
| `item-id` | `product-id` | A GUID from Partner Center, not the store's 32-letter ID |
| `zip`, `publish` | `zip`, `publish` | Same meaning |
| `dry-run` | `dry-run` | Same name. It checks less: the inputs and the ZIP, with no request |
| `crx`, `deploy-percentage`, `rollout-only`, `skip-review`, `block-on-warnings`, `publish-type` | none | The Edge API takes a ZIP only and has no staged rollout, no skip-review path and no hold |
| none | `certification-notes` | Partner Center's "Notes for certification" |
| outputs `result`, `state`, `version` | `result`, `version`, `error-code` | No `state`, because there is nothing to read back. `error-code` carries Microsoft's `errorCode` so a later step can act on it |

### Uploading a draft, publishing by hand

```yaml
      - uses: hamzahamidi/publish-to-edge-add-ons@v1
        with:
          api-key: ${{ secrets.EDGE_API_KEY }}
          client-id: ${{ secrets.EDGE_CLIENT_ID }}
          product-id: d34f98f5-f9b7-42b1-bebb-98707202b21d
          zip: extension.zip
          publish: false
```

The package lands in the draft and Microsoft validates it; nothing is submitted. Check the draft in Partner Center, edit the listing if needed and select Publish there, or run the job again with `publish: true` and the same ZIP. This is the only way to hold a version: certification starts only when the draft is published, and after approval Microsoft publishes without a hold.

### Notes for the certification testers

```yaml
      - uses: hamzahamidi/publish-to-edge-add-ons@v1
        with:
          api-key: ${{ secrets.EDGE_API_KEY }}
          client-id: ${{ secrets.EDGE_CLIENT_ID }}
          product-id: d34f98f5-f9b7-42b1-bebb-98707202b21d
          zip: extension.zip
          certification-notes: |
            Sign in with the test account: ${{ secrets.EDGE_TEST_ACCOUNT }}
            Open any page and click the toolbar button to see the word count.
            Release ${{ github.ref_name }}.
```

Partner Center calls this field "Notes for certification", and Microsoft [suggests putting test account usernames and passwords in it](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension#step-8-enter-certification-testing-notes-and-submit-the-extension). Compose those from a secret, as above. The action logs the number of characters, never the text.

**This input is best effort, and its format is not verified.** Microsoft's pages disagree on the body of the publish request: the [overview](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api?tabs=v1-1#publishing-the-submission) says JSON but its curl sample sends a string that is not JSON, the [reference](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/addons-api-reference?tabs=v1-1#publish-the-product-draft-submission) says plain text, and the PowerShell sample, the only complete program Microsoft publishes for this API, sends a form field named `notes`. The action sends that form field: `notes=<text>` as `application/x-www-form-urlencoded;charset=UTF-8`. Without notes the request has no body. No response echoes the notes, so the run cannot succeed or fail on them: check the submission in Partner Center the first time you use them. If the publish request answers 400 while notes are set, the error suggests one run without them.

Passing `${{ github.event.release.body }}` through `with:` is safe. Do not place it in a `run:` script, where it becomes shell code.

### Trying it first

Add `dry-run: true` to the step. The run checks every input, reads `manifest.json` from the ZIP, and prints what a real run would upload and submit. It sends nothing to Microsoft.

| A dry run checks | A dry run does not check |
| --- | --- |
| Every input, its format and the combinations | That Microsoft accepts the API key and the client ID |
| The ZIP's structure, its `manifest.json` and the version | That the product belongs to the account |
| | That Microsoft's package validation passes |
| | Whether a review is in progress, or whether the version is higher than the published one |

The API has no read endpoint, and whether a read-only request with a made-up operation ID can tell a good key from a bad one is not verified, so a dry run makes no request at all. The first request that proves the credentials is the upload of a real run; `publish: false` makes that run stop at the draft.

To start a dry run by hand, give the workflow a `workflow_dispatch` trigger, set `dry-run: ${{ github.event_name == 'workflow_dispatch' }}` on the step, and pick a tag under "Use workflow from" so the environment's tag rule lets the run through.

### Moving from wdzeng/edge-addon

[wdzeng/edge-addon](https://github.com/wdzeng/edge-addon) takes the same set of inputs under other names:

| wdzeng/edge-addon | This action |
| --- | --- |
| `product-id` | `product-id` |
| `zip-path` | `zip` |
| `api-key` | `api-key` |
| `client-id` | `client-id` |
| `upload-only: true` | `publish: false` |
| `notes-for-certification` | `certification-notes` |

wdzeng/edge-addon sends the notes as the raw request body; this action sends a form field. Neither format is verified to reach the testers.

### Other stores

This action publishes to Microsoft Edge Add-ons only. The Chrome Web Store has its own API and credentials: use [publish-to-chrome-web-store](https://github.com/hamzahamidi/publish-to-chrome-web-store) in its own job, as [above](#next-to-the-chrome-action). Firefox Add-ons also needs a separate step.

## Re-running a release

- Keep the Edge publish in its own job and use "Re-run failed jobs". An Edge job that succeeded is then not repeated when another job is re-run.
- Re-running a failed Edge job is safe. Every run uploads the ZIP into the draft again and asks to publish. It never cancels or replaces a submission already in review, because the API cannot.
- Raise the version in `manifest.json` for every release.

What a re-run of the same release does, with the same ZIP, after each place an earlier run can stop:

| Where the earlier run stopped | What the re-run does |
| --- | --- |
| A local check, or before any request | A full run |
| The upload request was refused with 400, 401, 403, 404 or 410 | The same failure until the cause is fixed |
| The upload request was throttled (429) | A full run once the throttling ends |
| The upload request lost its answer (network error, timeout, 408, 5xx, no operation ID), or processing outlasted 60 checks | Uploads again, normally ending `submitted` |
| The upload operation failed | The same failure until the package is fixed, or `submitted` if the cause was on Microsoft's side |
| After the upload succeeded, before the publish request, or after a `publish: false` run | Uploads again and publishes: `submitted` |
| The publish request lost its answer, or its checks outlasted 60 checks or answered 401, 403 or 404 | Uploads again and publishes: `InProgressSubmission` if the earlier submission went through, `submitted` if it did not |
| The publish succeeded and the version is in review | `InProgressSubmission`, or `skipped` if Microsoft answers `NoModulesUpdated` |
| The publish succeeded and the version is live | Depends on Microsoft's version rule, which is not documented: a refused upload, `skipped`, or a new review of the same version |
| The publish failed with `InProgressSubmission` because an older version was in review | `submitted` once that review ends |
| The publish failed with `SubmissionValidationError`, `ModuleStateUnPublishable`, `CreateNotAllowed` or `UnpublishInProgress` | The same failure until the cause is fixed in Partner Center or in the package |

**`InProgressSubmission` fails the run.** Two different cases get the same answer from Microsoft: a re-run of release 1.4.0 while its own submission is in review, and release 1.4.1 while an older 1.4.0 is still in review. No endpoint says which version the submission in progress holds. Reporting success would turn the step green without any check, and in the second case 1.4.1 would then wait in the draft with nobody told to publish it. So the run fails, and its message says: if an earlier run of this release submitted this version, nothing is wrong; otherwise re-run the job when the review ends, or select Publish in Partner Center, which stops the current review and starts a new one with the draft. The failure cancels nothing.

If you prefer that case green, use the `error-code` output, which is set even when the step fails:

```yaml
      - id: edge
        continue-on-error: true
        uses: hamzahamidi/publish-to-edge-add-ons@v1
        with:
          api-key: ${{ secrets.EDGE_API_KEY }}
          client-id: ${{ secrets.EDGE_CLIENT_ID }}
          product-id: d34f98f5-f9b7-42b1-bebb-98707202b21d
          zip: extension.zip
      - if: steps.edge.outcome == 'failure' && steps.edge.outputs.error-code != 'InProgressSubmission'
        run: exit 1
```

The price: a new version held back by an older review then also ends green, and it waits in the draft until someone publishes it.

**`NoModulesUpdated` ends `skipped` with a warning.** The action always uploads before it publishes, so this answer arrives only after this run's upload succeeded. Microsoft then says nothing changed since the last submission, which means that submission already holds this package. It cannot say whether that submission passed certification, so the warning points to Partner Center. This reading assumes Microsoft compares content: if it compares only the version, a rebuild with changes under the same version is reported `skipped` too, which is one more reason to raise the version for every release.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-key` | yes | | API key from Partner Center, Microsoft Edge, Publish API. It expires 72 days after it is created. Pass it from a secret |
| `client-id` | yes | | Client ID from the same Publish API page, not an OAuth client ID. Pass it from a secret |
| `product-id` | yes | | Product ID: the GUID on the Extension overview page in Partner Center, not the extension ID in the store address |
| `zip` | yes | | Path to the extension ZIP, with `manifest.json` at its root |
| `publish` | no | `true` | `false` uploads into the draft only |
| `certification-notes` | no | | Notes for the certification testers, sent as a form field named `notes`. Best effort, see [Notes](#notes-for-the-certification-testers). Needs `publish: true` |
| `dry-run` | no | `false` | `true` checks the inputs and the ZIP, prints what would happen and sends nothing |

Every input is checked before the first request. The action refuses an API key that starts with `ApiKey ` (it adds the scheme itself), credentials that look like JSON or contain spaces or control characters, an API key equal to the client ID, a product ID that is not a GUID or is the 32-letter store ID, `certification-notes` with `publish: false`, a CRX passed as `zip`, a ZIP over 2 GiB, a ZIP64 archive, and a ZIP without a valid `manifest.json` version at its root.

## Outputs

| Output | Description |
| --- | --- |
| `result` | `submitted` (the submission is in certification; Microsoft publishes it once approved), `uploaded` (`publish` was `false`), `skipped` (Microsoft answered `NoModulesUpdated`) or `dry-run`. Empty when the run fails |
| `version` | The version read from `manifest.json` in the ZIP. Set before the first request, so a failed run has it too |
| `error-code` | The `errorCode` of a failed Microsoft operation, such as `InProgressSubmission` or `NoModulesUpdated`. Set also when the step fails. Empty otherwise |

There is no `state` output: the API has nothing to read back, and printing "In review" after `submitted` would claim a read that never happened.

## What it does

1. Masks the API key and the client ID, then checks every input and reads `manifest.json` from the ZIP, before any request.
2. On a dry run, prints what a real run would do and stops.
3. Uploads the ZIP into the product's draft. Microsoft answers with an operation ID in `Location`.
4. Checks the upload operation every 10 seconds, up to 60 times, until Microsoft reports `Succeeded` or `Failed`. A check that fails with a network error, a response cut off, or HTTP 429, 500, 502, 503 or 504 counts as one of the 60, and three such failures in a row end the run. HTTP 401, 403, 404 or 410 ends it at once.
5. With `publish: false`, stops with `result` set to `uploaded`.
6. Submits the draft for certification, with the notes when given.
7. Checks the publish operation the same way, and decides:

   | Microsoft reports | What the action does |
   | --- | --- |
   | `Succeeded` | Succeeds with `submitted`: the version is in certification, and Microsoft publishes it once approved |
   | `Failed`, `NoModulesUpdated` | Succeeds with `skipped` and a warning |
   | `Failed`, `InProgressSubmission` | Fails, naming the case where nothing is wrong |
   | `Failed`, `CreateNotAllowed` | Fails: publish the first version in Partner Center |
   | `Failed`, `UnpublishInProgress` | Fails: wait until the unpublish finishes, then decide in Partner Center |
   | `Failed`, `ModuleStateUnPublishable` | Fails, naming the sections of the submission to fix in Partner Center |
   | `Failed`, `SubmissionValidationError` | Fails, listing Microsoft's validation errors |
   | `Failed` without a code, or an answer without a status | Fails: re-run later, and report it to Microsoft with the operation ID if it repeats |

An upload operation that fails is reported the same way, with its code, Microsoft's message and a hint. A failed request is reported with the method, the path, the HTTP status and reason phrase, and Microsoft's message. A failed operation is reported with Microsoft's code and message, up to 20 lines of its `errors` list and the operation ID for a support request. Both carry a hint when the cause is known.

## How it compares

Checked on 26 September 2026 from the source of [wdzeng/edge-addon](https://github.com/wdzeng/edge-addon/blob/main/src/lib.ts) on `main` and of the npm package [publish-browser-extension](https://github.com/aklinker1/publish-browser-extension) 6.1.1.

| Tool | Credentials | Waits for the upload operation | Waits for the publish operation | Certification notes |
| --- | --- | --- | --- | --- |
| This action | API key and client ID | Yes, every 10 s, up to 60 checks | Yes, every 10 s, up to 60 checks | Form field `notes` |
| wdzeng/edge-addon | API key and client ID | Yes, every 10 s, up to 10 minutes | Yes, every 10 s, up to 10 minutes | The raw text as the request body |
| publish-browser-extension 6.1.1 | API key and client ID | Yes | No | Not sent: the body is `{}` as JSON |

## Trust and security

### Every request the action makes

`{base}` is `https://api.addons.microsoftedge.microsoft.com`. Every request carries `Authorization: ApiKey <api-key>` and `X-ClientID: <client-id>`. A dry run sends none.

| When | Request | Body | Timeout |
| --- | --- | --- | --- |
| Unless a dry run | `POST {base}/v1/products/{product-id}/submissions/draft/package` with `Content-Type: application/zip`, once | The ZIP, as read from disk | 600 s |
| While the upload is processing | `GET {base}/v1/products/{product-id}/submissions/draft/package/operations/{upload operation ID}`, first 10 s after the upload is accepted, then every 10 s, at most 60 times | None | 120 s each |
| After the upload succeeded, unless `publish` is `false` | `POST {base}/v1/products/{product-id}/submissions`, once | With `certification-notes`: `notes=<text>` as `application/x-www-form-urlencoded;charset=UTF-8`. Without: empty, with no `Content-Type` | 120 s |
| While the submission is being created | `GET {base}/v1/products/{product-id}/submissions/operations/{publish operation ID}`, on the same schedule | None | 120 s each |

A release makes at least 4 requests and at most 122. A POST is never repeated within a run, even after a timeout or a 5xx, because a lost answer can hide a request Microsoft accepted; re-running the job is the retry.

The host is fixed in the code. There is no input to change it, redirects are refused rather than followed, and the test settings described under [Development](#development) only accept loopback addresses. The operation ID in `Location` is accepted only as a bare GUID and used only as a path segment under the fixed host. `product-id` and every operation ID are checked as GUIDs before they are placed in a URL.

### What it does not do

- It does not print credentials. `api-key` and `client-id` are masked before the first log line. It derives no token, so there is nothing else to mask.
- It does not print the certification notes, only their length.
- It does not return credentials. The outputs are `result`, `version` and `error-code`, and `error-code` is written only when it is a plain word of letters and digits.
- It writes no file other than its step outputs, starts no process and sends no telemetry.
- It has no runtime dependencies. TypeScript and `@types/node` are development dependencies that type-check the code in CI; the runner never installs them.

### The code

| File | Lines | Role |
| --- | --- | --- |
| [`src/main.ts`](src/main.ts) | ~110 | Reads and checks inputs, masks the credentials, reads the ZIP, sets outputs |
| [`src/store.ts`](src/store.ts) | ~360 | The four requests, the polling, the decisions on Microsoft's answers and the hints |
| [`src/zip.ts`](src/zip.ts) | ~130 | Reads `manifest.json` from the ZIP, with checksum verification |
| [`src/runner.ts`](src/runner.ts) | ~50 | GitHub Actions inputs, outputs, masking and annotations |
| [`src/errors.ts`](src/errors.ts) | ~20 | The error type for failures shown as an error annotation, and network error wording |

`src/zip.ts`, `src/runner.ts` and `src/errors.ts` are copies of the files in the Chrome action.

### How it is checked

- Every pull request type-checks the code and runs the tests on Linux, Windows and macOS with a coverage floor of 95% of lines. The tests run the action's entry point against a mock of the Edge Add-ons API that answers the way Microsoft was seen answering, such as `403 Client ID is Invalid` with an empty body, and a separate job runs the action from `action.yml` in four scenarios: submitted, upload only, a review in progress, and a dry run. See [ci.yml](.github/workflows/ci.yml). The Linux run reports coverage to Codecov with a short-lived OIDC token.
- [OpenSSF Scorecard](.github/workflows/scorecard.yml) checks the repository's security practices on every push to `main` and weekly, and publishes the result.
- [CodeQL](.github/workflows/codeql.yml) scans the JavaScript and the workflows on every pull request, every push to `main` and weekly. Dependabot keeps the workflow actions current.
- Releases are immutable: once `v1.0.0` is published, its tag and contents cannot change. `v1` points at the newest `1.x` release. [The workflow that moves it](.github/workflows/major-tag.yml) always points `v1` at the highest `1.x.y` release, refuses one that is not immutable, and runs one release at a time. If your organization requires full commit SHAs, pin the commit of a release.

### Your side

- The API key and the client ID most likely publish to every extension of the Partner Center account. Keep them in an environment with a required reviewer and a tag rule, used only by the Edge job.
- Delete a leaked key on the Publish API page. Rotation and revocation are the same steps.
- Microsoft's certification is the last gate, and an approved submission goes live without a hold.

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## Limits

What this action does not do:

- It does not notice a competing writer. A package uploaded by someone else between this run's upload and its publish request is submitted under this run's name.
- It does not compare the version with the published one or tell which version is in review, because it has nothing to read them from.
- It has no publish-only mode: every run uploads its ZIP before it submits the draft.
- It does not repeat a POST within a run, and waits at most 60 checks, about 10 minutes, per operation.
- It refuses ZIP64 archives and ZIPs over 2 GiB, and gives the upload request 10 minutes to finish.

What Microsoft imposes on any publishing tool:

- Update only. The API cannot create a product or change its metadata, such as the description ([Using the API endpoints](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api?tabs=v1-1#using-the-api-endpoints)).
- No endpoint reads the product or review state without an operation ID ([microsoft/MicrosoftEdge-Extensions#696](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/696)), and none cancels a submission or unpublishes ([#531](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/531)).
- Certification of up to 7 business days, after which an approved version is published without a hold ([#292](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/292)). No skip-review path ([#718](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/718)) and no staged rollout.
- API keys expire after 72 days and are replaced only by hand in Partner Center ([#311](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/311), [#272](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/272)). No OIDC or trusted publisher route ([#272](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/272)).
- A certification notes format that Microsoft's own pages disagree on.
- HTTP 429 when throttled, with no published quota; the [reference](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/addons-api-reference?tabs=v1-1#error-codes) names no `Retry-After` header.

## Not verified yet

These points have no Microsoft source that settles them and have not been tried against a real product. The action handles each possible answer, and the messages say so where it matters.

- Whether the form field `notes` reaches the certification testers, and whether a publish request without a body is accepted.
- Whether Microsoft accepts an upload while a submission is in review, and which operation reports `InProgressSubmission` if it does not.
- Whether Microsoft refuses a version equal to or lower than the published one, and with which code.
- Whether uploading identical bytes counts as a change, which decides when `NoModulesUpdated` appears.
- What an expired key answers. The reference lists 401 for an expired token, and the 401 hint names the expiry.
- Whether the credentials cover every product of the account.
- Whether two API keys authenticate at the same time during rotation.
- How long the two operations take. The limit of 60 checks, 10 seconds apart, follows wdzeng/edge-addon's 10-minute cap.

## FAQ

### Can it publish a new extension?

No. Publish the first version in Partner Center. After that, this action can publish every update.

### Does it need a stored secret?

Yes, two: the API key and the client ID. Microsoft offers no other way to call the API.

### Why does my release fail after two months?

The API key expired: keys last 72 days. Create a new one and replace the secret, as in [Rotating the API key](#rotating-the-api-key).

### Why did a re-run fail with `InProgressSubmission`?

A submission for the product is already in review, possibly the one an earlier run of the same release created. The message says how to tell the two cases apart, and [Re-running a release](#re-running-a-release) shows how to keep that case green.

### Can I hold a version until I choose to publish it?

Only before certification: `publish: false` leaves it in the draft. Once submitted, Microsoft publishes it as soon as it is approved.

### Can I try it without publishing?

Yes. `dry-run: true` checks the inputs and the ZIP and sends nothing. `publish: false` goes one step further and uploads into the draft without submitting.

### Is it made by Microsoft?

No. It is an independent open source project and calls Microsoft's public API.

## Development

Node.js 24 or later:

```bash
npm ci
npm run typecheck
npm test
```

The tests run the action against a local mock of the Edge Add-ons API. `EDGE_API_BASE` points the action at that mock, and it refuses the setting unless it is a loopback `http` address. `EDGE_POLL_INTERVAL_MS` shortens the 10-second wait between checks for the tests, and works only together with `EDGE_API_BASE`.

## License

[MIT](LICENSE)
