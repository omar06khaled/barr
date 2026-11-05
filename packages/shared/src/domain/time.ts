/** Timezone helpers without external deps (uses Intl). */

/** Returns {date: 'YYYY-MM-DD', minutes: minutes since local midnight} for an instant in a tz. */
export function localParts(instant: Date, timeZone: string): { date: string; minutes: number; weekday: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday as string);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: wd,
  };
}

export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid HH:MM: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Offset (ms) of tz from UTC at the given instant. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Converts a local date ('YYYY-MM-DD') + 'HH:MM' in tz to a UTC Date. DST-safe. */
export function zonedTimeToUtc(date: string, hhmm: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const mins = hhmmToMinutes(hhmm);
  const guess = Date.UTC(y, mo - 1, d, Math.floor(mins / 60), mins % 60);
  let off = tzOffsetMs(new Date(guess), timeZone);
  let result = guess - off;
  const off2 = tzOffsetMs(new Date(result), timeZone);
  if (off2 !== off) result = guess - off2;
  return new Date(result);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;
