"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import type { User } from "@/lib/types";
import { homeFor } from "@/components/useUser";
import { Spinner } from "@/components/ui";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api
      .get<User>("/auth/me")
      .then((u) => router.replace(homeFor(u.role)))
      .catch(() => router.replace("/login"));
  }, [router]);
  return <Spinner label="이동 중..." />;
}
