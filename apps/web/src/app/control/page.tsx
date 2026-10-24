import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../components/site-shell";
import { ControlCenter } from "../../components/control-center";

export const metadata: Metadata = { title: "Control room", robots: { index: false, follow: false } };

export default function ControlPage() {
  return <><SiteHeader control/><main className="shell page-main"><ControlCenter/></main><SiteFooter compact/></>;
}
