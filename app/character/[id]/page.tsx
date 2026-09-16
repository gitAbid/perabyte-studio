import type { Metadata } from "next";
import { CharacterDetail } from "@/components/character/CharacterDetail";

export const metadata: Metadata = {
  title: "Character — PeraByte",
  description:
    "Preview this character's sheet, renders and full specification; copy it, or seed a new generation.",
};

export default async function CharacterPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <CharacterDetail characterId={id} />;
}
