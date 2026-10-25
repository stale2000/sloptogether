import { copyFileSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(extensionRoot, "..");
const outputDirectory = path.join(repositoryRoot, "apps", "web", "public", "extension");
const publicAssets = ["panel.html", "config.html", "extension.css", "figtree-latin.woff2"];
const sourceScripts = ["panel.js", "config.js", "bits-state.mjs"];

export function syncExtensionAssets() {
  const sourceFiles = [
    ...publicAssets.map(name => path.join(extensionRoot, "public", name)),
    ...sourceScripts.map(name => path.join(extensionRoot, "src", name)),
  ];
  for (const file of sourceFiles) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`extension_asset_invalid:${path.basename(file)}`);
  }

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const name of publicAssets) copyFileSync(path.join(extensionRoot, "public", name), path.join(outputDirectory, name));
  for (const name of sourceScripts) copyFileSync(path.join(extensionRoot, "src", name), path.join(outputDirectory, name));
  return outputDirectory;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Twitch Extension assets synced to ${syncExtensionAssets()}`);
}
