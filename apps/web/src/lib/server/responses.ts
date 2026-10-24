import { NextResponse } from "next/server";
import { ApiError, assertSameOrigin, jsonError, jsonOk } from "./http";
import { extensionCorsHeaders } from "./extension-auth";

export function apiSuccess(request:Request,data:unknown,status=200){
  const cors=extensionCorsHeaders(request.headers.get("origin"));
  return jsonOk(data,{status,headers:cors});
}

export function apiFailure(request:Request,error:unknown){
  const base=jsonError(error);
  const headers=new Headers(base.headers);
  for(const [key,value] of extensionCorsHeaders(request.headers.get("origin")))headers.set(key,value);
  return new NextResponse(base.body,{status:base.status,statusText:base.statusText,headers});
}

export async function withApi(request:Request,action:()=>Promise<Response|unknown>,successStatus=200){
  try{
    const value=await action();
    if(value instanceof Response)return value;
    return apiSuccess(request,value,successStatus);
  }catch(error){
    return apiFailure(request,error);
  }
}

export function requireSameOrigin(request:Request){assertSameOrigin(request);}

export function unauthorized(){throw new ApiError(401,"login_required","Connect Twitch to continue.");}
