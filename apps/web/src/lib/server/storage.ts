import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiError } from "./http";
import { randomToken } from "./crypto";
import { isIP } from "node:net";

let client:S3Client|undefined;
function configuration(){
  const account=process.env.R2_ACCOUNT_ID;
  const keyId=process.env.R2_ACCESS_KEY_ID;
  const secret=process.env.R2_SECRET_ACCESS_KEY;
  const bucket=process.env.R2_BUCKET_NAME;
  if(!account||!keyId||!secret||!bucket)throw new ApiError(503,"storage_not_configured","Private media storage is not configured.");
  const localEndpoint=process.env.SLOPTOGETHER_LOCAL_S3_ENDPOINT;
  if(localEndpoint){
    let url:URL;try{url=new URL(localEndpoint)}catch{throw new ApiError(503,"local_storage_endpoint_invalid")}
    const host=url.hostname.toLowerCase();const loopback=host==="localhost"||host==="127.0.0.1"||host==="::1"||isIP(host)===4&&host.startsWith("127.");
    if(process.env.NODE_ENV==="production"||url.protocol!=="http:"||!loopback||url.username||url.password||url.search||url.hash||url.pathname!=="/")
      throw new ApiError(503,"local_storage_endpoint_not_allowed");
  }
  return {account,keyId,secret,bucket,localEndpoint};
}

function r2(){
  const c=configuration();
  client??=new S3Client({region:c.localEndpoint?"us-east-1":"auto",endpoint:c.localEndpoint??`https://${c.account}.r2.cloudflarestorage.com`,
    // R2's S3 API is hosted at the account endpoint. Keep the bucket in the
    // request path so signed URLs stay on the allowed account hostname.
    forcePathStyle:true,credentials:{accessKeyId:c.keyId,secretAccessKey:c.secret}});
  return client;
}

export function createQuarantineObjectKey(channelId:string,attemptId:string,extension:"mp4"|"png"|"jpg"|"webp"){
  const random=randomToken(24);
  return `incoming/${channelId}/${attemptId}/${random}.${extension}`;
}

export async function signedPrivateReadUrl(storageKey:string,expiresIn=120){
  if(!Number.isInteger(expiresIn)||expiresIn<5||expiresIn>600)throw new ApiError(500,"invalid_media_url_lifetime");
  const {bucket}=configuration();
  return getSignedUrl(r2(),new GetObjectCommand({Bucket:bucket,Key:storageKey}),{expiresIn});
}

export async function signedDirectUploadUrl(storageKey:string,contentType:string,contentLength:number,expiresIn=90){
  if(!Number.isSafeInteger(contentLength)||contentLength<1)throw new ApiError(500,"invalid_upload_content_length");
  const {bucket}=configuration();
  const {PutObjectCommand}=await import("@aws-sdk/client-s3");
  return getSignedUrl(r2(),new PutObjectCommand({Bucket:bucket,Key:storageKey,ContentType:contentType,ContentLength:contentLength}),{expiresIn});
}

export async function copyToImmutableSnapshot(sourceKey:string,destinationKey:string,etag?:string){
  const {bucket}=configuration();
  const {CopyObjectCommand}=await import("@aws-sdk/client-s3");
  await r2().send(new CopyObjectCommand({
    Bucket:bucket,
    Key:destinationKey,
    CopySource:`${bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
    ...(etag?{CopySourceIfMatch:etag}:{}),
  }));
}
