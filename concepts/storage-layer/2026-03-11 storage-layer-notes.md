# SQLite Storage Layer - Implementation Notes

Created: 2026-03-11
Status: Complete
File: `src/storage/db.ts`

## What this does

Provides SQLite persistence for detected outfield assist plays using `bun:sqlite`.
The module exposes four functions:

1. `createDatabase(dbPath)` - Opens/creates the DB file, runs CREATE TABLE IF NOT EXISTS, enables WAL mode
2. `insertPlay(db, play)` - Single insert with INSERT OR IGNORE for deduplication
3. `insertPlays(db, plays)` - Batch insert wrapped in a transaction
4. `queryPlays(db, filters?)` - Filtered SELECT with optional WHERE clauses

## Key design decisions

- **Deduplication**: UNIQUE constraint on `(game_pk, play_index)` combined with INSERT OR IGNORE.
  No need to check for existence before inserting.
- **WAL mode**: Enabled for better concurrent read performance. Safe for single-writer scenarios.
- **Named parameters**: All prepared statements use `$paramName` binding style for clarity.
- **Snake-to-camel mapping**: DB columns use snake_case. The `rowToStoredPlay` helper converts
  rows to camelCase `StoredPlay` objects on read.
- **No ORM**: Direct SQL with prepared statements. Keeps dependencies at zero.

## Schema

See the `CREATE_TABLE_SQL` constant in `db.ts` for the full schema. The `plays` table has:
- Auto-increment primary key
- All DetectedPlay fields mapped to snake_case columns
- `created_at` with DEFAULT datetime('now')
- UNIQUE(game_pk, play_index)

## Interfaces exported

- `DetectedPlay` - Input shape for inserts (matches detection module output)
- `PlayFilters` - Optional query filters (date, team, tier, fielder, gamePk)
- `StoredPlay` - extends DetectedPlay with `id` and `createdAt`
- `PlayTier` - "high" | "medium" | "low"

## How to test

```typescript
import { createDatabase, insertPlay, insertPlays, queryPlays } from "../storage/db";

const db = createDatabase(":memory:");

// Insert a play
insertPlay(db, { gamePk: 12345, playIndex: 0, ... });

// Query all
const all = queryPlays(db);

// Query with filters
const filtered = queryPlays(db, { tier: "high", date: "2025-06-15" });
```

## What comes next

- Task #6 (CLI entry point) will call these functions after detection runs
- Task #7 (tests) should cover:
  - Table creation
  - Insert + dedup behavior (insert same play twice, expect 1 row)
  - Transaction rollback on error
  - Each filter type individually and in combination
  - Empty result sets
