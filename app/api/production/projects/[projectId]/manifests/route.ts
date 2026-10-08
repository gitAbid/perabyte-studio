import { createManifestRouteHandlers } from "../../../../../../lib/services/production/manifest";

const handlers = createManifestRouteHandlers();
export const POST = handlers.POST;
