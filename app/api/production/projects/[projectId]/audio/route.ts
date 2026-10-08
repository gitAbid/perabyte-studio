import { createAudioRouteHandlers } from "../../../../../../lib/services/production/audio";

const handlers = createAudioRouteHandlers();
export const POST = handlers.POST;
