---
version: studio
name: PeraByte Studio
description: An editorial, image-first workspace for creating connected visual worlds.
colors:
  primary: "#315F4B"
  primary-dark: "#183D30"
  secondary: "#202B27"
  tertiary: "#C96C4C"
  success: "#3D7657"
  warning: "#97602E"
  danger: "#A8463A"
  neutral: "#F4F1E9"
  surface: "#FBF9F4"
  surface-muted: "#E9E5DB"
  border: "#D9D3C7"
  text: "#202B27"
  text-muted: "#758078"
  on-primary: "#FFFFFF"
typography:
  display:
    fontFamily: "Iowan Old Style, Palatino Linotype, Georgia, serif"
    fontSize: 4.375rem
    fontWeight: 500
    lineHeight: 0.99
    letterSpacing: "-0.045em"
  heading:
    fontFamily: "Iowan Old Style, Palatino Linotype, Georgia, serif"
    fontSize: 2.25rem
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Inter, Avenir Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: 0.9375rem
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "Inter, Avenir Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: 0.75rem
    fontWeight: 700
    lineHeight: 1.25
rounded:
  sm: 5px
  md: 8px
  lg: 12px
  xl: 18px
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

## Direction

PeraByte is a working image-making studio for individual frames, motion, stories, reusable characters, and locations. The interface uses the language of an editorial art desk: warm stock, deep evergreen controls, clay accents, restrained borders, and expressive serif display type. Content and generated media carry the visual emphasis.

## Palette

- Warm paper canvas: `#F4F1E9`; raised surfaces: `#FBF9F4`.
- Evergreen is the primary action and selection color: `#234C3B`.
- Clay marks secondary emphasis and wayfinding: `#C96C4C`.
- Ink and muted text use warm charcoal and grey-green, not blue-grey.
- Dark mode uses charcoal green (`#151B18`), parchment text, and sage accents. The navigation rail retains its evergreen palette in both themes.
- Keep status colors semantic and pair them with labels or icons.

## Layout and interaction

- A full-height, fixed left rail anchors the desktop studio. Its groups follow the creative journey: Make, Collect, and Build a world.
- On small screens, use a compact top bar and a slide-over navigation drawer with the same destinations.
- Creation screens prioritize the prompt and settings beside a large preview. Keep primary actions easy to locate and show progress, errors, and saved results in context.
- Library screens put search, sorting, and management controls close to the media grid.
- Use editorial spacing, numbered steps, fine rules, and image-led compositions. Avoid decorative gradients, excessive pills, and stacked dashboard cards.
- Keep controls clear and accessible, with visible focus, readable contrast, and touch targets of at least 44px where practical.

## Components and motion

- Primary buttons use deep evergreen with white text. Secondary actions stay outlined or quiet.
- Cards use warm raised surfaces and restrained shadow. Media itself may use a darker stage for contrast.
- Motion should explain a state change or add a small amount of life; respect reduced-motion preferences.
- The theme choice persists in local storage and follows the operating system before a preference is saved.
