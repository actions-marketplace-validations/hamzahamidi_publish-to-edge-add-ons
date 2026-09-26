# Changelog

## 1.0.0 (unreleased)

First release.

- Publishes updates to an extension that already exists on Microsoft Edge Add-ons through the v1.1 API: uploads the ZIP into the product's draft, waits until Microsoft has processed it, submits the draft for certification and waits until Microsoft says whether the submission entered review.
- Takes the only credential the API accepts, an API key and a client ID from the Publish API page in Partner Center, and masks both before the first log line. Refuses a key that starts with `ApiKey `, values that look like JSON, values with a space, a control character or a character outside printable ASCII, and a product ID that is not a GUID or is the 32-letter store ID.
- `publish: false` uploads into the draft only. `certification-notes` sends notes for the testers as a form field named `notes`.
- `dry-run: true` checks the inputs and the ZIP and sends nothing to Microsoft.
- Outputs `result` (`submitted`, `uploaded`, `skipped` or `dry-run`), `version` and `error-code`, the `errorCode` of a failed Microsoft operation, written also when the step fails.
- `InProgressSubmission` fails the run with a message that names the case where nothing is wrong. `NoModulesUpdated` after a successful upload ends `skipped` with a warning. Every other documented code fails with its own hint.
- Never repeats a POST within a run. Status checks run every 10 seconds, up to 60 times per operation, and three transient failures in a row end the run.
- Error messages keep the HTTP reason phrase, which is the only detail of some Microsoft failures, such as `403 Client ID is Invalid` with an empty body.
- Accepts the operation ID in `Location` only as a bare GUID and never requests it as a URL. Refuses redirects, a `zip` path that is not a regular file, and ZIPs over 2 GiB.
- Written in TypeScript that Node 24 runs directly, with no bundle and no runtime dependencies.
