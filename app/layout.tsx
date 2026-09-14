import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import { StoreBootstrap } from "@/components/StoreBootstrap";
import { ToastProvider } from "@/components/ui";

export const metadata: Metadata = {
  title: {
    default: "PeraByte — AI image & video generation studio",
    template: "%s · PeraByte",
  },
  description:
    "An easy-to-use image and video generation studio for everyone. Create, explore, and bring your imagination to life — in seconds.",
  applicationName: "PeraByte Studio",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:text-white"
        >
          Skip to content
        </a>
        <ToastProvider>
          <StoreBootstrap />
          <SiteHeader />
          <main id="main" className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </ToastProvider>
      </body>
    </html>
  );
}