import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const project = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version?: string;
};
const plugin = JSON.parse(
  readFileSync(join(root, "maw-plugin", "plugin.json"), "utf8"),
) as { version?: string };
const calver = /^\d{2}\.\d{1,2}\.\d{1,3}(?:-(?:alpha|beta)\.(?:0|[1-9]\d{0,3}))?$/;

if (!project.version || !calver.test(project.version)) {
  throw new Error(`package.json version is not project CalVer: ${project.version ?? "missing"}`);
}
if (plugin.version !== project.version) {
  throw new Error(
    `version mismatch: package.json=${project.version}, maw-plugin/plugin.json=${plugin.version ?? "missing"}`,
  );
}

console.log(`Lanceglass v${project.version}`);
