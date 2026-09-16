import type { Metadata } from "next";
import { CharacterLibrary } from "@/components/character/CharacterLibrary";

export const metadata: Metadata = {
  title: "Characters",
  description:
    "Your character library: browse, search, tag, and create variations of every AI character you've saved.",
};

export default function CharacterPage() {
  return <CharacterLibrary />;
}
