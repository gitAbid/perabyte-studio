# Compact Render Settings and Responsive Studio Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the prompt composer’s default height with expandable render options and keep studios usable across narrow and wide screens.

**Architecture:** Keep model selection in the shared `PromptComposer` visible and move the remaining render controls behind an inline disclosure with a live settings summary. Move the viewport-locked, two-panel layout in Story Studio and the image/video generator from the 1024px breakpoint to 1280px; below that, retain the existing content order in a naturally scrolling stack.

**Tech Stack:** Next.js, React, TypeScript, Tailwind CSS 4.

---

## Files and responsibilities

- Modify `components/PromptComposer.tsx`: compute the concise current-settings summary, keep the model field outside the disclosure, render an accessible disclosure row, and make the expanded controls responsive to the composer’s own width.
- Modify `components/GeneratorScreen.tsx`: move only the viewport-fit and two-panel layout rules to the `xl` breakpoint; retain the current header and visual hierarchy.
- Modify `app/story/page.tsx`: apply the same `xl` breakpoint to the scene studio root, workspace columns, and panel scrolling.
- No provider, persistence, generation-payload, or storyboard interaction changes.

## Task 1: Compact render controls in the shared composer

**Files:**
- Modify: `components/PromptComposer.tsx`

- [x] **Step 1: Add derived render summary and disclosure state.**

Add state near the existing prompt budget and derive a summary from only the
settings the current composer can edit:

```tsx
const [renderOptionsOpen, setRenderOptionsOpen] = useState(false);
const renderSummary = [
  allowed.aspects.length > 0 ? settings.aspect : null,
  allowed.resolutions.length > 0 ? settings.resolution : null,
  stylesSupported === false ? null : settings.style,
  kind === "video" ? settings.duration : null,
  !hideRenderCount
    ? `${settings.count} variation${settings.count === 1 ? "" : "s"}`
    : null,
].filter((value): value is string => Boolean(value)).join(" · ");
const hasExpandableRenderOptions = Boolean(renderSummary);
```

- [x] **Step 2: Keep the model field outside the disclosure.**

In the `Render settings` section, preserve its header and the Cast, LoRA, and
More options actions. Move the existing model `PillSelect` out of the grid so
it remains visible, full-width, and first. Keep its current `modelPickerSections`
options, selected value, tail group, and `onModelChange` callback unchanged.

- [x] **Step 3: Add the compact accessible disclosure row.**

Immediately after the model field, render a `type="button"` disclosure only
when `hasExpandableRenderOptions` is true. It must show `renderSummary`, have
`aria-expanded={renderOptionsOpen}`, reference the expanded region with
`aria-controls="render-options-panel"`, and toggle `renderOptionsOpen`. Give
the button an accessible name that announces whether it will show or hide
render options and includes the current summary. Use the existing icon family
for the expand/collapse indicator and visible focus styling consistent with
the other composer buttons.

- [x] **Step 4: Move existing selectors into the inline disclosure.**

Render the existing Aspect ratio, Resolution, Style, Duration, and Variations
`PillSelect` controls unchanged inside the disclosure region. Keep their
existing `allowed` filtering, `stylesSupported` disabled state, change
callbacks, `hideRenderCount` behavior, and model-aware settings. Give the
region `id="render-options-panel"` and render it only while expanded. Do not
put it in a portal, modal, or popover.

Use `@container` on the region and `grid grid-cols-1 gap-2
@sm:grid-cols-2` on its controls grid so the composer width, rather than the
viewport width, decides when two columns fit. Keep the existing non-model
fields in their current order inside that grid.

The model field stays outside this grid. If no editable render option exists,
omit the disclosure row and keep the model and auxiliary controls available.

- [x] **Step 5: Review the resulting JSX and interaction states.**

Confirm the initial state is collapsed, toggling does not change settings,
every existing option still updates `onSettingsChange`, and the expanded
control grid becomes one column when its container is narrow. Keep a 176px
minimum prompt surface and allow the composer itself to scroll at `xl` heights
so expanded controls never collide with the prompt or Generate action. Do not
add automated tests for this UI change; exercise the states during the final
viewport review in Task 3.

## Task 2: Make the workspace split responsive to available width

**Files:**
- Modify: `components/GeneratorScreen.tsx`
- Modify: `app/story/page.tsx`

- [x] **Step 1: Move the generator’s fixed-height and split-layout rules to `xl`.**

In `components/GeneratorScreen.tsx`, change the root from
`lg:h-dvh lg:flex-none lg:overflow-hidden` to
`xl:h-dvh xl:flex-none xl:overflow-hidden`. Change the workspace grid’s
`lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(360px,440px)_minmax(0,1fr)] lg:items-stretch`
to the equivalent `xl:` utilities. Move the composer’s `lg:overflow-y-auto`
and preview panel’s `lg:min-h-0` to `xl:` as well. Leave `lg:mt-5` and the
header subtitle’s `lg:block` unchanged because they do not create the split or
constrain the page height.

- [x] **Step 2: Move the Story Studio’s fixed-height and split-layout rules to `xl`.**

In `app/story/page.tsx`, change the root’s `lg:h-dvh lg:flex-none
lg:overflow-hidden` to the equivalent `xl:` utilities. Move the workspace
grid’s `lg:min-h-0`, `lg:flex-1`, and `lg:grid-cols-[minmax(360px,440px)_minmax(0,1fr)]`
rules to `xl:`. Move the composer column’s `lg:overflow-y-auto` and storyboard
panel/grid `lg:min-h-0`, `lg:overflow-hidden`, `lg:overflow-y-auto`, and
`lg:pr-1` rules to `xl:`. Keep `sm:grid-cols-2` and `2xl:grid-cols-3` on the
scene grid so its tile count remains adaptive.

- [x] **Step 3: Update layout comments to document the 1280px threshold.**

Update the comments beside each workspace root and panel to say that the
side-by-side viewport-fitted layout starts at `xl`/1280px. Below it, the
composer remains first and the page scrolls through the stacked panels.

## Task 3: Verify settings and responsive behavior

**Files:**
- Verify: `components/PromptComposer.tsx`
- Verify: `components/GeneratorScreen.tsx`
- Verify: `app/story/page.tsx`

- [x] **Step 1: Run the TypeScript check.**

Run: `npm run typecheck`
Expected: exit code 0 with no TypeScript errors.

- [x] **Step 2: Review both shared-composer routes at narrow widths.**

Run the app with `npm run dev`, then inspect `/story` and `/generate/video` at
390px and 1024px viewport widths. Confirm the page is naturally scrollable,
the composer appears before its adjacent panel, the collapsed model is
visible, the render summary opens/closes, and no horizontal overflow or
clipped Generate action appears. At 390px, open the render disclosure and
confirm its fields use one column when the composer is narrow.

- [x] **Step 3: Review the two-panel workspace at and above the breakpoint.**

At 1279px wide, confirm the composer and storyboard/preview are stacked and
the page can scroll. At 1280px and 1920px wide, confirm they are side-by-side;
the header and panels fit the viewport, and panel content scrolls internally
when the viewport height is short (700px). At 1280×700, open the render
options, scroll the composer, and confirm each field and Generate remain
reachable without overlap. Confirm the settings disclosure does not reset the
prompt or any selected settings.

- [x] **Step 4: Inspect the final diff.**

Run: `git diff --check`
Expected: no whitespace errors. Review `git diff -- components/PromptComposer.tsx components/GeneratorScreen.tsx app/story/page.tsx` and confirm the changes are limited to the compact settings control and responsive breakpoint behavior.
