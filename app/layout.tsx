import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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

const description =
  "Six trick shots, one ball. Make it and move up, miss once and you start over. Same bounce every time — no luck, just touch. How deep can you go?";

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
      <body className={`${inter.variable} ${jetbrainsMono.variable} font-sans`}>
        <main className="min-h-screen">{children}</main>
        {/* Vercel-only: the insights script is served by their edge, so
            local/CI builds would 404 it and fail */}
        {process.env.VERCEL === "1" && <Analytics />}
      </body>
    </html>
  );
}
