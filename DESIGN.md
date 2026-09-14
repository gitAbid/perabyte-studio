---
version: alpha
name: PeraByte Studio
description: Calm, polished AI media creation with a blue SaaS interface and visual-first workflows.
colors:
  primary: "#2563EB"
  primary-dark: "#1D4ED8"
  secondary: "#0F172A"
  tertiary: "#7C3AED"
  success: "#15803D"
  warning: "#B45309"
  danger: "#B91C1C"
  neutral: "#F8FAFC"
  surface: "#FFFFFF"
  surface-muted: "#F1F5F9"
  border: "#CBD5E1"
  text: "#0F172A"
  text-muted: "#475569"
  on-primary: "#FFFFFF"
typography:
  display:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 3.5rem
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.04em"
  h1:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 2.25rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  h2:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 1.5rem
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  body:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: Inter, ui-sans-serif, system-ui, sans-serif
    fontSize: 0.875rem
    fontWeight: 600
    lineHeight: 1.25
rounded:
  sm: 8px
  md: 12px
  lg: 20px
  xl: 28px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 48px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: 12px 18px
  button-primary-hover:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: 12px 18px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.md}"
    padding: 12px 18px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: 12px 14px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: 24px
---

## Overview

PeraByte should feel like a welcoming creative workspace rather than a technical AI console. Use generous whitespace, strong media previews, concise labels, and progressive disclosure for advanced controls.

## Colors

- **Primary blue (#2563EB):** Main calls to action, active navigation, links, and selected controls.
- **Deep navy (#0F172A):** Headings and high-emphasis text.
- **Purple (#7C3AED):** Optional Story Mode or creative accent; do not compete with the primary action.
- **Neutral surfaces:** White cards on a pale slate background create a clean SaaS canvas.
- **Semantic colors:** Green for success, amber for warnings, and red for destructive/error states. Always pair color with text or an icon.

## Typography

Use Inter or a metrically compatible sans-serif. Headings should be compact and confident; body text should remain highly readable. Avoid all-caps for essential instructions.

## Layout

Use a responsive 12-column desktop grid with a maximum content width of approximately 1280px. Generator screens use a two-panel workspace on desktop and a single stacked flow on mobile. Keep the primary action visible without requiring excessive scrolling.

## Elevation & Depth

Prefer borders and subtle shadows over heavy elevation. Media cards may use a slightly stronger shadow on hover. Avoid gradients behind important text or controls.

## Shapes

Use rounded cards and controls consistently. Cards are more rounded than inputs; buttons should remain compact and easy to scan. Maintain at least 44px touch targets on mobile.

## Components

Primary buttons are reserved for the main action, especially Generate, Create Story, and Export. Secondary buttons support navigation and reversible actions. Destructive actions require confirmation and use the danger semantic color.

## Do's and Don'ts

- **Do** keep generated media visually dominant.
- **Do** show progress, cost, and recoverability before generation.
- **Do** use skeletons and empty states to explain what is happening.
- **Don't** hide essential errors inside a toast that disappears.
- **Don't** use multiple competing primary buttons in one viewport.
- **Don't** rely on color alone for status or selection.
