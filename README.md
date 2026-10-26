# PlyWooder

Open a STEP file and get plywood cut sheets. Each solid in the file becomes a part. PlyWooder lays the flat parts out on sheets, shows an animation of the model coming apart onto the sheets, and exports DXF files for a CNC.

## Run it

```bash
npm install
npm run dev
```

Then open the printed URL and drop a `.step` / `.stp` file onto the page.

## What it does

- **Reads the parts.** Each solid's largest flat face sets its thickness direction. The tool projects the solid onto that face to get the true through-cut outline: notches, slots and through holes. Faces that sit between the two skins become pockets, with their depth. Parts that are not flat stock (such as turned legs) start unticked.
- **Groups by thickness.** Each stock thickness gets its own set of sheets. When the parts don't fit on one sheet, the layout continues onto more.
- **Two packing modes.**
  - *Most efficient*: true-shape nesting on a fine grid. Bottom-left fill with a search over part order. Small parts can nest inside holes and notches. Best for a CNC.
  - *Easiest to cut*: three-stage guillotine layout. Crosscut strips, rip rows, then crosscut parts. Every cut runs edge to edge, so a table saw or track saw works. Includes a cut-order list.
- **Margins.** Sheet edge margin, bit or blade width, and an extra gap for human error. Parts are kept at least *bit + extra gap* apart.
- **Shared cuts (common-line cutting).** On by default. Neighbouring parts sit exactly one bit apart, so one pass cuts both edges. After the grid pass, the efficient nester slides every part left and down until it butts against a neighbour. It then keeps the candidate layout with the fewest plunges and the least cutting. Off: parts get the extra error gap and are cut separately.
- **Cut plan.** Each sheet's toolpaths are merged into one network, with shared edges cut once. The network is split into passes that run straight through junctions. Lines that stop within the edge margin get a lead-in to the sheet edge, so the cut starts outside the material. Passes are ordered so each starts at the sheet edge or on an earlier cut where possible. A *plunge* is a pass that has to start mid-sheet. Each sheet shows plunges, passes, cut length and shared length. "Show cut paths" draws the network, with shared runs highlighted.
- **Display.** Toggle between actual cuts and convex hulls. Hulls also pack as hulls, so no part goes into another part's notch. Lengths show in mm or inches.
- **Rotation.** Any 90° turn, grain-locked (0°/180° only), or 45° and 15° steps.
- **Export.** DXF (R12, mm or inches), per sheet or all sheets, plus SVG. DXF layers: `CUT_OUTSIDE`, `CUT_INSIDE`, `POCKET_<depth>`, `CUT_PATHS`, `SAW_CUTS`, `LABELS`, `SHEET`. `CUT_PATHS` holds the merged tool-centre passes in cutting order. Profile it *on the line* with the same bit, so shared edges are cut once. Round holes are written as true circles. DWG is a closed Autodesk format. Every CAM package reads DXF, and any CAD program can re-save it as DWG.
- **3D / Animate.** The model as designed, then every part flies to its spot on the sheet. Use play/pause and scrub.

## Tests

```bash
npm test -- path/to/model.step
```

Runs the STEP → parts → nesting → DXF pipeline in Node. It checks that no two parts come closer than the requested gap and that every part stays on the sheet.
