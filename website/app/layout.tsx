import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const title = "Aside — Ask about the work. Don’t interrupt it.";
const description =
  "Read-only, persistent side chats for the Codex, Claude Code, and Pi threads already on your Mac.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "aside.local";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    metadataBase: new URL(origin),
    title,
    description,
    icons: {
      icon: "/aside-icon.svg",
      shortcut: "/aside-icon.svg",
      apple: "/aside-icon.svg",
    },
    openGraph: {
      type: "website",
      url: origin,
      siteName: "Aside",
      title,
      description,
      images: [
        {
          url: `${origin}/og.png`,
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
      images: [`${origin}/og.png`],
    },
  };
}

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
