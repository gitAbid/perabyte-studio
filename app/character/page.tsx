import type { Metadata } from "next";
import { CharacterStudio } from "@/components/character/CharacterStudio";

export const metadata: Metadata = {
  title: "Character Studio",
  description:
    "Create unique AI characters for your images and videos. Design every detail — from appearance to personality.",
};

export default function CharacterPage() {
  return <CharacterStudio />;
}
