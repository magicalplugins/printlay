---
title: "How to Add a Cut Line for Stickers (CutContour Spot Colour)"
description: "Learn how to add a cut line to a sticker: trace the contour, offset for a border, assign the CutContour spot colour and export a print-and-cut ready file."
h1: "How to add a cut line for stickers"
excerpt: "Trace, offset, assign the CutContour spot, export — the manual method, plus the one-click alternative."
category: "How-to"
date: "2026-06-05"
updated: "2026-06-05"
keywords:
  - how to add a cut line for stickers
  - add cutcontour
  - sticker cut line illustrator
related:
  - sticker-cut-lines
  - kiss-cut-vs-die-cut
  - sticker-cut-line-generator
faq:
  - q: "What colour should a cut line be?"
    a: "A cut line should be a 100% spot colour, conventionally named 'CutContour', not a normal CMYK or RGB colour. RIP software like Roland VersaWorks recognises that spot name and sends the path to the cutter instead of printing it."
  - q: "Should the cut line overprint?"
    a: "Yes — set the cut path to overprint so it doesn't knock out the artwork beneath it. Combined with bleed, this prevents white edges if the cut drifts slightly."
---

Adding a cut line by hand is a fixed sequence of steps. Here's the manual method in a vector editor like Illustrator — and the faster alternative.

## The manual method

### 1. Place and size the artwork
Open your design at final size, 300 DPI, on its own layer.

### 2. Trace the outline
For solid-shape art, create the contour from the artwork edge. For photographic or complex art, use Image Trace (or draw the path) and clean up the result into a single smooth path.

### 3. Offset for a border (optional)
For the classic sticker "kiss" border, **offset the path outward** (Object → Path → Offset Path) by 2–4 mm so there's a white margin around the design.

### 4. Create the CutContour spot colour
Make a new **spot** swatch named exactly **`CutContour`** (this is the convention RIPs recognise). Give the cut path a stroke of 100% CutContour and no fill.

### 5. Set overprint and add bleed
Set the cut path to **overprint stroke**, and make sure the artwork **bleeds 2–3 mm past** the cut so a slight drift never shows white. See the [sticker cut lines guide](/guides/sticker-cut-lines) for why.

### 6. Export
Export a **PDF** preserving the spot colour, then load it into your print-and-cut RIP.

## The faster method

Tracing, smoothing, offsetting and assigning spots — for every design — is exactly the tedious part. A [sticker cut line generator](/features/sticker-cut-line-generator) does all of it automatically: it traces the artwork, builds a smooth contour (tight, offset border, or simple shape), assigns the CutContour spot, adds bleed and exports a ready file. Then pack many onto a [gang sheet](/guides/what-is-a-gang-sheet) and cut them in one pass.
