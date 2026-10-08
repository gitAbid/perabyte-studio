import type { Metadata } from "next";
import { EnvironmentLibrary } from "@/components/environments/EnvironmentLibrary";

export const metadata: Metadata = {
  title: "Environments",
  description:
    "Your environment canon: reusable places with a canonical plate, structured lighting and derived views, reused across scenes so every render sits in the same world.",
};

export default function EnvironmentsPage() {
  return <EnvironmentLibrary />;
}
