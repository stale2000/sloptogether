import { NextRequest } from "next/server";
import { jsonError } from "@/lib/server/http";
import { startTwitchOAuth } from "@/lib/server/oauth";

export const runtime="nodejs";

export async function GET(request:NextRequest){
  try{return await startTwitchOAuth(request);}catch(error){return jsonError(error);}
}
