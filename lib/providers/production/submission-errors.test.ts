import { describe, expect, it } from "vitest";
import { ProductionApplicationError } from "../../production/errors";
import { isUncertainSubmissionError } from "./submission-errors";

const CONNECTION_CODES=["ECONNRESET","ECONNREFUSED","ECONNABORTED","ETIMEDOUT","EPIPE","UND_ERR_SOCKET","UND_ERR_CONNECT_TIMEOUT"] as const;

describe("isUncertainSubmissionError",()=>{
  it("recognizes network-class error codes carried on the thrown error",()=>{for(const code of CONNECTION_CODES)expect(isUncertainSubmissionError(Object.assign(new Error("request failed"),{code}))).toBe(true);});
  it("recognizes an undici fetch-failed TypeError even when the cause is missing",()=>{expect(isUncertainSubmissionError(new TypeError("fetch failed"))).toBe(true);});
  it("recognizes the real network cause wrapped inside a fetch-failed TypeError",()=>{const cause=Object.assign(new Error("socket hang up"),{code:"ECONNRESET"});expect(isUncertainSubmissionError(new TypeError("fetch failed",{cause}))).toBe(true);});
  it("recognizes network causes nested through multiple cause links",()=>{const inner=new Error("connect timed out") as Error & {code?:string};inner.code="UND_ERR_CONNECT_TIMEOUT";const mid=new Error("request failed",{cause:inner});expect(isUncertainSubmissionError(new TypeError("fetch failed",{cause:mid}))).toBe(true);});
  it("recognizes socket hang ups and stringified connection codes in the message",()=>{expect(isUncertainSubmissionError(new Error("socket hang up"))).toBe(true);expect(isUncertainSubmissionError(new Error("socket ECONNRESET"))).toBe(true);expect(isUncertainSubmissionError(new Error("read ECONNRESET while creating the provider project"))).toBe(true);});
  it("recognizes mid-submit AbortErrors regardless of their constructor",()=>{expect(isUncertainSubmissionError(new DOMException("This operation was aborted","AbortError"))).toBe(true);const aborted=new Error("The operation was aborted");aborted.name="AbortError";expect(isUncertainSubmissionError(aborted)).toBe(true);});
  it("never classifies deterministic provider rejections as uncertain",()=>{expect(isUncertainSubmissionError(new ProductionApplicationError("INVALID_INPUT","HTTP 400: the model rejected these parameters."))).toBe(false);expect(isUncertainSubmissionError(new ProductionApplicationError("CAPABILITY_MISMATCH","Fresh live Sogni capability evidence is required."))).toBe(false);expect(isUncertainSubmissionError(new Error("HTTP 401 unauthorized"))).toBe(false);expect(isUncertainSubmissionError(new Error("HTTP 429 rate limited"))).toBe(false);expect(isUncertainSubmissionError(new Error("Sogni returned an unrecognized project state; result persistence is blocked."))).toBe(false);});
  it("ignores non-error inputs and self-referential cause chains",()=>{expect(isUncertainSubmissionError(null)).toBe(false);expect(isUncertainSubmissionError(undefined)).toBe(false);expect(isUncertainSubmissionError(42)).toBe(false);const loop=new Error("boom") as Error & {cause?:unknown};loop.cause=loop;expect(isUncertainSubmissionError(loop)).toBe(false);});
});
