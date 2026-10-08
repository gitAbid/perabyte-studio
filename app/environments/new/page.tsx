import type { Metadata } from "next";
import { EnvironmentCreate } from "@/components/environments/EnvironmentCreate";

export const metadata: Metadata = {
  title: "New environment — PeraByte",
  description:
    "Describe a place, generate candidate plates, and pin structured canon defaults for scenes to inherit.",
};

export default function NewEnvironmentPage() {
  return <EnvironmentCreate />;
}
