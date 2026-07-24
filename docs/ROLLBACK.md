# Rolling back a DevHarmonics upgrade

Both downgrades below are schema-crossing. Migrations are one-way: an older
build refuses to open a ledger whose `user_version` is newer than it
supports, so every rollback needs the matching pre-upgrade ledger backup, not
just an older checkout. The same general pattern applies to any downgrade:
reinstall the older source, restore the matching pre-upgrade ledger backup,
and accept that ledger records created after the upgrade stay behind.

## Development-line rollback: ledger schema 37 → v0.6.1

The unreleased development line after v0.6.1 advances the ledger through
three ordered migrations:

1. **Ledger schema 34 → 35** adds the `runs_status` index used by the
   approval Inbox projection.
2. **Ledger schema 35 → 36** adds append-only decision records.
3. **Ledger schema 36 → 37** adds decision provenance, uniqueness indexes,
   and database triggers that prevent decision-record updates and deletes.

Backups describe the schema the database actually started at and the maximum
schema supported by the build that opened it. Therefore, opening a schema-34
v0.6.1 ledger directly with the current schema-37 build creates one snapshot
named
`devharmonics.db.backup-v34-to-v37-<timestamp>-<id>.sqlite`. It does **not**
create separate v34-to-v35, v35-to-v36, and v36-to-v37 files while applying
the three migrations in one transaction. Those pairwise names exist only
when an intermediate development build whose maximum schema was 35 or 36
performed that upgrade.

To return from the schema-37 development line to v0.6.1:

1. Stop DevHarmonics.
2. Keep the schema-37 ledger by renaming it; do not delete it.
3. Restore the matching
   `devharmonics.db.backup-v34-to-v37-*.sqlite` snapshot as
   `devharmonics.db`.
4. Check out v0.6.1, run `npm.cmd ci` and `npm.cmd run build`, then restart
   DevHarmonics.

The restored ledger contains none of the Inbox-index, decision-record, or
decision-provenance changes made after the schema-34 snapshot. The renamed
schema-37 ledger retains that later data for re-upgrade or inspection.

## Rollback plan for v0.6.1 → v0.6.0

v0.6.1 applies migration 34 and runs ledger schema 34; v0.6.0 only
understands schema 33 and explicitly refuses to start against a newer
`user_version`. Opening an existing project's ledger with v0.6.1 upgrades it
from 33 to 34, so simply checking out v0.6.0 afterward makes it refuse to
start — this is **not** a no-restore downgrade.

Before the first migration of that 33→34 upgrade runs, DevHarmonics writes a
byte-consistent `VACUUM INTO` snapshot beside the ledger named
`devharmonics.db.backup-v33-to-v34-<timestamp>-<id>.sqlite`.

### What v0.6.1 changes that a rollback must account for

1. **Ledger schema 33 → 34.** Same one-way migration guard as every other
   schema bump; the pre-migration backup is named
   `devharmonics.db.backup-v33-to-v34-<timestamp>-<id>.sqlite`.
2. **Project configuration is unchanged** (config schema version 2). No
   config rollback is needed.
3. **External surfaces.** Same push/PR/merge/tag approval model as v0.6.0.
   Completed, owner-approved facts on GitHub are unaffected by a local
   software rollback.

### Procedure (v0.6.1 → v0.6.0)

1. Stop the DevHarmonics server (close its terminal or end the process).
2. Check out and build the older release:

   ```powershell
   git checkout v0.6.0
   npm.cmd ci
   npm.cmd run build
   ```

3. In each affected project, restore the pre-upgrade ledger snapshot. Keep
   the newer ledger under a different name instead of deleting it:

   ```powershell
   Set-Location C:\path\to\your\project\.devharmonics
   Rename-Item devharmonics.db devharmonics.db.v0.6.1-kept
   Copy-Item "devharmonics.db.backup-v33-to-v34-*.sqlite" devharmonics.db
   ```

4. Restart: `node dist/src/cli.js serve --project C:\path\to\your\project`.

### What is lost

Runs, receipts, deliveries, workflow revisions, and steering recorded
**after** the v0.6.1 upgrade exist only in the schema-34 ledger. The renamed
`devharmonics.db.v0.6.1-kept` file retains them for later inspection or for
re-upgrading. Branches, pull requests, and tags already delivered to GitHub
are unaffected and remain valid.

### Verify the rollback

- `node dist/src/cli.js doctor` reports providers normally.
- The dashboard opens and lists the pre-upgrade runs.
- `devharmonics --version` (or `node dist/src/cli.js --version`) reports
  0.6.0.

## Rollback plan for v0.6.0 → v0.5.1

The same pattern applies: reinstall the older source, restore the matching
pre-upgrade ledger backup, and accept that ledger records created after the
upgrade stay behind.

### What v0.6.0 changes that a rollback must account for

1. **Ledger schema 26 → 33.** Before the first migration of an upgrade
   applies, DevHarmonics writes a byte-consistent `VACUUM INTO` snapshot
   beside the ledger named
   `devharmonics.db.backup-v<from>-to-v<to>-<timestamp>-<id>.sqlite`
   (for this upgrade: `...backup-v26-to-v33-...`).
2. **Project configuration is unchanged** (config schema version 2). No config
   rollback is needed.
3. **External surfaces.** v0.6.0 can push branches, open pull requests, merge,
   and tag on GitHub — each only with a per-action owner approval. Those are
   completed, owner-approved facts on the forge; rolling back the software
   neither needs nor attempts to undo them.

### Procedure (v0.6.0 → v0.5.1)

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

### What is lost

Runs, receipts, deliveries, workflow revisions, and steering recorded **after**
the v0.6.0 upgrade exist only in the schema-33 ledger. The renamed
`devharmonics.db.v0.6.0-kept` file retains them for later inspection or for
re-upgrading. Branches, pull requests, and tags already delivered to GitHub are
unaffected and remain valid.

### Verify the rollback

- `node dist/src/cli.js doctor` reports providers normally.
- The dashboard opens and lists the pre-upgrade runs.
- `devharmonics --version` (or `node dist/src/cli.js --version`) reports 0.5.1.
