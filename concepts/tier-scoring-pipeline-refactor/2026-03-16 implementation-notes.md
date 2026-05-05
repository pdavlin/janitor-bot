# Tier Scoring Pipeline Refactor

## Date: 2026-03-16

## What changed

Tier scoring was moved from the detection step to the final pipeline step, after video matching. This lets video presence act as a scoring signal.

## Before

1. `detectOutfieldAssists()` called `calculateTier()` during detection
2. Video matching happened after, but tier was already locked in

## After

1. `detectOutfieldAssists()` sets `tier: "low"` as a placeholder
2. Video matching runs (unchanged)
3. `calculateTier()` runs on each play with full data including `hasVideo`

## Files changed

### src/detection/ranking.ts
- Added `hasVideo: boolean` to the `TierInput` interface
- Added +1 score for `hasVideo === true` inside `calculateTier()`
- Updated JSDoc scoring breakdown

### src/detection/detect.ts
- Removed `calculateTier` import (no longer used here)
- Replaced tier calculation with hardcoded `tier: "low"` placeholder
- Updated module docstring to remove tier ranking mention

### src/pipeline.ts
- Added `calculateTier` import
- Added a scoring loop after video matching that recalculates tier with `hasVideo: play.videoUrl !== null`

### src/cli/scan.ts
- Added `calculateTier` import
- Added the same scoring loop after video matching in `scanSingleGame()`
- This path bypasses `processGame`, so it needs its own scoring step

### src/detection/__tests__/ranking.test.ts
- Added `hasVideo: false` to all existing test inputs
- Added three new tests for the video bonus:
  - Relay to home with video: medium -> high (score 5)
  - Relay to 2B with video: stays low (score 2)
  - Relay to 3B with video: stays medium (score 4)

### src/detection/__tests__/detect.test.ts
- No changes needed. Existing tests did not assert on tier values.

## Scoring breakdown (updated)

| Signal | Points |
|---|---|
| Target base: Home | 4 |
| Target base: 3B | 3 |
| Target base: 2B | 1 |
| Direct throw (2-segment credit chain) | 2 |
| Video available | 1 |

Tier thresholds: 5+ = high, 3-4 = medium, 0-2 = low

## Edge cases to know about

- If video fetch fails, plays still get scored with `hasVideo: false`. The try/catch around video matching means the scoring loop always runs.
- The `"low"` placeholder from detection is always overwritten by the pipeline scoring step. If someone adds a new code path that skips the scoring step, plays will appear as "low" tier regardless of their actual score.
