import { ChannelDirectory } from "../components/channel-directory";
import { SiteFooter, SiteHeader } from "../components/site-shell";

export default function HomePage() {
  return (
    <div className="home-page">
      <a className="skip-link" href="#channels">Skip to channels</a>
      <SiteHeader />
      <main className="home-main">
        <ChannelDirectory />
      </main>
      <SiteFooter compact />
    </div>
  );
}
