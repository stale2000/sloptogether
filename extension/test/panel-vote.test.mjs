import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

function packagedPanelSource() {
  const directory = mkdtempSync(path.join(tmpdir(), "sloptogether-panel-test-"));
  const output = path.join(directory, "extension.zip");
  try {
    execFileSync("python3.12", ["extension/package.py", "--output", output]);
    return execFileSync("python3.12", ["-c", "import sys,zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read('panel.js'))", output], { encoding: "utf8" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const panelSource = packagedPanelSource();

class Element {
  constructor() { this.hidden = false; this.disabled = false; this.value = ""; this.textContent = ""; this.dataset = {}; this.children = []; this.handlers = {}; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  setAttribute(name, value) { this[name] = value; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  querySelectorAll(selector) { return selector === ".choice" ? this.children.filter(child => child.className === "choice") : []; }
  focus() {}
  click() { this.handlers.click?.(); }
}

function panelHarness({ proposalResponse = { ok:true, json:async()=>({state:"eligible"}) }, streams = [{ slug:"main", displayName:"Main stream", isDefault:true }], streamsByToken = null } = {}) {
  const elements = new Map();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  let onAuthorized;
  let onVisibilityChanged;
  let bitsCatalogReads = 0;
  const calls = [];
  const ext = {
    viewer: { isLinked: true, id: "viewer-one" },
    features: { isBitsEnabled: true },
    bits: { getProducts() { bitsCatalogReads++; return Promise.resolve([{ sku:"turbo", cost:{type:"bits",amount:"100"}, inDevelopment:false }]); }, onTransactionComplete() {}, onTransactionCancelled() {} },
    onAuthorized(callback) { onAuthorized = callback; },
    onContext() {},
    onVisibilityChanged(callback) { onVisibilityChanged = callback; },
  };
  let ballotSignal;
  let completeBallot;
  const election = { id: "election-one", state: "open", choices: [{ id: "choice-one", title: "A scene", voteCount: 0 }] };
  const otherElection = { id: "election-late", state: "open", choices: [{ id: "choice-late", title: "A late scene", voteCount: 0 }] };
  const fetch = (url, options = {}) => {
    calls.push({ url, options });
    if (url.startsWith("https://www.clips.gg/sloptogether/api/v1/extension/state?stream=")) {
      const stream = new URL(url).searchParams.get("stream");
      const availableStreams=streamsByToken?.[options.headers?.["x-extension-jwt"]]??streams;
      if(!availableStreams.some(item=>item.slug===stream))return Promise.resolve({ok:false,json:async()=>({message:"Stream not found."})});
      return Promise.resolve({ ok: true, json: async () => ({
        channel: { twitchLogin: options.headers?.["x-extension-jwt"]==="two"?"other-channel":"channel" }, streams:availableStreams,
        activeElection: stream === "late-night" ? otherElection : election, canSubmitPrompts: true,
      }) });
    }
    if (/\/proposals$/.test(url)) return Promise.resolve(proposalResponse);
    if (url.endsWith("/ballots")) {
      ballotSignal = options.signal;
      return new Promise((resolve, reject) => {
        completeBallot = () => resolve({ ok: true, json: async () => ({}) });
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const window = {
    Twitch: { ext },
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener() {},
    sessionStorage: { getItem: () => null, removeItem() {} },
  };
  const source = panelSource
    .replace('import { bitsOutcome, isLateReceiptGracePending } from "./bits-state.mjs";', 'const bitsOutcome = () => ({}); const isLateReceiptGracePending = () => false;');
  vm.runInNewContext(source, { window, document: { getElementById, createElement: () => new Element(), documentElement: { dataset: {} } }, fetch, AbortController, Date, Number, Boolean, String, Array, Math, Error, encodeURIComponent });
  return { elements, ext, calls, get bitsCatalogReads() { return bitsCatalogReads; }, authorize: auth => onAuthorized(auth), show: () => onVisibilityChanged(true), get ballotSignal() { return ballotSignal; }, completeBallot: () => completeBallot() };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

async function startVote(panel) {
  panel.authorize({ channelId: "channel", userId: "viewer-one", token: "one" });
  await settle();
  panel.elements.get("choices").children[0].click();
  panel.elements.get("submit-vote").click();
  await settle();
  assert.ok(panel.ballotSignal, "ballot request was submitted");
}

test("a polling refresh does not cancel an in-flight ballot", async () => {
  const panel = panelHarness();
  await startVote(panel);
  const signal = panel.ballotSignal;
  panel.show();
  await settle();
  assert.equal(signal.aborted, false);
  panel.completeBallot();
  await settle();
  assert.equal(panel.elements.get("error").hidden, true);
});

test("changing identity cancels the old ballot without showing its error to the new viewer", async () => {
  const panel = panelHarness();
  await startVote(panel);
  const signal = panel.ballotSignal;
  panel.ext.viewer.id = "viewer-two";
  panel.authorize({ channelId: "channel", userId: "viewer-two", token: "two" });
  await settle();
  assert.equal(signal.aborted, true);
  assert.equal(panel.elements.get("error").hidden, true);
});

test("a free Extension prompt submits to the channel proposal API while paid Turbo stays hidden", async () => {
  const panel = panelHarness();
  panel.authorize({ channelId:"channel", userId:"viewer-one", token:"one" });
  await settle();
  assert.equal(panel.elements.get("turbo").hidden, true);
  assert.equal(panel.bitsCatalogReads, 0);
  assert.equal(panel.calls.some(call => call.url.endsWith("/extension/bits/state")), false);

  panel.elements.get("prompt-toggle").click();
  panel.elements.get("prompt-input").value = "A cartoon rocket bursts into confetti";
  panel.elements.get("prompt-input").handlers.input();
  panel.elements.get("submit-prompt").click();
  await settle();
  const request = panel.calls.find(call => call.url.endsWith("/channels/channel/streams/main/proposals"));
  assert.ok(request, "the Extension submits through the regular proposal API");
  assert.deepEqual(JSON.parse(request.options.body), { prompt:"A cartoon rocket bursts into confetti", planningMode:"continuation" });
  assert.equal(request.options.headers["x-extension-jwt"], "one");
  assert.equal(panel.elements.get("turbo").hidden, true);
});

test("a prompt rejection stays visible through the next successful poll", async () => {
  const panel = panelHarness({ proposalResponse:{ ok:false, json:async()=>({ error:"open_segment_required", message:"There is no unlocked future segment available." }) } });
  panel.authorize({ channelId:"channel", userId:"viewer-one", token:"one" });
  await settle();
  panel.elements.get("prompt-toggle").click();
  panel.elements.get("prompt-input").value = "A cartoon rocket bursts into confetti";
  panel.elements.get("prompt-input").handlers.input();
  panel.elements.get("submit-prompt").click();
  await settle();
  assert.equal(panel.elements.get("error").textContent,"There is no unlocked future segment available.");
  assert.equal(panel.elements.get("error").hidden,false);
  panel.show();
  await settle();
  assert.equal(panel.elements.get("error").textContent,"There is no unlocked future segment available.");
  assert.equal(panel.elements.get("error").hidden,false);
});

test("switching streams loads and submits to that stream's election", async () => {
  const streams=[{slug:"main",displayName:"Main stream",isDefault:true},{slug:"late-night",displayName:"Late night",isDefault:false}];
  const panel=panelHarness({streams});
  panel.authorize({channelId:"channel",userId:"viewer-one",token:"one"});
  await settle();
  const streamSelect=panel.elements.get("stream-select");
  assert.equal(panel.elements.get("stream-picker").hidden,false);
  streamSelect.value="late-night";
  streamSelect.handlers.change();
  await settle();
  assert.equal(panel.elements.get("choices").children[0].dataset.choiceId,"choice-late");

  panel.elements.get("choices").children[0].click();
  panel.elements.get("submit-vote").click();
  await settle();
  assert.ok(panel.calls.some(call=>call.url.endsWith("/channels/channel/streams/late-night/elections/election-late/ballots")));

  panel.elements.get("prompt-toggle").click();
  panel.elements.get("prompt-input").value="A late-night cartoon rocket bursts into confetti";
  panel.elements.get("prompt-input").handlers.input();
  panel.elements.get("submit-prompt").click();
  await settle();
  assert.ok(panel.calls.some(call=>call.url.endsWith("/channels/channel/streams/late-night/proposals")));
});

test("a vote finishing after a stream switch does not update the new stream's UI", async () => {
  const streams=[{slug:"main",displayName:"Main stream",isDefault:true},{slug:"late-night",displayName:"Late night",isDefault:false}];
  const panel=panelHarness({streams});
  await startVote(panel);
  panel.elements.get("stream-select").value="late-night";
  panel.elements.get("stream-select").handlers.change();
  await settle();
  panel.completeBallot();
  await settle();
  assert.equal(panel.elements.get("choices").children[0].dataset.choiceId,"choice-late");
  assert.equal(panel.elements.get("submit-vote").textContent,"Cast vote");
});

test("a prompt finishing after a stream switch does not clear the new stream's draft", async () => {
  const streams=[{slug:"main",displayName:"Main stream",isDefault:true},{slug:"late-night",displayName:"Late night",isDefault:false}];
  let finishPrompt;
  const proposalResponse={ok:true,json:()=>new Promise(resolve=>{finishPrompt=resolve;})};
  const panel=panelHarness({streams,proposalResponse});
  panel.authorize({channelId:"channel",userId:"viewer-one",token:"one"});
  await settle();
  panel.elements.get("prompt-toggle").click();
  panel.elements.get("prompt-input").value="Main stream draft";
  panel.elements.get("prompt-input").handlers.input();
  panel.elements.get("submit-prompt").click();
  await settle();

  panel.elements.get("stream-select").value="late-night";
  panel.elements.get("stream-select").handlers.change();
  await settle();
  panel.elements.get("prompt-input").value="Late night draft";
  panel.elements.get("prompt-input").handlers.input();
  finishPrompt({state:"eligible"});
  await settle();
  assert.equal(panel.elements.get("prompt-input").value,"Late night draft");
});

test("authorizing a different channel resets a stream that does not exist there", async () => {
  const main=[{slug:"main",displayName:"Main stream",isDefault:true}];
  const streamsByToken={
    one:[...main,{slug:"late-night",displayName:"Late night",isDefault:false}],
    two:main,
  };
  const panel=panelHarness({streams:main,streamsByToken});
  panel.authorize({channelId:"channel-one",userId:"viewer-one",token:"one"});
  await settle();
  panel.elements.get("stream-select").value="late-night";
  panel.elements.get("stream-select").handlers.change();
  await settle();
  assert.equal(panel.elements.get("choices").children[0].dataset.choiceId,"choice-late");

  panel.authorize({channelId:"channel-two",userId:"viewer-two",token:"two"});
  await settle();
  assert.ok(panel.calls.some(call=>call.url.endsWith("/extension/state?stream=main")&&call.options.headers["x-extension-jwt"]==="two"));
  assert.equal(panel.elements.get("choices").children[0].dataset.choiceId,"choice-one");
  assert.equal(panel.elements.get("error").hidden,true);
});
