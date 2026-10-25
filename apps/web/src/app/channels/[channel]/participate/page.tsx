import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";
import { ChannelWorkspace } from "../../../../components/channel-workspace";

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> }): Promise<Metadata> {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) return { title: "Channel participation" };
  return { title: `Join @${channel}'s story` };
}

export default async function ParticipatePage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  return <ChannelWorkspace channelSlug={channel.toLowerCase()} />;
}
