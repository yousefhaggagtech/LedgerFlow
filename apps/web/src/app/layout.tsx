import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { IdentityProvider } from "@/components/identity/identity-provider";
import { AppFrame } from "@/components/layout/app-frame";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "LedgerFlow | Workspace",
  description: "Your business finances, in one workspace."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={inter.variable}><IdentityProvider><AppFrame>{children}</AppFrame></IdentityProvider></body>
    </html>
  );
}
