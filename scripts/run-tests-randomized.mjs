import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seededShuffle } from "../dist/src/ci-harness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDirectory = path.join(root, "dist", "test");
const seedIndex = process.argv.findIndex((argument) => argument === "--seed");
const inlineSeed = process.argv.find((argument) => argument.startsWith("--seed="))?.slice("--seed=".length);
const seed = inlineSeed ?? (seedIndex >= 0 ? process.argv[seedIndex + 1] : undefined) ?? crypto.randomUUID();

if (!seed.trim()) throw new Error("The randomized test seed must not be empty");

const files = (await readdir(testDirectory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDirectory, name));

if (files.length === 0) throw new Error(`No compiled test files found in ${testDirectory}`);
if (new Set(files).size !== files.length) throw new Error("Compiled test-file census contains duplicates");

const ordered = seededShuffle(files, seed);
console.log(`Randomized test-file seed: ${seed}`);
console.log("Randomized test-file order:");
ordered.forEach((file, index) => console.log(`${index + 1}. ${path.relative(root, file)}`));

for (const file of ordered) {
  const result = spawnSync(process.execPath, ["--test", file], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Randomized test-file run passed: ${ordered.length}/${files.length} files executed exactly once.`);
