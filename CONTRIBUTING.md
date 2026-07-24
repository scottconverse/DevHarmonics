# Contributing to DevHarmonics

DevHarmonics v0.6.1 is an early public project. Start with a GitHub Discussion for design proposals and use an issue for a bounded, reproducible defect.

## Local checks

```powershell
npm.cmd ci
npm.cmd run check
```

GitHub Actions runs `check` on Node 24 for Ubuntu and Windows. It also runs
the full compiled suite in a logged, seeded test-file order and mutation-proves
the verification-integrity sentinel. To reproduce those lanes locally:

```powershell
npm.cmd run test:randomized -- --seed local-reproduction
npm.cmd run test:mutation
```

Keep provider authentication outside tests. The integration suite uses fake provider commands and temporary Git repositories; contributions must not require real subscription credentials or API keys.

Use focused commits, preserve safety boundaries, and update documentation and tests whenever observable behavior changes.

DevHarmonics is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it is provided under those same terms, per section 5 of the license.
