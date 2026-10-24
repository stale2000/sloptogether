export class BitsReconcileError extends Error {
  constructor(code){super(code);this.name="BitsReconcileError";this.code=code;}
}

export async function processBitsReconcileMessage({config,message,fetchImpl=fetch}){
  const payload=message.payload;
  const intentId=payload&&typeof payload==="object"&&!Array.isArray(payload)?payload.intentId:null;
  if(typeof intentId!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)
    ||message.aggregateId!==intentId||typeof message.id!=="string"||!/^[0-9]+$/.test(message.id)
    ||!(message.leaseUntil instanceof Date)||!Number.isFinite(message.leaseUntil.getTime()))throw new BitsReconcileError("bits_reconcile_payload_invalid");
  const secret=config.bitsReconcileSecret;
  let endpoint,app;
  try{endpoint=new URL(config.bitsReconcileUrl??"");app=new URL(config.publicAppUrl??"");}catch{throw new BitsReconcileError("bits_reconcile_not_configured");}
  const local=app.hostname==="localhost"||app.hostname==="127.0.0.1"||app.hostname==="::1";
  const expectedPath=`${app.pathname.replace(/\/$/,"")}/api/v1/internal/bits/reconcile`;
  if(!secret||secret.length<32||!(app.protocol==="https:"||local&&app.protocol==="http:")||app.username||app.password||app.search||app.hash
    ||!(endpoint.protocol==="https:"||local&&endpoint.protocol==="http:")
    ||endpoint.origin!==app.origin||endpoint.pathname!==expectedPath||endpoint.username||endpoint.password||endpoint.search||endpoint.hash){
    throw new BitsReconcileError("bits_reconcile_not_configured");
  }
  const response=await fetchImpl(endpoint,{method:"POST",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(12_000),
    headers:{"Content-Type":"application/json",Authorization:`SlopBits ${secret}`},
    body:JSON.stringify({intentId,outboxId:message.id,leaseUntil:message.leaseUntil.toISOString()})})
    .catch(()=>{throw new BitsReconcileError("bits_reconcile_request_uncertain");});
  if(!response.ok)throw new BitsReconcileError(`bits_reconcile_http_${response.status}`);
  const result=await response.json().catch(()=>null);
  if(!result||typeof result.state!=="string"||result.state.length>64)throw new BitsReconcileError("bits_reconcile_response_invalid");
  return {status:"reconciled",state:result.state};
}
