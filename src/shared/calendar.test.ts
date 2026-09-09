import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildIcs,
  eventDescription,
  fromLocalInputValue,
  googleCalendarUrl,
  icsEscape,
  outlookCalendarUrl,
  presetDue,
  toIcsUtc,
  toLocalInputValue,
} from "./calendar.ts";

describe("calendar", () => {
  it("formats UTC ICS timestamps", () => {
    assert.equal(toIcsUtc(Date.UTC(2026, 8, 9, 15, 30, 0)), "20260909T153000Z");
  });

  it("escapes ICS special characters", () => {
    assert.equal(icsEscape("Milk, bread; see notes\\aisle"), "Milk\\, bread\\; see notes\\\\aisle");
  });

  it("builds a VEVENT with folded description", () => {
    const ics = buildIcs({
      uid: "abc@basket",
      title: "Shop: Groceries",
      description: "Groceries\n- Milk (2)\n- Bread",
      start: Date.UTC(2026, 8, 9, 15, 0, 0),
      end: Date.UTC(2026, 8, 9, 16, 0, 0),
    });
    assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
    assert.match(ics, /SUMMARY:Shop: Groceries/);
    assert.match(ics, /DTSTART:20260909T150000Z/);
    assert.match(ics, /DTEND:20260909T160000Z/);
    assert.match(ics, /DESCRIPTION:Groceries\\n- Milk \(2\)\\n- Bread/);
    assert.match(ics, /END:VCALENDAR\r\n$/);
  });

  it("lists unchecked items in the event description", () => {
    const desc = eventDescription("Groceries", [
      { name: "Milk", quantity: "2", checked: false },
      { name: "Bananas", quantity: "", checked: true },
      { name: "Bread", quantity: "", checked: false },
    ]);
    assert.equal(desc, "Groceries\n- Milk (2)\n- Bread");
  });

  it("builds Google and Outlook calendar URLs", () => {
    const event = {
      title: "Shop: Groceries",
      description: "Groceries\n- Milk",
      start: Date.UTC(2026, 8, 9, 15, 0, 0),
      end: Date.UTC(2026, 8, 9, 16, 0, 0),
    };
    const g = googleCalendarUrl(event);
    assert.equal(g.startsWith("https://calendar.google.com/calendar/render?"), true);
    assert.match(g, /dates=20260909T150000Z%2F20260909T160000Z/);
    const o = outlookCalendarUrl(event);
    assert.equal(o.startsWith("https://outlook.live.com/calendar/0/deeplink/compose?"), true);
    assert.match(o, /startdt=2026-09-09T15%3A00%3A00Z/);
  });

  it("round-trips local datetime inputs", () => {
    const ms = new Date(2026, 8, 9, 18, 45).getTime();
    assert.equal(toLocalInputValue(ms), "2026-09-09T18:45");
    assert.equal(fromLocalInputValue("2026-09-09T18:45"), ms);
    assert.equal(Number.isNaN(fromLocalInputValue("nope")), true);
  });

  it("resolves due presets in local time", () => {
    const afternoon = new Date(2026, 8, 9, 14, 0, 0).getTime();
    const evening = new Date(presetDue("evening", afternoon));
    assert.equal(evening.getHours(), 18);
    assert.equal(evening.getDate(), 9);

    const night = new Date(2026, 8, 9, 19, 0, 0).getTime();
    const later = new Date(presetDue("evening", night));
    assert.equal(later.getDate(), 10);
    assert.equal(later.getHours(), 18);

    const hour = presetDue("1h", afternoon);
    assert.equal(hour - afternoon, 60 * 60 * 1000);

    const morning = new Date(presetDue("tomorrow", afternoon));
    assert.equal(morning.getDate(), 10);
    assert.equal(morning.getHours(), 10);

    // Wednesday 9 Sep 2026 -> Saturday 12 Sep 10:00
    const sat = new Date(presetDue("saturday", afternoon));
    assert.equal(sat.getDay(), 6);
    assert.equal(sat.getDate(), 12);
    assert.equal(sat.getHours(), 10);

    const saturdayMorning = new Date(2026, 8, 12, 9, 0, 0).getTime();
    const todaySat = new Date(presetDue("saturday", saturdayMorning));
    assert.equal(todaySat.getDate(), 12);

    const saturdayNoon = new Date(2026, 8, 12, 12, 0, 0).getTime();
    const nextSat = new Date(presetDue("saturday", saturdayNoon));
    assert.equal(nextSat.getDate(), 19);
  });
});
