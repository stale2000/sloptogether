import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";
import { OutputSource } from "../../../../../../components/output-source";
import { findChannel } from "../../../../../../lib/server/channels";
import { getStream } from "../../../../../../lib/server/stream-service";
import { ApiError } from "../../../../../../lib/server/http";

type Params={params:Promise<{channel:string;stream:string}>};
export const metadata:Metadata={title:"Browser stream output",robots:{index:false,follow:false}};
export default async function StreamOutputPage({params}:Params){
  const {channel,stream}=await params;
  if(!channelSlugSchema.safeParse(channel).success)notFound();
  let channelRow;let streamRow;
  try{channelRow=await findChannel(channel.toLowerCase());streamRow=await getStream(channelRow.twitch_channel_id,stream.toLowerCase());}
  catch(error){if(error instanceof ApiError&&error.status===404)notFound();throw error;}
  return <OutputSource channel={channelRow.twitch_login} streamSlug={streamRow.slug}/>;
}
