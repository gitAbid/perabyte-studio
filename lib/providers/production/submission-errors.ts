// C18-UNCERTAIN-SUBMISSION (contract-first, offline): shared classification for
// provider submission transport failures whose outcome the caller cannot observe.
// When the submission step throws one of these, the request may have already
// reached the provider and been accepted (connection reset/refused mid-submit,
// socket hang up, undici "fetch failed", a mid-submit abort), so the job must
// land in submission_unknown with errorCode SUBMISSION_UNKNOWN and must never be
// auto-retried or resubmitted; only durable reconciliation
// (recoverSubmission/resolveSubmissionUnknown) may attach a provider receipt.
// Deterministic provider rejections (the provider answered: validation, auth,
// quota, capability) must never match. User cancellation is expressed through
// job status (cancel_requested) and never through this classification, so an
// abort that fires during submit is treated as uncertain, not as a cancel.

const UNCERTAIN_ERROR_CODES:ReadonlySet<string>=new Set([
  "ECONNRESET","ECONNREFUSED","ECONNABORTED","ETIMEDOUT","EPIPE",
  "UND_ERR_SOCKET","UND_ERR_CONNECT_TIMEOUT",
]);
const CONNECTION_CODE_IN_MESSAGE=/\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\b/;
const SOCKET_HANG_UP=/socket hang ?up/i;
const OPERATION_ABORTED=/\boperation was aborted\b/i;
const FETCH_FAILED=/^fetch failed$/;
/** Bounded cause-chain walk: cycle guard plus depth cap. */
const MAX_CAUSE_DEPTH=10;

interface FailureNode{code?:unknown;name?:unknown;message?:unknown;cause?:unknown}

/** True only when the failure shape makes the submission outcome unobservable. */
export function isUncertainSubmissionError(error:unknown):boolean{
  return hasUncertainCause(error,new Set<unknown>(),0);
}
function hasUncertainCause(error:unknown,visited:Set<unknown>,depth:number):boolean{
  if(error===null||typeof error!=="object"||depth>MAX_CAUSE_DEPTH||visited.has(error))return false;
  visited.add(error);
  const node=error as FailureNode;
  if(typeof node.code==="string"&&UNCERTAIN_ERROR_CODES.has(node.code))return true;
  if(node.name==="AbortError")return true;
  const message=typeof node.message==="string"?node.message:"";
  if(SOCKET_HANG_UP.test(message)||CONNECTION_CODE_IN_MESSAGE.test(message)||OPERATION_ABORTED.test(message))return true;
  if(error instanceof TypeError&&FETCH_FAILED.test(message.trim()))return true;
  return hasUncertainCause(node.cause,visited,depth+1);
}
