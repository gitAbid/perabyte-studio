import type { Metadata } from "next";
import { GeneratorScreen } from "@/components/GeneratorScreen";

export const metadata: Metadata = {
  title: "Video studio",
  description:
    "Bring your ideas to life with motion. Choose duration, aspect ratio and cinematic style.",
};

export default function GenerateVideoPage() {
  return <GeneratorScreen kind="video" />;
}
