import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;

const expectations = [
  ["src/product.ts", `VERSION = "${version}"`],
  ["README.md", `Current release: **v${version}**`],
  ["docs/USER_MANUAL.md", `Manual version: **${version}**`],
  ["docs/index.html", `data-product-version="${version}"`],
  ["src/ui/index.html", `v${version}`],
  ["CHANGELOG.md", `## [${version}]`],
];

const failures = [];
for (const [file, marker] of expectations) {
  const contents = await readFile(path.join(root, file), "utf8");
  if (!contents.includes(marker)) failures.push(`${file}: missing ${JSON.stringify(marker)}`);
}

if (failures.length) {
  console.error(`Version ${version} is inconsistent:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Version ${version} is consistent across ${expectations.length + 1} release surfaces.`);
}
