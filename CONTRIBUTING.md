# Contributing to DevHarmonics

DevHarmonics v0.6.1 is an early public project. Start with a GitHub Discussion for design proposals and use an issue for a bounded, reproducible defect.

## Local checks

```powershell
npm.cmd ci
npm.cmd run check
```

Keep provider authentication outside tests. The integration suite uses fake provider commands and temporary Git repositories; contributions must not require real subscription credentials or API keys.

Use focused commits, preserve safety boundaries, and update documentation and tests whenever observable behavior changes.

DevHarmonics is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it is provided under those same terms, per section 5 of the license.
