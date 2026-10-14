import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clivada",
  description: "Run your business. Not your software.",
  icons: { icon: "/brand/clivada-icon.png", apple: "/brand/clivada-icon.png" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=DM+Sans:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap"
        />
        {/* Applies a remembered light choice before the first paint, so the page never flashes dark first. */}
        <script
          dangerouslySetInnerHTML={{
            __html: 'try{if(localStorage.getItem("cedro-mode")==="light")document.documentElement.dataset.mode="light"}catch(e){}',
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
