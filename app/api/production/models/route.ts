import { createProductionModelsHandler } from "../../../../lib/providers/production/http-routes";

export const runtime = "nodejs";

export const GET = createProductionModelsHandler();
