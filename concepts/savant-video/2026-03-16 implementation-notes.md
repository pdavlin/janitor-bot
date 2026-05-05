# Savant Video: Implementation Notes

## What was built

Baseball Savant is now the primary video source for outfield assist plays. The MLB content API remains as a fallback for plays where Savant has no video (Spring Training, WBC, or videos not yet processed).

## How it works

1. After detecting outfield assists, the pipeline looks up each play's `playEvents` from the live feed
2. The last pitch event with `isPitch: true` carries a `playId` UUID
3. That playId is used to fetch `https://baseballsavant.mlb.com/sporty-videos?playId={uuid}`
4. The HTML response contains a `<source>` tag with an mp4 URL from `sporty-clips.mlb.com`
5. If Savant returns no video, the play falls through to the content API keyword/description matching

## Files changed

- `src/types/mlb-api.ts` -- Added `PlayEvent` interface and `playEvents` optional field to the `Play` interface
- `src/detection/savant-video.ts` -- New module. Exports `extractPlayId()` and `fetchSavantVideo()`
- `src/pipeline.ts` -- `processGame` now tries Savant first, content API fallback only for plays still missing video
- `src/cli/scan.ts` -- `scanSingleGame` follows the same Savant-first pattern
- `src/detection/__tests__/savant-video.test.ts` -- Tests for playId extraction and Savant fetch with mocked responses

## Key details a junior should know

### The User-Agent header is required
Savant returns 403 or "No Video Found" without a browser-like User-Agent header. The constant is defined at the top of `savant-video.ts`.

### HTML entity decoding
Savant HTML-encodes characters in the video URL. The `decodeHtmlEntities` function handles hex entities (`&#x3D;` for `=`), decimal entities (`&#38;` for `&`), and `&amp;`. If you see broken URLs, check whether Savant started using a new entity encoding.

### The playId comes from the last pitch
A single at-bat has multiple pitch events. Only the final pitch (the one that ends the at-bat) maps to the Savant video of the play outcome. The code iterates backward through `playEvents` to find the last event where `isPitch === true` and `playId` exists.

### Savant coverage gaps
Spring Training and WBC games have no Savant video. The content API fallback handles these. Regular season games should always have Savant video once the game is final.

### Error handling is defensive
`fetchSavantVideo` returns null on any error (network, parsing, non-200 status). This is intentional because Savant is an unofficial API that could change without notice. The pipeline treats video matching as best-effort for both sources.

### The duplicate video logic in scan.ts
`scanSingleGame` in `src/cli/scan.ts` has its own video matching loop separate from `processGame` in `src/pipeline.ts`. This is existing duplication. The `--game` flag path uses `scanSingleGame` directly (it fetches the live feed itself to print the matchup header). Both paths now use the same Savant-first approach.

## Testing

Run `bun test` to execute all tests. The savant-video tests mock `globalThis.fetch` and restore it after each test. No network calls are made during testing.
