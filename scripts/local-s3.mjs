import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream,createWriteStream } from "node:fs";
import { mkdir,readFile,rm,stat,writeFile } from "node:fs/promises";
import { join,resolve,sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

function objectPath(root,bucket,key){
  const path=resolve(root,bucket,...key.split("/"));
  if(path!==root&&!path.startsWith(root+sep))throw new Error("local_s3_path_invalid");
  return path;
}

function parseObjectPath(rawUrl){
  const rawPath=rawUrl.split("?",1)[0]??"";
  const encoded=rawPath.split("/").slice(1);if(encoded.at(-1)==="")encoded.pop();
  const parts=encoded.map(part=>decodeURIComponent(part));
  if(!parts[0]||parts.some(part=>!part||part==="."||part===".."||part.includes("/")||part.includes("\\")||part.includes("\0")))
    throw new Error("local_s3_path_invalid");
  return {bucket:parts[0],key:parts.slice(1).join("/")};
}

function corsHeaders(origin){
  return {"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"GET,HEAD,PUT,POST,DELETE,OPTIONS","Access-Control-Allow-Headers":"*",
    "Access-Control-Expose-Headers":"ETag,Accept-Ranges,Content-Range,Content-Length","X-SlopTogether-Local-Store":"loopback-v1","Vary":"Origin"};
}

export function createLocalS3Server({root,port=9000,allowedOrigin="http://localhost:3000",maxBytes=512*1024*1024}){
  const resolvedRoot=resolve(root);
  const server=createServer(async(request,response)=>{
    const origin=request.headers.origin;
    if(origin&&origin!==allowedOrigin){response.writeHead(403);response.end();return;}
    if(request.method==="OPTIONS"){
      response.writeHead(204,corsHeaders(origin??allowedOrigin));response.end();return;
    }
    let object;
    try{object=parseObjectPath(request.url??"");}catch{response.writeHead(400);response.end();return;}
    const {bucket,key}=object;
    if(!key&&request.method==="PUT"){
      await mkdir(objectPath(resolvedRoot,bucket,""),{recursive:true});response.writeHead(200,corsHeaders(origin??allowedOrigin));response.end();return;
    }
    if(!key&&request.method==="GET"&&new URL(request.url??"/","http://local").searchParams.has("location")){
      response.writeHead(200,{...corsHeaders(origin??allowedOrigin),"Content-Type":"application/xml"});response.end("<LocationConstraint>us-east-1</LocationConstraint>");return;
    }
    const path=objectPath(resolvedRoot,bucket,key);
    if(request.method==="PUT"&&request.headers["x-amz-copy-source"]){
      let source;
      try{const decoded=decodeURIComponent(String(request.headers["x-amz-copy-source"]));source=parseObjectPath(decoded.startsWith("/")?decoded:`/${decoded}`);}catch{response.writeHead(400);response.end();return;}
      const sourcePath=objectPath(resolvedRoot,source.bucket,source.key);const etag=String(await readFile(sourcePath+".etag","utf8").catch(()=>""));
      const expected=String(request.headers["x-amz-copy-source-if-match"]??"").replaceAll('"',"");
      if(!etag||expected&&expected!==etag){response.writeHead(expected?412:404);response.end();return;}
      await mkdir(resolve(path,".."),{recursive:true});
      await (await import("node:fs/promises")).copyFile(sourcePath,path);
      await writeFile(path+".etag",etag);
      const contentType=request.headers["x-amz-metadata-directive"]==="REPLACE"?String(request.headers["content-type"]??"application/octet-stream"):String(await readFile(sourcePath+".content-type","utf8").catch(()=>"application/octet-stream"));
      await writeFile(path+".content-type",contentType);
      response.writeHead(200,{...corsHeaders(origin??allowedOrigin),"Content-Type":"application/xml",ETag:`"${etag}"`});
      response.end(`<CopyObjectResult><ETag>\"${etag}\"</ETag><LastModified>${new Date().toISOString()}</LastModified></CopyObjectResult>`);return;
    }
    if(request.method==="PUT"){
      await mkdir(resolve(path,".."),{recursive:true});let size=0;const hash=createHash("md5");
      const limit=new Transform({transform(chunk,_encoding,callback){size+=chunk.length;if(size>maxBytes)return callback(new Error("local_s3_object_too_large"));hash.update(chunk);callback(null,chunk);}});
      try{await pipeline(request,limit,createWriteStream(path,{flags:"w"}));}
      catch{await rm(path,{force:true});response.writeHead(413);response.end();return;}
      const contentType=String(request.headers["content-type"]??"application/octet-stream");
      await writeFile(path+".content-type",contentType);
      const etag=hash.digest("hex");await writeFile(path+".etag",etag);
      response.writeHead(200,{...corsHeaders(origin??allowedOrigin),ETag:`"${etag}"`});response.end();return;
    }
    if(request.method==="DELETE"){
      await rm(path,{force:true});await rm(path+".content-type",{force:true});await rm(path+".etag",{force:true});response.writeHead(204,corsHeaders(origin??allowedOrigin));response.end();return;
    }
    if(request.method==="GET"||request.method==="HEAD"){
      let info;try{info=await stat(path);}catch{response.writeHead(404);response.end();return;}
      const contentType=String(await readFile(path+".content-type","utf8").catch(()=>"application/octet-stream"));
      const etag=String(await readFile(path+".etag","utf8").catch(()=>""));
      const headers={...corsHeaders(origin??allowedOrigin),"Accept-Ranges":"bytes","Content-Type":contentType,"Content-Length":String(info.size),...(etag?{ETag:`\"${etag}\"`}:{})};
      const range=request.headers.range;
      if(range){
        const match=/^bytes=(\d+)-(\d*)$/.exec(range);
        if(!match){response.writeHead(416,{...headers,"Content-Range":`bytes */${info.size}`});response.end();return;}
        const start=Number(match[1]),end=Math.min(match[2]?Number(match[2]):info.size-1,info.size-1);
        if(start>end||start>=info.size){response.writeHead(416,{...headers,"Content-Range":`bytes */${info.size}`});response.end();return;}
        response.writeHead(206,{...headers,"Content-Length":String(end-start+1),"Content-Range":`bytes ${start}-${end}/${info.size}`});
        if(request.method==="HEAD"){response.end();return;}
        createReadStream(path,{start,end}).pipe(response);return;
      }
      response.writeHead(200,headers);if(request.method==="HEAD"){response.end();return;}createReadStream(path).pipe(response);return;
    }
    response.writeHead(405,{Allow:"GET,HEAD,PUT,DELETE,OPTIONS"});response.end();
  });
  return new Promise((resolvePromise,reject)=>{
    server.once("error",reject);server.listen(port,"127.0.0.1",()=>{server.off("error",reject);resolvePromise(server);});
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const root=process.env.SLOPTOGETHER_LOCAL_S3_DATA;
  if(!root)throw new Error("SLOPTOGETHER_LOCAL_S3_DATA_required");
  const server=await createLocalS3Server({root,port:Number(process.env.SLOPTOGETHER_LOCAL_S3_PORT??9000),
    allowedOrigin:process.env.SLOPTOGETHER_LOCAL_S3_ALLOWED_ORIGIN??"http://localhost:3000"});
  console.info(JSON.stringify({event:"local_s3_started",address:"127.0.0.1",port:server.address().port}));
  const stop=()=>server.close(()=>process.exit(0));process.on("SIGINT",stop);process.on("SIGTERM",stop);
}
