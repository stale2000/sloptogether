import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/site-shell";
import { WorkerDownloads } from "../../components/worker-downloads";

export const metadata: Metadata = { title: "Windows GPU worker" };

export default function DownloadsPage() {
  return <><SiteHeader/><main className="shell page-main"><WorkerDownloads/></main><SiteFooter compact/></>;
}
