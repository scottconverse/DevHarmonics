import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/src/ui/", import.meta.url), { recursive: true });
await cp(new URL("../src/ui/", import.meta.url), new URL("../dist/src/ui/", import.meta.url), {
  recursive: true,
});
// DH810-R3-001: the shipped workflows-of-record are runtime assets. Copying
// them beside the compiled sources lets the server resolve "../workflows/"
// identically in source (src/ -> repo root) and compiled (dist/src/ -> dist/)
// layouts, so `npm run dev` and the built product seed the same fixtures.
await cp(new URL("../workflows/", import.meta.url), new URL("../dist/workflows/", import.meta.url), {
  recursive: true,
});
