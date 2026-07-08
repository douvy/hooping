import { ImageResponse } from "next/og";

// The unfurl card. Static per build — at share scale a gray link card
// costs real players. Drafting register: dark table, paper accent, the
// skip trail as the hero.

export const alt = "SKIP — skip stones across an endless lake";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OG() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: "#111318",
          color: "#eceae0",
          fontFamily: "monospace",
          padding: 80,
        }}
      >
        <div style={{ fontSize: 96, letterSpacing: -2 }}>SKIP</div>
        <div style={{ display: "flex", fontSize: 48, marginTop: 24, color: "#eceae0" }}>
          🪨··💦··💦·💦·💦💦⚓
        </div>
        <div style={{ fontSize: 28, marginTop: 40, color: "#7b7e8a" }}>
          skip stones across an endless lake · same lake for everyone
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 60,
            left: 80,
            right: 80,
            height: 1,
            background: "#474b56",
          }}
        />
      </div>
    ),
    size,
  );
}
