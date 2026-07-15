# Contributing to DevHarmonics

DevHarmonics v0.5.0 is an early public project. Start with a GitHub Discussion for design proposals and use an issue for a bounded, reproducible defect.

## Local checks

```powershell
npm.cmd ci
npm.cmd run check
```

Keep provider authentication outside tests. The integration suite uses fake provider commands and temporary Git repositories; contributions must not require real subscription credentials or API keys.

Use focused commits, preserve safety boundaries, and update documentation and tests whenever observable behavior changes.

No open-source license has been selected yet. Please do not assume public repository visibility grants reuse rights; license selection is a planned community discussion.
