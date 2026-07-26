import type { Metadata } from "next";
import "./globals.css";

const title = "Aside — Ask about the work. Don’t interrupt it.";
const description =
  "Search every local Codex, Claude Code, and Pi thread, see what needs your attention, and keep a persistent side chat beside the work.";
const siteOrigin =
  process.env.NEXT_PUBLIC_SITE_ORIGIN ?? "https://aside.vgnsh.xyz";

export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin),
  alternates: {
    canonical: "/",
  },
  title,
  description,
  icons: {
    icon: "/aside-icon.svg",
    shortcut: "/aside-icon.svg",
    apple: "/aside-icon.svg",
  },
  openGraph: {
    type: "website",
    url: siteOrigin,
    siteName: "Aside",
    title,
    description,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "Aside — a side chat for your coding agents",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
