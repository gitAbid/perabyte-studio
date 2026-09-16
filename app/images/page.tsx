import type { Metadata } from "next";
import { ImagesLibrary } from "@/components/library/ImagesLibrary";

export const metadata: Metadata = {
  title: "Images & videos",
  description:
    "Your generation library: browse, search, tag, favourite, and reuse every image and video you've made.",
};

export default function ImagesPage() {
  return <ImagesLibrary />;
}
