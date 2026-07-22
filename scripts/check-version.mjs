import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const version = packageJson.version;

const expectations = [
  ["src/product.ts", `VERSION = "${version}"`],
  ["README.md", `Current release: **v${version}**`],
  ["docs/USER_MANUAL.md", `Manual version: **${version}**`],
  ["docs/USER_MANUAL.md", `Product release: **v${version}**`],
  ["docs/index.html", `data-product-version="${version}"`],
  ["docs/index.html", `href="USER_MANUAL.html">Manual`],
  ["docs/index.html", `href="USER_MANUAL.html">Read the user manual`],
  ["docs/USER_MANUAL.md", `](https://github.com/scottconverse/DevHarmonics/blob/main/SECURITY.md)`],
  ["src/ui/index.html", `v${version}`],
  ["src/ui/index.html", `/app.css?v=${version}`],
  ["src/ui/index.html", `/app.js?v=${version}`],
  ["CHANGELOG.md", `## [${version}]`],
  ["docs/ARCHITECTURE.md", `Architecture version: **${version}**`],
  ["docs/PRODUCT_SPEC.md", `Current implementation baseline: **DevHarmonics v${version}**`],
  ["docs/IMPLEMENTATION_PLAN.md", `Current implementation baseline: **DevHarmonics v${version}**`],
  ["CONTRIBUTING.md", `DevHarmonics v${version} is an early public project.`],
  ["SECURITY.md", `latest tagged release, **v${version}**`],
  ["README.md", `[Contributing](CONTRIBUTING.md)`],
  // Release-truth guards added at the v0.6.0 gate: the rollback recipe's
  // from-schema pair and the README suite count drifted unnoticed because
  // this gate did not reach them. The pair below must be updated together
  // with any release that changes the prior tag or the ledger schema.
  ["docs/ROLLBACK.md", `backup-v26-to-v33`],
  ["docs/ROLLBACK.md", `Ledger schema 26 → 33`],
  // Release-truth guard added at the v0.6.1 gate (R4-001): the 0.6-line
  // "v0.6.1 -> v0.6.0" rollback section went stale the same way the v0.5.1
  // one did, claiming a no-restore downgrade across an actual 34->33 schema
  // change. This pair must be updated together with any release that moves
  // LEDGER_SCHEMA_VERSION or renames the prior-tag rollback target.
  ["docs/ROLLBACK.md", `backup-v33-to-v34`],
  ["docs/ROLLBACK.md", `Ledger schema 33 → 34`],
  // The test count below must be bumped by hand whenever the suite size
  // changes (README.md:397) — this string match is not truth-sourced from
  // the actual `npm test` output, only kept in sync manually. See R4-003.
  ["README.md", `191 tests across`],
];

const failures = [];
let checks = 1;
for (const [file, marker] of expectations) {
  const contents = await readFile(path.join(root, file), "utf8");
  if (!contents.includes(marker)) failures.push(`${file}: missing ${JSON.stringify(marker)}`);
  checks += 1;
}

const lockVersion = packageLock.packages?.[""]?.version;
if (packageLock.version !== version || lockVersion !== version) {
  failures.push(`package-lock.json: expected root and package versions to both equal ${version}`);
}
checks += 1;

if (packageLock.packages?.[""]?.license !== packageJson.license) {
  failures.push(`package-lock.json: root package license must match package.json (${packageJson.license})`);
}
checks += 1;

const productSpec = await readFile(path.join(root, "docs/PRODUCT_SPEC.md"), "utf8");
const implementationPlan = await readFile(path.join(root, "docs/IMPLEMENTATION_PLAN.md"), "utf8");
const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
const specificationVersion = productSpec.match(/Specification version: \*\*([^*]+)\*\*/)?.[1];
if (!specificationVersion) {
  failures.push("docs/PRODUCT_SPEC.md: missing canonical specification version");
} else if (!implementationPlan.includes(`Product specification baseline: **DevHarmonics Product Specification v${specificationVersion}**`)) {
  failures.push(`docs/IMPLEMENTATION_PLAN.md: product specification baseline must be v${specificationVersion}`);
}
checks += 1;

if (!changelog.includes(`[${version}]: https://github.com/scottconverse/DevHarmonics/releases/tag/v${version}`)) {
  failures.push(`CHANGELOG.md: missing release link for v${version}`);
}
const unreleasedIndex = changelog.indexOf("## [Unreleased]");
const releaseIndex = changelog.indexOf(`## [${version}]`);
if (unreleasedIndex < 0 || releaseIndex < 0 || unreleasedIndex > releaseIndex) {
  failures.push(`CHANGELOG.md: Unreleased must precede the v${version} release section`);
}
checks += 1;

const expectedRepository = "git+https://github.com/scottconverse/DevHarmonics.git";
if (
  packageJson.private !== true ||
  packageJson.license !== "Apache-2.0" ||
  packageJson.repository?.url !== expectedRepository ||
  packageJson.homepage !== "https://scottconverse.github.io/DevHarmonics/" ||
  packageJson.bugs?.url !== "https://github.com/scottconverse/DevHarmonics/issues"
) {
  failures.push("package.json: public repository coordinates or Apache-2.0 licensing metadata are inconsistent");
}
checks += 1;

if (!existsSync(path.join(root, "LICENSE"))) {
  failures.push("LICENSE: the Apache-2.0 license file is missing");
}
checks += 1;

if (process.argv.includes("--release")) {
  try {
    const tag = execFileSync("git", ["describe", "--tags", "--exact-match", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    if (tag !== `v${version}`) failures.push(`Git: expected exact release tag v${version}, found ${tag || "none"}`);
  } catch {
    failures.push(`Git: HEAD is not tagged v${version}`);
  }
  checks += 1;
}

if (failures.length) {
  console.error(`Version ${version} is inconsistent:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Version ${version} is consistent across ${checks} release surfaces.`);
}
