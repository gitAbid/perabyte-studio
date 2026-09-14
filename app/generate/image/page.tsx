import type { Metadata } from "next";
import { GeneratorScreen } from "@/components/GeneratorScreen";

export const metadata: Metadata = {
  title: "Generate Image",
  description:
    "Turn your idea into stunning images. Adjust aspect ratio, resolution and style to get the perfect result.",
};

export default function GenerateImagePage() {
  return <GeneratorScreen kind="image" />;
}