# UX Design System for Product Features

## 1. Visual direction

PeraByte should feel:

- cinematic
- calm
- creator-first
- image-led
- premium
- understandable without AI expertise

It should not feel like:

- a generic SaaS dashboard
- an engineering console
- a node graph
- a traditional NLE
- a model playground

---

## 2. Screen anatomy

Default feature screens should follow:

```text
┌──────────────────────────────────────────────────────┐
│ Global nav              Workspace: Milo & Luna 🔒    │
├──────────────────────────────────────────────────────┤
│ Page title                         Primary CTA       │
│ short human description                              │
├──────────────────────────────────────────────────────┤
│                                                      │
│                     MAIN CANVAS                      │
│                                                      │
├───────────────────────────────┬──────────────────────┤
│ Secondary content             │ Context inspector    │
└───────────────────────────────┴──────────────────────┘
```

Avoid dense tables unless the content is inherently tabular.

---

## 3. Universal long-action states

Every long-running action must visibly transition through:

```text
Ready → Queued → Running → Completed
                    ↘ Failed
```

Required UI:

- human-readable stage
- current item where possible
- cancel only if safe
- retry action on failure
- specific failure message
- estimated cost before launch
- actual cost after completion when available

Never show an indefinite spinner without a named state.

---

## 4. Universal generation card

```text
┌──────────────────────────────┐
│                              │
│          PREVIEW             │
│                              │
├──────────────────────────────┤
│ Variant 2                    │
│ ★ Recommended                │
│                              │
│ [Use This] [•••]             │
└──────────────────────────────┘
```

Overflow menu:

- Compare
- Favorite
- More Like This
- Change Something
- Delete draft

Approved assets show a clear `Canon` or `Approved` badge.

---

## 5. Universal empty state

Every empty surface must teach the next action.

Bad:

> No items.

Good:

> No environments yet. Create one so PeraByte can keep locations consistent across scenes.  
> **Create Environment**

---

## 6. Universal error style

Use:

> **Scene 04 couldn't generate video**  
> The approved storyboard frame is still safe. You can retry the same take or create a different take.

Avoid:

> ProviderError 503: inference failed.

Provider detail belongs under Diagnostics / Advanced.

---

## 7. Natural-language editing

Where natural-language change is supported, use a consistent box:

```text
Ask for a change
┌────────────────────────────────────────────┐
│ Make Luna look more nervous...             │
└────────────────────────────────────────────┘
[Apply Change]
```

Always show what the system plans to change before expensive/destructive actions.

---

## 8. Locks

Common preservation controls:

- Identity
- Outfit
- Environment
- Composition
- Camera
- Dialogue
- Timing

Default to preserving everything not mentioned.

---

## 9. Responsive behavior

### Desktop
- main canvas + inspector
- multi-card compare
- expandable shot details

### Tablet
- full canvas
- inspector becomes slide-over

### Mobile
- one-column cards
- bottom sheets for inspectors
- no hover-only actions
- primary actions remain reachable with one thumb

Target: WCAG 2.2 AA.

---

## 10. Test IDs

Every primary action and stateful UI surface gets stable `data-testid`.

Format:

```text
feature.entity.action
```

Examples:

```text
character.variant.select
character.refine.submit
storyboard.scene.approve
take.generate.different
publish.export.start
```

Tests should target semantic behavior, not CSS structure.
