# Settings UI Redesign — Design

**Date:** 2026-09-16
**Status:** Approved (user delegated layout decisions; approved summary design)
**Scope:** Presentation-only redesign of `/settings`. No API, service, or repository changes.

## Problem

`/settings` renders four stacked sections in a single 720px column. The scroll length is
dominated by `ProvidersSection`, where every provider card inline-lists every model
(image, video, and text) as a full-width toggle row — dozens of rows per provider. There
is no anchor navigation, no hierarchy beyond identical section cards, and no way to jump
to a known setting.

## Goals

- Kill the endless scroll: each settings area fits roughly one screen.
- Add navigation between areas with deep-linkable state.
- Increase visual hierarchy and density without leaving the existing token system
  (light + dark must both flip correctly).
- Preserve every existing behavior and payload contract exactly.

## Non-goals

- No new settings, no removed settings.
- No changes to `PUT /api/settings`, `ProviderSettingsUpdate`, optimistic-merge logic,
  `useSettings` store, catalog invalidation, or the uncensored confirmation gate.
- No server round-trips beyond what exists today.

## Layout: two-pane settings shell

- **Left rail (desktop ≥ md):** sticky, in-page nav — icon + label per section. It sits
  inside the content column, next to the existing capsule `SiteSidebar` (two-level nav,
  GitHub/Linear pattern).
- **Mobile (< md):** the rail becomes a horizontal chip row pinned under the page header.
- **Right pane:** renders the active section only, max-width ~680px.
- Section switching is view-switching (not scroll-spy): each pane is short, so the long
  page that made scroll-spy useful no longer exists.
- Active section lives in the URL as `/settings?section=models`, updated via
  `history.replaceState` (read once on mount) to avoid `useSearchParams` Suspense/SSR
  prerender pitfalls in the app router.

### Sections (4)

1. **General** (`sliders` icon)
   - Content preferences: Uncensored Mode toggle (existing `ConfirmDialog` gate and
     warning banner) + Mask 18+ toggle.
   - Task models: Default image model, Default video model, Prompt enhancement selects.
   - Caption: "Per-workspace model picks override these defaults" (existing copy).
2. **Providers** (`chip` icon)
   - One compact row per provider: name, status badge (Off / Active / Needs API key),
     masked-key caption, enable toggle (min-1-provider lock and toast preserved).
   - Chevron expands the row in place to reveal the API key editor (paste/save/clear)
     only — no model lists. This removes the bulk of the old scroll.
   - "Your only enabled provider" hint stays.
3. **Models** (`grid` icon)
   - All picker-visibility toggles, grouped under collapsible per-provider sub-headers.
   - Dense two-column toggle-pill grid per provider (one column on mobile); hint text on
     hover/focus.
   - Per-provider summary ("18 of 24 on"), enable-all / disable-all actions, and a client
     filter box.
   - Same `disabledModels` full-list payload via the existing `toggleModel` logic; bulk
     actions are just conveniences over the same contract. No new guards (current UI
     allows zero enabled models; keep that).
4. **Advanced** (`clock` icon)
   - Render timeouts (image/video minutes fields) essentially unchanged.

### Header / microcopy

- Page header: "Settings" + existing subtitle.
- Small caption near the header: "Changes save automatically." — saves are instant and
  optimistic; the caption pre-empts hunting for a Save button.

## Visual system

- Tokens only (`surface`, `raised`, `border`, `ink`, `muted`, `primary`, `warning`) so
  dark mode flips. No literal hex except the existing warning-banner fix below.
- Section header pattern reused by all four sections: small icon tile (soft surface,
  rounded), section title, one-line description.
- Provider rows: ~48px, `rounded-[14px]` containers consistent with app cards.
- Model pills: compact `role="switch"` buttons with on/off dot state.
- **Dark-mode fix (in scope):** the uncensored warning banner uses literal
  `bg-[#fffbeb] text-warning`; tokenize to a translucent warning surface
  (`bg-warning/10`-style) so it renders correctly in dark mode.

## Files

| File | Change |
| --- | --- |
| `app/settings/page.tsx` | Two-pane shell: data load + optimistic merge (kept), section state via `?section=`, nav + active pane. |
| `components/settings/SettingsNav.tsx` | New: desktop rail + mobile chips. |
| `components/settings/GeneralSection.tsx` | New: content prefs + task models (logic lifted from existing sections). |
| `components/settings/ProvidersSection.tsx` | Slim to auth-only compact rows with expandable key editor. |
| `components/settings/ModelsSection.tsx` | New: grouped model pill grid, counts, bulk actions, filter. |
| `components/settings/RenderTimeoutsSection.tsx` | Renamed role → `AdvancedSection` (timeouts unchanged). |
| `components/settings/ContentPreferencesSection.tsx` | Logic reused inside GeneralSection; banner tokenized. |

## Error handling & loading

- Unchanged: shell-level load error ("Could not load provider settings…"), loading state,
  optimistic rollback with server-truth recovery, toast on save failure. Sections render
  from the same single `data` payload; nav is usable while provider data loads
  (General works from the local store regardless).

## Testing & verification

- No component tests exist for settings UI; all lib-level tests must stay green.
- Manual browser verification (per house style):
  - All four sections: navigation, deep-link `?section=`, mobile chip row.
  - Provider enable/disable incl. last-provider lock toast; key save/clear.
  - Model toggles, enable/disable-all, filter; verify `disabledModels` payload in network
    tab.
  - Task model selects; timeouts commit + clamp.
  - Uncensored confirm flow; Mask 18+; dark + light rendering.
- `npm run build` + full test suite in the worktree.

## Alternatives rejected

- **Sticky scroll-spy over one page** — navigates the scroll, doesn't reduce it.
- **Top tabs** — app identity is the left sidebar; a second rail reads more native, and
  tabs don't scale as sections grow.
- **Settings dialog** — explicitly rejected when `/settings` was specced (page, not
  dialog).
