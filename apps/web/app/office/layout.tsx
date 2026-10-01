import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "사무실",
  description: "시험마다 방이 있는 사무실 한 층 — 방으로 가서 스탠딩 데스크 앞에 서면 시험이 시작됩니다.",
};

export default function OfficeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
