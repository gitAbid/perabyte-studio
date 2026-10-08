# <Feature Name>

**Requirement family:** FR-XX  
**Owner:** <team/subagent>  
**Creator Alpha:** Required | Partial | Deferred

---

## 1. Purpose

One paragraph explaining the creator problem this feature solves.

---

## 2. Goals

- ...
- ...
- ...

---

## 3. Non-goals

- ...
- ...
- ...

---

## 4. Routes / entry points

- `/...`
- `/...`

---

## 5. Primary UI/UX flow

```text
Entry
  ↓
Action
  ↓
Generated state
  ↓
Review
  ↓
Approval / handoff
```

---

## 6. Screen format

```text
┌──────────────────────────────────────────────────────┐
│ Workspace: Example 🔒                  Primary CTA   │
├──────────────────────────────────────────────────────┤
│                                                      │
│                    MAIN PREVIEW                      │
│                                                      │
├───────────────────────────────┬──────────────────────┤
│ Options / history             │ Inspector            │
│                               │ Change something...  │
└───────────────────────────────┴──────────────────────┘
```

---

## 7. User stories

### US-1
As a creator, I want to ... so that ...

Acceptance:
- ...
- ...

---

## 8. Data / shared contracts

Consumes:

- `Workspace`
- `CanonRevision`
- `GenerationJob`

Owns:

- `<FeatureLocalEntity>`

Must not redefine shared contracts.

---

## 9. State model

```text
Empty
 ↓
Draft
 ↓
Generating
 ↓
Ready
 ↓
Recommended
 ↓
Approved
```

Document stale/error/cancel states explicitly.

---

## 10. Actions

| User action | State change | Backend operation | Cost? |
|---|---|---|---|
| Generate | ... | ... | yes |
| Try Again | ... | exact retry | maybe |
| More Like This | ... | lead reference | yes |
| Change Something | ... | delta edit | yes |
| Approve | ... | approval record | no |

---

## 11. Failure UX

For every async operation document:

- queued
- running
- partial success
- retry
- exact error copy
- state preservation

---

## 12. Service/API responsibilities

```ts
interface FeatureService {
  // ...
}
```

Include only public contracts here.

Provider-specific implementation belongs behind adapters.

---

## 13. Accessibility / responsive behavior

Desktop:
- ...

Mobile:
- ...

Keyboard:
- ...

Focus behavior:
- ...

---

## 14. Analytics / product metrics

- time to ...
- acceptance rate
- retry rate
- cost
- failure rate

---

## 15. Acceptance tests

1. ...
2. ...
3. ...

---

## 16. Parallel subagent plan

### Agent A — UI
Owns:
- ...

### Agent B — domain/service
Owns:
- ...

### Agent C — provider/infrastructure
Owns:
- ...

### QA Agent
Owns:
- ...

### Integrator
Owns:
- shared schema/migrations
- public contract
- cross-feature tests

---

## 17. Dependencies

Upstream:
- ...

Downstream:
- ...

Parallel-safe with:
- ...

---

## 18. Definition of done

- [ ] Feature UX complete.
- [ ] Empty/loading/error/partial states complete.
- [ ] Shared contracts preserved.
- [ ] Unit tests.
- [ ] Contract tests.
- [ ] E2E happy path.
- [ ] Failure injection.
- [ ] Accessibility.
- [ ] Responsive behavior.
- [ ] Documentation/handoff.
