# Rolling back a DevHarmonics upgrade

Rollback plan for **v0.6.0 → v0.5.1**. The same pattern applies to any
downgrade: reinstall the older source, restore the matching pre-upgrade ledger
backup, and accept that ledger records created after the upgrade stay behind.

## What v0.6.0 changes that a rollback must account for

1. **Ledger schema 26 → 33.** Migrations are one-way, and an older build
   refuses to open a newer-schema ledger rather than corrupting it. Before the
   first migration of an upgrade applies, DevHarmonics writes a byte-consistent
   `VACUUM INTO` snapshot beside the ledger named
   `devharmonics.db.backup-v<from>-to-v<to>-<timestamp>-<id>.sqlite`
   (for this upgrade: `...backup-v26-to-v33-...`).
2. **Project configuration is unchanged** (config schema version 2). No config
   rollback is needed.
3. **External surfaces.** v0.6.0 can push branches, open pull requests, merge,
   and tag on GitHub — each only with a per-action owner approval. Those are
   completed, owner-approved facts on the forge; rolling back the software
   neither needs nor attempts to undo them.

## Procedure (v0.6.0 → v0.5.1)

1. Stop the DevHarmonics server (close its terminal or end the process).
2. Check out and build the older release:

   ```powershell
   git checkout v0.5.1
   npm.cmd ci
   npm.cmd run build
   ```

3. In each affected project, restore the pre-upgrade ledger snapshot. Keep the
   newer ledger under a different name instead of deleting it:

   ```powershell
   Set-Location C:\path\to\your\project\.devharmonics
   Rename-Item devharmonics.db devharmonics.db.v0.6.0-kept
   Copy-Item "devharmonics.db.backup-v26-to-v33-*.sqlite" devharmonics.db
   ```

4. Restart: `node dist/src/cli.js serve --project C:\path\to\your\project`.

## What is lost

Runs, receipts, deliveries, workflow revisions, and steering recorded **after**
the v0.6.0 upgrade exist only in the schema-33 ledger. The renamed
`devharmonics.db.v0.6.0-kept` file retains them for later inspection or for
re-upgrading. Branches, pull requests, and tags already delivered to GitHub are
unaffected and remain valid.

## Verify the rollback

- `node dist/src/cli.js doctor` reports providers normally.
- The dashboard opens and lists the pre-upgrade runs.
- `devharmonics --version` (or `node dist/src/cli.js --version`) reports 0.5.1.
