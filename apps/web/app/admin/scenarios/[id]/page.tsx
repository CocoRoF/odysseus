"use client";

import { use, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Scenario } from "@/lib/types";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { ScenarioStudio } from "@/components/ScenarioStudio";
import { Spinner } from "@/components/ui";

export default function EditScenarioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useUser(["admin"]);
  const [scenario, setScenario] = useState<Scenario | null>(null);

  useEffect(() => {
    if (user) api.get<Scenario>(`/scenarios/${id}`).then(setScenario);
  }, [user, id]);

  if (loading || !user || !scenario) return <Spinner />;
  return (
    <Shell user={user} wide>
      <ScenarioStudio initial={scenario} scenarioId={id} />
    </Shell>
  );
}
