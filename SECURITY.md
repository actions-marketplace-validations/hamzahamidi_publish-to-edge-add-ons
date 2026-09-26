# Security

Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/hamzahamidi/publish-to-edge-add-ons/security/advisories/new). Do not open a public issue for it.

Expect an acknowledgement within 7 days. A fix ships as a patch release of the latest major version, the major tag moves to it, and the advisory is published once the release is out.

The action sends credentials only to `api.addons.microsoftedge.microsoft.com` and refuses redirects to anywhere else. It masks the API key and the client ID before its first log line, derives no token, returns neither as an output and stores nothing. The README lists every request it makes.
