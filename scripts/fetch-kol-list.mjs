/**
 * Refreshes the labelled KOL wallet list from kolscan's leaderboard.
 *
 *   node scripts/fetch-kol-list.mjs
 *
 * The list is committed to the repo rather than fetched at runtime: it changes
 * slowly, and the dashboard should not depend on a third-party page being up
 * (or on its markup staying stable) to render a column.
 *
 * kolscan renders through the Next.js flight protocol, so the data arrives as
 * JSON escaped inside `self.__next_f.push(...)` string literals rather than in
 * a clean <script type="application/json"> block — hence the regex over the
 * doubly-escaped form.
 */
import { writeFileSync } from "node:fs";

const SOURCE = "https://kolscan.io/leaderboard";
const OUT = new URL("../src/data/kol-wallets.json", import.meta.url);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const res = await fetch(SOURCE, { headers: { "user-agent": UA, accept: "text/html" } });
if (!res.ok) {
  console.error(`kolscan a répondu ${res.status} — liste inchangée`);
  process.exit(1);
}
const html = await res.text();

const re =
  /\\"wallet_address\\":\\"([1-9A-HJ-NP-Za-km-z]{32,44})\\",\\"name\\":\\"((?:[^\\"]|\\\\.)*)\\"(?:,\\"pfp\\":(?:null|\\"[^"]*\\"))?(?:,\\"telegram\\":(?:null|\\"[^"]*\\"))?(?:,\\"twitter\\":(?:null|\\"([^\\"]*)\\"))?/g;

const byWallet = new Map();
for (const m of html.matchAll(re)) {
  const [, wallet, rawName, rawTwitter] = m;
  if (byWallet.has(wallet)) continue;
  const name = rawName.replace(/\\\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const handle = rawTwitter?.match(/x\.com\/([A-Za-z0-9_]+)/)?.[1] ?? null;
  byWallet.set(wallet, { wallet, name: name.trim(), twitter: handle });
}

if (byWallet.size < 50) {
  console.error(
    `Seulement ${byWallet.size} wallets extraits — le format de la page a probablement changé. Liste inchangée.`,
  );
  process.exit(1);
}

const payload = {
  source: SOURCE,
  fetchedAt: new Date().toISOString(),
  count: byWallet.size,
  wallets: [...byWallet.values()].sort((a, b) => a.name.localeCompare(b.name)),
};

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`${byWallet.size} wallets KOL écrits dans src/data/kol-wallets.json`);
