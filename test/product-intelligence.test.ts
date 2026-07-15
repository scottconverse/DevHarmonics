import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Ledger } from "../src/ledger.js";
import { scanProductIntelligence } from "../src/product-intelligence.js";
import { runProcess } from "../src/process.js";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess({ command: "git", args, cwd, timeoutMs: 30_000 });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function createRepository(directory: string, files: Record<string, string>): Promise<string> {
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  await git(directory, ["add", "."]);
  await git(directory, ["-c", "user.name=DevHarmonics Tests", "-c", "user.email=devharmonics-tests@local", "commit", "-m", "fixture"]);
  return git(directory, ["rev-parse", "HEAD"]);
}

test("creates a source-backed product intelligence snapshot without inferring maturity from tags", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "devharmonics-product-intelligence-"));
  const umbrellaPath = path.join(root, "umbrella");
  const modulePath = path.join(root, "module");
  const umbrellaHead = await createRepository(umbrellaPath, {
    "STATUS.md": "# Product status\n\nFixture version: 1.1.0\nStatus: public beta\nMaturity: release candidate\n",
    "README.md": "# Fixture suite\n",
  });
  const moduleHead = await createRepository(modulePath, {
    "package.json": `${JSON.stringify({ name: "fixture", version: "1.2.0" }, null, 2)}\n`,
    "README.md": "# Fixture module\n",
  });
  await git(modulePath, ["tag", "v9.9.9"]);
  const ledger = new Ledger(path.join(root, "ledger.sqlite"));
  try {
    ledger.upsertProduct({
      id: "fixture",
      name: "Fixture",
      organizationUrl: "https://github.com/example",
      description: "Fixture product",
      repositories: [],
    });
    const repository = (id: string, name: string, localPath: string, role: "umbrella" | "module", governanceSources: string[]) => ledger.upsertRepository({
      id,
      productId: "fixture",
      name,
      fullName: `example/${name}`,
      url: `https://github.com/example/${name}`,
      cloneUrl: `https://github.com/example/${name}.git`,
      defaultBranch: "main",
      visibility: "public",
      archived: false,
      sizeKb: 1,
      language: null,
      description: null,
      intelligence: {},
      localPath,
      role,
      expectedBranch: "main",
      owners: [],
      dependencyRepositoryIds: role === "module" ? ["repo:umbrella"] : [],
      validators: {},
      governanceSources,
      governanceRules: [],
    });
    repository("repo:detached", "detached", path.join(root, "no-longer-present"), "module", ["README.md"]);
    repository("repo:umbrella", "umbrella", umbrellaPath, "umbrella", ["STATUS.md", "README.md", "MISSING.md"]);
    repository("repo:module", "module", modulePath, "module", ["package.json", "README.md"]);

    const beforeUmbrella = await git(umbrellaPath, ["status", "--porcelain=v1"]);
    const beforeModule = await git(modulePath, ["status", "--porcelain=v1"]);
    const snapshot = await scanProductIntelligence(ledger.getProduct("fixture")!);

    assert.deepEqual(snapshot.repositories.map((item) => [item.repositoryId, item.headSha]), [
      ["repo:detached", null],
      ["repo:module", moduleHead],
      ["repo:umbrella", umbrellaHead],
    ]);
    assert.equal(snapshot.sources.filter((source) => source.status === "read").length, 4);
    assert.ok(snapshot.sources.filter((source) => source.status === "read").every((source) => /^[a-f0-9]{64}$/.test(source.contentSha256 ?? "")));
    assert.ok(snapshot.findings.some((finding) => finding.kind === "missing_source" && finding.sourcePath === "MISSING.md"));
    assert.ok(snapshot.findings.some((finding) => finding.kind === "unreadable_source" && finding.repositoryId === "repo:detached"));
    const conflict = snapshot.findings.find((finding) => finding.kind === "conflicting_claim" && finding.claimKind === "version");
    assert.ok(conflict);
    assert.deepEqual(new Set(conflict.values), new Set(["1.1.0", "1.2.0"]));
    assert.ok(conflict.citations.some((citation) => citation.endsWith("STATUS.md:3")));
    assert.ok(conflict.citations.some((citation) => citation.endsWith("package.json:3")));
    assert.equal(snapshot.repositories.find((item) => item.repositoryId === "repo:module")?.maturity, "unknown");
    assert.ok(!snapshot.claims.some((claim) => claim.value === "v9.9.9"), "Git tags must not become product claims");

    const saved = ledger.recordProductIntelligenceSnapshot(snapshot);
    assert.equal(ledger.latestProductIntelligenceSnapshot("fixture")?.id, saved.id);
    assert.equal(await git(umbrellaPath, ["status", "--porcelain=v1"]), beforeUmbrella);
    assert.equal(await git(modulePath, ["status", "--porcelain=v1"]), beforeModule);
  } finally {
    ledger.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
