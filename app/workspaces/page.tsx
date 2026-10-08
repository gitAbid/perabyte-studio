import type { Metadata } from "next";
import { WorkspacesBrowser } from "@/components/workspaces/WorkspacesBrowser";

export const metadata: Metadata = {
  title: "Workspaces",
  description:
    "Your workspaces: each one is a show's home for its characters, places, world rules, and production recipe.",
};

export default function WorkspacesPage() {
  return <WorkspacesBrowser />;
}
