import { describe, expect, it } from "vitest";
import type { Approval } from "./contracts";
import { latestMatchingApproval } from "./approval-policy";

const approval=(overrides:Partial<Approval>={}):Approval=>({version:1,id:"approval-1",targetKind:"story",targetId:"story-1",targetHash:"a".repeat(64),decision:"approved",actorId:"creator",createdAt:10,checklist:[{id:"review",passed:true,note:"Reviewed"}],notes:"",advisoryAcknowledgements:[],...overrides});

describe("latest matching approval policy",()=>{
  it("requires exact current target kind, ID, and hash",()=>{
    expect(latestMatchingApproval([approval()],"story","story-1","a".repeat(64))).toEqual([approval()]);
    expect(latestMatchingApproval([approval()],"story","story-1","b".repeat(64))).toBeNull();
    expect(latestMatchingApproval([approval()],"animatic","story-1","a".repeat(64))).toBeNull();
    expect(latestMatchingApproval([approval()],"story","other","a".repeat(64))).toBeNull();
  });
  it("uses only the newest timestamp and rejects absent or conflicting tied decisions",()=>{
    const oldRejected=approval({id:"old",decision:"rejected",createdAt:2,checklist:[]});
    expect(latestMatchingApproval([oldRejected,approval()],"story","story-1","a".repeat(64))).toEqual([approval()]);
    expect(latestMatchingApproval([],"story","story-1","a".repeat(64))).toBeNull();
    expect(latestMatchingApproval([approval(),approval({id:"tie-rejected",decision:"rejected",checklist:[]})],"story","story-1","a".repeat(64))).toBeNull();
    expect(latestMatchingApproval([approval(),approval({id:"tie-stale",targetHash:"b".repeat(64)})],"story","story-1","a".repeat(64))).toBeNull();
  });
});
