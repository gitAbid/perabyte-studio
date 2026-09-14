import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();

page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console error]", m.text().slice(0, 200));
});

await page.goto(`${BASE}/generate/image`, { waitUntil: "networkidle" });
console.log("after load:", await page.evaluate(() => {
  const raw = localStorage.getItem("perabyte.assets.v2");
  return { keys: Object.keys(localStorage), assets: raw ? JSON.parse(raw).length : null };
}));

await page.getByRole("textbox").first().fill("A red rowing boat on a misty lake at dawn");
await page.getByRole("button", { name: /^generate$/i }).first().click();
await page.waitForSelector("img[alt*='rowing boat' i]", { timeout: 180_000 });
console.log("generated ok");

await page.waitForTimeout(2000);
console.log("after generate:", await page.evaluate(() => {
  const raw = localStorage.getItem("perabyte.assets.v2");
  const items = raw ? JSON.parse(raw) : [];
  return { count: items.length, firstTitle: items[0]?.title, firstUrl: items[0]?.url?.slice(0, 60) };
}));

await page.goto(`${BASE}/history`, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
console.log("history page:", await page.evaluate(() => {
  const raw = localStorage.getItem("perabyte.assets.v2");
  const items = raw ? JSON.parse(raw) : [];
  return {
    stored: items.length,
    titles: items.map((i) => i.title),
    renderedRows: document.querySelectorAll("li").length,
    bodyHasRowing: document.body.innerText.includes("Rowing"),
  };
}));

await browser.close();
