import assert from "node:assert/strict";
import test from "node:test";
import { countDeclaredNodeTests, replaceExactlyOnce, seededShuffle } from "../src/ci-harness.js";
import { analyzeVerificationIntegrity } from "../src/verification-integrity.js";

test("seededShuffle is reproducible and does not mutate its input", () => {
  const input = ["core", "integration", "product", "reconciliation", "repository", "status"];

  const first = seededShuffle(input, "run-123");
  const second = seededShuffle(input, "run-123");

  assert.deepEqual(first, second);
  assert.deepEqual(input, ["core", "integration", "product", "reconciliation", "repository", "status"]);
  assert.deepEqual([...first].sort(), [...input].sort());
});

test("seededShuffle can produce different orders for different seeds", () => {
  const input = ["a", "b", "c", "d", "e", "f"];
  const permutations = new Set(
    ["one", "two", "three", "four", "five"].map((seed) => JSON.stringify(seededShuffle(input, seed))),
  );

  assert.ok(permutations.size > 1, "different seeds should not all collapse to one order");
});

test("replaceExactlyOnce applies one asserted mutation", () => {
  assert.equal(replaceExactlyOnce("before guard after", "guard", "mutant"), "before mutant after");
});

test("replaceExactlyOnce refuses missing or ambiguous mutation targets", () => {
  assert.throws(() => replaceExactlyOnce("no target", "guard", "mutant"), /exactly once.*found 0/i);
  assert.throws(() => replaceExactlyOnce("guard and guard", "guard", "mutant"), /exactly once.*found 2/i);
});

test("mutation sentinel binds the skipped-test detector to its public finding kind", () => {
  const result = analyzeVerificationIntegrity([
    {
      path: "test/example.test.ts",
      diff: "@@ -1 +1 @@\n-test(\"works\", () => {});\n+test.skip(\"works\", () => {});",
    },
  ]);

  assert.ok(
    result.findings.some((finding) => finding.kind === "test-skipped"),
    "MUTATION_SENTINEL: a skipped test must produce the public test-skipped finding",
  );
});

test("declared test census counts syntax, not line shape or comment/string phantoms", () => {
  const source = `
    import test from "node:test";
    test("top-level", () => {});
    if (process.platform === "win32") {
      test.skip("indented platform case", () => {});
    }
    test.todo("declared todo");
    // test("line-comment phantom", () => {});
    /* test("block-comment phantom", () => {}); */
    const example = "test('string phantom', () => {})";
    contest("unrelated identifier", () => {});
  `;

  assert.equal(countDeclaredNodeTests(source, "fixture.test.ts"), 3);
});
