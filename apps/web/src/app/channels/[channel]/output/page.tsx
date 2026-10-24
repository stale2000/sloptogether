import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { channelSlugSchema } from "@sloptogether/contracts";
import { OutputSource } from "../../../../components/output-source";

export const metadata: Metadata = {
  title: "Browser program output",
  robots: { index: false, follow: false },
};

export default async function OutputPage({ params }: { params: Promise<{ channel: string }> }) {
  const { channel } = await params;
  if (!channelSlugSchema.safeParse(channel).success) notFound();
  return <OutputSource channel={channel.toLowerCase()} />;
}
