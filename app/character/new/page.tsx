import type { Metadata } from "next";
import { CharacterStudio } from "@/components/character/CharacterStudio";

export const metadata: Metadata = {
  title: "New character — PeraByte",
  description:
    "Create a unique AI character, or seed one from an existing character to design a variation.",
};

export default async function NewCharacterPage({
  searchParams,
}: {
  searchParams: Promise<{ parent?: string }>;
}) {
  const { parent } = await searchParams;
  return <CharacterStudio mode="new" parentId={parent} />;
}
