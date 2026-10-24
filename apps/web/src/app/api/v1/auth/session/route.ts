import { NextRequest } from "next/server";
import { sessionOverview } from "@/lib/server/channel-service";
import { jsonError,jsonOk } from "@/lib/server/http";

export const runtime="nodejs";

export async function GET(request:NextRequest){
  try{return jsonOk(await sessionOverview(request));}catch(error){return jsonError(error);}
}
