#!/usr/bin/env node
/**
 * 构建 = 纯拷贝。源码即产物，这里不转译、不打包、不引入依赖。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));

const copies = [
	["src/index.js", "lib/index.js"],
	["src/client/index.js", "lib/client.js"]
];

for (const [from, to] of copies) {
	mkdirSync(dirname(join(root, to)), { recursive: true });
	copyFileSync(join(root, from), join(root, to));
	console.log("copy " + from + " -> " + to);
}
