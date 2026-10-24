import { NextResponse } from "next/server";
import { publicRuntimeStatus } from "@/lib/server/env";

export const runtime = "nodejs";

export async function GET(){
  return NextResponse.json({
    service:"sloptogether",
    status:"online",
    pathPrefix:"/sloptogether",
    browserOutput:"obs-window-capture",
    configured:publicRuntimeStatus(),
  },{headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
