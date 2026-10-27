import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";
import { ChannelWorkspace } from "../../../../../../components/channel-workspace";
import { findChannel } from "../../../../../../lib/server/channels";
import { getStream } from "../../../../../../lib/server/stream-service";
import { ApiError } from "../../../../../../lib/server/http";

type Params={params:Promise<{channel:string;stream:string}>};
export async function generateMetadata({params}:Params):Promise<Metadata>{
  const {channel,stream}=await params;
  return {title:`Join ${stream} · @${channel}`};
}
export default async function StreamParticipatePage({params}:Params){
  const {channel,stream}=await params;
  if(!channelSlugSchema.safeParse(channel).success)notFound();
  let channelRow;let streamRow;
  try{channelRow=await findChannel(channel.toLowerCase());streamRow=await getStream(channelRow.twitch_channel_id,stream.toLowerCase());}
  catch(error){if(error instanceof ApiError&&error.status===404)notFound();throw error;}
  return <ChannelWorkspace channelSlug={channelRow.twitch_login} streamSlug={streamRow.slug}/>;
}
