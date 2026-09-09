export type CalendarItem = {
  name: string;
  quantity: string;
  checked: boolean;
};

export function toIcsUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export function icsEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (ch) => `\\${ch}`);
}

function icsFold(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [line.slice(0, 74)];
  let rest = line.slice(74);
  while (rest.length) {
    parts.push(` ${rest.slice(0, 73)}`);
    rest = rest.slice(73);
  }
  return parts.join("\r\n");
}

export function buildIcs(event: {
  uid: string;
  title: string;
  description: string;
  start: number;
  end: number;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Basket//Shopping List//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${toIcsUtc(Date.now())}`,
    `DTSTART:${toIcsUtc(event.start)}`,
    `DTEND:${toIcsUtc(event.end)}`,
    icsFold(`SUMMARY:${icsEscape(event.title)}`),
    icsFold(`DESCRIPTION:${icsEscape(event.description)}`),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export function eventDescription(listName: string, items: CalendarItem[]): string {
  const lines = [listName];
  const open = items.filter((i) => !i.checked);
  const shown = open.slice(0, 40);
  for (const item of shown) {
    lines.push(`- ${item.name}${item.quantity ? ` (${item.quantity})` : ""}`);
  }
  if (open.length > shown.length) lines.push(`- … +${open.length - shown.length}`);
  return lines.join("\n").slice(0, 1800);
}

export function googleCalendarUrl(event: {
  title: string;
  description: string;
  start: number;
  end: number;
}): string {
  const dates = `${toIcsUtc(event.start)}/${toIcsUtc(event.end)}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates,
    details: event.description.slice(0, 1500),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function outlookCalendarUrl(event: {
  title: string;
  description: string;
  start: number;
  end: number;
}): string {
  const params = new URLSearchParams({
    rru: "addevent",
    subject: event.title,
    body: event.description.slice(0, 1500),
    startdt: new Date(event.start).toISOString().replace(/\.\d{3}Z$/, "Z"),
    enddt: new Date(event.end).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&${params.toString()}`;
}

export type DuePreset = "1h" | "evening" | "tomorrow" | "saturday";

export function presetDue(kind: DuePreset, now = Date.now()): number {
  const d = new Date(now);
  if (kind === "1h") return now + 60 * 60 * 1000;
  if (kind === "evening") {
    d.setHours(18, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  if (kind === "tomorrow") {
    d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
    return d.getTime();
  }
  const day = d.getDay();
  let add = (6 - day + 7) % 7;
  if (add === 0 && d.getTime() >= new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0, 0, 0).getTime()) {
    add = 7;
  }
  d.setDate(d.getDate() + add);
  d.setHours(10, 0, 0, 0);
  return d.getTime();
}

export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInputValue(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return Number.NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}