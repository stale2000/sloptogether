import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";
import { Breadcrumbs, PageTitle, SiteFooter, SiteHeader } from "../../../components/site-shell";
import { ChannelSettings } from "../../../components/control-center";
import { StreamerOverridePanel } from "../../../components/streamer-override-panel";

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> }): Promise<Metadata> {
  const { channel } = await params;
  return { title: `@${channel} channel settings`, robots: { index: false, follow: false } };
}

export default async function ChannelControlPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  return <><SiteHeader control/><main className="shell page-main"><div className="page-top"><Breadcrumbs items={[{label:"Control room",href:"/control"},{label:channel},{label:"Settings"}]}/></div><PageTitle eyebrow="CHANNEL SETTINGS" title="Set your channel rules." description="Contribution, review, trusted workers and subscriber moments are channel-specific."/><div className="channel-control-layout"><ChannelSettings channel={channel.toLowerCase()}/><StreamerOverridePanel channel={channel.toLowerCase()}/></div></main><SiteFooter compact/></>;
}
