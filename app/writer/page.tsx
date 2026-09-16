import type { Metadata } from "next";
import { WriterView } from "@/components/writer/WriterView";

export const metadata: Metadata = {
  title: "Writer",
  description: "Compose a story with AI, then split it into scenes to render.",
};

export default function WriterPage() {
  return <WriterView />;
}
