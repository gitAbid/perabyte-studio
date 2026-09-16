import type { Metadata } from "next";
import { StoriesLibrary } from "@/components/library/StoriesLibrary";

export const metadata: Metadata = {
  title: "Stories",
  description:
    "Your story library: open, rename, duplicate, and manage every multi-scene story you've started.",
};

export default function StoriesPage() {
  return <StoriesLibrary />;
}
