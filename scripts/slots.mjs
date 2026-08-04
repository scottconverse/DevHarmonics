import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * Ported from codex-factory scripts/factory-slots.mjs (same owner, Apache-2.0,
 * live-fire-tested 2026-08). File-lock worker slots + generic exclusive file
 * locks, unchanged in behavior: a lock is a file whose mere EXISTENCE is the
 * claim (`wx` — fails if the file already exists), so two processes racing
 * for the same slot can never both win. The dead-PID-reclaim rule is kept
 * intact — a lock is only ever reclaimed after `process.kill(pid, 0)` proves
 * the owning PID is actually gone (ESRCH), never on a timeout or a guess.
 */

function claim(pathname, metadata) {
  let descriptor;
  try {
    descriptor = openSync(pathname, "wx");
    writeFileSync(descriptor, `${JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...metadata,
    })}\n`);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      rmSync(pathname, { force: true });
    }
    throw error;
  }
  closeSync(descriptor);
  let owned = true;
  return {
    path: pathname,
    quarantine(metadata = {}) {
      if (!owned) return;
      writeFileSync(pathname, `${JSON.stringify({ pid: process.pid, quarantined: true, quarantinedAt: new Date().toISOString(), ...metadata })}\n`);
    },
    release() {
      if (!owned) return;
      owned = false;
      rmSync(pathname, { force: true });
    },
  };
}

function reclaimDeadClaim(pathname) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(pathname, "utf8"));
  } catch {
    return false;
  }
  const ownedPid = owner.quarantined === true ? owner.childPid : owner.pid;
  if (!Number.isSafeInteger(ownedPid) || ownedPid < 1) return false;
  try {
    process.kill(ownedPid, 0);
    return false;
  } catch (error) {
    if (error.code !== "ESRCH") return false;
  }
  rmSync(pathname, { force: true });
  return true;
}

/**
 * Whether an `openSync(path, "wx")` failure means "someone else already holds
 * this lock" rather than a real I/O error. Windows adds a wrinkle: a file
 * mid-delete (unlinked but not yet gone from the directory entry) reports
 * EPERM, not EEXIST, and `existsSync` can even say the path is absent while
 * the open call still refuses it — `boundedFileLock` callers (which retry
 * inside a deadline anyway) treat a bare EPERM as contention rather than a
 * hard failure.
 */
export function isContendedClaim(
  error,
  pathname,
  platform = process.platform,
  { boundedFileLock = false } = {},
) {
  return error.code === "EEXIST"
    || (platform === "win32" && error.code === "EPERM" && (boundedFileLock || existsSync(pathname)));
}

/**
 * Claim one of `maximum` (1-4) campaign-wide worker slots under `stateRoot`.
 * Slots are plain files named `1.lock` .. `N.lock`; the first unclaimed (or
 * reclaimably-dead) one wins. Throws when every slot is genuinely occupied by
 * a live process — callers back off and retry rather than oversubscribing.
 */
export function acquireWorkerSlot(stateRoot, maximum, metadata = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4) {
    throw new Error("Worker slot maximum must be between 1 and 4");
  }
  const slotRoot = path.resolve(stateRoot, "worker-slots");
  mkdirSync(slotRoot, { recursive: true });
  for (let index = 1; index <= maximum; index += 1) {
    try {
      return claim(path.join(slotRoot, `${index}.lock`), { slot: index, ...metadata });
    } catch (error) {
      if (!isContendedClaim(error, path.join(slotRoot, `${index}.lock`))) throw error;
      if (reclaimDeadClaim(path.join(slotRoot, `${index}.lock`))) {
        return claim(path.join(slotRoot, `${index}.lock`), { slot: index, ...metadata });
      }
    }
  }
  throw new Error(`All ${maximum} worker slots are occupied`);
}

/**
 * Claim one arbitrary exclusive file lock (e.g. a usage ledger's `.lock`
 * sibling), retrying with backoff until `timeoutMs` rather than racing
 * concurrent reservations against the same append-only file.
 */
export async function acquireFileLock(pathname, metadata = {}, { timeoutMs = 5_000, retryMs = 25 } = {}) {
  const resolved = path.resolve(pathname);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return claim(resolved, metadata);
    } catch (error) {
      if (!isContendedClaim(error, resolved, process.platform, { boundedFileLock: true })) throw error;
      if (reclaimDeadClaim(resolved)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock ${resolved}`);
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}
