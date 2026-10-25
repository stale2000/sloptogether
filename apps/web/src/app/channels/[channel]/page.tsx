import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> }): Promise<Metadata> {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) return { title: "Channel" };
  return { title: `@${channel}`, description: `Watch @${channel}'s channel program.` };
}

export default async function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  redirect(`/channels/${encodeURIComponent(channel.toLowerCase())}/output`);
}
