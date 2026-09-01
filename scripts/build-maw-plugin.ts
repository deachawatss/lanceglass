import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "maw-plugin");
const dist = join(source, "dist");
const project = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(source, "plugin.json"), "utf8"));

if (manifest.version !== project.version) {
  throw new Error(
    `version mismatch: package.json=${project.version}, maw-plugin/plugin.json=${manifest.version}`,
  );
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(source, "index.ts"), join(dist, "index.ts"));
writeFileSync(join(dist, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(dist, "project-root.txt"), root + "\n");

console.log(`built ${manifest.name}@${manifest.version} -> ${dist}`);
