import type { Metadata } from "next";
import { CharacterStudio } from "@/components/character/CharacterStudio";

export const metadata: Metadata = {
  title: "Edit character — PeraByte",
  description:
    "Edit this character's identity, re-render the sheet in place, and save changes back.",
};

export default async function EditCharacterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CharacterStudio mode="edit" characterId={id} />;
}
