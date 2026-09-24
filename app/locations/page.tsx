import type { Metadata } from "next";
import { LocationLibrary } from "@/components/locations/LocationLibrary";

export const metadata: Metadata = {
  title: "Locations",
  description:
    "Your location library: saved places with reference plates, reused across scenes so every render anchors to the same world.",
};

export default function LocationsPage() {
  return <LocationLibrary />;
}
