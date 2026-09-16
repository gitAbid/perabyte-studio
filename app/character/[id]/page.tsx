import type { Metadata } from "next";
import { CharacterStudio } from "@/components/character/CharacterStudio";

export const metadata: Metadata = {
  title: "Edit character — PeraByte",
  description: "Edit this character's identity, re-render, and save changes back to the library.",
};

export default async function EditCharacterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CharacterStudio mode="edit" characterId={id} />;
}
