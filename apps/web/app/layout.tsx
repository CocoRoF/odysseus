import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/toast";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "https://odysseus.hrletsgo.me"),
  title: { default: "Odysseus", template: "%s · Odysseus" },
  description: "실무 시뮬레이션 기반 개발자 평가 플랫폼 — Explore. Uncover. Solve.",
  applicationName: "Odysseus",
  manifest: "/manifest.webmanifest",
  // app/icon.png · app/apple-icon.png 는 Next 의 파일 규약으로 서빙된다. 그런데 metadata.icons
  // 를 일부만 적으면 파일 규약 링크가 <head> 에서 빠지므로(실측), 전부 명시한다.
  icons: {
    icon: [{ url: "/icon.png", type: "image/png", sizes: "512x512" }],
    shortcut: "/favicon.ico",
    apple: [{ url: "/apple-icon.png", type: "image/png", sizes: "180x180" }],
  },
  openGraph: {
    title: "Odysseus",
    description: "문제는 지문이 아니라 상황이다 — 실무 시뮬레이션 개발자 평가",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
    type: "website",
  },
  appleWebApp: { title: "Odysseus", statusBarStyle: "black" },
};

export const viewport = { themeColor: "#050805" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
