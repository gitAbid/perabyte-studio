import type { Metadata } from "next";
import { StyleGuideView } from "@/components/StyleGuideView";

export const metadata: Metadata = {
  title: "UI elements & style guide",
  description:
    "The PeraByte Studio design tokens: colours, typography, buttons, inputs and containers.",
};

export default function StyleGuidePage() {
  return <StyleGuideView />;
}