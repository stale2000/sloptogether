import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { channelSlugSchema } from "@sloptogether/contracts";
import { Breadcrumbs, PageTitle, SiteHeader, SiteFooter } from "../../../../components/site-shell";
import { ChannelModerationQueue } from "../../../../components/control-center";

export const metadata: Metadata = { title: "Review channel clips", robots: { index: false, follow: false } };

export default async function ModerationPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  const slug = channel.toLowerCase();
  const playbackOnlyDemo = slug === "localdemo" && process.env.NEXT_PUBLIC_LOCAL_DEMO_ENABLED === "true";
  return <><SiteHeader control/><main className="shell page-main">{playbackOnlyDemo ? <>
    <div className="page-top"><Breadcrumbs items={[{label:"Channels",href:"/"},{label:slug,href:`/channels/${encodeURIComponent(slug)}`},{label:"Moderate"}]}/></div>
    <PageTitle eyebrow="PLAYBACK-ONLY DEMO" title="No review queue in this demo." description="The four localdemo clips are static playback fixtures. They have no pending uploads or moderation decisions." action={<Link className="button secondary small" href={`/channels/${encodeURIComponent(slug)}/output`}>Watch the stream</Link>}/>
    <section className="auth-card"><span className="auth-symbol" aria-hidden="true">◈</span><div><span className="section-label">REAL CHANNEL MODERATION</span><h2>Connect Twitch to review clips.</h2><p>Moderation queues are available after a broadcaster or moderator signs in and connects a real channel.</p><Link className="button" href="/control">Open control room <span aria-hidden="true">↗</span></Link></div></section>
  </> : <ChannelModerationQueue channel={slug}/>}</main><SiteFooter compact/></>;
}
