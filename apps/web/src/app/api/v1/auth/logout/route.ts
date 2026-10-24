import { NextRequest } from "next/server";
import { revokeRequestSession } from "@/lib/server/session";
import { assertSameOrigin,jsonError,jsonOk } from "@/lib/server/http";

export const runtime="nodejs";

export async function POST(request:NextRequest){
  try{assertSameOrigin(request);await revokeRequestSession(request);return jsonOk({signedOut:true});}
  catch(error){return jsonError(error);}
}
