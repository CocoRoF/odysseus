"use client";

import { use, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Assessment } from "@/lib/types";
import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { AssessmentForm } from "@/components/AssessmentForm";
import { Spinner } from "@/components/ui";

export default function EditAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useUser(["admin"]);
  const [assessment, setAssessment] = useState<Assessment | null>(null);

  useEffect(() => {
    if (user) api.get<Assessment>(`/assessments/${id}`).then(setAssessment);
  }, [user, id]);

  if (loading || !user || !assessment) return <Spinner />;
  return (
    <Shell user={user}>
      <AssessmentForm initial={assessment} assessmentId={id} />
    </Shell>
  );
}
