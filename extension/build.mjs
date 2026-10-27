import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(extensionRoot, "..");
const outputDirectory = path.join(repositoryRoot, "apps", "web", "public", "extension");
const publicAssets = ["panel.html", "config.html", "extension.css", "figtree-latin.woff2"];
const sourceScripts = ["panel.js", "config.js", "bits-state.mjs"];
const surfaceViews = [
  ["mobile.html", "mobile", "mobile panel"],
  ["video_component.html", "video-component", "video component"],
  ["video_overlay.html", "video-overlay", "video overlay"],
];

function renderSurfaceView(panelHtml, surface, title) {
  return panelHtml
    .replace('data-theme="dark"', `data-theme="dark" data-surface="${surface}"`)
    .replace("<title>SlopTogether scene vote</title>", `<title>SlopTogether ${title}</title>`);
}

export function extensionAssets() {
  const files = {};
  for (const [directory, names] of [["public", publicAssets], ["src", sourceScripts]]) {
    for (const name of names) {
      const file = path.join(extensionRoot, directory, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`extension_asset_invalid:${name}`);
      files[name] = readFileSync(file);
    }
  }
  const panelHtml = files["panel.html"].toString("utf8");
  for (const [name, surface, title] of surfaceViews) {
    files[name] = Buffer.from(renderSurfaceView(panelHtml, surface, title));
  }
  return files;
}

export function syncExtensionAssets(destination = outputDirectory) {
  const files = extensionAssets();
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  for (const [name, contents] of Object.entries(files)) writeFileSync(path.join(destination, name), contents);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--package-json") {
    const files = extensionAssets();
    console.log(JSON.stringify({
      files: Object.fromEntries(Object.entries(files).map(([name, contents]) => [name, contents.toString("base64")])),
      viewerPages: ["panel.html", ...surfaceViews.map(([name]) => name)],
    }));
  } else {
    console.log(`Twitch Extension assets synced to ${syncExtensionAssets()}`);
  }
}
