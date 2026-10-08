# AI Story Production Studio — UI/UX Product Specification (verbatim product vision)

> Provenance: pasted by the product owner 2026-10-06 and adopted as the **behavioral
> authority** for PeraByte. Fused into
> `docs/PERABYTE_STORY_PRODUCTION_REQUIREMENTS.md` (v2.0), which owns capability/scope
> reality. This file is preserved verbatim and unedited below the rule line.

---

# AI Story Production Studio
## UI/UX Product Specification

### Product Vision

Design a polished, opinionated AI creative production studio that allows users to create consistent characters and environments, develop stories and storyboards, generate complete scenes and videos, add intelligent voice acting, music and sound, and publish finished content with minimal manual effort.

The product should support:

- episodic animated series
- short films
- children's stories
- cinematic stories
- music videos
- social shorts
- trailers
- recurring branded content

The experience should feel like an **AI production studio/showrunner**, not a collection of disconnected AI-generation tools.

The user expresses creative intent and approves results.

The platform handles the underlying complexity.

---

# 1. Core Product Philosophy

The interface should follow five principles.

### 1. Selection over configuration

Whenever possible:

**Generate options → choose one → refine it**

Avoid exposing technical generation controls by default.

### 2. Canon before prompts

Characters and environments become reusable visual identities.

Once selected, users should not repeatedly describe them in prompts.

### 3. Workspace isolation

A workspace defines exactly which characters, environments, styles, voices, rules and previous productions are available to its AI context.

Assets outside the workspace must not influence generation unless explicitly selected.

### 4. Progressive complexity

Beginners should be able to generate an episode from one idea.

Advanced users should be able to open scenes, shots, audio layers and generation versions when necessary.

### 5. AI produces the first complete result

The system should automatically make reasonable decisions regarding:

- storytelling
- shot composition
- camera direction
- character placement
- environment selection
- video generation
- voices
- emotional delivery
- music
- sound effects
- transitions
- captions
- final editing

The user primarily reviews and corrects.

---

# 2. Product Mental Model

```text
GLOBAL CREATIVE SYSTEM

Characters
Environments
Generation
Library
     │
     │ selected into
     ▼
WORKSPACE
     │
     ├── Selected Characters
     ├── Selected Environments
     ├── Selected Voices
     ├── Style
     ├── World Rules
     ├── Production Defaults
     └── Continuity
            │
            ▼
       PRODUCTIONS
            │
            ├── Episode
            ├── Story
            ├── Music Video
            ├── Short
            └── Trailer
                    │
                    ▼
             Story → Board
                    ↓
                 Scenes
                    ↓
                 Video
                    ↓
               Voice/Audio
                    ↓
               Final Edit
                    ↓
                 Publish
```

---

# 3. Primary Product Navigation

Keep the application navigation deliberately small.

```text
HOME

WORKSPACES

CREATE
├── Characters
├── Environments
└── Generate

LIBRARY

────────────────

RECENT WORKSPACES
├── Milo & Luna Adventures
├── NOVA Music Videos
└── Kids Shorts

+ New Workspace
```

### Main high-level capabilities

**Characters**

Create and manage reusable consistent characters.

**Environments**

Create and manage reusable consistent locations/worlds.

**Generate**

Generate stories, storyboards, scenes, episodes, videos, music videos and other productions.

**Workspaces**

Create isolated creative contexts using selected assets and configurations.

**Library**

Browse generated media and reusable creative assets.

---

# 4. Home

The home screen should emphasize continuation and creation.

## Layout

```text
┌──────────────────────────────────────────────────────────────┐
│ Story Studio                                      Profile    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ What do you want to create?                                 │
│                                                              │
│ [ Create Character ] [ Create Environment ] [ Generate ✨ ] │
│                                                              │
│ YOUR WORKSPACES                                              │
│                                                              │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐    │
│ │ Milo & Luna    │ │ NOVA           │ │ Kids Shorts    │    │
│ │ 12 productions │ │ 4 productions  │ │ 19 productions │    │
│ └────────────────┘ └────────────────┘ └────────────────┘    │
│                                                              │
│ CONTINUE WORKING                                             │
│                                                              │
│ Episode 08       Music Video 02       Dragon Short           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Primary actions should always be obvious.

Avoid dashboard analytics unless genuinely useful.

---

# 5. Character Studio

Characters are a global, high-level capability.

Characters can later be selected into one or more workspaces.

## Character Library

```text
CHARACTERS

[ + Create Character ]

Search...

┌──────────┐  ┌──────────┐  ┌──────────┐
│  Milo    │  │  Luna    │  │ Robot X  │
│          │  │          │  │          │
└──────────┘  └──────────┘  └──────────┘

┌──────────┐  ┌──────────┐
│  Sarah   │  │ Grandpa  │
└──────────┘  └──────────┘
```

Each card may show:

- character portrait
- name
- visual style
- workspace usage
- canon indicator

Do not overload cards with metadata.

---

# 6. Create Character

Character creation follows:

```text
Describe
   ↓
Generate variants
   ↓
Select
   ↓
Refine
   ↓
Approve
   ↓
Save Canon
```

## Initial screen

```text
CREATE CHARACTER

Describe your character

┌─────────────────────────────────────────────────┐
│ Curious young inventor with messy dark hair,   │
│ warm personality and adventurous clothing.     │
└─────────────────────────────────────────────────┘

Optional
[ + Add reference image ]

Style
[ Use default workspace/style ▾ ]

                     [ Generate ]
```

Technical parameters remain hidden.

---

# 7. Character Variant Selection

Generate approximately **3–4 strong candidates** by default.

Each generated candidate should preferably be a single character-sheet style image containing multiple useful views.

```text
CHOOSE A DIRECTION

┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│             │ │             │ │             │
│  Variant A  │ │  Variant B  │ │  Variant C  │
│             │ │             │ │             │
└─────────────┘ └─────────────┘ └─────────────┘

                  ✓ Selected B

[ Generate More ]      [ Continue with B ]
```

Users should be able to:

- select any variant
- zoom
- compare
- favorite
- generate more variations based on a selected candidate

---

# 8. Character Refinement

Once a candidate is selected, edits should preserve identity.

```text
MILO — SELECTED VERSION

┌──────────────────────────────────────────────┐
│                                              │
│             CHARACTER SHEET                  │
│                                              │
└──────────────────────────────────────────────┘

Quick changes

[ Outfit ] [ Hair ] [ Colors ] [ Expression ]
[ Accessories ] [ Age ] [ Style ]

Describe a change
┌──────────────────────────────────────────────────┐
│ Make the jacket red and remove the backpack.    │
└──────────────────────────────────────────────────┘

[ Apply Change ]

Versions
V1 ─ V2 ─ V3 ─ V4 ✓

[ Generate Similar ]            [ Save Character ]
```

### Important behavior

Refinement must operate on the selected variant.

Changing clothing should not accidentally produce a completely different face.

---

# 9. Character Canon

Once approved:

**Save as Character**

The system creates a canonical character identity containing:

```text
Character
│
├── Master appearance
├── Face reference
├── Full-body reference
├── Front / side / rear references
├── Expressions
├── Default outfit
├── Optional outfits
├── Personality
├── Voice association
└── Identity embedding/reference data
```

Users should not need to manually understand this structure.

They simply see a polished character profile.

---

# 10. Environment Studio

Environments are also a global, high-level capability.

```text
ENVIRONMENTS

[ + Create Environment ]

┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Treehouse    │ │ Magic Forest │ │ Mars Base    │
└──────────────┘ └──────────────┘ └──────────────┘
```

---

# 11. Create Environment

Use the same interaction model as characters.

```text
Describe
   ↓
Generate 3–4 variants
   ↓
Select
   ↓
Refine
   ↓
Approve
   ↓
Save Canon
```

Example:

```text
CREATE ENVIRONMENT

A cozy magical treehouse surrounded by enormous
ancient trees and softly glowing plants.

[ Add Reference ]

                         [ Generate ]
```

---

# 12. Environment Variant Selection

```text
CHOOSE A WORLD

┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Variant A   │ │ Variant B ✓ │ │ Variant C   │
└─────────────┘ └─────────────┘ └─────────────┘

[ Generate More Like B ]

                       [ Continue ]
```

---

# 13. Environment Refinement

```text
MAGICAL TREEHOUSE

┌──────────────────────────────────────────────┐
│                                              │
│              ENVIRONMENT                     │
│                                              │
└──────────────────────────────────────────────┘

Quick Changes

[ Lighting ]
[ Time ]
[ Weather ]
[ Colors ]
[ Props ]
[ Layout ]
[ Mood ]

Describe change

[ Make the forest more magical and change to sunset. ]

                         [ Apply ]
```

Once approved, the platform can automatically create supporting references:

```text
Environment
│
├── Main view
├── Wide establishing view
├── Alternative angles
├── Interior views
├── Day
├── Sunset
├── Night
└── Weather variants
```

---

# 14. Global vs Workspace Assets

Characters and environments exist globally.

Workspaces reference them.

Example:

```text
GLOBAL CHARACTER LIBRARY

Milo
Luna
Robot X
Sarah
Grandpa
Astronaut
```

Workspace:

```text
MILO & LUNA ADVENTURES

Selected Characters
✓ Milo
✓ Luna
✓ Grandpa

Not selected
Robot X
Sarah
Astronaut
```

Only selected characters are available to generation inside this workspace.

---

# 15. Workspace Concept

A workspace is a **scoped creative preset/universe**.

It combines selected assets and production context without duplicating the entire global library.

A workspace may represent:

- animated series
- YouTube channel
- music artist
- film
- content brand
- advertising campaign
- story universe

---

# 16. Create Workspace

Keep creation lightweight.

```text
CREATE WORKSPACE

Workspace Name
[Milo & Luna Adventures]

Characters
[ + Select Characters ]

Selected
[Milo ×] [Luna ×]

Environments
[ + Select Environments ]

Selected
[Treehouse ×] [Magical Forest ×]

Style
[Stylized 3D Animation ▾]

Default Format
[Episode ▾]

Language
[English ▾]

                     [ Create Workspace ]
```

Users can configure additional settings later.

---

# 17. Workspace Isolation Rule

This is a critical product requirement.

### Generation context may include

```text
✓ selected workspace characters
✓ selected workspace environments
✓ selected workspace voices
✓ workspace visual style
✓ workspace story rules
✓ workspace continuity
✓ workspace production history
✓ currently selected production
```

### Generation context must exclude

```text
✕ unrelated global characters
✕ unrelated environments
✕ other workspace stories
✕ unrelated voices
✕ other workspace generation history
✕ unrelated styles
```

Global assets remain available for explicit selection but must not automatically influence generation.

---

# 18. Workspace Home

```text
MILO & LUNA ADVENTURES

Stylized 3D Adventure Series

Characters
[Milo] [Luna] [Grandpa]          [ Manage ]

Environments
[Treehouse] [Forest] [Village]   [ Manage ]

──────────────────────────────────────────

What do you want to make?

[ Episode ] [ Short ] [ Story ] [ Trailer ]

──────────────────────────────────────────

RECENT PRODUCTIONS

Episode 08
Episode 07
Halloween Special
Trailer 01
```

The strongest CTA:

**Create Next**

For episodic content this should be extremely prominent.

---

# 19. Workspace Asset Management

Users can explicitly add or remove global assets.

```text
WORKSPACE CHARACTERS

IN THIS WORKSPACE

✓ Milo
✓ Luna

GLOBAL LIBRARY

○ Robot X
○ Sarah
○ Grandpa

[ + Add Selected ]
```

Adding a character should make it available to future workspace generations.

Removing one should stop new generations from using it but should not break historical productions containing it.

---

# 20. Workspace-Specific Variants

A workspace may override or extend a global asset without changing the global original.

Example:

```text
GLOBAL MILO
     │
     └── Milo & Luna Workspace
          │
          ├── Default Milo
          ├── Winter Outfit
          └── Explorer Outfit
```

Workspace-specific variants stay isolated unless the user chooses:

**Save to Global Library**

---

# 21. Generate — High-Level Creation

Generate is the central production capability.

```text
GENERATE

What do you want to create?

[ Episode ]
[ Story ]
[ Short ]
[ Music Video ]
[ Trailer ]
[ Scene ]
[ Video ]
```

If entered through a workspace, generation automatically uses that workspace context.

---

# 22. Generation Context Header

Always make active scope visible.

```text
Generate Episode

Workspace
[Milo & Luna Adventures 🔒]

Characters
[Milo] [Luna]

Available Environments
[Treehouse] [Forest] [Village]

Style
Stylized 3D Adventure
```

The lock communicates that generation is isolated to this workspace.

---

# 23. Minimal Episode Creation

Ideal workflow:

```text
CREATE EPISODE

What happens?

┌────────────────────────────────────────────────┐
│ Milo and Luna discover a tiny sleeping dragon │
│ while exploring the forest.                   │
└────────────────────────────────────────────────┘

Length
[ ~5 min ]

                       [ Create Episode ✨ ]
```

That can be enough.

The platform determines everything else.

---

# 24. AI Production Pipeline

Internally:

```text
IDEA
 ↓
STORY
 ↓
SCRIPT
 ↓
SCENES
 ↓
STORYBOARD
 ↓
SHOT PLAN
 ↓
CHARACTER + ENVIRONMENT BINDING
 ↓
DRAFT VIDEO
 ↓
VOICE ACTING
 ↓
LIP SYNC
 ↓
MUSIC
 ↓
SFX
 ↓
EDIT
 ↓
FINAL VIDEO
 ↓
PUBLISH
```

The user should not have to manually execute every internal step.

---

# 25. Production Navigation

Inside a production expose only four major stages.

```text
DESIGN        STORY        PRODUCE        PUBLISH
  ✓             ✓             ●              ○
```

### DESIGN

Review production-specific characters, locations and visual direction.

### STORY

Story, script and storyboard.

### PRODUCE

Video scenes, voice, music, sound and corrections.

### PUBLISH

Final edit, export and publishing.

---

# 26. Story Studio

Story creation should be conversational rather than form-heavy.

```text
EPISODE 09

Tell us what happens

[Milo finds a mysterious seed that grows overnight.]

                         [ Generate Story ]
```

System creates:

```text
Story
│
├── Title
├── Synopsis
├── Story beats
├── Scenes
├── Dialogue
└── Ending
```

The user can ask:

```text
Make the ending funnier.
Give Luna more dialogue.
Add a chase before Scene 6.
Make this appropriate for younger children.
```

---

# 27. Storyboard Studio

Storyboard should be the main visual planning interface.

```text
EPISODE 09 — THE MAGIC SEED

01             02             03             04
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ Forest  │ →  │ Seed    │ →  │ Garden  │ →  │ Tree    │
└─────────┘    └─────────┘    └─────────┘    └─────────┘

00:00          00:25          00:58          01:30
```

Each card should contain:

- storyboard image
- scene title
- duration
- major characters
- environment
- generation state

Users can drag scenes to reorder them.

---

# 28. Storyboard Scene Detail

```text
SCENE 03 — THE GARDEN

┌───────────────────────────────────────────────┐
│                                               │
│              STORYBOARD IMAGE                 │
│                                               │
└───────────────────────────────────────────────┘

Characters
Milo • Luna

Environment
Treehouse Garden

Action
Milo carefully plants the mysterious glowing seed.

Dialogue

Luna:
"Are you sure we should do this?"

Milo:
"Only one way to find out."

Camera
Medium shot → slow push in

Duration
18 sec

[ Regenerate ] [ Edit ] [ Approve ]
```

---

# 29. Shot Complexity

Shots should exist internally but remain collapsed by default.

```text
Scene 03

▸ Shots (5)
```

Expanding reveals:

```text
Shot 01 — Establishing
Shot 02 — Milo medium
Shot 03 — Luna reaction
Shot 04 — Seed close-up
Shot 05 — Push into soil
```

This provides professional control without intimidating casual users.

---

# 30. Scene Generation

The platform automatically combines:

```text
Story context
+
Character canon
+
Environment canon
+
Outfit state
+
Visual style
+
Camera direction
+
Current action
+
Dialogue
+
Previous scene
+
Continuity state
        ↓
VIDEO GENERATION
```

Users should not manually construct prompts from these elements.

---

# 31. Scene Generation UI

```text
SCENE 03 OF 8

┌──────────────────────────────────────────────────────┐
│                                                      │
│                   VIDEO PREVIEW                      │
│                                                      │
└──────────────────────────────────────────────────────┘

✓ Milo
✓ Luna
✓ Treehouse Garden
✓ Character consistency
✓ Environment
✓ Voice
✓ Sound
✓ Music

───────────────────────────────────────────────────────

Ask for a change

┌──────────────────────────────────────────────────────┐
│ Make Luna look more nervous and move closer.        │
└──────────────────────────────────────────────────────┘

                        [ Apply ]
```

Natural-language editing should be the main correction mechanism.

---

# 32. Video Variants

Video generation should use the same selection model as character/environment generation.

```text
TAKES

Take 1
Take 2 ✓
Take 3

[ Generate Another ]
```

Users can select the best take.

The chosen take becomes the scene's current approved version.

Previous takes remain recoverable.

---

# 33. Continuity Engine

Continuity should operate silently.

The platform should validate:

```text
Character identity
Character outfit
Character age
Character accessories
Environment identity
Lighting continuity
Object placement
Story chronology
Character relationships
Previous shot
Previous scene
```

If the system detects an issue, it can automatically repair or notify the user.

Example:

```text
Continuity issue detected

Milo's jacket differs from Scene 04.

[ Fix Automatically ]
```

Avoid exposing technical AI terminology.

---

# 34. Intelligent Voice System

Voices belong to characters.

Example:

```text
MILO

Voice
Young • energetic • curious

Language
English

Delivery
Automatic
```

The scene determines emotional delivery.

```text
Character voice identity
+
Dialogue
+
Scene emotion
+
Character action
+
Story context
        ↓
VOICE PERFORMANCE
```

The user should not need to manually configure obscure voice-generation parameters.

---

# 35. Voice Overrides

Users should still have simple optional controls.

```text
Luna — Scene 05

Delivery
[ Auto ▾ ]

Optional presets

Calm
Excited
Scared
Angry
Whisper
Shout

[ Regenerate Voice ]
```

Default should remain **Auto**.

---

# 36. Music and Sound

The system automatically analyzes each scene.

Example:

```text
Scene Audio

Dialogue
✓

Ambience
Forest at night

Sound Effects
Footsteps
Leaves
Dragon movement

Music
Mysterious Adventure

[ Edit Audio ]
```

The user should receive a complete audio pass automatically.

---

# 37. Production Editor

Default view:

```text
┌────────────────────────────────────────────────────────┐
│ EPISODE 09                               Preview       │
├────────────┬───────────────────────────────────────────┤
│            │                                           │
│ Scene 01 ✓ │                                           │
│ Scene 02 ✓ │              VIDEO                        │
│ Scene 03 ● │              PREVIEW                      │
│ Scene 04 ○ │                                           │
│ Scene 05 ○ │                                           │
│            │                                           │
├────────────┴───────────────────────────────────────────┤
│ ✨ Ask for a change...                                │
│ [ Make this scene feel more dramatic             ] ➜ │
└────────────────────────────────────────────────────────┘
```

The AI command bar should remain available throughout production.

---

# 38. Advanced Timeline

The timeline should exist but not dominate the experience.

Use:

**Advanced Edit**

to open:

```text
VIDEO
──────────── Scene clips ────────────

VOICE
────────── Character dialogue ───────

MUSIC
──────────── Background score ───────

SFX
─────────── Effects / ambience ──────

CAPTIONS
──────────── Subtitle track ─────────
```

This supports professional corrections while keeping the default interface simple.

---

# 39. Auto Mode

Auto Mode should become a flagship experience.

```text
What do you want to make?

[Milo and Luna accidentally wake a sleeping dragon.]

Length
[5 minutes]

                      [ Create Episode ✨ ]
```

The platform automatically handles:

```text
Story
Script
Storyboard
Shots
Visual generation
Video
Voices
Lip sync
Music
Sound
Editing
Captions
```

Then:

```text
YOUR FIRST CUT IS READY

[ Watch Episode ]

[ Make Changes ]             [ Publish ]
```

---

# 40. Music Video Mode

Music videos should use the same underlying production architecture.

```text
CREATE MUSIC VIDEO

Upload Song
[ Choose Audio ]

Workspace
[NOVA]

Visual direction
[ Optional description ]

                      [ Create Concept ]
```

AI performs:

```text
Song analysis
↓
Lyrics / sections
↓
Beat structure
↓
Visual concept
↓
Storyboard
↓
Character/environment matching
↓
Scene generation
↓
Beat synchronization
↓
Edit
↓
Final video
```

---

# 41. Publish Studio

```text
READY TO PUBLISH

┌────────────────────────────────────────┐
│                                        │
│              FINAL VIDEO               │
│                                        │
└────────────────────────────────────────┘

Episode 09 — The Magic Seed
05:48

✓ Video
✓ Voice
✓ Music
✓ Sound
✓ Captions

Title
[ The Magic Seed | Milo & Luna Adventures ]

Description
[ Generated automatically... ]

Thumbnail

[ Option 1 ] [ Option 2 ] [ Option 3 ]

Platforms

☑ YouTube
☐ YouTube Shorts
☐ TikTok
☐ Instagram

                         [ Publish ]
```

---

# 42. Export Options

Support:

```text
16:9  Landscape
9:16  Vertical
1:1   Square
4:5   Social
Custom
```

Quality options can remain simple:

```text
Standard
High Quality
Master
```

Avoid exposing codecs and bitrates unless the user chooses advanced export.

---

# 43. Direct Platform Integration

Publishing architecture should support integrations such as:

```text
YouTube
YouTube Shorts
TikTok
Instagram
Other future channels
```

The system can automatically prepare:

- title
- description
- hashtags
- thumbnail
- captions
- chapters
- aspect ratio
- platform-specific version

The user approves before publishing.

---

# 44. Library

The Library is for discovery and reuse, not workspace context.

```text
LIBRARY

All
Characters
Environments
Images
Videos
Audio
Stories
Storyboards
Productions
```

An asset existing here does **not** mean it enters every AI generation.

Workspace selection controls context.

---

# 45. Versioning

Every important generated object should support history.

```text
Character
├── V1
├── V2
├── V3 ✓
└── V4

Environment
├── V1
├── V2 ✓
└── V3

Scene
├── Take 1
├── Take 2 ✓
└── Take 3
```

Users should feel safe experimenting.

Do not overwrite approved versions silently.

---

# 46. Canon vs Generation

Make this a core system concept.

### Canon

Approved reusable identity.

Examples:

- Milo's appearance
- Luna's voice
- Treehouse design
- world rules
- visual style

### Generation

Individual output.

Examples:

- storyboard frame
- scene video
- voice take
- image variant
- music cue

Only explicit user approval should alter Canon.

---

# 47. Recommended Information Architecture

```text
ACCOUNT
│
├── GLOBAL ASSETS
│   ├── Characters
│   ├── Environments
│   ├── Voices
│   ├── Styles
│   └── Media
│
├── WORKSPACES
│   │
│   └── Workspace
│       ├── Selected Characters
│       ├── Selected Environments
│       ├── Selected Voices
│       ├── Selected Style
│       ├── World Rules
│       ├── Production Defaults
│       │
│       └── Productions
│           │
│           └── Production
│               ├── Story
│               ├── Scenes
│               │   └── Shots
│               ├── Storyboard
│               ├── Video Takes
│               ├── Audio
│               └── Export
│
└── LIBRARY
```

---

# 48. Key Entity Relationships

```text
Character
   └── can belong to many Workspaces

Environment
   └── can belong to many Workspaces

Workspace
   ├── selects Characters
   ├── selects Environments
   └── owns Productions

Production
   └── belongs to exactly one Workspace

Scene
   └── belongs to a Production

Generated Take
   └── belongs to a Scene
```

A production should retain a snapshot of relevant canon/configuration so older episodes remain reproducible even when global assets later change.

---

# 49. Design Language

The visual identity should feel:

- premium
- cinematic
- modern
- creative
- calm
- AI-native
- approachable
- professional

Avoid making it look like:

- a generic SaaS dashboard
- an engineering console
- a Photoshop clone
- a node-based generation tool
- a complex traditional video editor

Reference feeling:

**Netflix browsing simplicity + modern creative studio + AI-native conversational editing.**

---

# 50. UI Principles

Use large visual previews.

Prefer imagery over metadata.

Use cards heavily for:

- characters
- environments
- productions
- storyboard scenes
- variants
- takes

Keep primary CTAs obvious.

Use progressive disclosure for advanced features.

Keep technical model settings out of the primary interface.

Show context visually.

Example:

```text
Using

[Milo]
[Luna]
[Forest]

Workspace: Milo & Luna
```

rather than displaying a large generated prompt.

---

# 51. Primary CTA Language

Prefer language users naturally understand.

Use:

**Generate Variants**

**Use This Character**

**Use This Environment**

**Generate More Like This**

**Make a Change**

**Create Story**

**Create Episode**

**Generate Scene**

**Approve**

**Create Next Episode**

**Publish**

Avoid:

**Inference**

**Seed**

**CFG**

**Reference Weight**

**Sampler**

**Context Strength**

unless explicitly exposed under advanced settings.

---

# 52. Empty-State Philosophy

Every empty state should teach the next action.

Example:

```text
No characters yet.

Create your first reusable character.
We'll keep their appearance consistent across your stories.

[ Create Character ]
```

Workspace:

```text
No productions yet.

Tell us what should happen and we'll create
your first story, storyboard and episode.

[ Create First Episode ]
```

---

# 53. Onboarding

Avoid long setup wizards.

Recommended sequence:

```text
Create Workspace
↓
Choose/create characters
↓
Choose/create environments
↓
Enter first idea
↓
Generate
```

Do not require users to configure voices, music, models or export settings before creating something.

Those can be inferred and changed later.

---

# 54. Target First-Time Experience

A new user should ideally be able to:

```text
Create workspace
      ↓
Generate/select character
      ↓
Generate/select environment
      ↓
Enter one-sentence story idea
      ↓
Receive storyboard
      ↓
Approve
      ↓
Receive generated first cut
```

without understanding the underlying AI stack.

---

# 55. Returning User Experience

The returning workflow should be even shorter.

```text
Open Workspace

MILO & LUNA ADVENTURES

[ Create Next Episode ]

What happens?

[Milo and Luna find a secret tunnel.]

                 [ Create ]
```

Characters, environments, style, voices and continuity are already established.

This recurring workflow is a major product advantage.

---

# 56. Final Product Structure

The UI should ultimately communicate this simple mental model:

```text
CHARACTERS
Create reusable people.

ENVIRONMENTS
Create reusable worlds.

WORKSPACES
Choose what belongs together.

GENERATE
Turn those ingredients into stories and video.

PUBLISH
Turn completed productions into deliverable content.
```

Internally the platform can be highly sophisticated.

Externally the user should feel:

> "I describe what I want, choose what I like, and the studio handles the production."

---

# 57. Primary End-to-End Experience

```text
CREATE CHARACTER
↓
Generate variants
↓
Select
↓
Tweak
↓
Save Canon

            +

CREATE ENVIRONMENT
↓
Generate variants
↓
Select
↓
Tweak
↓
Save Canon

            ↓

CREATE / OPEN WORKSPACE
↓
Select characters
↓
Select environments
↓
Set style/defaults

            ↓

CREATE PRODUCTION
↓
Enter idea
↓
Generate story
↓
Generate storyboard
↓
Review / change
↓
Generate scenes
↓
Select best video takes
↓
Automatic voice acting
↓
Automatic sound/music
↓
Automatic edit

            ↓

FIRST CUT

            ↓

Natural-language corrections

            ↓

FINALIZE

            ↓

EXPORT / PUBLISH
```

---

# 58. Product North Star

The product should not optimize for:

> "How many AI controls can we expose?"

It should optimize for:

> **"How little does the creator need to do before they receive something they actually want?"**

AI handles complexity.

The user handles intent, taste and approval.

That should guide every UI/UX decision in the product.