import { bitsOutcome, isLateReceiptGracePending, promptLockBitsOutcome } from "./bits-state.mjs";

(() => {
  "use strict";

  const API = "https://www.clips.gg/sloptogether/api/v1";
  const POLL_MS = 12000;
  const PAID_TURBO_UI_ENABLED = false;
  const nodes = {
    status: document.getElementById("status"),
    streamPicker: document.getElementById("stream-picker"),
    streamSelect: document.getElementById("stream-select"),
    turbo: document.getElementById("turbo"),
    turboPrompt: document.getElementById("turbo-prompt"),
    turboProducts: document.getElementById("turbo-products"),
    turboStatus: document.getElementById("turbo-status"),
    turboLink: document.getElementById("turbo-link"),
    turboReconcile: document.getElementById("turbo-reconcile"),
    promptLock: document.getElementById("prompt-lock"),
    promptLockProducts: document.getElementById("prompt-lock-products"),
    promptLockStatus: document.getElementById("prompt-lock-status"),
    promptLockLink: document.getElementById("prompt-lock-link"),
    promptLockReconcile: document.getElementById("prompt-lock-reconcile"),
    bitsEventSubTest: document.getElementById("bits-eventsub-test"),
    bitsEventSubTestRun: document.getElementById("bits-eventsub-test-run"),
    bitsEventSubTestStatus: document.getElementById("bits-eventsub-test-status"),
    ballot: document.getElementById("ballot"),
    question: document.getElementById("question"),
    countdown: document.getElementById("countdown"),
    helper: document.getElementById("helper"),
    choices: document.getElementById("choices"),
    submit: document.getElementById("submit-vote"),
    promptSection: document.getElementById("prompt-section"),
    promptToggle: document.getElementById("prompt-toggle"),
    promptForm: document.getElementById("prompt-form"),
    promptInput: document.getElementById("prompt-input"),
    promptSubmit: document.getElementById("submit-prompt"),
    empty: document.getElementById("empty"),
    link: document.getElementById("link-account"),
    error: document.getElementById("error"),
    subscriber: document.getElementById("subscriber-card"),
  };

  let authorization = null;
  let currentElection = null;
  let selectedStreamSlug = "main";
  let currentChannelLogin = null;
  let selectedChoiceId = null;
  let abortController = null;
  let voteAbortController = null;
  let pollTimer = 0;
  let refreshEpoch = 0;
  let isVisible = true;
  let isSubmitting = false;
  let isSubmittingPrompt = false;
  let isPromptFormOpen = false;
  let canSubmitPrompts = false;
  let bitsState = null;
  let promptLockState = null;
  let bitsEventSubTestState = null;
  let bitsEventSubTestPending = false;
  let bitsEventSubTestSince = null;
  let bitsEventSubTestTimer = 0;
  let bitsEventSubTestStatusText = "";
  let promptLockStatusText = "";
  let bitsPending = false;
  let bitsBusy = false;
  let bitsReceiptUnverified = false;
  let bitsIntent = null;
  let bitsTimer = 0;
  let bitsTargetInFlight = null;
  let authorizedIdentity = null;
  let authorizedChannelId = null;
  let identityEpoch = 0;
  let streamEpoch = 0;
  let bitsTransactionEpoch = null;
  let errorSource = null;

  function message(target, text) {
    target.textContent = text;
  }

  function clearError() {
    nodes.error.hidden = true;
    nodes.error.textContent = "";
    errorSource = null;
  }

  function setError(text, source = "interaction") {
    nodes.error.hidden = false;
    message(nodes.error, text);
    errorSource = source;
  }

  function setTurboStatus(text) {
    if (!PAID_TURBO_UI_ENABLED) return;
    nodes.turboStatus.hidden = !text;
    message(nodes.turboStatus, text || "");
  }

  function setBitsActionStatus(text){
    if(bitsIntent?.actionKind==="prompt_lock"){
      promptLockStatusText=text||"";
      renderPromptLock();
    }else setTurboStatus(text);
  }

  function renderPromptLock(){
    const currentProposal=promptLockState?.proposals?.find(item=>item.proposalId===selectedChoiceId&&item.electionId===currentElection?.id);
    const pending=bitsPending&&bitsIntent?.actionKind==="prompt_lock";
    const requiresLink=promptLockState?.requiresLinkedIdentity===true&&Boolean(currentElection?.choices?.length);
    const show=Boolean(pending||promptLockStatusText||promptLockState?.enabled&&currentProposal||requiresLink);
    nodes.promptLock.hidden=!show;
    nodes.promptLockStatus.hidden=!promptLockStatusText;
    message(nodes.promptLockStatus,promptLockStatusText);
    nodes.promptLockLink.hidden=!requiresLink||linkedIdentity(authorization);
    nodes.promptLockReconcile.hidden=!bitsReceiptUnverified||bitsIntent?.actionKind!=="prompt_lock";
    nodes.promptLockProducts.replaceChildren();
    if(!currentProposal||pending||!promptLockState?.enabled)return;
    for(const product of promptLockState.products){
      const button=document.createElement("button");
      button.type="button";button.className="prompt-lock-product";
      button.disabled=!linkedIdentity(authorization)||bitsBusy||bitsPending;
      button.addEventListener("click",()=>{void usePromptLockBits(product,currentProposal);});
      const title=document.createElement("span");title.textContent=product.displayName;
      const price=document.createElement("small");price.textContent=`${product.amountBits} Bits`;
      button.append(title,price);nodes.promptLockProducts.append(button);
    }
  }

  function renderBitsEventSubTest(){
    nodes.bitsEventSubTest.hidden=!bitsEventSubTestState?.enabled;
    nodes.bitsEventSubTestStatus.hidden=!bitsEventSubTestStatusText;
    message(nodes.bitsEventSubTestStatus,bitsEventSubTestStatusText);
    nodes.bitsEventSubTestRun.disabled=!bitsEventSubTestState?.productAvailable||!linkedIdentity(authorization)||bitsEventSubTestPending;
    nodes.bitsEventSubTestRun.textContent=bitsEventSubTestPending?"Waiting for Twitch…":"Run Bits test";
  }

  async function loadBitsEventSubTest(){
    const requestEpoch=identityEpoch,currentAuthorization=authorization,helper=window.Twitch?.ext;
    if(!currentAuthorization||!helper?.bits){bitsEventSubTestState=null;renderBitsEventSubTest();return;}
    try{
      const url=new URL(`${API}/extension/bits/eventsub-test/state`);
      if(bitsEventSubTestSince)url.searchParams.set("since",bitsEventSubTestSince);
      const response=await fetch(url,{headers:{"x-extension-jwt":currentAuthorization.token},cache:"no-store"});
      const state=await response.json().catch(()=>({}));
      if(requestEpoch!==identityEpoch)return;
      if(!response.ok||state.enabled!==true){bitsEventSubTestState=null;renderBitsEventSubTest();return;}
      const catalog=await helper.bits.getProducts();
      if(requestEpoch!==identityEpoch)return;
      const productAvailable=catalog.some(item=>item.sku===state.sku&&item.inDevelopment===true
        &&item.cost?.type==="bits"&&Number(item.cost.amount)===state.amountBits);
      bitsEventSubTestState={...state,productAvailable};
      if(state.latestEvent?.state==="development_ignored"&&bitsEventSubTestSince
        &&Date.parse(state.latestEvent.occurredAt)>=Date.parse(bitsEventSubTestSince)){
        bitsEventSubTestPending=false;
        bitsEventSubTestStatusText="EventSub received; no render started.";
        if(bitsEventSubTestTimer)window.clearTimeout(bitsEventSubTestTimer);
        bitsEventSubTestTimer=0;
      }
      renderBitsEventSubTest();
    }catch{
      if(requestEpoch!==identityEpoch)return;
      bitsEventSubTestState=null;renderBitsEventSubTest();
    }
  }

  async function pollBitsEventSubTest(){
    if(!bitsEventSubTestPending)return;
    if(bitsEventSubTestTimer)window.clearTimeout(bitsEventSubTestTimer);
    bitsEventSubTestTimer=0;
    await loadBitsEventSubTest();
    if(bitsEventSubTestPending)bitsEventSubTestTimer=window.setTimeout(pollBitsEventSubTest,2000);
  }

  function startBitsEventSubTest(){
    const helper=window.Twitch?.ext,product=bitsEventSubTestState;
    if(!authorization||!linkedIdentity(authorization)||!helper?.bits||!product?.enabled||!product.productAvailable||bitsEventSubTestPending)return;
    bitsEventSubTestPending=true;bitsEventSubTestSince=new Date().toISOString();
    bitsEventSubTestStatusText="Confirm the development test in Twitch. No render will start.";
    renderBitsEventSubTest();
    try{helper.bits.useBits(product.sku);}catch{
      bitsEventSubTestPending=false;bitsEventSubTestStatusText="Twitch test purchase unavailable.";renderBitsEventSubTest();return;
    }
    bitsEventSubTestTimer=window.setTimeout(pollBitsEventSubTest,2000);
  }

  function clearBitsIntent() {
    if (bitsTimer) window.clearTimeout(bitsTimer);
    bitsTimer = 0;
    const linkedId = window.Twitch?.ext?.viewer?.id;
    if (linkedId && authorization?.channelId) {
      try { window.sessionStorage.removeItem(`sloptogether-bits:${authorization.channelId}:${linkedId}`); } catch { /* Storage is optional; server state is authoritative. */ }
    }
    bitsIntent = null;
    bitsPending = false;
    bitsReceiptUnverified = false;
    bitsTransactionEpoch = null;
    nodes.turboReconcile.hidden = true;
    renderTurboProducts();
    renderPromptLock();
  }

  function resetBitsForIdentityChange() {
    if (bitsTimer) window.clearTimeout(bitsTimer);
    bitsTimer = 0;
    bitsState = null;
    promptLockState=null;
    promptLockStatusText="";
    bitsPending = false;
    bitsBusy = false;
    bitsReceiptUnverified = false;
    bitsIntent = null;
    bitsTransactionEpoch = null;
    if(bitsEventSubTestTimer)window.clearTimeout(bitsEventSubTestTimer);
    bitsEventSubTestTimer=0;bitsEventSubTestState=null;bitsEventSubTestPending=false;bitsEventSubTestSince=null;bitsEventSubTestStatusText="";
    bitsTargetInFlight = null;
    nodes.turboProducts.replaceChildren();
    nodes.turboStatus.hidden = true;
    nodes.turboStatus.textContent = "";
    nodes.turboLink.hidden = true;
    nodes.turboReconcile.hidden = true;
    nodes.turbo.hidden = true;
    nodes.promptLockProducts.replaceChildren();
    nodes.promptLockStatus.hidden=true;nodes.promptLockStatus.textContent="";
    nodes.promptLockLink.hidden=true;nodes.promptLockReconcile.hidden=true;nodes.promptLock.hidden=true;
    nodes.bitsEventSubTestStatus.hidden=true;nodes.bitsEventSubTestStatus.textContent="";nodes.bitsEventSubTest.hidden=true;
  }

  function renderTurboProducts() {
    if (!PAID_TURBO_UI_ENABLED) { nodes.turbo.hidden = true; return; }
    nodes.turboProducts.replaceChildren();
    if (selectedStreamSlug !== "main" && !bitsPending && !bitsBusy) {
      nodes.turbo.hidden = true;
      return;
    }
    nodes.turboLink.hidden = !authorization || linkedIdentity(authorization);
    nodes.turboReconcile.hidden = !bitsReceiptUnverified || !bitsIntent;
    if (bitsPending || bitsBusy) {
      nodes.turbo.hidden = false;
      const prompt = bitsIntent?.promptPreview || bitsTargetInFlight?.promptPreview;
      message(nodes.turboPrompt, prompt
        ? `${prompt} · locked during verification.`
        : "Locked to the original scene during verification.");
      nodes.turboLink.hidden = true;
      return;
    }
    if (!bitsState?.enabled || !bitsState.target) {
      nodes.turbo.hidden = true;
      return;
    }
    nodes.turbo.hidden = false;
    message(nodes.turboPrompt, `${bitsState.target.promptPreview} · one 15-second Turbo attempt.`);
    for (const product of bitsState.products) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "turbo-product";
      button.disabled = !linkedIdentity(authorization) || bitsBusy || bitsPending;
      button.addEventListener("click", () => { void useTurboBits(product); });
      const title = document.createElement("span");
      title.textContent = product.displayName;
      const price = document.createElement("small");
      price.textContent = `${product.amountBits} Bits · ${product.resolution}`;
      button.append(title, price);
      nodes.turboProducts.append(button);
    }
  }

  async function loadTurbo() {
    if (!PAID_TURBO_UI_ENABLED) { bitsState = null; nodes.turbo.hidden = true; return; }
    const requestEpoch = identityEpoch;
    const currentAuthorization = authorization;
    const helper = window.Twitch?.ext;
    if (selectedStreamSlug !== "main" || !currentAuthorization || helper?.features?.isBitsEnabled !== true || !helper.bits) {
      bitsState = null;
      if (!bitsPending) nodes.turbo.hidden = true;
      renderTurboProducts();
      return;
    }
    try {
      const [response, catalog] = await Promise.all([
        fetch(`${API}/extension/bits/state`, { headers: { "x-extension-jwt": currentAuthorization.token }, cache: "no-store" }),
        helper.bits.getProducts(),
      ]);
      const state = await response.json().catch(() => ({}));
      if (requestEpoch !== identityEpoch) return;
      if (!response.ok || state.enabled !== true || !Array.isArray(state.products)) {
        bitsState = null;
        renderTurboProducts();
        return;
      }
      const eligibleCatalog = catalog.filter((item) => item.inDevelopment !== true && item.cost?.type === "bits");
      const products = state.products.filter((item) => eligibleCatalog.some((listed) => listed.sku === item.sku && Number(listed.cost.amount) === item.amountBits));
      bitsState = { ...state, enabled: products.length > 0, products };
      renderTurboProducts();
    } catch {
      if (requestEpoch !== identityEpoch) return;
      bitsState = null;
      renderTurboProducts();
    }
  }

  async function loadPromptLock(){
    const requestEpoch=identityEpoch,requestStreamEpoch=streamEpoch;
    const currentAuthorization=authorization,helper=window.Twitch?.ext;
    if(!currentAuthorization||helper?.features?.isBitsEnabled!==true||!helper.bits){
      promptLockState=null;renderPromptLock();return;
    }
    try{
      const response=await fetch(`${API}/extension/bits/prompt-lock/state?stream=${encodeURIComponent(selectedStreamSlug)}`,{
        headers:{"x-extension-jwt":currentAuthorization.token},cache:"no-store",
      });
      const state=await response.json().catch(()=>({}));
      if(requestEpoch!==identityEpoch||requestStreamEpoch!==streamEpoch)return;
      if(!response.ok||state.enabled!==true||!Array.isArray(state.products)||!Array.isArray(state.proposals)){
        promptLockState={enabled:false,requiresLinkedIdentity:state.requiresLinkedIdentity===true,products:[],proposals:[]};
        renderPromptLock();return;
      }
      const catalog=await helper.bits.getProducts();
      if(requestEpoch!==identityEpoch||requestStreamEpoch!==streamEpoch)return;
      const eligibleCatalog=catalog.filter(item=>item.inDevelopment!==true&&item.cost?.type==="bits");
      const products=state.products.filter(item=>eligibleCatalog.some(listed=>listed.sku===item.sku&&Number(listed.cost.amount)===item.amountBits));
      promptLockState={...state,enabled:products.length>0,products};
      renderPromptLock();
    }catch{
      if(requestEpoch!==identityEpoch||requestStreamEpoch!==streamEpoch)return;
      promptLockState=null;renderPromptLock();
    }
  }

  async function checkBitsIntent() {
    if (!authorization || !bitsIntent) return;
    const requestEpoch = identityEpoch;
    const intentId = bitsIntent.intentId;
    const currentAuthorization = authorization;
    if (bitsIntent.identityEpoch !== requestEpoch) return;
    if (bitsTimer) window.clearTimeout(bitsTimer);
    bitsTimer = 0;
    try {
      const response = await fetch(`${API}/extension/bits/intents/${encodeURIComponent(intentId)}`, {
        headers: { "x-extension-jwt": currentAuthorization.token }, cache: "no-store",
      });
      if (!response.ok) throw new Error("status_unavailable");
      const result = await response.json();
      if (typeof result.state !== "string") throw new Error("status_invalid");
      if (requestEpoch !== identityEpoch || bitsIntent?.intentId !== intentId) return;
      if(result.actionKind&&!bitsIntent.actionKind)bitsIntent={...bitsIntent,actionKind:result.actionKind};
      clearError();
      if (isLateReceiptGracePending(result.state,result.transactionReceived,result.expiresAt)) {
        setBitsActionStatus("Bits verification in progress.");
        bitsTimer = window.setTimeout(checkBitsIntent, 5000);
        return;
      }
      const outcome = bitsIntent.actionKind==="prompt_lock"?promptLockBitsOutcome(result.state):bitsOutcome(result.state);
      setBitsActionStatus(outcome.text);
      bitsReceiptUnverified = result.state === "receipt_unverified";
      nodes.turboReconcile.hidden = !bitsReceiptUnverified||bitsIntent.actionKind==="prompt_lock";
      nodes.promptLockReconcile.hidden = !bitsReceiptUnverified||bitsIntent.actionKind!=="prompt_lock";
      if (outcome.pending) {
        bitsTimer = window.setTimeout(checkBitsIntent, bitsReceiptUnverified ? 30_000 : 5000);
        return;
      }
      if (outcome.error) setError(outcome.text);
      clearBitsIntent();
      await loadTurbo();
      await loadPromptLock();
    } catch {
      if (requestEpoch === identityEpoch && bitsIntent?.intentId === intentId)
        bitsTimer = window.setTimeout(checkBitsIntent, 5000);
    }
  }

  async function useTurboBits(product) {
    if (!PAID_TURBO_UI_ENABLED) return;
    const helper = window.Twitch?.ext;
    if (!authorization || !linkedIdentity(authorization) || !bitsState?.enabled || !helper?.bits || !bitsState.target || bitsBusy || bitsPending) return;
    const requestEpoch = identityEpoch;
    const currentAuthorization = authorization;
    const target = bitsState.target;
    bitsTargetInFlight = { promptPreview: target.promptPreview };
    bitsBusy = true;
    renderTurboProducts();
    clearError();
    setTurboStatus("");
    let intentId = null;
    try {
      const response = await fetch(`${API}/extension/bits/intents`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-extension-jwt": currentAuthorization.token },
        body: JSON.stringify({ sku: product.sku }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "The Turbo action is not available for this scene.");
      intentId = result.intentId;
      if (typeof intentId !== "string" || result.segmentRevisionId !== target.segmentRevisionId) throw new Error("The selected scene changed. Refresh the panel before using Bits.");
      if (requestEpoch !== identityEpoch) throw new Error("Account changed before confirmation.");
      bitsIntent = { intentId, sku: product.sku, promptPreview: target.promptPreview, identityEpoch: requestEpoch };
      bitsPending = true;
      const linkedId = helper.viewer?.id;
      if (PAID_TURBO_UI_ENABLED && linkedId) {
        try { window.sessionStorage.setItem(`sloptogether-bits:${currentAuthorization.channelId}:${linkedId}`, intentId); } catch { /* Server polling still works for this panel session. */ }
      }
      setTurboStatus(`Confirm ${product.amountBits} Bits to use one render attempt on this scene.`);
      renderTurboProducts();
      bitsTransactionEpoch = requestEpoch;
      helper.bits.useBits(product.sku);
      bitsTimer = window.setTimeout(checkBitsIntent, 5000);
    } catch (error) {
      if (intentId) void fetch(`${API}/extension/bits/intents/${encodeURIComponent(intentId)}/cancel`, { method: "POST", headers: { "x-extension-jwt": currentAuthorization.token } });
      if (requestEpoch === identityEpoch) {
        bitsIntent = null;
        bitsPending = false;
        bitsTransactionEpoch = null;
        setError(error.message || "The Turbo action could not be started.");
      }
    } finally {
      if (requestEpoch === identityEpoch) {
        bitsBusy = false;
        bitsTargetInFlight = null;
        renderTurboProducts();
      }
    }
  }

  async function usePromptLockBits(product,proposal){
    const helper=window.Twitch?.ext;
    if(!authorization||!linkedIdentity(authorization)||!promptLockState?.enabled||!helper?.bits||bitsBusy||bitsPending)return;
    const currentAuthorization=authorization,requestEpoch=identityEpoch,requestStreamEpoch=streamEpoch;
    bitsBusy=true;clearError();promptLockStatusText="";renderPromptLock();
    let intentId=null;
    try{
      const response=await fetch(`${API}/extension/bits/prompt-lock/intents`,{
        method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":currentAuthorization.token},
        body:JSON.stringify({sku:product.sku,proposalId:proposal.proposalId,stream:selectedStreamSlug}),
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.message||"Prompt Lock is unavailable for this scene.");
      intentId=result.intentId;
      if(typeof intentId!=="string"||result.proposalId!==proposal.proposalId||result.streamSlug!==selectedStreamSlug)
        throw new Error("The selected prompt changed. Refresh the Extension before using Bits.");
      if(requestEpoch!==identityEpoch||requestStreamEpoch!==streamEpoch)throw new Error("Account or stream changed before confirmation.");
      bitsIntent={intentId,sku:product.sku,promptPreview:proposal.promptPreview,actionKind:"prompt_lock",proposalId:proposal.proposalId,identityEpoch:requestEpoch};
      bitsPending=true;
      const linkedId=helper.viewer?.id;
      if(linkedId){try{window.sessionStorage.setItem(`sloptogether-bits:${currentAuthorization.channelId}:${linkedId}`,intentId);}catch{/* Server state remains authoritative. */}}
      setBitsActionStatus(`Confirm ${product.amountBits} Bits to lock this prompt.`);
      bitsTransactionEpoch=requestEpoch;
      helper.bits.useBits(product.sku);
      bitsTimer=window.setTimeout(checkBitsIntent,5000);
    }catch(error){
      if(intentId)void fetch(`${API}/extension/bits/intents/${encodeURIComponent(intentId)}/cancel`,{method:"POST",headers:{"x-extension-jwt":currentAuthorization.token}});
      if(requestEpoch===identityEpoch){bitsIntent=null;bitsPending=false;bitsTransactionEpoch=null;setError(error.message||"Prompt Lock could not be started.");}
    }finally{
      if(requestEpoch===identityEpoch){bitsBusy=false;renderPromptLock();}
    }
  }

  async function retryBitsReconciliation() {
    if (!authorization || !bitsIntent || !bitsReceiptUnverified) return;
    const requestEpoch = identityEpoch;
    const intentId = bitsIntent.intentId;
    const currentAuthorization = authorization;
    try {
      const response = await fetch(`${API}/extension/bits/intents/${encodeURIComponent(intentId)}/reconcile`, {
        method: "POST", headers: { "x-extension-jwt": currentAuthorization.token },
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "Transaction check could not be queued.");
      if (requestEpoch !== identityEpoch || bitsIntent?.intentId !== intentId) return;
      clearError();
      setBitsActionStatus(result.queued ? "Verification queued." : `Verification already queued${result.retryAfterSeconds ? `; retry in ${result.retryAfterSeconds}s.` : "."}`);
      bitsTimer = window.setTimeout(checkBitsIntent, 5000);
    } catch (error) { if (requestEpoch === identityEpoch) setError(error.message || "Transaction check could not be queued."); }
  }

  function linkedIdentity(auth) {
    const viewer = window.Twitch?.ext?.viewer;
    return Boolean(viewer && viewer.isLinked === true && viewer.id && auth?.userId);
  }

  function stopPolling() {
    refreshEpoch += 1;
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = 0;
    if (abortController) abortController.abort();
    abortController = null;
  }

  async function api(path, options = {}) {
    if (!authorization?.token) throw new Error("Waiting for Extension authorization.");
    const response = await fetch(`${API}${path}`, {
      ...options,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-extension-jwt": authorization.token,
        ...options.headers,
      },
      signal: options.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || "The channel service could not complete that request.");
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function countdown(closesAt) {
    if (!closesAt) return "";
    const seconds = Math.max(0, Math.ceil((Date.parse(closesAt) - Date.now()) / 1000));
    if (seconds <= 0) return "Closing";
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} left`;
  }

  function showNoElection() {
    currentElection = null;
    selectedChoiceId = null;
    nodes.ballot.hidden = true;
    nodes.empty.hidden = false;
    nodes.link.hidden = !authorization || linkedIdentity(authorization);
    nodes.status.hidden = true;
    nodes.submit.disabled = true;
    renderPromptLock();
  }

  function renderPromptForm(allowed = canSubmitPrompts) {
    canSubmitPrompts = allowed;
    nodes.promptSection.hidden = !authorization || !canSubmitPrompts;
    nodes.promptForm.hidden = !isPromptFormOpen;
    nodes.promptToggle.setAttribute("aria-expanded", String(isPromptFormOpen));
    nodes.promptToggle.textContent = linkedIdentity(authorization) ? "Suggest a scene" : "Link account to suggest";
    nodes.promptInput.disabled = !linkedIdentity(authorization) || isSubmittingPrompt;
    nodes.promptSubmit.disabled = !linkedIdentity(authorization) || isSubmittingPrompt || !nodes.promptInput.value.trim();
    nodes.promptSubmit.textContent = isSubmittingPrompt ? "Submitting…" : "Submit prompt";
  }

  function togglePromptForm() {
    if (!linkedIdentity(authorization)) {
      try { window.Twitch?.ext?.actions?.requestIdShare(); } catch { /* Linking is optional until the viewer submits. */ }
      message(nodes.status, "Link your account to suggest a scene.");
      nodes.status.hidden = false;
      return;
    }
    isPromptFormOpen = !isPromptFormOpen;
    renderPromptForm();
    if (isPromptFormOpen) nodes.promptInput.focus();
  }

  function renderChoices(election) {
    const choices = Array.isArray(election.choices) ? election.choices : [];
    const ownChoice = election.myVote?.choiceId || null;
    if (!selectedChoiceId || !choices.some((choice) => choice.id === selectedChoiceId)) {
      selectedChoiceId = ownChoice;
    }
    nodes.choices.replaceChildren();
    for (const choice of choices) {
      if (!choice || typeof choice.id !== "string" || typeof choice.title !== "string") continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      button.setAttribute("aria-pressed", String(choice.id === selectedChoiceId));

      const radio = document.createElement("span");
      radio.className = "choice-radio";
      radio.setAttribute("aria-hidden", "true");
      const title = document.createElement("span");
      title.className = "choice-title";
      title.textContent = choice.title;
      button.append(radio, title);

      if (Number.isSafeInteger(choice.voteCount) && choice.voteCount >= 0) {
        const count = document.createElement("span");
        count.className = "choice-count";
        count.textContent = `${choice.voteCount} vote${choice.voteCount === 1 ? "" : "s"}`;
        button.append(count);
      }

      button.addEventListener("click", () => {
        if (election.state !== "open") return;
        selectedChoiceId = choice.id;
        for (const sibling of nodes.choices.querySelectorAll(".choice")) {
          sibling.setAttribute("aria-pressed", String(sibling.dataset.choiceId === choice.id));
        }
        button.dataset.choiceId = choice.id;
        nodes.submit.disabled = !linkedIdentity(authorization) || isSubmitting;
        nodes.submit.textContent = ownChoice === choice.id ? "Keep my vote" : ownChoice ? "Change vote" : "Cast vote";
        renderPromptLock();
      });
      button.dataset.choiceId = choice.id;
      nodes.choices.append(button);
    }
    if (choices.length === 0) {
      showNoElection();
      return;
    }
    nodes.empty.hidden = true;
    nodes.link.hidden = !authorization || linkedIdentity(authorization);
    nodes.status.hidden = true;
    nodes.ballot.hidden = false;
    message(nodes.countdown, countdown(election.closesAt));
    nodes.submit.disabled = !linkedIdentity(authorization) || !selectedChoiceId || isSubmitting || election.state !== "open";
    nodes.submit.textContent = ownChoice
      ? ownChoice === selectedChoiceId ? "Keep my vote" : "Change vote"
      : "Cast vote";
    nodes.helper.textContent = election.state === "open"
      ? "Choose one scene."
      : "Voting closed.";
    renderPromptLock();
  }

  function renderSubscriberNotice(value) {
    nodes.subscriber.hidden = true;
    nodes.subscriber.replaceChildren();
    if (!value || value.enabled !== true) return;
    const title = document.createElement("strong");
    title.textContent = "Subscriber scene";
    const text = document.createElement("span");
    if (value.current && typeof value.current.label === "string") {
      text.textContent = value.current.state === "playing"
        ? `${value.current.label}'s shout-out is playing.`
        : `${value.current.label}'s shout-out is queued.`;
    } else {
      text.textContent = "Subscriber shout-outs are enabled for this channel.";
    }
    nodes.subscriber.append(title, text);
    nodes.subscriber.hidden = false;
  }

  async function refresh() {
    if (!authorization || !isVisible) return;
    const requestEpoch = identityEpoch;
    const requestStreamEpoch = streamEpoch;
    stopPolling();
    const requestRefreshEpoch = refreshEpoch;
    abortController = new AbortController();
    try {
      const channelId = authorization.channelId;
      if (!channelId) throw new Error("Channel context unavailable.");
      const result = await api(`/extension/state?stream=${encodeURIComponent(selectedStreamSlug)}`, { signal: abortController.signal });
      if (requestEpoch !== identityEpoch || requestStreamEpoch !== streamEpoch || requestRefreshEpoch !== refreshEpoch) return;
      currentChannelLogin=result.channel?.twitchLogin||null;
      const streams=Array.isArray(result.streams)?result.streams:[];
      const available=streams.filter(item=>item&&typeof item.slug==="string"&&typeof item.displayName==="string");
      if(nodes.streamSelect){
        nodes.streamSelect.replaceChildren(...available.map(item=>{
          const option=document.createElement("option");option.value=item.slug;option.textContent=item.displayName;return option;
        }));
        if(available.some(item=>item.slug===selectedStreamSlug))nodes.streamSelect.value=selectedStreamSlug;
      }
      if(nodes.streamPicker)nodes.streamPicker.hidden=available.length<2;
      renderSubscriberNotice(result.subscriberInterrupts || result.channel?.subscriberInterrupts);
      if (errorSource === "refresh") clearError();
      renderPromptForm(result.canSubmitPrompts === true);
      void loadTurbo();
      void loadPromptLock();
      void loadBitsEventSubTest();
      const election = result.activeElection || result.election ||
        (Array.isArray(result.elections) ? result.elections.find((item) => item?.state === "open") : null);
      if (!election) {
        showNoElection();
      } else {
        currentElection = election;
        renderChoices(currentElection);
      }
      pollTimer = window.setTimeout(refresh, POLL_MS);
    } catch (error) {
      if (requestEpoch !== identityEpoch || requestStreamEpoch !== streamEpoch || requestRefreshEpoch !== refreshEpoch) return;
      if (error.name === "AbortError") return;
      nodes.status.hidden = false;
      message(nodes.status, "The vote is temporarily unavailable. Your channel is still playing its current scene.");
      nodes.ballot.hidden = true;
      nodes.empty.hidden = true;
      nodes.link.hidden = true;
      setError(error.message || "Could not load this channel's vote.", "refresh");
      pollTimer = window.setTimeout(refresh, Math.min(POLL_MS * 2, 30000));
    }
  }

  async function submitVote() {
    if (!authorization || !currentElection || !selectedChoiceId || isSubmitting) return;
    if (!linkedIdentity(authorization)) {
      nodes.link.hidden = false;
      setError("Link your account before voting.");
      return;
    }
    const requestEpoch = identityEpoch;
    const requestStreamEpoch = streamEpoch;
    const voteController = new AbortController();
    voteAbortController = voteController;
    isSubmitting = true;
    nodes.submit.disabled = true;
    clearError();
    try {
      await api(`/channels/${encodeURIComponent(currentChannelLogin)}/streams/${encodeURIComponent(selectedStreamSlug)}/elections/${encodeURIComponent(currentElection.id)}/ballots`, {
        method: "POST",
        body: JSON.stringify({ choiceId: selectedChoiceId }),
        signal: voteController.signal,
      });
      if (requestEpoch !== identityEpoch || requestStreamEpoch !== streamEpoch) return;
      nodes.submit.textContent = "Vote saved";
      await refresh();
    } catch (error) {
      if (requestEpoch !== identityEpoch || requestStreamEpoch !== streamEpoch) return;
      setError(error.status === 401 || error.status === 403
        ? "Identity could not be verified. Reconnect and try again."
        : error.status === 409
          ? "This round closed before your vote arrived."
          : error.message || "Your vote was not saved.");
    } finally {
      if (voteAbortController === voteController) voteAbortController = null;
      if (requestEpoch === identityEpoch && requestStreamEpoch === streamEpoch) {
        isSubmitting = false;
        if (currentElection) renderChoices(currentElection);
      }
    }
  }

  async function submitPrompt() {
    if (!authorization || !linkedIdentity(authorization) || isSubmittingPrompt) return;
    const prompt = nodes.promptInput.value.trim();
    if (!prompt) return;
    const requestEpoch = identityEpoch;
    const requestStreamEpoch = streamEpoch;
    const currentAuthorization = authorization;
    isSubmittingPrompt = true;
    clearError();
    renderPromptForm();
    try {
      const response = await fetch(`${API}/channels/${encodeURIComponent(currentChannelLogin||currentAuthorization.channelId)}/streams/${encodeURIComponent(selectedStreamSlug)}/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-extension-jwt": currentAuthorization.token },
        body: JSON.stringify({ prompt, planningMode: "continuation", ...(currentElection?.segmentId ? { segmentId: currentElection.segmentId } : {}) }),
      });
      const result = await response.json().catch(() => ({}));
      if (requestEpoch !== identityEpoch || requestStreamEpoch !== streamEpoch) return;
      if (!response.ok) throw new Error(result.message || result.error || "Prompt could not be submitted.");
      nodes.promptInput.value = "";
      isPromptFormOpen = false;
      nodes.status.textContent = result.state === "pending" ? "Prompt sent for review." : "Prompt added to the vote.";
      nodes.status.hidden = false;
      await refresh();
    } catch (error) {
      if (requestEpoch === identityEpoch && requestStreamEpoch === streamEpoch) setError(error.message || "Prompt could not be submitted.");
    } finally {
      if (requestEpoch === identityEpoch && requestStreamEpoch === streamEpoch) {
        isSubmittingPrompt = false;
        renderPromptForm();
      }
    }
  }

  function connect() {
    const helper = window.Twitch?.ext;
    if (!helper) {
      message(nodes.status, "Open this panel from a channel with the SlopTogether Extension enabled.");
      return;
    }
    helper.onAuthorized((auth) => {
      const nextIdentity = `${auth.channelId}:${auth.userId || ""}`;
      if (auth.channelId !== authorizedChannelId) {
        authorizedChannelId = auth.channelId;
        selectedStreamSlug = "main";
        streamEpoch += 1;
      }
      if (nextIdentity !== authorizedIdentity) {
        if (voteAbortController) voteAbortController.abort();
        voteAbortController = null;
        authorizedIdentity = nextIdentity;
        identityEpoch += 1;
        resetBitsForIdentityChange();
        isSubmitting = false;
        isSubmittingPrompt = false;
        isPromptFormOpen = false;
        canSubmitPrompts = false;
        nodes.promptInput.value = "";
        renderPromptForm(false);
        currentElection = null;
        selectedChoiceId = null;
        nodes.ballot.hidden = true;
        nodes.empty.hidden = true;
        nodes.link.hidden = true;
        nodes.subscriber.hidden = true;
        nodes.subscriber.replaceChildren();
        nodes.status.hidden = false;
        message(nodes.status, "Loading channel…");
        clearError();
      }
      authorization = auth;
      refresh();
      const linkedId = helper.viewer?.id;
      if (linkedId) {
        try {
          const intentId = window.sessionStorage.getItem(`sloptogether-bits:${auth.channelId}:${linkedId}`);
          if (intentId && /^[0-9a-f-]{36}$/i.test(intentId)) {
            if (bitsIntent?.intentId !== intentId) bitsIntent = { intentId, sku: "", promptPreview: null, identityEpoch };
            bitsPending = true;
            nodes.turbo.hidden = false;
            setTurboStatus("Checking your existing Bits action.");
            void checkBitsIntent();
          }
        } catch { /* Storage is optional; Twitch and server receipts remain authoritative. */ }
      }
    });
    helper.onContext((context) => {
      if (context?.theme === "light" || context?.theme === "dark") document.documentElement.dataset.theme = context.theme;
      if (context?.mode === "config") {
        message(nodes.status, "Configure this Extension from the broadcaster dashboard.");
      }
    });
    helper.onVisibilityChanged((visible) => {
      isVisible = visible;
      if (visible) { refresh(); if (bitsPending) void checkBitsIntent(); if(bitsEventSubTestPending)void pollBitsEventSubTest(); }
      else {
        stopPolling();
        if (bitsTimer) window.clearTimeout(bitsTimer); bitsTimer = 0;
        if(bitsEventSubTestTimer)window.clearTimeout(bitsEventSubTestTimer);bitsEventSubTestTimer=0;
      }
    });
    helper.features?.onChanged?.(() => { void loadTurbo(); void loadPromptLock(); void loadBitsEventSubTest(); });
    helper.bits?.onTransactionComplete?.((receipt) => {
      if(bitsEventSubTestPending&&receipt?.initiator==="current_user"){
        bitsEventSubTestStatusText="Waiting for EventSub…";renderBitsEventSubTest();void pollBitsEventSubTest();return;
      }
      if (!PAID_TURBO_UI_ENABLED&&bitsIntent?.actionKind!=="prompt_lock") return;
      if (bitsTransactionEpoch !== identityEpoch || !bitsIntent || bitsIntent.identityEpoch !== identityEpoch || receipt?.initiator !== "current_user" || typeof receipt.transactionReceipt !== "string" || !authorization) return;
      bitsTransactionEpoch = null;
      const requestEpoch = identityEpoch;
      const intentId = bitsIntent.intentId;
      const currentAuthorization = authorization;
      void fetch(`${API}/extension/bits/receipt`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-extension-jwt": currentAuthorization.token },
        body: JSON.stringify({ intentId, transactionReceipt: receipt.transactionReceipt }),
      }).then(async (response) => {
        const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "Bits receipt could not be verified.");
        if (requestEpoch !== identityEpoch || bitsIntent?.intentId !== intentId) return;
        if(result.actionKind&&!bitsIntent.actionKind)bitsIntent={...bitsIntent,actionKind:result.actionKind};
        const outcome = bitsIntent?.actionKind==="prompt_lock"?promptLockBitsOutcome(result.state||"receipt_seen"):bitsOutcome(result.state||"receipt_seen");
        setBitsActionStatus(outcome.text);
        if (outcome.error) setError(outcome.text);
        void checkBitsIntent();
      }).catch((error) => { if (requestEpoch === identityEpoch) setError(error.message || "Bits receipt verification failed."); });
    });
    helper.bits?.onTransactionCancelled?.(() => {
      if(bitsEventSubTestPending){
        bitsEventSubTestPending=false;bitsEventSubTestStatusText="Test purchase cancelled.";
        if(bitsEventSubTestTimer)window.clearTimeout(bitsEventSubTestTimer);bitsEventSubTestTimer=0;renderBitsEventSubTest();return;
      }
      if (!PAID_TURBO_UI_ENABLED&&bitsIntent?.actionKind!=="prompt_lock") return;
      if (bitsTransactionEpoch !== identityEpoch || !bitsIntent || bitsIntent.identityEpoch !== identityEpoch || !authorization) return;
      bitsTransactionEpoch = null;
      const intentId = bitsIntent.intentId;
      void fetch(`${API}/extension/bits/intents/${encodeURIComponent(intentId)}/cancel`, { method: "POST", headers: { "x-extension-jwt": authorization.token } });
      setBitsActionStatus(bitsIntent.actionKind==="prompt_lock"?"Prompt Lock cancelled. No job was started.":"Bits action cancelled. No render was started.");
      clearBitsIntent();
    });
  }

  nodes.submit.addEventListener("click", submitVote);
  nodes.promptInput.addEventListener("input", () => renderPromptForm());
  nodes.streamSelect?.addEventListener("change",()=>{
    if(!nodes.streamSelect.value||nodes.streamSelect.value===selectedStreamSlug)return;
    selectedStreamSlug=nodes.streamSelect.value;
    streamEpoch+=1;
    isSubmitting=false;
    isSubmittingPrompt=false;
    canSubmitPrompts=false;
    promptLockState=null;
    currentElection=null;selectedChoiceId=null;
    nodes.ballot.hidden=true;nodes.empty.hidden=true;nodes.status.hidden=false;
    message(nodes.status,"Loading stream…");
    clearError();
    renderPromptForm(false);
    renderPromptLock();
    void refresh();
  });
  nodes.promptToggle.addEventListener("click", togglePromptForm);
  nodes.promptSubmit.addEventListener("click", submitPrompt);
  nodes.bitsEventSubTestRun.addEventListener("click",startBitsEventSubTest);
  nodes.turboLink.addEventListener("click", () => {
    try { window.Twitch?.ext?.actions?.requestIdShare(); setTurboStatus("Confirm identity sharing, then return to use Bits."); }
    catch { setError("Identity linking is unavailable right now."); }
  });
  nodes.turboReconcile.addEventListener("click", () => { void retryBitsReconciliation(); });
  nodes.promptLockLink.addEventListener("click",()=>{
    try{window.Twitch?.ext?.actions?.requestIdShare();message(nodes.promptLockStatus,"Confirm identity sharing, then return to lock a prompt.");nodes.promptLockStatus.hidden=false;nodes.promptLock.hidden=false;}
    catch{setError("Identity linking is unavailable right now.");}
  });
  nodes.promptLockReconcile.addEventListener("click",()=>{void retryBitsReconciliation();});
  nodes.link.addEventListener("click", () => {
    try {
      window.Twitch?.ext?.actions?.requestIdShare();
      message(nodes.status, "Confirm identity sharing, then return to vote.");
      nodes.status.hidden = false;
    } catch {
      setError("Identity linking is unavailable right now.");
    }
  });
  window.addEventListener("pagehide",()=>{stopPolling();if(bitsEventSubTestTimer)window.clearTimeout(bitsEventSubTestTimer);}, { once: true });
  connect();
})();
