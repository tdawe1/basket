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
  await Promise.all([
    alex.waitForSelector("h1"),
    alex.click("form .btn.block"),
  ]);
  await alex.waitForFunction(() => document.querySelector("h1")?.textContent === "Basket");
  await shot(alex, "02-empty-list");

  const add = 'input[aria-label="Item name"]';
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

  const samCtx = await browser.createBrowserContext();
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
  await shot(desk, "09-desktop-light");

  const html = await alex.content();
  if (!html.includes("Bananas") || !html.includes("Sourdough")) throw new Error("missing items on alex");
  console.log("e2e ok, invite", invite);
} finally {
  await browser.close();
}
