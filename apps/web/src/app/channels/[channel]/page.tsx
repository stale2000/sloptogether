import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";
import { ChannelStreams } from "../../../components/channel-streams";
import { listStreams } from "../../../lib/server/stream-service";
import { ApiError } from "../../../lib/server/http";

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> }): Promise<Metadata> {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) return { title: "Channel" };
  return { title: `@${channel} streams`, description: `Browse @${channel}'s streams.` };
}

export default async function ChannelPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  const slug=channel.toLowerCase();
  let directory;
  try{directory=await listStreams(slug);}
  catch(error){if(error instanceof ApiError&&error.status===404)notFound();throw error;}
  return <ChannelStreams channelSlug={slug} channelName={directory.channel.displayName} initialStreams={directory.streams}/>;
}
