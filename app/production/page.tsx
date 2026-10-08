import type { Metadata } from "next";
import { ProjectListPanel } from "@/components/production/project-canon";

export const metadata: Metadata = {
  title: "Production — PeraByte",
  description: "Production projects: reusable canon, script revisions and provenance.",
};

export default function ProductionIndexPage() {
  return <ProjectListPanel />;
}
