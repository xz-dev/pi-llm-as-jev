// Keep the tracked, copyable client outputs aligned with the canonical TypeScript.
import { copyFileSync } from "node:fs";
for (const extension of ["js", "d.ts"]) {
	const file = `judgment-client.${extension}`;
	copyFileSync(new URL(`../dist/client/${file}`, import.meta.url), new URL(`../client/${file}`, import.meta.url));
}
