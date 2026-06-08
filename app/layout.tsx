import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Preflight MCP",
  description: "Multi-chain AI trading oracle",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
