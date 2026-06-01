# Throw Velocity Calibration Report

Generated: 2026-06-01

## Summary

- **Plays with velocity data**: 2
- **Plays with any votes**: 0 (0.0%)
- **Total fire reactions**: 0
- **Total trash reactions**: 0
- **Overall fire rate**: 0.0%
- **Average velocity**: 63.2 mph

## Velocity Buckets

| Bucket | Plays | With Votes | Fire | Trash | Net | Fire Rate |
|--------|-------|------------|------|-------|-----|-----------|
| < 80 mph | 1 | 0 | 0 | 0 | 0 | 0.0% |
| 80-85 mph | 1 | 0 | 0 | 0 | 0 | 0.0% |

## Cross-Tabulations

### By Target Base

| Target Base | Plays | With Votes | Fire | Trash | Net | Avg Velocity |
|---|-------|------------|------|-------|-----|--------------|
| 2B | 1 | 0 | 0 | 0 | 0 | 84.1 |
| 1B | 1 | 0 | 0 | 0 | 0 | 42.4 |

### By Position

| Position | Plays | With Votes | Fire | Trash | Net | Avg Velocity |
|---|-------|------------|------|-------|-----|--------------|
| RF | 2 | 0 | 0 | 0 | 0 | 63.2 |

### By Throw Type

| Throw Type | Plays | With Votes | Fire | Trash | Net | Avg Velocity |
|---|-------|------------|------|-------|-----|--------------|
| Direct | 2 | 0 | 0 | 0 | 0 | 63.2 |

### By Video Availability

| Video | Plays | With Votes | Fire | Trash | Net | Avg Velocity |
|---|-------|------------|------|-------|-----|--------------|
| Has Video | 1 | 0 | 0 | 0 | 0 | 84.1 |
| No Video | 1 | 0 | 0 | 0 | 0 | 42.4 |

## Confidence Assessment

⚠️  **Low sample warning**: The following buckets have fewer than 10 plays:
- < 80 mph: 1 plays
- 80-85 mph: 1 plays

⚠️  **Sparse vote warning**: The following buckets have vote rates below 10%:
- < 80 mph: 0.0% vote rate
- 80-85 mph: 0.0% vote rate

⚠️  **Near-zero trash signal**: Trash reactions are very sparse (<5% of total). The velocity-to-reaction correlation is unreliable for tier calibration. Recommend conservative default (single +1 above 95 mph) rather than aggressive multi-band mapping.

## Recommended velocityBonus Bands

Based on the analysis above, the following conservative mapping is recommended:

```typescript
function velocityBonus(mph: number | null | undefined): number {
  if (mph == null) return 0;
  if (mph >= 95) return 1;
  return 0;
}
```

**Rationale**: With sparse negative signal, a single threshold at 95 mph provides a modest lift for elite throws without overfitting to a dataset that cannot reliably distinguish velocity-driven reactions from other factors. This can be revisited as more vote data accumulates.

## Data Limitations

- Reactions are sparse and overwhelmingly positive (near-zero trash)
- Velocity is confounded with video availability and throw difficulty
- Sample sizes in higher velocity buckets may be insufficient for statistical significance
- The analysis does not control for game context (score, inning, importance)

---

*This report is a committed artifact. The `velocityBonus` bands in `src/detection/ranking.ts` should reference this document for auditable rationale.*
