/**
 * Week-window math for the weekly-review CLI.
 *
 * All boundaries are computed in `America/Chicago` to match the
 * scheduler's local-time convention (`src/daemon/scheduler.ts`'s
 * `formatDate`/`getTodayDate`). Bun ships the IANA database, so we
 * use `Intl.DateTimeFormat` instead of pulling in a date library.
 */

const TZ = "America/Chicago";

export interface WeekWindow {
  /** Inclusive Sunday in YYYY-MM-DD (Chicago local). */
  weekStarting: string;
  /** Inclusive Saturday in YYYY-MM-DD (Chicago local). */
  weekEnding: string;
}

interface ChicagoParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=Sunday, 6=Saturday
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Maps a JS `Date` to its Chicago-local calendar parts.
 *
 * `Intl.DateTimeFormat#formatToParts` does the heavy lifting (DST,
 * year boundaries) without a date library.
 */
function chicagoParts(date: Date): ChicagoParts {
  const parts = partsFormatter.formatToParts(date);
  let year = 0;
  let month = 0;
  let day = 0;
  let weekdayShort = "";
  for (const p of parts) {
    if (p.type === "year") year = Number(p.value);
    else if (p.type === "month") month = Number(p.value);
    else if (p.type === "day") day = Number(p.value);
    else if (p.type === "weekday") weekdayShort = p.value;
  }
  return { year, month, day, weekday: WEEKDAY_INDEX[weekdayShort] ?? 0 };
}

function formatYmd(parts: { year: number; month: number; day: number }): string {
  const y = String(parts.year).padStart(4, "0");
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Subtracts `days` calendar days from a Chicago-local YMD without
 * recrossing UTC. Anchors on midnight UTC of the source date and walks
 * back 24h * days, then reads the Chicago calendar parts of the result.
 *
 * Safe for DST: the +/-1h DST shift never spans a full calendar day.
 */
function subtractDays(parts: ChicagoParts, days: number): ChicagoParts {
  const anchor = Date.UTC(parts.year, parts.month - 1, parts.day, 12);
  const shifted = new Date(anchor - days * 24 * 60 * 60 * 1000);
  return chicagoParts(shifted);
}

/**
 * Returns the most recent **complete** Sunday-Saturday window in
 * `America/Chicago` relative to `now`.
 *
 * If today (Chicago) is Sunday, the current week is mid-flight and the
 * window is the prior Sunday-Saturday (two Sundays back). On any other
 * day, the window ends on the most recent Saturday.
 */
export function defaultCompletedWeek(now: Date = new Date()): WeekWindow {
  const today = chicagoParts(now);
  // Days back from today to the Saturday that closes the target window.
  //   Sunday   -> 8 days (skip the just-closed week per the spec's
  //               "two Sundays back" rule).
  //   Saturday -> 7 days (today's Saturday isn't fully done yet).
  //   Mon..Fri -> weekday + 1 days (lands on the Saturday before today).
  const daysToPriorSaturday = today.weekday === 0 ? 8 : today.weekday + 1;
  const saturday = subtractDays(today, daysToPriorSaturday);
  const sunday = subtractDays(saturday, 6);
  return {
    weekStarting: formatYmd(sunday),
    weekEnding: formatYmd(saturday),
  };
}

/**
 * Validates an explicit `--week-starting YYYY-MM-DD` input and returns
 * the matching window. The input must be a Sunday in Chicago local time;
 * any other weekday throws.
 */
export function explicitWeek(weekStartingYmd: string): WeekWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(weekStartingYmd);
  if (!match) {
    throw new Error(
      `Invalid --week-starting: "${weekStartingYmd}". Expected YYYY-MM-DD.`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Anchor at noon UTC on the requested calendar day so DST shifts can't
  // bump the resulting Chicago calendar onto a neighboring date.
  const anchor = new Date(Date.UTC(year, month - 1, day, 12));
  const parts = chicagoParts(anchor);
  if (parts.year !== year || parts.month !== month || parts.day !== day) {
    throw new Error(
      `Invalid --week-starting: "${weekStartingYmd}" is not a real calendar date.`,
    );
  }
  if (parts.weekday !== 0) {
    throw new Error(
      `Invalid --week-starting: "${weekStartingYmd}" is not a Sunday in ${TZ}.`,
    );
  }
  const saturday = subtractDays(parts, -6);
  return {
    weekStarting: formatYmd(parts),
    weekEnding: formatYmd(saturday),
  };
}
