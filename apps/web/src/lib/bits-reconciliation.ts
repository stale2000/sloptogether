export interface BitsReceiptTarget {
  channelId:string;
  extensionClientId:string;
  twitchUserId:string;
  sku:string;
  amountBits:number;
  transactionId:string;
  purchaseWindowStartedAt:Date;
  expiresAt:Date;
}

export interface AuthoritativeBitsTransaction {
  id:string;
  broadcasterId:string;
  extensionClientId:string;
  userId:string;
  sku:string;
  amountBits:number;
  timestamp:Date;
  inDevelopment:boolean;
}

export function bitsReconcileEndpointMatchesApp(reconcileUrl:string|undefined,publicAppUrl:string|undefined){
  try{
    if(!reconcileUrl||!publicAppUrl)return false;
    const endpoint=new URL(reconcileUrl),app=new URL(publicAppUrl);
    const local=app.hostname==="localhost"||app.hostname==="127.0.0.1"||app.hostname==="::1";
    const expectedPath=`${app.pathname.replace(/\/$/,"")}/api/v1/internal/bits/reconcile`;
    return (app.protocol==="https:"||local&&app.protocol==="http:")&&!app.username&&!app.password&&!app.search&&!app.hash
      &&endpoint.origin===app.origin&&endpoint.pathname===expectedPath&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash;
  }catch{return false;}
}

export function bitsTransactionMatchesReceiptTarget(target:BitsReceiptTarget,transaction:AuthoritativeBitsTransaction){
  const timestamp=transaction.timestamp.getTime();
  return transaction.id===target.transactionId&&transaction.broadcasterId===target.channelId
    &&transaction.extensionClientId===target.extensionClientId&&transaction.userId===target.twitchUserId
    &&transaction.sku===target.sku&&transaction.amountBits===target.amountBits&&!transaction.inDevelopment
    &&timestamp>=target.purchaseWindowStartedAt.getTime()&&timestamp<=target.expiresAt.getTime();
}
