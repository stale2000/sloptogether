import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";

export const metadata: Metadata = {
  title: "Browser program output",
  robots: { index: false, follow: false },
};

export default async function OutputPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  redirect(`/channels/${encodeURIComponent(channel.toLowerCase())}/streams/main/output`);
}
