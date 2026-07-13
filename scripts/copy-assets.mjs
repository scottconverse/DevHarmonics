import { cp, mkdir } from "node:fs/promises";

await mkdir(new URL("../dist/src/ui/", import.meta.url), { recursive: true });
await cp(new URL("../src/ui/", import.meta.url), new URL("../dist/src/ui/", import.meta.url), {
  recursive: true,
});
