import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { replaceExactlyOnce } from "../dist/src/ci-harness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledGuard = path.join(root, "dist", "src", "verification-integrity.js");
const sentinelTest = path.join(root, "dist", "test", "ci-harness.test.js");
const target = 'kind: "test-skipped"';
const mutant = 'kind: "test-skipped-mutant"';
const sentinelName = "mutation sentinel binds the skipped-test detector to its public finding kind";
const sentinelMessage = "MUTATION_SENTINEL: a skipped test must produce the public test-skipped finding";
const original = await readFile(compiledGuard, "utf8");
const mutated = replaceExactlyOnce(original, target, mutant);

function runSentinel() {
  return spawnSync(process.execPath, [`--test-name-pattern=${sentinelName}`, "--test", sentinelTest], {
    cwd: root,
    encoding: "utf8",
  });
}

let red;
try {
  await writeFile(compiledGuard, mutated, "utf8");
  const applied = await readFile(compiledGuard, "utf8");
  if (applied !== mutated || applied === original) throw new Error("Mutation was not applied exactly as prepared");
  console.log("Mutation applied exactly once to the compiled verification-integrity guard.");
  red = runSentinel();
} finally {
  await writeFile(compiledGuard, original, "utf8");
}

if (red.error) throw red.error;
const redOutput = `${red.stdout ?? ""}${red.stderr ?? ""}`;
console.log("Expected RED output:");
console.log(redOutput.trim());
if (red.status === 0) throw new Error("Mutation discipline failed: the sentinel test stayed green");
if (!redOutput.includes(sentinelMessage)) {
  throw new Error("Mutation discipline failed: the test went red for an unexpected reason");
}

const green = runSentinel();
if (green.error) throw green.error;
const greenOutput = `${green.stdout ?? ""}${green.stderr ?? ""}`;
console.log("Restored GREEN output:");
console.log(greenOutput.trim());
if (green.status !== 0) throw new Error("Mutation discipline failed: the restored guard did not return green");

console.log("Mutation discipline passed: asserted mutation → RED, restored guard → GREEN.");
