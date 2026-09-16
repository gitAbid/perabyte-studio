/**
 * UI overflow/scroll audit: walks key studio pages at several viewports and
 * reports (a) document-level horizontal overflow, (b) visible elements that
 * extend past the viewport without a clipping ancestor, (c) screenshots for
 * visual review. Read-only — no navigation side effects.
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://localhost:3000";
const OUT = "/tmp/ui-audit/";
await mkdir(OUT, { recursive: true });

const PAGES = [
  { name: "character-library", path: "/character" },
  { name: "character-new-simple", path: "/character/new" },
  { name: "character-detail", path: "/character/ch_mu3f53e5_vmt9q" },
  { name: "results", path: "/results?id=a_rec2" },
  { name: "generate-image", path: "/generate/image" },
  { name: "images", path: "/images" },
  { name: "stories", path: "/stories" },
  { name: "settings", path: "/settings" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "laptop", width: 1150, height: 760 },
  { name: "tablet", width: 768, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

const browser = await chromium.launch({
  args: ["--no-sandbox"],
  executablePath: process.env.PW_EXECUTABLE || undefined,
});

const report = [];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await context.newPage();

  for (const target of PAGES) {
    try {
      await page.goto(`${BASE}${target.path}`, { waitUntil: "networkidle", timeout: 45_000 });
    } catch {
      try { await page.waitForTimeout(4000); } catch {}
    }
    await page.waitForTimeout(1200);

    const issues = await page.evaluate(() => {
      const out = [];
      const vw = document.documentElement.clientWidth;
      const de = document.documentElement;
      if (de.scrollWidth > vw + 1) {
        out.push(`DOC h-overflow: scrollWidth=${de.scrollWidth} vw=${vw}`);
      }
      const clipTest = (el) => {
        let p = el.parentElement;
        while (p && p !== document.body) {
          const cs = getComputedStyle(p);
          if (/(hidden|clip)/.test(cs.overflow + cs.overflowX + cs.overflowY)) {
            const pr = p.getBoundingClientRect();
            if (pr.width > 0) return true;
          }
          p = p.parentElement;
        }
        return false;
      };
      for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if ((r.right > vw + 3 || r.left < -3) && !clipTest(el)) {
          const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).slice(0, 70);
          out.push(`past-viewport <${el.tagName.toLowerCase()}> ${cls} L=${Math.round(r.left)} R=${Math.round(r.right)} vw=${vw}`);
        }
        // vertically lost content: element taller than viewport that isn't a scroll container
        if (r.height > window.innerHeight * 1.05 && !/(auto|scroll)/.test(cs.overflowY) && el.tagName !== "HTML" && el.tagName !== "BODY") {
          const cls = String(el.className).slice(0, 70);
          out.push(`viewport-tall <${el.tagName.toLowerCase()}> ${cls} h=${Math.round(r.height)} vh=${window.innerHeight} (bottom cut: ${Math.round(r.bottom) > window.innerHeight})`);
        }
      }
      return [...new Set(out)].slice(0, 25);
    });

    if (issues.length) {
      report.push({ viewport: vp.name, page: target.name, issues });
    }
    await page.screenshot({ path: `${OUT}${target.name}-${vp.name}.png`, fullPage: false });
  }

  // Extra: character/new with the Detailed tab and the mobile drawer open
  await page.goto(`${BASE}/character/new`, { waitUntil: "networkidle", timeout: 45_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.getByRole("tab", { name: "Detailed" }).click().catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}character-new-detailed-${vp.name}.png` });
  const detIssues = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return document.documentElement.scrollWidth > vw + 1 ? [`DOC h-overflow ${document.documentElement.scrollWidth}>${vw}`] : [];
  });
  if (detIssues.length) report.push({ viewport: vp.name, page: "character-new-detailed", issues: detIssues });

  if (vp.width < 1024) {
    await page.getByRole("tab", { name: "Simple" }).click().catch(() => {});
    await page.getByLabel("Character Prompt").fill("audit probe character prompt").catch(() => {});
    const pill = page.getByRole("button", { name: /Sheet \d\/6/ });
    if (await pill.isVisible().catch(() => false)) {
      await pill.click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}character-new-drawer-${vp.name}.png` });
      const drawerIssues = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const out = [];
        if (document.documentElement.scrollWidth > vw + 1) out.push(`DOC h-overflow ${document.documentElement.scrollWidth}>${vw}`);
        const drawer = document.querySelector("aside");
        if (drawer) {
          const r = drawer.getBoundingClientRect();
          if (r.height > window.innerHeight) out.push(`drawer taller than viewport without fit: h=${Math.round(r.height)}`);
        }
        return out;
      });
      if (drawerIssues.length) report.push({ viewport: vp.name, page: "character-new-drawer", issues: drawerIssues });
    }
  }

  await context.close();
}

await browser.close();

for (const entry of report) {
  console.log(`\n== ${entry.viewport} / ${entry.page}`);
  for (const issue of entry.issues) console.log("  " + issue);
}
if (!report.length) console.log("no issues found");
