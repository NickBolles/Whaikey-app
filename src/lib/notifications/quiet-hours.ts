/**
 * Quiet-hours arithmetic.
 *
 * Quiet hours are stored as a wall-clock window ("22:00"–"08:00") plus an IANA
 * zone, never as UTC offsets. Offsets move twice a year; "ten at night" does
 * not, and a user who set 22:00 in March expects 22:00 in November too.
 *
 * Every device carries its own zone (see `push_devices.time_zone`), which is
 * the reason this takes a zone parameter instead of reading one global setting:
 * a laptop in Denver and a phone that travelled to Lisbon are both "this user",
 * and both are right about what 22:00 means where they are.
 */

/** A window is half-open: `start` is quiet, `end` is not. */
export interface QuietWindow {
  /** "HH:MM", 24-hour. */
  start: string;
  end: string;
  /** IANA zone id, e.g. "America/Denver". Falls back to UTC if unusable. */
  timeZone: string;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Is this a storable "HH:MM"? Route validation and the UI share this test. */
export function isValidTimeOfDay(value: string): boolean {
  return TIME_RE.test(value);
}

/** "HH:MM" → minutes past local midnight, or null if malformed. */
export function parseTimeOfDay(value: string): number | null {
  const m = TIME_RE.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes past midnight → "HH:MM". */
export function formatTimeOfDay(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Does the runtime know this zone? Used to validate before storing one. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Local wall-clock minutes past midnight for an instant, in a zone.
 *
 * `Intl` is the only DST-correct way to do this without shipping a tz database;
 * an unknown zone degrades to UTC rather than throwing, because a bad string in
 * one device row must not take down the whole send.
 */
export function minutesOfDayInZone(at: Date, timeZone: string): number {
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/**
 * Is `at` inside the window?
 *
 * Windows routinely cross midnight — that is the common case, not the edge one
 * — so `start > end` means "wrap": quiet from 22:00 through 08:00 next morning.
 * A zero-length window (start === end) is treated as *no* quiet time rather
 * than 24 hours of it: someone dragging two sliders together means "never",
 * and silently muting an account for a full day is the worse way to be wrong.
 */
export function isWithinQuietWindow(at: Date, window: QuietWindow): boolean {
  const start = parseTimeOfDay(window.start);
  const end = parseTimeOfDay(window.end);
  if (start === null || end === null || start === end) return false;

  const now = minutesOfDayInZone(at, window.timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * When the window next opens up, as an instant. Used to tell the user *when*
 * a held notification will arrive — "held until 08:00" is actionable, "held"
 * on its own reads like a failure.
 */
export function quietWindowEndsAt(at: Date, window: QuietWindow): Date | null {
  if (!isWithinQuietWindow(at, window)) return null;
  const end = parseTimeOfDay(window.end);
  if (end === null) return null;

  const now = minutesOfDayInZone(at, window.timeZone);
  // Minutes until `end` comes round again, wrapping past midnight if needed.
  const delta = end > now ? end - now : 1440 - now + end;
  return new Date(at.getTime() + delta * 60_000);
}

/** "10:00 PM – 8:00 AM" for display; falls back to the raw values. */
export function describeQuietWindow(window: Pick<QuietWindow, "start" | "end">): string {
  const fmt = (value: string): string => {
    const minutes = parseTimeOfDay(value);
    if (minutes === null) return value;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const suffix = h < 12 ? "AM" : "PM";
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return m === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(m).padStart(2, "0")} ${suffix}`;
  };
  return `${fmt(window.start)} – ${fmt(window.end)}`;
}
