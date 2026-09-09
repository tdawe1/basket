import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3456";
const out = new URL("../e2e-artifacts/", import.meta.url);
mkdirSync(out, { recursive: true });

function shot(page, name) {
  return page.screenshot({
    path: new URL(`${name}.png`, out).pathname,
    fullPage: true,
  });
}

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

const phone = { viewport: { width: 390, height: 844, isMobile: true, hasTouch: true }, deviceScaleFactor: 2 };

try {
  const alexCtx = await browser.createBrowserContext();
  await alexCtx.overridePermissions(BASE, ["notifications"]);
  const alex = await alexCtx.newPage();
  await alex.setViewport(phone.viewport);
  alex.setDefaultTimeout(8000);
  await alex.goto(BASE, { waitUntil: "networkidle0" });
  await alex.waitForSelector(".wordmark");
  await shot(alex, "01-welcome");

  await alex.click('button[type="button"]'); // Start is first and already active
  await alex.type('input[name="householdName"]', "Home");
  await alex.type('input[name="displayName"]', "Alex");
  await alex.type('input[name="username"]', "alex");
  await alex.type('input[name="password"]', "password1");
  await alex.click("form .btn.block");
  await alex.waitForSelector(".topbar");
  await alex.waitForSelector(".list-tabs");
  await shot(alex, "02-empty-list");

  const add = 'input[aria-label="Add an item"]';
  await alex.waitForSelector(add);
  await alex.type(add, "2x milk");
  await alex.keyboard.press("Enter");
  await alex.waitForFunction(() =>
    [...document.querySelectorAll(".name")].some((n) => n.textContent.toLowerCase().includes("milk")),
  );

  await alex.type(add, "Bananas");
  await alex.click(".add-row .btn");
  await alex.waitForFunction(() => [...document.querySelectorAll(".name")].some((n) => n.textContent === "Bananas"));

  await alex.type(add, "Sourdough");
  await alex.click(".add-row .btn");
  await alex.waitForFunction(() => [...document.querySelectorAll(".name")].some((n) => n.textContent === "Sourdough"));
  await shot(alex, "03-list-with-items");

  await alex.click('button[aria-label="Settings"]');
  await alex.waitForSelector(".invite");
  const invite = await alex.$eval(".invite span", (el) => el.textContent.trim());
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(invite)) throw new Error(`bad invite ${invite}`);
  await shot(alex, "04-settings-invite");
  await alex.click(".sheet-backdrop", { offset: { x: 10, y: 10 } });
  await alex.waitForSelector(".invite", { hidden: true });

  await alex.click('button[aria-label="Remind"]');
  await alex.waitForSelector(".sheet h2");
  const remindTitle = await alex.$eval(".sheet h2", (el) => el.textContent.trim());
  if (remindTitle !== "Remind") throw new Error(`expected Remind sheet, got ${remindTitle}`);
  await alex.waitForSelector(".cal-row");
  const calLinks = await alex.$$eval(".cal-row a", (els) => els.map((a) => a.getAttribute("href")));
  if (!calLinks.some((h) => h && h.includes("calendar.google.com"))) throw new Error("missing Google Calendar link");
  if (!calLinks.some((h) => h && h.includes("outlook.live.com"))) throw new Error("missing Outlook link");
  await Promise.all([
    alex.waitForFunction(() => [...document.querySelectorAll(".toast")].some((n) => n.textContent.includes("Nudge sent"))),
    alex.click('button[data-action="nudge"]'),
  ]);
  await shot(alex, "10-remind-sheet");
  await alex.click('button[data-action="set-reminder"]');
  await alex.waitForFunction(() =>
    [...document.querySelectorAll(".upcoming-row strong, .remind-banner span")].some((n) =>
      (n.textContent || "").includes("Shop:"),
    ),
  );
  await alex.click(".sheet-backdrop", { offset: { x: 10, y: 10 } });
  await alex.waitForSelector(".cal-row", { hidden: true });

  const samCtx = await browser.createBrowserContext();
  await samCtx.overridePermissions(BASE, ["notifications"]);
  const sam = await samCtx.newPage();
  await sam.setViewport(phone.viewport);
  sam.setDefaultTimeout(8000);
  await sam.goto(BASE, { waitUntil: "networkidle0" });
  const tabs = await sam.$$(".tabs button");
  await tabs[1].click(); // Join
  await sam.waitForSelector('input[name="inviteCode"]');
  await sam.type('input[name="inviteCode"]', invite);
  await sam.type('input[name="displayName"]', "Sam");
  await sam.type('input[name="username"]', "sam");
  await sam.type('input[name="password"]', "password2");
  await sam.click("form .btn.block");
  await sam.waitForFunction(() =>
    [...document.querySelectorAll(".name")].some((n) => n.textContent.toLowerCase().includes("milk")),
  );
  await shot(sam, "05-sam-sees-list");

  const bananaRow = await sam.evaluateHandle(() => {
    const name = [...document.querySelectorAll(".name")].find((n) => n.textContent === "Bananas");
    return name?.closest(".item")?.querySelector('button[aria-label="Check"]');
  });
  const bananaBtn = bananaRow.asElement();
  if (!bananaBtn) throw new Error("could not find bananas check");
  await bananaBtn.click();
  await sam.waitForFunction(() =>
    [...document.querySelectorAll(".item.checked .name")].some((n) => n.textContent === "Bananas"),
  );

  await alex.waitForFunction(() =>
    [...document.querySelectorAll(".item.checked .name")].some((n) => n.textContent === "Bananas"),
  );
  await shot(alex, "06-alex-sees-check");
  await shot(sam, "07-sam-checked");

  await alex.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await shot(alex, "08-light-mobile");
  const desk = await alexCtx.newPage();
  await desk.setViewport({ width: 1280, height: 800 });
  await desk.goto(BASE, { waitUntil: "networkidle0" });
  await desk.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const layout = await desk.evaluate(() => {
    const phone = document.querySelector(".phone");
    const nav = document.querySelector(".list-tabs");
    const frame = phone?.getBoundingClientRect();
    const lists = nav?.getBoundingClientRect();
    return {
      phoneW: frame?.width ?? 0,
      navW: lists?.width ?? 0,
      navH: lists?.height ?? 0,
    };
  });
  if (layout.phoneW < 1000) throw new Error(`desktop shell too narrow: ${layout.phoneW}`);
  if (layout.navW < 200 || layout.navW > 360) throw new Error(`desktop sidebar width off: ${layout.navW}`);
  if (layout.navH < 400) throw new Error(`desktop sidebar not tall: ${layout.navH}`);
  await shot(desk, "09-desktop-light");
  await desk.click('button[aria-label="Remind"]');
  await desk.waitForSelector(".sheet h2");
  await shot(desk, "11-desktop-remind");
  await desk.click(".sheet-backdrop", { offset: { x: 10, y: 10 } });
  await desk.waitForSelector(".cal-row", { hidden: true });
  const wide = await alexCtx.newPage();
  await wide.setViewport({ width: 1920, height: 1080 });
  await wide.goto(BASE, { waitUntil: "networkidle0" });
  await wide.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await shot(wide, "12-desktop-wide");

  const html = await alex.content();
  if (!html.includes("Bananas") || !html.includes("Sourdough")) throw new Error("missing items on alex");
  console.log("e2e ok, invite", invite);
} finally {
  await browser.close();
}
