import { permanentRedirect } from "next/navigation";

/**
 * Legacy route: "Places" is now the Environment Studio. Every request is
 * permanently redirected so old links and bookmarks keep working while the
 * canonical route lives at /environments.
 */
export default function LocationsPage(): never {
  permanentRedirect("/environments");
}
