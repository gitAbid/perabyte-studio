import { createBudgetRouteHandlers } from "../../../../../../lib/services/production/budget";
import { withProductionComposition } from "../../../../../../lib/production/composition";
import type { ProductionComposition } from "../../../../../../lib/production/composition";

const handlers = (composition: ProductionComposition) => createBudgetRouteHandlers({
  withStore: async operation => operation(composition.store),
  serviceOptions: {
    resolveAccountIdentity: composition.composer.resolveAccountIdentity,
    prepareExecutionEvidence: composition.composer.prepareExecutionEvidence,
    currentCredentialBindingId: composition.composer.currentCredentialBindingId,
  },
});

export const GET = (request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> =>
  withProductionComposition(async composition => handlers(composition).GET(request, context), { role: "web" });

export const POST = (request: Request, context: { params: Promise<{ projectId: string }> }): Promise<Response> =>
  withProductionComposition(async composition => handlers(composition).POST(request, context), { role: "web" });
