"use client";

import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "./api";

interface ExtensionAuth { channelId:string;token:string;userId?:string }
interface BitsProduct {sku:string;displayName:string;cost:{type:string;amount:string|number};inDevelopment?:boolean}
interface PaidProduct {sku:string;amountBits:number;resolution:string;displayName:string}
interface PendingBitsIntent {intentId:string;sku:string;promptPreview:string|null;amountBits?:number;resolution?:string;identityEpoch:number}
interface BitsState {enabled:boolean;products:PaidProduct[];target:{segmentId:string;segmentRevisionId:string;promptPreview:string}|null;requiresLinkedIdentity:boolean}
interface ExtensionElection {
  id:string;state:string;closesAt:string;
  choices:Array<{id:string;title:string;votes:number}>;
  myChoiceId:string|null;
  myVote?:{choiceId:string}|null;
}
interface ExtensionState {
  channel:{twitchChannelId:string;twitchLogin:string;displayName:string};
  elections:ExtensionElection[];
  activeElection:ExtensionElection|null;
  subscriberInterrupts:{enabled:boolean;current:{id:string;label:string;state:string}|null};
  canSubmitPrompts:boolean;
}
interface TwitchHelper {
  onAuthorized:(callback:(auth:ExtensionAuth)=>void)=>void;
  viewer?:{isLinked?:boolean;id?:string|null};
  features?:{isBitsEnabled?:boolean;onChanged?:(callback:()=>void)=>void};
  bits?:{
    getProducts:()=>Promise<BitsProduct[]>;
    useBits:(sku:string)=>void;
    onTransactionComplete:(callback:(receipt:{initiator?:string;transactionReceipt?:string})=>void)=>void;
    onTransactionCancelled:(callback:()=>void)=>void;
  };
  actions?:{requestIdShare:()=>void};
}
declare global { interface Window { Twitch?:{ext?:TwitchHelper} } }
const expiredReceiptGraceMs=10*60_000;

function isElection(value:unknown):value is ExtensionElection {
  if(!value||typeof value!=="object")return false;
  const row=value as Partial<ExtensionElection>;
  return typeof row.id==="string"&&typeof row.state==="string"&&Array.isArray(row.choices)
    &&row.choices.every(choice=>Boolean(choice)&&typeof choice.id==="string"&&typeof choice.title==="string"&&typeof choice.votes==="number");
}

export function bitsReceiptOutcome(state:string){
  switch(state){
    case "intent_open":return {pending:true,error:false,message:"Waiting for Twitch to confirm this single-attempt purchase."};
    case "receipt_seen":return {pending:true,error:false,message:"Receipt received. The server is checking Twitch's transaction record; do not purchase again."};
    case "receipt_unverified":return {pending:true,error:false,message:"Twitch has not confirmed this receipt yet. No render will start; do not buy again. Retry the transaction check or contact support."};
    case "reserved":return {pending:false,error:false,message:"The single Turbo render attempt is reserved. This payment cannot authorize another render."};
    case "paid_unfulfilled":return {pending:false,error:true,message:"The payment could not be fulfilled. It is not reusable; contact the channel owner for reconciliation."};
    case "verified_unallocated":return {pending:false,error:true,message:"Twitch verified a transaction, but it could not be matched to this scene. No render was started; contact support."};
    case "development_ignored":return {pending:false,error:true,message:"Twitch marked this as a test transaction. No production render was started."};
    case "consumed_succeeded":return {pending:false,error:false,message:"The paid render attempt completed."};
    case "consumed_failed":case "consumed_rejected":case "consumed_uncertain":
      return {pending:false,error:true,message:"This payment's one render attempt is spent. A new render requires a new purchase."};
    case "expired":return {pending:false,error:false,message:"The purchase window expired without a receipt. No render was started; a new paid action may be opened."};
    case "cancelled":return {pending:false,error:true,message:"This purchase was cancelled. Start a new action if you still want to participate."};
    default:return {pending:true,error:false,message:"The server is reconciling this single Turbo attempt."};
  }
}

export function isLateReceiptGracePending(state:string,transactionReceived:boolean,expiresAt:string,now=Date.now()){
  const deadline=Date.parse(expiresAt)+expiredReceiptGraceMs;
  return state==="expired"&&!transactionReceived&&Number.isFinite(deadline)&&now<deadline;
}

function pendingBitsStorageKey(channelId:string,userId:string){return `sloptogether-bits:${channelId}:${userId}`}
function readPendingBits(channelId:string,userId:string){try{return sessionStorage.getItem(pendingBitsStorageKey(channelId,userId))}catch{return null}}
function savePendingBits(channelId:string,userId:string,intentId:string){try{sessionStorage.setItem(pendingBitsStorageKey(channelId,userId),intentId)}catch{/* payment processing remains server-owned */}}
function clearPendingBits(channelId:string,userId:string){try{sessionStorage.removeItem(pendingBitsStorageKey(channelId,userId))}catch{/* status can be reloaded from the server */}}

export function TwitchExtensionPanel(){
  const [auth,setAuth]=useState<ExtensionAuth|null>(null);
  const [state,setState]=useState<ExtensionState|null>(null);
  const [linked,setLinked]=useState(false);
  const [bitsState,setBitsState]=useState<BitsState|null>(null);
  const [bitsBusy,setBitsBusy]=useState(false);
  const [bitsTargetInFlight,setBitsTargetInFlight]=useState<string|null>(null);
  const [bitsPending,setBitsPending]=useState(false);
  const [pendingBitsDisplay,setPendingBitsDisplay]=useState<PendingBitsIntent|null>(null);
  const [bitsReceiptUnverified,setBitsReceiptUnverified]=useState(false);
  const [bitsStatusVersion,setBitsStatusVersion]=useState(0);
  const pendingBitsIntent=useRef<PendingBitsIntent|null>(null);
  const currentAuth=useRef<ExtensionAuth|null>(null);
  const authorizedIdentity=useRef<string|null>(null);
  const identityEpoch=useRef(0);
  const bitsTransactionEpoch=useRef<number|null>(null);
  const transactionCallbacks=useRef(false);
  const [busy,setBusy]=useState<string|null>(null);
  const [promptDraft,setPromptDraft]=useState("");
  const [message,setMessage]=useState<string|null>(null);
  const [error,setError]=useState<string|null>(null);
  const active=useRef(true);
  const initialized=useRef(false);

  const load=useCallback(async(current:ExtensionAuth)=>{
    const requestEpoch=identityEpoch.current;
    try{
      const response=await fetch(`${API_BASE}/extension/state`,{headers:{"x-extension-jwt":current.token},cache:"no-store"});
      const body=await response.json();
      if(!response.ok)throw new Error(typeof body?.message==="string"?body.message:"The channel panel could not load.");
      if(!body?.channel||typeof body.channel.displayName!=="string"||!Array.isArray(body.elections)
        ||!body.elections.every(isElection)||(body.activeElection!==null&&!isElection(body.activeElection))||typeof body.canSubmitPrompts!=="boolean")
        throw new Error("The channel returned an invalid vote response.");
      if(active.current&&requestEpoch===identityEpoch.current){setState(body as ExtensionState);setError(null)}
    }catch(problem){if(active.current&&requestEpoch===identityEpoch.current)setError(problem instanceof Error?problem.message:"The channel panel could not load.")}
  },[]);

  const loadBits=useCallback(async(current:ExtensionAuth,helper:TwitchHelper)=>{
    const requestEpoch=identityEpoch.current;
    if(helper.features?.isBitsEnabled!==true||!helper.bits){setBitsState(null);return;}
    try{
      const [serverResponse,products]=await Promise.all([
        fetch(`${API_BASE}/extension/bits/state`,{headers:{"x-extension-jwt":current.token},cache:"no-store"}),
        helper.bits.getProducts(),
      ]);
      const body=await serverResponse.json();
      if(requestEpoch!==identityEpoch.current)return;
      if(!serverResponse.ok||!body?.enabled||!Array.isArray(body.products)){setBitsState(null);return;}
      const catalog=products.filter(item=>item.inDevelopment!==true&&item.cost?.type==="bits");
      const eligible=(body.products as PaidProduct[]).filter(item=>catalog.some(product=>product.sku===item.sku&&Number(product.cost.amount)===item.amountBits));
      if(active.current)setBitsState({...body,products:eligible,enabled:eligible.length>0});
    }catch{if(active.current&&requestEpoch===identityEpoch.current)setBitsState(null)}
  },[]);

  const initialize=useCallback(()=>{
    const helper=window.Twitch?.ext;
    if(!helper)return false;
    if(initialized.current)return true;
    initialized.current=true;
    helper.onAuthorized(info=>{
      if(!active.current)return;
      const nextIdentity=`${info.channelId}:${info.userId??""}`;
      if(authorizedIdentity.current!==nextIdentity){
        authorizedIdentity.current=nextIdentity;
        identityEpoch.current+=1;
        bitsTransactionEpoch.current=null;
        pendingBitsIntent.current=null;
        setBitsPending(false);
        setPendingBitsDisplay(null);
        setBitsReceiptUnverified(false);
        setBitsBusy(false);
        setBitsTargetInFlight(null);
        setBitsState(null);
        setBitsStatusVersion(version=>version+1);
        setState(null);
        setBusy(null);
        setPromptDraft("");
        setMessage(null);
        setError(null);
      }
      currentAuth.current=info;
      setAuth(info);
      setLinked(Boolean(helper.viewer?.isLinked&&helper.viewer.id));
      void load(info);
      void loadBits(info,helper);
      if(helper.viewer?.isLinked&&helper.viewer.id){
        const intentId=readPendingBits(info.channelId,helper.viewer.id);
        if(intentId&&/^[0-9a-f-]{36}$/i.test(intentId)){
          if(pendingBitsIntent.current?.intentId!==intentId)
            pendingBitsIntent.current={intentId,sku:"",promptPreview:null,identityEpoch:identityEpoch.current};
          setPendingBitsDisplay(pendingBitsIntent.current);
          setBitsPending(true);
        }
      }
      if(helper.features?.onChanged)helper.features.onChanged(()=>{
        const latest=currentAuth.current;
        if(active.current&&latest){setBitsState(null);void loadBits(latest,helper)}
      });
      if(helper.bits&&!transactionCallbacks.current){
        transactionCallbacks.current=true;
        helper.bits.onTransactionComplete(receipt=>{
          const pending=pendingBitsIntent.current;
          const latest=currentAuth.current;
          if(bitsTransactionEpoch.current!==identityEpoch.current||!pending||pending.identityEpoch!==identityEpoch.current||!latest||receipt.initiator!=="current_user"||!receipt.transactionReceipt)return;
          bitsTransactionEpoch.current=null;
          const requestEpoch=identityEpoch.current;
          const intentId=pending.intentId;
          void fetch(`${API_BASE}/extension/bits/receipt`,{method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":latest.token},
            body:JSON.stringify({intentId,transactionReceipt:receipt.transactionReceipt})})
            .then(async response=>{
              const result=await response.json().catch(()=>({}));
              if(!response.ok)throw new Error(typeof result?.message==="string"?result.message:"Twitch payment receipt could not be verified.");
              if(requestEpoch!==identityEpoch.current||pendingBitsIntent.current?.intentId!==intentId)return;
              if(active.current){const state=typeof result?.state==="string"?result.state:"receipt_seen";const outcome=bitsReceiptOutcome(state);setBitsReceiptUnverified(state==="receipt_unverified");setMessage(outcome.message);if(outcome.error)setError(outcome.message)}
              if(active.current)setBitsStatusVersion(version=>version+1);
              const current=currentAuth.current;
              if(current)void loadBits(current,helper);
            }).catch(problem=>{if(active.current&&requestEpoch===identityEpoch.current)setError(problem instanceof Error?problem.message:"Bits receipt verification failed.")});
        });
        helper.bits.onTransactionCancelled(()=>{
          const pending=pendingBitsIntent.current;
          const latest=currentAuth.current;
          const requestEpoch=identityEpoch.current;
          if(bitsTransactionEpoch.current!==requestEpoch||!pending||pending.identityEpoch!==requestEpoch||!latest)return;
          bitsTransactionEpoch.current=null;
          pendingBitsIntent.current=null;
          setPendingBitsDisplay(null);
          const linkedId=helper.viewer?.id;
          if(linkedId)clearPendingBits(latest.channelId,linkedId);
          if(active.current){setBitsPending(false);setBitsReceiptUnverified(false)}
          if(pending&&latest)void fetch(`${API_BASE}/extension/bits/intents/${encodeURIComponent(pending.intentId)}/cancel`,{
            method:"POST",headers:{"x-extension-jwt":latest.token},
          });
          if(requestEpoch!==identityEpoch.current)return;
        });
      }
    });
    return true;
  },[load,loadBits]);

  useEffect(()=>{
    active.current=true;
    queueMicrotask(()=>{if(active.current)initialize()});
    return()=>{active.current=false};
  },[initialize]);

  useEffect(()=>{
    if(!auth||!bitsPending||!pendingBitsIntent.current)return;
    let current=true;
    let stopped=false;
    let timer:number|null=null;
    const intentId=pendingBitsIntent.current.intentId;
    const requestEpoch=identityEpoch.current;
    const check=async()=>{
      if(stopped)return;
      try{
        const response=await fetch(`${API_BASE}/extension/bits/intents/${encodeURIComponent(intentId)}`,{headers:{"x-extension-jwt":auth.token},cache:"no-store"});
      if(!response.ok)return;
        const result=await response.json();if(typeof result?.state!=="string")return;
        if(requestEpoch!==identityEpoch.current||pendingBitsIntent.current?.intentId!==intentId||pendingBitsIntent.current.identityEpoch!==requestEpoch)return;
        if(typeof result.expiresAt==="string"&&isLateReceiptGracePending(result.state,Boolean(result.transactionReceived),result.expiresAt)){
          setMessage("The purchase window ended. Waiting for a delayed Twitch receipt; do not purchase again yet.");
          return;
        }
        const outcome=bitsReceiptOutcome(result.state);
        if(!current||pendingBitsIntent.current?.intentId!==intentId)return;
        setBitsReceiptUnverified(result.state==="receipt_unverified");
        setMessage(outcome.message);
        if(outcome.pending)return;
        pendingBitsIntent.current=null;
        setPendingBitsDisplay(null);
        bitsTransactionEpoch.current=null;
        const helper=window.Twitch?.ext;
        const linkedId=helper?.viewer?.id;
        if(linkedId)clearPendingBits(auth.channelId,linkedId);
        setBitsPending(false);
        setBitsReceiptUnverified(false);
        if(outcome.error)setError(outcome.message);else setError(null);
        if(helper)void loadBits(auth,helper);
      }catch{/* Status remains pending; outbox reconciliation continues on the server. */}
    };
    timer=window.setInterval(()=>void check(),bitsReceiptUnverified?30_000:5_000);
    void check();
    return()=>{current=false;stopped=true;if(timer!==null)window.clearInterval(timer)};
  },[auth,bitsPending,bitsReceiptUnverified,bitsStatusVersion,loadBits]);

  useEffect(()=>{
    if(!auth)return;
    const timer=window.setInterval(()=>{if(!document.hidden)void load(auth)},12000);
    return()=>window.clearInterval(timer);
  },[auth,load]);

  const vote=async(electionId:string,choiceId:string)=>{
    if(!auth||!linked)return;
    setBusy(choiceId);setMessage(null);setError(null);
    try{
      const response=await fetch(`${API_BASE}/elections/${encodeURIComponent(electionId)}/ballots`,{method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":auth.token},body:JSON.stringify({choiceId})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof body?.message==="string"?body.message:"Vote could not be recorded.");
      setMessage("Vote saved. It also counts in chat and on the site.");
      await load(auth);
    }catch(problem){setError(problem instanceof Error?problem.message:"Vote could not be recorded.")}finally{setBusy(null)}
  };

  const submitPrompt=async()=>{
    const prompt=promptDraft.trim();
    if(!auth||!linked||!state?.canSubmitPrompts||!prompt||busy!==null)return;
    setBusy("proposal");setMessage(null);setError(null);
    try{
      const response=await fetch(`${API_BASE}/channels/${encodeURIComponent(auth.channelId)}/proposals`,{
        method:"POST",
        headers:{"Content-Type":"application/json","x-extension-jwt":auth.token},
        body:JSON.stringify({prompt,planningMode:"continuation"}),
      });
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof body?.message==="string"?body.message:"Prompt could not be submitted.");
      setPromptDraft("");
      setMessage(body.state==="pending"?"Prompt submitted for review. It will join the vote after approval.":"Prompt entered the open vote. Cast your ballot below.");
      await load(auth);
    }catch(problem){setError(problem instanceof Error?problem.message:"Prompt could not be submitted.")}
    finally{setBusy(null)}
  };

  const purchaseTurbo=async(product:PaidProduct)=>{
    const helper=window.Twitch?.ext;
    if(!auth||!linked||!bitsState?.enabled||!helper?.bits||!bitsState.target)return;
    const requestEpoch=identityEpoch.current;
    const target=bitsState.target;
    setBitsBusy(true);setError(null);setMessage(null);
    setBitsTargetInFlight(target.promptPreview);
    let intentId:string|undefined;
    try{
      const response=await fetch(`${API_BASE}/extension/bits/intents`,{method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":auth.token},body:JSON.stringify({sku:product.sku})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof body?.message==="string"?body.message:"The Turbo action is not available for this scene.");
      intentId=body.intentId;
      if(typeof intentId!=="string")throw new Error("The server did not reserve the Turbo action.");
      if(body.segmentRevisionId!==target.segmentRevisionId)throw new Error("The selected scene changed. Refresh the panel before using Bits.");
      if(requestEpoch!==identityEpoch.current)throw new Error("Twitch identity changed before the Bits confirmation opened.");
      pendingBitsIntent.current={intentId,sku:product.sku,promptPreview:target.promptPreview,amountBits:product.amountBits,resolution:product.resolution,identityEpoch:requestEpoch};
      setPendingBitsDisplay(pendingBitsIntent.current);
      setBitsReceiptUnverified(false);
      const linkedId=helper.viewer?.id;
      if(linkedId)savePendingBits(auth.channelId,linkedId,intentId);
      setBitsPending(true);
      bitsTransactionEpoch.current=requestEpoch;
      helper.bits.useBits(product.sku);
      setMessage(`Twitch is opening the ${product.amountBits} Bits confirmation for the next selected scene.`);
    }catch(problem){
      if(intentId)void fetch(`${API_BASE}/extension/bits/intents/${encodeURIComponent(intentId)}/cancel`,{method:"POST",headers:{"x-extension-jwt":auth.token}});
      if(requestEpoch===identityEpoch.current){
        pendingBitsIntent.current=null;
        setPendingBitsDisplay(null);
        bitsTransactionEpoch.current=null;
        setBitsReceiptUnverified(false);
        setBitsPending(false);
        setError(problem instanceof Error?problem.message:"The Turbo action could not be started.");
      }
    }finally{if(requestEpoch===identityEpoch.current){setBitsBusy(false);setBitsTargetInFlight(null)}}
  };

  const retryBitsReconciliation=async()=>{
    if(!auth||!pendingBitsIntent.current)return;
    const requestEpoch=identityEpoch.current;
    const intentId=pendingBitsIntent.current.intentId;
    setError(null);
    try{
      const response=await fetch(`${API_BASE}/extension/bits/intents/${encodeURIComponent(intentId)}/reconcile`,{
        method:"POST",headers:{"Content-Type":"application/json","x-extension-jwt":auth.token},
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof result?.message==="string"?result.message:"Transaction check could not be queued.");
      if(requestEpoch!==identityEpoch.current||pendingBitsIntent.current?.intentId!==intentId)return;
      setBitsPending(true);
      if(result.queued!==true){
        setBitsReceiptUnverified(result.state==="receipt_unverified");
        setMessage(result.retryAfterSeconds?`A retry is available in ${result.retryAfterSeconds} seconds.`:"A transaction check is already queued.");
        return;
      }
      setBitsReceiptUnverified(false);
      setBitsStatusVersion(version=>version+1);
      setMessage("A fresh Twitch transaction check is queued.");
    }catch(problem){if(requestEpoch===identityEpoch.current)setError(problem instanceof Error?problem.message:"Transaction check could not be queued.")}
  };

  const election=state?.activeElection??state?.elections.find(item=>item.state==="open")??null;
  const subscriber=state?.subscriberInterrupts?.current;
  return <div className="extension-frame">
    <Script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js" strategy="afterInteractive"
      onReady={()=>{if(!initialize())setError("The Twitch helper did not initialize. Open this panel inside Twitch.")}}
      onError={()=>setError("The Twitch helper could not load. Reload the panel in Twitch.")}/>
    <header className="extension-header"><span className="extension-mark">✦</span><span>STORY VOTE</span><span className="extension-channel">{state?.channel.displayName??"Twitch channel"}</span></header>
    <main className="extension-content">
      {error?<p role="status" className="extension-note">{error}</p>:null}
      {!auth&&!error?<p className="extension-note">Open this panel inside Twitch to connect to its channel vote.</p>:null}
      {auth&&!linked?<p className="extension-note">Share your Twitch identity before submitting prompts or voting. <button type="button" onClick={()=>window.Twitch?.ext?.actions?.requestIdShare()}>Link Twitch account</button></p>:null}
      {subscriber?<section className="extension-scene"><small>SUBSCRIBER MOMENT</small><strong>{subscriber.label}</strong><span>{subscriber.state==="playing"?"Shout-out is playing":"Shout-out is queued"}</span></section>:null}
      {bitsPending||bitsBusy?<section className="extension-votes"><small>{bitsPending?"PAID TURBO ATTEMPT":"PREPARING TURBO ATTEMPT"}</small><strong>{pendingBitsDisplay?.promptPreview??bitsTargetInFlight??"This purchase remains locked to its original scene."}</strong><small>{pendingBitsDisplay?.amountBits?`${pendingBitsDisplay.amountBits} Bits · ${pendingBitsDisplay.resolution}. `:""}One attempt only. Do not purchase again while Twitch confirms this transaction.</small></section>:bitsState?.enabled&&bitsState.target?<section className="extension-votes"><small>OPTIONAL TURBO RENDER</small><strong>{bitsState.target.promptPreview}</strong><small>Applies to the next channel-selected scene. One render attempt; a rejected result does not reuse this exchange.</small>{bitsState.products.map(product=><button key={product.sku} disabled={!linked} onClick={()=>void purchaseTurbo(product)}><span>{product.displayName}</span><small>{product.amountBits} Bits · {product.resolution}</small></button>)}</section>:null}
      {auth&&state?.canSubmitPrompts?<section className="extension-prompt-form" aria-label="Submit a scene prompt">
        <small>SUGGEST THE NEXT SCENE</small>
        <label htmlFor="extension-prompt">Prompt idea</label>
        <textarea id="extension-prompt" maxLength={1000} rows={3} value={promptDraft} disabled={!linked||busy!==null} onChange={event=>setPromptDraft(event.currentTarget.value)} placeholder="Describe one clear 15-second scene. Prompts are screened before voting."/>
        <small className="extension-prompt-help">Submissions open when a reviewed start frame is ready; prompts are screened before entering the ballot.</small>
        <div className="extension-prompt-actions"><small>{promptDraft.length}/1000 · one prompt per submission</small><button type="button" disabled={!state||!linked||busy!==null||!promptDraft.trim()} onClick={()=>void submitPrompt()}>{busy==="proposal"?"SUBMITTING…":"SUBMIT PROMPT"}</button></div>
      </section>:null}
      {auth&&linked&&state&&!state.canSubmitPrompts?<p className="extension-note">This channel currently limits prompt submissions to approved contributors.</p>:null}
      {election?.choices.length?<section aria-label="Choose the next scene" className="extension-votes"><small>WHAT HAPPENS NEXT?</small>{election.choices.map(choice=><button key={choice.id} disabled={busy!==null||!linked||election.state!=="open"} aria-pressed={(election.myChoiceId??election.myVote?.choiceId)===choice.id} onClick={()=>void vote(election.id,choice.id)}><span>{choice.title}</span><small>{busy===choice.id?"SAVING…":`${choice.votes} votes`}</small></button>)}</section>:state?<p className="extension-note">No open vote right now. Tell chat what scene you would like to see.</p>:null}
      {message?<p role="status" className="extension-success">{message}</p>:null}
      {bitsReceiptUnverified&&auth?<button type="button" className="button secondary small" onClick={()=>void retryBitsReconciliation()}>Retry transaction check</button>:null}
      <p className="extension-footer">One ballot per Twitch account · Free voting</p>
    </main>
  </div>;
}
