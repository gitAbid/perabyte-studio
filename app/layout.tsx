import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ConditionalFooter, SiteSidebar } from "@/components/SiteChrome";
import { StoreBootstrap } from "@/components/StoreBootstrap";
import { ToastProvider } from "@/components/ui";
import { themeInitScript } from "@/lib/theme";

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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the inline theme script below adds `.dark`
    // to <html> before React hydrates, which is an expected mismatch.
    <html lang="en" suppressHydrationWarning>
      {/* Column on mobile (top bar above content), row on md+ (sidebar
          beside content) — the mobile top bar is a direct body child. */}
      <body className="flex min-h-dvh flex-col md:flex-row">
        {/* Runs before first paint: applies the stored (or OS) theme and
            avoids a light→dark flash on load. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:text-canvas"
        >
          Skip to content
        </a>
        <SiteSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <ToastProvider>
            <StoreBootstrap />
            <main id="main" className="flex flex-1 flex-col">
              {children}
            </main>
            <ConditionalFooter />
          </ToastProvider>
        </div>
      </body>
    </html>
  );
}
