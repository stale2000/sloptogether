import { NextRequest } from "next/server";
import { jsonError } from "@/lib/server/http";
import { completeTwitchOAuth } from "@/lib/server/oauth";

export const runtime="nodejs";

export async function GET(request:NextRequest){
  try{return await completeTwitchOAuth(request);}catch(error){return jsonError(error);}
}
