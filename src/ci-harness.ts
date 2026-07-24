import ts from "typescript";

export function countDeclaredNodeTests(source: string, fileName: string): number {
  const syntax = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const isDirectTest = ts.isIdentifier(expression) && expression.text === "test";
      const isQualifiedTest =
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "test" &&
        ["only", "skip", "todo"].includes(expression.name.text);
      if (isDirectTest || isQualifiedTest) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return count;
}

function seedToUint32(seed: string): number {
  let hash = 0x811c9dc5;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function nextRandom(state: number): [number, number] {
  const nextState = (state + 0x6d2b79f5) >>> 0;
  let value = nextState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return [nextState, ((value ^ (value >>> 14)) >>> 0) / 4294967296];
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const shuffled = [...items];
  let state = seedToUint32(seed);
  for (let index = shuffled.length - 1; index > 0; index--) {
    let random: number;
    [state, random] = nextRandom(state);
    const swapIndex = Math.floor(random * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

export function replaceExactlyOnce(source: string, target: string, replacement: string): string {
  if (!target) throw new Error("Mutation target must not be empty");
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(target, offset)) !== -1) {
    count++;
    offset += target.length;
  }
  if (count !== 1) throw new Error(`Mutation target must occur exactly once; found ${count}`);
  return source.replace(target, replacement);
}
