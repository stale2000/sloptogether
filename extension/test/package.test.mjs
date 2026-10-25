import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("packages exactly the Twitch Extension assets with CDN-safe paths", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "sloptogether-extension-"));
  const output = path.join(directory, "extension.zip");
  try {
    const result = execFileSync("python3.12", [
      "extension/package.py", "--output", output,
    ], { encoding: "utf8" });
    assert.match(result, /Extension ZIP ready:/);
    assert.match(result, /\(\d+ bytes\)/);
    const files = JSON.parse(execFileSync("python3.12", ["-c", [
      "import json,zipfile,sys",
      "with zipfile.ZipFile(sys.argv[1]) as z:",
      " files={name:z.read(name).decode('utf-8') for name in ('panel.html','config.html','extension.css','panel.js','config.js','bits-state.mjs')}",
      " files['fontBytes']=len(z.read('figtree-latin.woff2'))",
      " print(json.dumps(files))",
    ].join("\n"), output], { encoding: "utf8" }));
    assert.match(files["panel.html"], /id="prompt-form"/);
    assert.match(files["panel.html"], /data-theme="dark"/);
    assert.match(files["config.html"], /twitch-ext\.min\.js/);
    assert.ok(files["config.html"].indexOf("twitch-ext.min.js")<files["config.html"].indexOf("config.js"));
    assert.match(files["extension.css"], /width: min\(100%, 318px\)/);
    assert.match(files["extension.css"], /font-family: Figtree/);
    assert.ok(files.fontBytes > 10_000);
    assert.match(files["panel.js"], /context\?\.theme === "light"/);
    assert.match(files["panel.js"], /fetch\(`\$\{API\}\/channels\/\$\{encodeURIComponent\(currentAuthorization\.channelId\)\}\/proposals`/);
    assert.match(files["panel.js"], /const requestEpoch = identityEpoch;[\s\S]*?if \(requestEpoch !== identityEpoch\) return;/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to overwrite a source asset", () => {
  const entry = "extension/public/panel.html";
  const before = readFileSync(entry);
  assert.throws(() => execFileSync("python3.12", [
    "extension/package.py", "--output", entry,
  ], { encoding: "utf8" }), error => error.status !== 0);
  assert.deepEqual(readFileSync(entry), before);
});
