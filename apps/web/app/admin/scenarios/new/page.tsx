"use client";

import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { ScenarioStudio } from "@/components/ScenarioStudio";
import { Spinner } from "@/components/ui";

export default function NewScenarioPage() {
  const { user, loading } = useUser(["admin"]);
  if (loading || !user) return <Spinner />;
  return (
    <Shell user={user} wide>
      <ScenarioStudio />
    </Shell>
  );
}
