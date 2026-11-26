# GORDIX firmware: the "OUT OF RANGE" rule

This note records the rule the GORDIX firmware uses to reject a G-code file.
It was recovered by disassembling the vendor firmware images.
The images were supplied by the machine's owner, for interoperability.

## Summary

The firmware does **not** run the formula in the vendor's `table_config.html`.
It runs this rule instead:

```
reachX = (S + N) / 4 − 140
reachY = (E + W) / 4 − 200

accept  ⇔  |Xmin·r| < reachX  and  |Xmax·r| < reachX
       and |Ymin·r| < reachY  and  |Ymax·r| < reachY
       and Zmin ≥ −30.0
       and Zmax ≤ 3.0
```

- `E`, `S`, `W`, `N` are the selected table's values from `/system/table.cfg`.
  `D` and the X/Y scale factors play no part in the check.
- `Xmin … Zmax` are the file's extents, as measured by the SD board.
  Each extent is rounded to 0.1 mm before the check.
- `r` is the on-machine "Size Ratio" setting. Keep it at 100 % (r = 1).
- The X and Y comparisons are strict (`<`). The Z comparisons are inclusive.
- The rule is the same for router, laser and pen.

For the user's table 1 (E1481 S1345 W1481 N1355):

| Axis | Firmware limit | Largest extent that passes | Vendor page says |
|------|----------------|----------------------------|------------------|
| X    | ±535.0         | ±534.9                     | ±533             |
| Y    | ±540.5         | ±540.4                     | ±601             |
| Z    | −30.0 … +3.0   | −30.0 … +3.0               | (not shown)      |

Confidence: **high** for the X/Y/Z rule, the field mapping and the rounding.
Every measured result agrees with it (see "Check against measurements").

## Check against measurements

All measurements were on table 1. The predicted Y limit is 540.5 (strict).
The predicted X limit is 535.0 (strict).

| File                           | Prediction                    | Observed |
|--------------------------------|-------------------------------|----------|
| Y −534.9, X within ±255        | 534.9 + 200 = 734.9 < 740.5 → accept | accepted |
| Same file scaled to Y −541     | 741.0 ≥ 740.5 → reject        | rejected |
| Y ±601                         | reject                        | rejected |
| Y ±500                         | accept                        | ran      |
| X ±600                         | 740 ≥ 675 → reject            | rejected |
| Y ±600                         | reject                        | rejected |

The 534.9 / 541 pair brackets the predicted 540.5 limit.
The vendor's ±601 figure for Y is about 60 mm too generous.
The vendor's ±533 figure for X is about 2 mm too cautious.

## Predicted limits for other tables

Limits are `reachX = (S+N)/4 − 140` and `reachY = (E+W)/4 − 200`.
The user's tables 2–5 match Studio's defaults.

| Table                        | E / S / W / N           | X limit | Y limit |
|------------------------------|-------------------------|---------|---------|
| User table 1                 | 1481 / 1345 / 1481 / 1355 | ±535.0 | ±540.5 |
| Studio default 1             | 1460 / 2560 / 1460 / 2560 | ±1140.0 | ±530.0 |
| Studio default 2 (= user 2)  | 1460 / 1340 / 1460 / 1340 | ±530.0 | ±530.0 |
| Studio default 3 (= user 3)  | 1440 / 1320 / 1440 / 1320 | ±520.0 | ±520.0 |
| Studio default 4 (= user 4)  | 840 / 1320 / 840 / 1320   | ±520.0 | ±220.0 |
| Studio default 5 (= user 5)  | 840 / 720 / 840 / 720     | ±220.0 | ±220.0 |
| Firmware built-in (no cfg)   | 1000 / 1000 / 1000 / 1000 | ±360.0 | ±300.0 |

All limits are strict. Use them as "extent must round to at most limit − 0.1".

## How the check works, board by board

The machine has three ESP32 boards. Their roles in the check are as follows.

| Image          | Chip (image header)     | Role in the check |
|----------------|-------------------------|-------------------|
| `u107.ino.bin` | ESP32-S3 (chip id 9)    | Reads `table.cfg`. Scans the G-code file. Sends `TABLE …` and `[BOUND] …` lines to t113. |
| `t113.ino.bin` | ESP32-S3 (chip id 9)    | Stores the tables and bounds. Runs the comparison. Shows "OUT OF RANGE". |
| `d105.ino.bin` | ESP32 (chip id 0)       | Motion board. Receives `BOUND …` from t113. It has no range check and no "OUT OF RANGE" text. |

Tools: radare2 6.2.6 with `-a xtensa -b 32`.
Each image segment was mapped at its load address from the image header.
ROM helper addresses were resolved against the ESP32-S3 ROM libgcc table
(for example `0x400022a4` = `__extendsfdf2`, `0x40002184` = `__adddf3`,
`0x40002418` = `__muldf3`, `0x400023dc` = `__ltdf2`, `0x400023a0` = `__gtdf2`).

### 1. u107 reads `table.cfg` into seven floats per table

The parser at `u107:0x4200c39e` compares each key with `strcmp`.
It stores each value at a fixed offset in a 7-float record at `0x3fca4208`:

| Key        | Offset | Sent to t113 as |
|------------|--------|-----------------|
| `TABLEnE`  | +0     | `X`             |
| `TABLEnS`  | +4     | `Y`             |
| `TABLEnW`  | +8     | `Z`             |
| `TABLEnN`  | +12    | `I`             |
| `TABLEnD`  | +16    | `J`             |
| `TABLEnX`  | +20    | `S`             |
| `TABLEnY`  | +24    | `P`             |

Evidence: the `strcmp` hits branch to stores at `0x3fca4208` (E), `0x3fca420c` (S),
`0x3fca4210` (W), `0x3fca4214` (N), `0x3fca4218` (D), `0x3fca421c` (X), `0x3fca4220` (Y).
The sender at `u107:0x4200b204` prints them in that order with
`TABLE N%d X%4.1f Y%4.1f Z%4.1f I%4.1f J%4.1f S%1.4f P%1.4f`.

### 2. t113 stores each `TABLE` line in the same order

The serial handler at `t113:0x4200734b` runs
`sscanf(line, "TABLE N%d X%f Y%f Z%f I%f J%f S%f P%f", …)`.
It requires 8 matches and `1 ≤ N ≤ 5`.
It stores X, Y, Z, I, J, S, P at offsets 0–24 of `tables[N−1]`, base `0x3fc96820`:

```
0x42007376  l32r  a10, =0x3fc96820     ; tables
0x4200737c  subx8 a9, a9, a9           ; (N-1)*7
0x4200737f  addx4 a9, a9, a10          ; &tables[N-1]
0x42007388  s32i.n a10, a9, 0          ; X  (= E)
0x42007390  s32i.n a10, a9, 4          ; Y  (= S)
0x42007398  s32i.n a10, a9, 8          ; Z  (= W)
0x42007382  s32i.n a8,  a9, 12         ; I  (= N)
```

### 3. u107 measures the file's extents

The analyzer at `u107:0x4200a96c` reads `/cubiio/<file>` line by line.
It tracks a box with `min`/`max` for X, Y and Z (helper `0x4200a548`).
For each G0/G1 move it adds both end points (helper `0x4200a5dc`).
G2/G3 arcs go through a separate helper (`0x4200a6e4`) that reads I and J.
The first update seeds the box from the position before the first move.

The reporter at `u107:0x4200d264` sends:

```
[BOUND] X%4.1f Y%4.1f Z%4.1f I%4.1f J%4.1f S%4.1f P%4.1f A%4.1f E%4.1f
          Xmin   Ymin   Zmin   Xmax   Ymax   Zmax   time   M3   M5
```

The mapping comes from the same function's debug print, which labels the
same struct slots `Xmin =`, `Xmax =`, `Ymin =`, `Ymax =`, `Zmin =`, `Zmax =`
(struct offsets +8, +12, +16, +20, +24, +28).
`P` is a time/distance figure. `A` and `E` are the M3 and M5 counts.
The `%4.1f` format rounds every extent to 0.1 mm.

### 4. t113 parses `[BOUND]` and runs the check

The handler at `t113:0x42006f1d` parses the nine values with `sscanf`.
It stores Xmin→`0x3fc9a324`, Ymin→`0x3fc9a31c`, Zmin→`0x3fc9a314`,
Xmax→`0x3fc9a328`, Ymax→`0x3fc9a320`, Zmax→`0x3fc9a318`.
It then forwards the first seven values to d105 as `BOUND X… P…`.

The check is in the function at `t113:0x42005214`.
Decompiled by hand (names are mine):

```c
float r = size_ratio;                       // 0x3fc9a2f0
table_t *t = &tables[current_table];        // 0x3fc96820 + idx*28
float xmin = r*Xmin, ymin = r*Ymin, xmax = r*Xmax, ymax = r*Ymax;

double limX = (double)(t->I + t->Y) * 0.25; // (N + S) / 4
if (!(fabs(xmin) + 140.0 < limX)) goto out_of_range;
if (!(limX > fabs(xmax) + 140.0)) goto out_of_range;

double limY = (double)(t->X + t->Z) * 0.25; // (E + W) / 4
if (!(fabs(ymin) + 200.0 < limY)) goto out_of_range;
if (!(limY > fabs(ymax) + 200.0)) goto out_of_range;

if (!(-30.0f <= Zmin)) goto out_of_range;   // Z is not scaled by r
if (!(Zmax <= 3.0f))   goto out_of_range;
/* show "Est. Time" screen for router / laser / pen */
...
out_of_range:
  show(get_text(66));                       // "OUT OF RANGE"
```

Key instructions:

```
0x4200533c  addx4 a2, a2, a8           ; &tables[idx]
0x4200533f  lsi   f0, a2, 12           ; N
0x42005342  lsi   f1, a2, 4            ; S
0x42005345  add.s f0, f0, f1
0x42005351  l32r  a13, =0x3fd00000     ; 0.25
0x42005359  callx8 __muldf3            ; limX
0x42005362  abs.s f0, f2               ; |xmin*r|
0x42005374  l32r  a13, =0x40618000     ; 140.0
0x4200537c  callx8 __adddf3
0x42005386  callx8 __ltdf2
0x4200538c  bgez  a10, out_of_range
...
0x420053bd  lsi   f1, a2, 0            ; E
0x420053c0  lsi   f0, a2, 8            ; W
0x420053ed  l32r  a13, =0x40690000     ; 200.0
...
0x42005439  movi  a8, 0xfffffc1f
0x4200543c  slli  a8, a8, 20           ; 0xc1f00000 = -30.0f
0x42005442  ole.s b0, f1, f0           ; -30 <= Zmin
0x42005451  movi  a8, 0x101
0x42005454  slli  a8, a8, 22           ; 0x40400000 = 3.0f
0x4200545a  ole.s b0, f0, f1           ; Zmax <= 3
0x420055ad  movi.n a10, 66             ; "OUT OF RANGE"
0x420055af  call8 get_text
```

`get_text` is `t113:0x420028ac`, which indexes an 80-entry-per-language
string table at `0x3c1e4e50`. Entry 66 is "OUT OF RANGE".
This is the only call site that passes 66.

## What matters for building valid files

1. **Use the selected table's E, S, W, N.** Compute
   `reachX = (S+N)/4 − 140` and `reachY = (E+W)/4 − 200`.
   Keep every X extent below `reachX` and every Y extent below `reachY`,
   after rounding to 0.1 mm. A 0.1 mm margin is enough. A larger margin is kinder.
2. **The box is symmetric about the file origin.** The check uses
   `|min|` and `|max|`, so the file origin must be the table centre.
   An off-centre part cannot borrow reach from the other side.
3. **Z must stay within −30.0 … +3.0 mm.** This includes travel and retract
   moves. A safe height above 3.0 mm makes the file "OUT OF RANGE".
   The accepted sample used `G0 Z2.000`, which fits.
4. **Keep "Size Ratio" at 100 %.** The X/Y extents are multiplied by this
   ratio before the check. Z is not.
5. **Units:** the analyzer labels its output "mm, G21".
   u107 contains no 25.4 constant, so it most likely does not convert G20.
   Always emit `G21`.
6. **Arcs:** G2/G3 are handled by a separate bounds helper.
   That helper was not fully traced. Prefer G1 segments near the limit.
7. **Origin:** the bounding box is seeded from the position before the
   first move. That appears to start at 0,0,0, so the origin is always
   inside the box. This does not affect the X/Y check.
8. **Manual jogging has no check.** Only file selection runs this rule.
   This agrees with the crash seen while jogging.

## What was not verified

- Exact comment handling (`;` and `(...)`) and absolute/relative mode
  (`G90`/`G91`) in the u107 analyzer. The line reader skips spaces, tabs,
  CR and LF. The parser recognizes the letters G, M, X, Y, Z, I, J and F.
  A file that only uses `G0`/`G1`, `G21`, `G90` and `;` comments
  (as PlyWooder writes now) is known to work.
- Line-length and file-size limits. "ERR: command too long" belongs to the
  serial command parser, not the file analyzer.
- That "Size Ratio" 100 % means `r = 1.0` exactly. The variable lives in BSS
  and is set at runtime. The default sample files passed, which fits r = 1.

## Test files that would confirm the edges

Each file should be a small square path with `G21`, `G90`, `G0 Z2`.
Use table 1.

| File                  | Prediction |
|-----------------------|------------|
| X ±534.9, Y ±100      | accept     |
| X ±535.0, Y ±100      | reject     |
| X ±100, Y ±540.4      | accept     |
| X ±100, Y ±540.5      | reject     |
| Y from −540.5 to +10  | reject (one side alone is enough to fail) |
| Retract `G0 Z3.0`     | accept     |
| Retract `G0 Z3.1`     | reject     |
| Cut to `Z-30.0`       | accept     |
| Cut to `Z-30.1`       | reject     |
