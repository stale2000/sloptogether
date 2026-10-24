import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";
import { ChannelWorkspace } from "../../../components/channel-workspace";

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> }): Promise<Metadata> {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) return { title: "Channel" };
  return { title: `@${channel} channel`, description: `Vote on and watch @${channel}'s shared live story.` };
}

export default async function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  return <ChannelWorkspace channelSlug={channel.toLowerCase()} />;
}
