# Security Policy

## Supported version

DevHarmonics is an early public preview. Security fixes currently target the latest tagged release, **v0.6.1**.

## Reporting a vulnerability

Do not open a public issue or Discussion for a suspected vulnerability, exposed credential, or provider authorization code.

Use GitHub's private vulnerability reporting for this repository when available. Include the affected version, reproduction steps, impact, and any suggested mitigation. Do not include live credentials; revoke them with the provider first.

## Security model

- DevHarmonics binds its dashboard to `127.0.0.1`.
- It never asks for provider passwords and relies on official CLI login sessions.
- Common model API-key and cloud-credential variables are removed from provider child-process environments.
- Model-selected checks are limited to validator names configured by the local user.
- Parallel changes are isolated in Git worktrees and are not merged into the user's checked-out branch automatically.

Run ledgers can contain prompts, repository paths, provider output, and validator logs. Protect `.devharmonics/` as potentially sensitive local data.
