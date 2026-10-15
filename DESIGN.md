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
over a collection of polished portfolio components. The homepage retains the
original centered “Code for / − work. / + fun.” composition and introductory
line, with a Games link in the header. The separate `/games/` lobby uses only the
`fun.dev` wordmark, a language switch, and a simple game list. A game with a cover
shows it as a small square thumbnail in place of its row number; the list stays a
single column of rows, never a card grid. Avoid introductory
essays, slogans, about sections, or repeated explanations.

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

- Wordmark: bold, with fluid `clamp()` sizing on the lobby.
- Body: regular weight with a comfortable `1.5` line height.
- Keep paragraphs narrow enough to scan in one glance.

## Layout

- Use a full-viewport yellow canvas.
- Keep the `fun.dev` wordmark in the top-left corner.
- Center the original typographic hero on the homepage.
- On `/games/`, keep the game list directly beneath the header.
- Preserve generous empty space; do not fill the page to prove it has content.
- Design for mobile first, then adapt to desktop. Keep labels short and controls comfortably sized.
- Minimum supported viewport width: `320px`.

## Components

### Wordmark

Plain text, bold monospace, no logo lockup. Its hover underline uses Beak Deep.

### Supporting copy

Only include short game descriptions, instructions, and necessary status text.
Use Duck Brown for secondary text. All interface copy supports Chinese and
English; keep `fun.dev` unchanged. Detect the browser language automatically;
keep the optional Auto/中文/English selector small and borderless at the right of the lobby
header and inside the mobile player menu. Preserve its 44px touch area and focus outline.

### Future surfaces

If longer content needs separation, use Duck Cream with Duck Ink. Avoid generic
white cards, shadows, glass effects, and large collections of rounded pills.

## Motion and Interaction

The wordmark remains readable without JavaScript; the game
catalog and player require it and show a noscript explanation. CSS motion must
respect `prefers-reduced-motion`. The player passes this preference to games.

### Shared player

Platform controls live in one ☰ menu on every screen: restart, fullscreen (where
supported), My progress, options, share and the language. Opening it pauses the game.
On phones and tablets the game fills the available dynamic viewport, the menu button
floats at the top left and the site link, back link and title move into the menu;
respect display cutouts and safe areas in both orientations. Desktop keeps a slim
yellow header (wordmark, back link, title, menu button at the right) and no footer;
short action messages show briefly over the bottom of the game. Wooden Fish
(敲木鱼) uses the yellow canvas, brown wood, and simple dark text without neon effects.
All of it stays keyboard accessible, including the return to the lobby.
Loading, pause, and error messages are plain text in a high-contrast inset.
Game options (how to play, sound and haptics, settings, cheats) open in a dialog
styled like My progress: Duck Yellow surface, Duck Ink border, plain fieldsets.
Game covers are 1200×630 screenshots of the game itself, cropped to a square
with a Duck Ink border in the lobby.

## Accessibility

- Preserve the current high-contrast text variants on Duck Yellow.
- Use Focus Blue for a visible `3px` keyboard outline.
- Do not communicate game state through color alone; retain text status.
- Keep touch controls at least `44px` high if controls are introduced.
- Decorative images and marks must be hidden from assistive technology.

## Do

- Let yellow occupy most of the viewport.
- Use a single memorable typographic idea.
- Keep markup semantic and the page useful without JavaScript.
- Prefer local SVG and CSS over third-party assets.
- Allow small imperfections and humor in content.

## Do Not

- Do not add gradients, glassmorphism, glossy 3D ducks, or SaaS-style card grids.
- Do not use several saturated colors at equal visual weight.
- Do not use Beak Orange or Water Blue for small text on yellow.
- Do not introduce a framework, CSS library, icon set, or remote font for
  visual convenience.
- Do not copy another site's brand assets or wording.
