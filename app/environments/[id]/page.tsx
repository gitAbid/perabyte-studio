import type { Metadata } from "next";
import { EnvironmentDetail } from "@/components/environments/EnvironmentDetail";

export const metadata: Metadata = {
  title: "Environment — PeraByte",
  description:
    "This environment's canonical plate, derived views, structured state and version history.",
};

export default async function EnvironmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <EnvironmentDetail environmentId={id} />;
}
