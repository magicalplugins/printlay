---
title: "Sticker Cut Lines: Die-Cut, Kiss-Cut & Cut Contours Explained"
description: "A complete guide to sticker cut lines for print shops: die-cut vs kiss-cut, cut contours, spot colours like CutContour, bleed, and how to generate them automatically."
h1: "Sticker cut lines: the complete guide"
excerpt: "Die-cut vs kiss-cut, cut contours, CutContour spot colours and bleed — how sticker cut lines actually work, and how to stop drawing them by hand."
category: "Stickers"
date: "2026-06-11"
updated: "2026-06-11"
keywords:
  - sticker cut line
  - cut contour
  - die cut sticker
  - kiss cut
  - cutline generator
related:
  - kiss-cut-vs-die-cut
  - how-to-add-a-cut-line-for-stickers
  - sticker-cut-line-generator
faq:
  - q: "What is a cut line on a sticker?"
    a: "A cut line (or cut contour) is a vector path that tells a cutter or plotter where to cut around a printed design. It's usually a separate spot colour — often named 'CutContour' — so the cutter recognises it and ignores it when printing colour."
  - q: "What is the difference between die-cut and kiss-cut?"
    a: "Kiss-cut cuts only the vinyl, leaving the backing intact so stickers peel off a sheet. Die-cut cuts through both the vinyl and the backing, producing individual stickers cut to shape. Kiss-cut is best for sheets and packs; die-cut for single stickers."
  - q: "What is a CutContour spot colour?"
    a: "CutContour is a named spot colour recognised by print-and-cut RIP software such as Roland VersaWorks. Any path assigned to a 100% CutContour spot is treated as a cut path, not printed ink. It's the standard way to tell a cutter where to cut."
  - q: "How much bleed do stickers need?"
    a: "Around 2–3 mm of bleed beyond the cut line is standard. The artwork extends past where the cut happens so any slight cutter drift never leaves an unprinted white edge."
---

If you print stickers, the **cut line** is where jobs go right or wrong. Get the contour, the cut type and the bleed right and stickers come off the cutter clean every time. Get them wrong and you get white edges, mis-cuts and reprints. Here's how cut lines actually work.

## What a cut line is

A **cut line** (also called a **cut contour**) is a **vector path** that tells your cutter or plotter where to cut. Crucially, it's not printed — it's a separate instruction layer. The standard way to mark it is a **spot colour named `CutContour`** that print-and-cut RIP software (like Roland VersaWorks) recognises and routes to the cutter instead of the print heads.

So a sticker file really has two parts:

1. **The printed artwork** — your colours, at 300 DPI, with bleed.
2. **The cut path** — a single vector contour on the CutContour spot.

## Die-cut vs kiss-cut

The two cut types solve different jobs:

- **Kiss-cut** cuts through the **vinyl only**, leaving the paper backing intact. Stickers stay on the sheet and peel off individually — perfect for sticker sheets, packs and easy handling.
- **Die-cut** cuts through **both vinyl and backing**, giving you individual stickers cut to the exact shape — the classic single "die-cut sticker".

We compare them in detail in [kiss-cut vs die-cut](/blog/kiss-cut-vs-die-cut).

## Types of cut contour

Not every sticker is cut tight to the artwork. Common contour styles:

- **Contour cut** — follows the edge of the design exactly (true die-cut look).
- **Offset / sticker border** — a path offset outward from the artwork for the classic white "kiss" border.
- **Simple shapes** — circle, rounded rectangle or square around the design.
- **Through-the-art** — for designs with holes or complex outlines.

## Bleed and why it matters

Cutters aren't perfect — there's always a tiny bit of drift. **Bleed** is the safety margin: extend the artwork **2–3 mm past the cut line** so that even if the cut wanders slightly, it cuts through printed colour, never bare white vinyl. Our [bleed & DPI calculator](/tools/bleed-dpi-calculator) does the maths for any size.

## The hard way vs the easy way

**By hand:** open the artwork in Illustrator, trace the outline (or use Image Trace and clean it up), offset the path for a border, assign it to a CutContour spot colour, set the path to overprint, then export. For every single design. It's fiddly and slow, especially when the artwork has fine detail or transparency.

**Automatically:** a [sticker cut line generator](/features/sticker-cut-line-generator) traces the design, builds a smooth contour (tight, offset border, or simple shape), assigns the CutContour spot, and exports a print-and-cut ready file — in seconds. For a manual walkthrough, see [how to add a cut line for stickers](/blog/how-to-add-a-cut-line-for-stickers).

## Putting cut stickers on a gang sheet

Once each sticker has its contour, you'll usually gang many onto one sheet to cut cost — the cutter follows every contour in one pass. The same packing and spacing rules from the [gang sheet guide](/guides/what-is-a-gang-sheet) apply, with enough gap between contours for the blade.

## The bottom line

A clean cut comes down to four things: the right cut type (kiss vs die), a smooth contour on the CutContour spot, enough bleed, and tidy spacing on the sheet. Nail those and stickers come off the cutter perfect — without you drawing a single path by hand.
