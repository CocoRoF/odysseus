"use client";

import { useUser } from "@/components/useUser";
import { Shell } from "@/components/Shell";
import { AssessmentForm } from "@/components/AssessmentForm";
import { Spinner } from "@/components/ui";

export default function NewAssessmentPage() {
  const { user, loading } = useUser(["admin"]);
  if (loading || !user) return <Spinner />;
  return (
    <Shell user={user}>
      <AssessmentForm />
    </Shell>
  );
}
