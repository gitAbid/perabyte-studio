import type { Metadata } from "next";
import { ProjectCreationFlow } from "@/components/production/project-canon";

export const metadata: Metadata = {
  title: "New production project — PeraByte",
  description: "Create a production project with reusable cast and world canon and the first script revision.",
};

export default function NewProductionProjectPage() {
  return <ProjectCreationFlow />;
}
