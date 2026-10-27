import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";

export const metadata: Metadata = { title: "Review channel clips", robots: { index: false, follow: false } };

export default async function ModerationPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  redirect(`/channels/${encodeURIComponent(channel.toLowerCase())}/streams/main/moderate`);
}
