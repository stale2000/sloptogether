import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { channelSlugSchema } from "@sloptogether/contracts";
import { Breadcrumbs, PageTitle, SiteHeader, SiteFooter } from "../../../../../../components/site-shell";
import { ChannelModerationQueue } from "../../../../../../components/control-center";
import { findChannel } from "../../../../../../lib/server/channels";
import { getStream } from "../../../../../../lib/server/stream-service";
import { ApiError } from "../../../../../../lib/server/http";

type Params={params:Promise<{channel:string;stream:string}>};
export const metadata:Metadata={title:"Review stream clips",robots:{index:false,follow:false}};
export default async function StreamModerationPage({params}:Params){
  const {channel,stream}=await params;
  if(!channelSlugSchema.safeParse(channel).success)notFound();
  let channelRow;let streamRow;
  try{channelRow=await findChannel(channel.toLowerCase());streamRow=await getStream(channelRow.twitch_channel_id,stream.toLowerCase());}
  catch(error){if(error instanceof ApiError&&error.status===404)notFound();throw error;}
  const slug=channelRow.twitch_login;const streamName=streamRow.slug;
  const playbackOnlyDemo=slug==="localdemo"&&process.env.NEXT_PUBLIC_LOCAL_DEMO_ENABLED==="true";
  return <div className="moderation-view"><SiteHeader control/><main className="shell page-main"><div className="page-top"><Breadcrumbs items={[{label:"Channels",href:"/"},{label:slug,href:`/channels/${encodeURIComponent(slug)}`},{label:streamRow.display_name,href:`/channels/${encodeURIComponent(slug)}/streams/${encodeURIComponent(streamName)}`},{label:"Moderate"}]}/></div>
    <PageTitle title="Review clips" action={<div className="row"><Link className="button secondary small" href={`/control/${encodeURIComponent(slug)}`}>Settings</Link><Link className="button secondary small" href={`/channels/${encodeURIComponent(slug)}/streams/${encodeURIComponent(streamName)}/output`}>Watch stream</Link></div>}/>
    {playbackOnlyDemo?<section className="auth-card"><div><h2>No review queue in this demo.</h2><p>Connect Twitch to review clips from a channel.</p><Link className="button" href="/control">Connect Twitch</Link></div></section>:<ChannelModerationQueue channel={slug} streamSlug={streamName}/>}
  </main><SiteFooter compact/></div>;
}
