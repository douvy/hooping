import type { Metadata, Viewport } from "next";
import { Caveat, IBM_Plex_Serif, Inter, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

// the display face — the wordmark, GAME OVER, and the canvas pops
const plexSerif = IBM_Plex_Serif({
  weight: ["600", "700"],
  variable: "--font-plex-serif",
  subsets: ["latin"],
});

// the handwriting — one job: the little guy's note when you beat the game
const caveat = Caveat({
  weight: "600",
  variable: "--font-caveat",
  subsets: ["latin"],
});

const description =
  "Six trick shots, one ball. Make it and move up, miss once and you start over. Same bounce every time — no luck, just touch. How deep can you go?";

// a game, not a document: no pinch zoom mid-aim, edge-to-edge on notched
// phones (safe-area padding lives on the two chrome bars), browser chrome
// tinted to match the header
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#4a5f7d",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://hooping.io"),
  title: "Hooping — six trick shots, one ball",
  description,
  openGraph: {
    title: "Hooping",
    description,
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Hooping",
    description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable} ${plexSerif.variable} ${caveat.variable} font-sans`}>
        {/* dvh, not vh — iOS Safari's 100vh overshoots the visible area
            and leaves phantom scroll under the game */}
        <main className="min-h-dvh">{children}</main>
        {/* Vercel-only: the insights script is served by their edge, so
            local/CI builds would 404 it and fail */}
        {process.env.VERCEL === "1" && <Analytics />}
      </body>
    </html>
  );
}
