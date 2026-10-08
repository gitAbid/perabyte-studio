import { CreateStoryProposalCommandSchema } from '@/lib/production/proposals';
import { assessProposalText } from '@/lib/services/production/moderation-gate';
import { ProductionApplicationError } from '@/lib/production/errors';
import { assertSameOriginMutation, getRequestId, productionErrorResponse, readProductionJson } from '@/lib/production/http';
import { withProductionStore } from '@/lib/production/runtime';
import { isTextProvider, type TextProvider } from '@/lib/providers/types';
import { getInstalledPolicy } from '@/lib/services/production/policy-service';
import { generateStoryProposal } from '@/lib/services/production/proposals';
import { recordGeneration } from '@/lib/services/production/metrics';
import { resolveChainTextProvider } from '@/lib/services/production/text-chain-provider';
type Context = { params: Promise<{ projectId: string }> };
export const runtime = 'nodejs';

function budgetBlocked(): ProductionApplicationError {
  return new ProductionApplicationError('BUDGET_BLOCKED', 'Text proposal generation is not authorized: no reviewed text entitlement or standing budget authorization exists for text proposals.', { action: 'Edit the script manually, or configure I01 text-charge coverage before proposing.', retryable: false });
}

/**
 * No chain engine publishes a context window today, so the adapter declares a
 * conservative bound per model. The production planner compares raw UTF-8
 * bytes against this token count (byte >= token), so the bound errs on the
 * safe side and over-long plans fail visibly with model_limit instead of
 * silently truncating at the provider.
 */

export async function POST(request: Request, context: Context) {
  const requestId = getRequestId(request);
  try {
    assertSameOriginMutation(request);
    const { projectId } = await context.params;
    const command = await readProductionJson(request, CreateStoryProposalCommandSchema);
    if (command.projectId !== projectId) throw new ProductionApplicationError('INVALID_INPUT', 'Route project ID does not match command project ID');
    // F3 moderation pre-check: advisory gate over the submitted script; gate-level
    // categories block before any entitlement/spend path runs. Suggestive-only
    // text passes with advisories ignored here (they never approve or reject anything).
    const moderation = assessProposalText(command.scriptText);
    if (!moderation.allowed) {
      const codes = moderation.advisories.map((advisory) => advisory.code).join(', ');
      throw new ProductionApplicationError('INVALID_INPUT', `Story proposal was blocked by the moderation pre-check (${codes}).`, { action: 'Revise the script text and resubmit.', retryable: false });
    }
    // F1 entitlement seam: a reviewed spend policy installed on this machine is
    // the reviewed text entitlement. Without one the route stays exactly as
    // fail-closed as before; nothing else about admission changes.
    const installed = await getInstalledPolicy();
    if (!installed.configured || !installed.policy) throw budgetBlocked();
    const policy = installed.policy;
    const now = Date.now();
    if (policy.providerId !== command.providerId) {
      throw new ProductionApplicationError('BUDGET_BLOCKED', `The installed reviewed policy covers provider ${policy.providerId}, not the selected provider ${command.providerId}.`, { action: 'Install a reviewed policy for the selected provider, or select the covered provider.', retryable: false });
    }
    if (policy.capturedAt > now || policy.expiresAt <= now) {
      throw new ProductionApplicationError('BUDGET_BLOCKED', 'The installed reviewed policy is expired or not yet valid; text proposal generation stays blocked.', { action: 'Rotate the reviewed policy in Settings → Budget & authorization.', retryable: false });
    }
    const provider = resolveChainTextProvider(command.providerId);
    if (!isTextProvider(provider)) throw new ProductionApplicationError('CAPABILITY_MISMATCH', `No enabled text engine is available for provider ${command.providerId}.`, { retryable: false });
    // I01 integration: the atomic budget reservation for text spend slots in
    // here — compose the text budget quote + account evidence through
    // createProductionBudgetComposer (its quote draft path binds media recipes
    // only today), call createProductionBudgetService().reserveInTransaction(...)
    // for the planned chunk estimate inside the store transaction that persists
    // the proposal, and reconcile(reservationId, reference) after the provider
    // call returns. The reviewed-policy gate above is the entitlement seam
    // those steps will consume; until they land, generation runs unreserved
    // under the policy's install-time review only.
    const startedAt = Date.now();
    const result = await withProductionStore(async (store) => {
      const proposal = await generateStoryProposal(store, provider, command);
      // C19 best-effort product metric: recordGeneration never throws, so a failed
      // metric write can never fail the proposal response.
      recordGeneration(store, {
        projectId, workspaceId: null, kind: 'story_proposal_completed',
        at: Date.now(), durationMs: Math.max(0, Date.now() - startedAt), costMicros: null,
        dims: { provider: command.providerId, model: command.modelId, kind: command.kind },
      });
      return proposal;
    });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return productionErrorResponse(error, requestId); }
}
