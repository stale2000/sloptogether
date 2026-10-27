import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { channelSlugSchema } from "@sloptogether/contracts";
import { SiteFooter, SiteHeader, Breadcrumbs, PageTitle } from "../../../../../components/site-shell";
import { findChannel } from "../../../../../lib/server/channels";
import { getStream } from "../../../../../lib/server/stream-service";
import { ApiError } from "../../../../../lib/server/http";

type Params={params:Promise<{channel:string;stream:string}>};
export async function generateMetadata({params}:Params):Promise<Metadata>{
  const {channel,stream}=await params;
  return {title:`${stream} · @${channel}`,description:`Watch ${stream} from @${channel}.`};
}
export default async function StreamPage({params}:Params){
  const {channel,stream:streamSlug}=await params;
  if(!channelSlugSchema.safeParse(channel).success)notFound();
  let channelRow;let stream;
  try{channelRow=await findChannel(channel.toLowerCase());stream=await getStream(channelRow.twitch_channel_id,streamSlug.toLowerCase());}
  catch(error){if(error instanceof ApiError&&error.status===404)notFound();throw error;}
  const base=`/channels/${encodeURIComponent(channelRow.twitch_login)}/streams/${encodeURIComponent(stream.slug)}`;
  return <><SiteHeader/><main className="shell page-main"><div className="page-top"><Breadcrumbs items={[{label:"Channels",href:"/"},{label:channelRow.twitch_login,href:`/channels/${encodeURIComponent(channelRow.twitch_login)}`},{label:stream.display_name}]}/></div>
      <PageTitle eyebrow="CHANNEL STREAM" title={stream.display_name} description={`@${channelRow.twitch_login}`}/>
      <section className="panel-list">
        <article className="panel"><div className="panel-label">PROGRAM</div><h2>Watch</h2><Link className="button" href={`${base}/output`}>Open stream</Link></article>
        <article className="panel"><div className="panel-label">COMMUNITY</div><h2>Vote</h2><Link className="button secondary" href={`${base}/participate`}>Join this stream</Link></article>
        <article className="panel"><div className="panel-label">MODERATION</div><h2>Review</h2><Link className="button secondary" href={`${base}/moderate`}>Open review queue</Link></article>
      </section>
    </main><SiteFooter compact/></>;
}
