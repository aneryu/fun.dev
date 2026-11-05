# DESIGN.md

## Status

Version: `alpha`

This is the current visual direction for `fun.dev`, not a permanent brand lock.
Keep content and structure independent from these tokens so the direction can be
replaced later without rebuilding the site.

## Visual Theme

`fun.dev` is a tiny, playful corner of the internet. Its visual identity is
based on the cheerful directness of a yellow rubber duck: one unmistakable
yellow field, dark simple marks, and very small touches of beak orange and water
blue.

The page should feel lightweight, curious, and personal. Prefer one strong idea
over a collection of polished portfolio components. The homepage (`/`) pairs the
minimalist `Code for / − work. / + fun.` poster identity (`Things I make for fun.`)
with a single interactive 3D WebGPU SDF Bath Duck (`bath-duck`) toy floating directly
on the Duck Yellow canvas, plus a lightweight `Studio ↗` entry point in the top bar
that opens the standalone `/studio` SDF block studio (SDF 低模造物台), where the same
duck is edited block by block and viewed smooth, faceted low-poly, or as a 36-duck crowd.
When WebGPU is unavailable or compiling, a crisp local SVG poster stands in on
the same yellow canvas.

## Color Palette

### Core colors

| Token | Value | Role |
| --- | --- | --- |
| Duck Yellow | `#FFD43B` | Dominant page canvas and identity color |
| Duck Ink | `#211F17` | Primary text, wordmark, and structural marks |
| Duck Brown | `#5C5133` | Secondary text and quiet labels |
| Beak Orange | `#F28C28` | Decorative accent only; not body text |
| Beak Deep | `#9C3A12` | Accessible removal state and strike-through |
| Water Blue | `#4BA3C7` | Decorative water accent only |
| Water Deep | `#064F67` | Added state and strong secondary accent |
| Focus Blue | `#004E89` | Keyboard focus outlines |
| Duck Cream | `#FFF7D6` | Optional inset surface if content later needs one |

Duck Yellow must remain the dominant color. Duck Ink and Duck Brown provide the
neutral hierarchy. Beak Orange and Water Blue are supporting colors, not equal
brand colors.

On Duck Yellow, use the darker text variants:

- Duck Ink for normal text.
- Duck Brown for secondary text.
- Beak Deep instead of Beak Orange for text.
- Water Deep instead of Water Blue for text.

Do not put Beak Orange, Water Blue, Duck Cream, or white body text directly on
Duck Yellow; their contrast is too low.

## Typography

Use the local system monospace stack:

```css
"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace
```

Do not load remote fonts. Monospace is part of the current character, not a
signal that the site must look like a terminal.

- Hero: fluid `clamp()` sizing, regular weight, tight tracking.
- Added line: bold.
- Body: regular weight with a comfortable `1.5` line height.
- Keep paragraphs narrow enough to scan in one glance.

## Layout

- Use a full-viewport yellow canvas.
- Keep the `fun.dev` wordmark in the top-left corner and a lightweight `Studio ↗` entry in the top-right corner.
- On the minimalist `/` homepage, balance the left-hand `Code for / − work. / + fun.` hero statement (`Things I make for fun.`) with the right-hand 3D Bath Duck stage on desktop, and stack the hero statement and 3D stage vertically on mobile without extra control panels, badges, or captions.
- Preserve generous empty space; do not fill the page to prove it has content.
- Keep every diff line intact on desktop when possible.
- On mobile, reduce type size before changing the composition.
- Minimum supported viewport width: `320px`.

## Components

### Wordmark

Plain text, bold monospace, no logo lockup. Its hover underline uses Beak Deep.

### Diff statement

- Context line: Duck Ink.
- Removed `work.` line: Beak Deep with a clear strike-through and `−` marker.
- Added `fun.` line: Water Deep at bold weight with a `+` marker.
- Markers are generated with CSS so copied text remains clean.

### Supporting copy

Short and set in regular-weight Duck Brown. It should quietly anchor
the page without competing with the diff statement. The current line is
`Things I make for fun.`

### Future surfaces

If longer content or dedicated tooling needs separation (such as the standalone
`/studio` SDF block studio), use Duck Cream (`#FFF7D6`)
with Duck Ink (`#211F17`) borders. Avoid generic white cards, shadows, glass
effects, and large collections of rounded pills.

## Motion and Interaction

The baseline page does not require JavaScript or motion. Add interaction only
when it introduces a real playful idea. CSS motion must respect
`prefers-reduced-motion`, and core content must remain available without it.

## Accessibility

- Preserve the current high-contrast text variants on Duck Yellow.
- Use Focus Blue for a visible `3px` keyboard outline.
- Do not communicate diff meaning through color alone; retain `+`, `−`,
  insertion, deletion, and strike-through semantics.
- Keep touch controls at least `44px` high if controls are introduced.
- Decorative images and marks must be hidden from assistive technology.

## Do

- Let yellow occupy most of the viewport.
- Use a single memorable typographic idea.
- Keep markup semantic and the page useful without JavaScript.
- Prefer local SVG and CSS over third-party assets.
- Allow small imperfections and humor in content.

## Do Not

- Do not add gradients, glassmorphism, photorealistic stock 3D assets, or SaaS-style card grids (keep 3D SDF toys tactile, matte, and stylized).
- Do not use several saturated colors at equal visual weight.
- Do not use Beak Orange or Water Blue for small text on yellow.
- Do not introduce a framework, CSS library, icon set, or remote font for
  visual convenience.
- Do not copy another site's brand assets or wording.
