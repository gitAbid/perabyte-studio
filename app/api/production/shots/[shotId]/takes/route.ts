import { createMediaRouteHandlers } from "../../../../../../lib/services/production/takes";
import { withProductionComposition } from "../../../../../../lib/production/composition";
import { getRequestId, productionErrorResponse } from "../../../../../../lib/production/http";

export const POST = (request: Request, context: { params: Promise<{ shotId: string }> }): Promise<Response> =>
  withProductionComposition(async composition => createMediaRouteHandlers({
    withStore: async operation => operation(composition.store),
    serviceOptions: {
      resolveBillingMode: composition.composer.resolveBillingMode,
      quoteRecipe: composition.composer.prepareMediaQuoteDraft,
      commitPreparedQuote: composition.composer.commitPreparedQuote,
      readAssetVerified: composition.readAssetVerified,
    },
  }).takePOST(request, context), { role: "web" }).catch((error: unknown) => productionErrorResponse(error, getRequestId(request)));
