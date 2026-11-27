# Security policy

## Supported versions

Only the latest release gets fixes. It is the `latest` tag of `@accodev/pullywog` on npm and the newest `pullywog--v*` tag on GitHub.

## Reporting a vulnerability

Report a vulnerability privately at https://github.com/accodev/pullywog/security/advisories/new. Do not open a public issue.

A vulnerability here is a way to make pullywog run a command, read a file or send data that the user did not ask for. Examples: a reply text that makes it run something other than `gh`, or a reference that sends a GitHub token to another host.

## Disclosure

- A first answer comes within 7 days.
- A fix for a confirmed vulnerability ships as a patch release within 30 days.
- The advisory is published with the fix. Public disclosure waits for the fix, or for 90 days after the report, whichever comes first.
