/**
 * Visual check of the running dashboard.
 *
 * Usage: node scripts/screenshot.mjs [url] [out.png]
 *
 * Uses the Chromium already present in the image rather than downloading one.
 */
import { chromium } from "playwright-core";

const url = process.argv[2] ?? "http://localhost:3000/";
const out = process.argv[3] ?? "/tmp/radar.png";

// The image ships a versioned Chromium; glob for it rather than pinning a build.
const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const { readdirSync } = await import("node:fs");
const dir = readdirSync(root).find((d) => /^chromium-\d+$/.test(d));
if (!dir) throw new Error(`aucun Chromium trouvé dans ${root}`);

const browser = await chromium.launch({
  executablePath: `${root}/${dir}/chrome-linux/chrome`,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
// Let the client hydrate and the first SSE-driven refresh land.
await page.waitForTimeout(3_000);

const rows = await page.locator("tbody tr").count();
const title = await page.title();
console.log(JSON.stringify({ title, rows, url }));

await page.screenshot({ path: out, fullPage: false });
await browser.close();
console.log(`écrit: ${out}`);
