import type { Metadata, Viewport } from "next";
import Script from "next/script";
import Particles from "@/components/Particles";
import { SpecularButtonEffects } from "@/components/SpecularButton";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quorum — AI-powered Group Discussions",
  description:
    "Host online group discussions, invite participants with a link and code, transcribe speech live, get AI-assisted moderation and download evaluated PDF reports.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f5f7f6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {`try { if (localStorage.getItem("quorum-theme") === "dark") document.documentElement.dataset.theme = "dark"; } catch {}`}
        </Script>
      </head>
      <body className="isolate min-h-dvh font-sans antialiased">
        <SpecularButtonEffects />
        <Particles
          particleColors={["#ffffff"]}
          particleCount={200}
          particleSpread={10}
          speed={0.2}
          particleBaseSize={100}
          glow={0.5}
          twinkle={0.3}
          moveParticlesOnHover
          hoverEffect="parallax"
        />
        <div className="relative z-10 min-h-dvh">{children}</div>
      </body>
    </html>
  );
}
