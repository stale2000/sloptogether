import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";
import { SiteHeader, SiteFooter } from "../../../../components/site-shell";
import { ChannelModerationQueue } from "../../../../components/control-center";

export const metadata: Metadata = { title: "Review channel clips", robots: { index: false, follow: false } };

export default async function ModerationPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  return <><SiteHeader control/><main className="shell page-main"><ChannelModerationQueue channel={channel.toLowerCase()}/></main><SiteFooter compact/></>;
}
