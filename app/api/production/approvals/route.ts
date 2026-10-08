import { createApprovalRouteHandlers } from "../../../../lib/services/production/approval";

const handlers = createApprovalRouteHandlers();
export const POST = handlers.POST;
