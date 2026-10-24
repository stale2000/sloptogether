import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./homepage.css";
import "./output-scrubber.css";

export const metadata: Metadata = {
  title: {
    default: "SlopTogether — live stories, made together",
    template: "%s · SlopTogether",
  },
  description: "Shape the next scene. Watch the story move.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.clips.gg/sloptogether"),
  openGraph: { siteName: "SlopTogether", type: "website" },
};

export const viewport: Viewport = {
  themeColor: "#101018",
  colorScheme: "dark light",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
