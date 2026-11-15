// Smoke test: serves the repository, loads the page in Chromium and checks known results.
// Usage (from the repository root): node tests/smoke.js
// Needs Node and the "playwright" package (npm i -D playwright && npx playwright install chromium).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const PORT = 8765;
const URL = `http://127.0.0.1:${PORT}/`;

// Mon usine: goals (+ recipe choices), then the raw resources expected in "Ressources à amener" (per minute).
// Every expected value is checked by hand from data.json (see .claude/docs/projet/tests.md).
const FACTORY_CASES = [
  { name: "Cadre modulaire lourd 2/min (recettes standard)", factory: [{ c: "Desc_ModularFrameHeavy_C", rate: 2 }],
    expect: { "Minerai de fer": 480, "Charbon": 180, "Calcaire": 180 } },
  // 300 iron ingots/min with Pure Iron Ingot (7 ore + 4 water → 13 ingots): 300 × 7/13 = 161,54 ore and 300 × 4/13 = 92,31 m³ water,
  // plus 180 ore for the steel (standard Steel Ingot: 3 ore + 3 coal → 3 steel).
  { name: "Cadre modulaire lourd 2/min, lingot de fer pur", factory: [{ c: "Desc_ModularFrameHeavy_C", rate: 2 }],
    choice: { Desc_IronIngot_C: "Recipe_Alternate_PureIronIngot_C" },
    expect: { "Minerai de fer": 341.54, "Eau": 92.31, "Charbon": 180 } },
  { name: "Lingot d'aluminium 60/min : eau nette après recyclage", factory: [{ c: "Desc_AluminumIngot_C", rate: 60 }],
    expect: { "Eau": 60 } },
  // Default Ficsite Ingot = aluminium recipe (2 reanimated S.A.M. + 4 aluminium ingots → 1). 2 sculptors/min need 40 Ficsite
  // Trigons → 13,33 ingots → 26,67 reanimated S.A.M. (× 4 = 106,67 S.A.M.) and 53,33 aluminium ingots → 53,33 bauxite,
  // 26,67 raw quartz. Same raw totals as satisfactory-calculator.com for this target.
  { name: "Sculptrice biochimique 2/min : lingot de ficsite à l'aluminium par défaut", factory: [{ c: "Desc_SpaceElevatorPart_10_C", rate: 2 }],
    expect: { "Minerai de fer": 262.5, "É.M.E.": 106.67, "Bauxite": 53.33, "Quartz brut": 26.67, "Charbon": 139.17, "Eau": 63.33 } },
];

// Extraction (Mon usine): default extractor = the smallest that covers the need alone on the node (normal by default:
// Mk.1 60, Mk.2 120, Mk.3 240 /min), MW at 100 % = extractors needed (fraction) × power, like the machines.
// Sculptrice 2/min: oil 252/120 × 40 = 84 ; water 63,33/120 × 20 = 10,56 ; copper 267/240 × 45 = 50,06 ; iron 262,5/240 × 45
// = 49,22 ; coal 139,17/240 × 45 = 26,09 ; S.A.M. 106,67/120 × 15 = 13,33 ; limestone 90/120 × 15 = 11,25 ; caterium
// 62,4/120 × 15 = 7,8 ; bauxite 53,33/60 × 5 = 4,44 ; quartz 26,67/60 × 5 = 2,22 → 258,98 MW, 14 extractors (3+1+2+2+1+1+1+1+1+1).
// Production: 102 machines, 1 131,84 MW → 116 machines, 1 390,82 MW.
const EXTRACTION_CASES = [
  { name: "Sculptrice biochimique 2/min · extraction par défaut", ext: {},
    stats: ["116 machines au total dont 14 extracteurs", "1 390,82 MW à 100 % dont 258,98 MW d'extraction"],
    cards: { "Calcaire": "1 Foreuse Mk.2 11,25 MW · gisement normal", "Minerai de fer": "2 Foreuses Mk.3 49,22 MW · gisement normal",
             "Pétrole brut": "3 Puits de pétrole 84 MW · gisement normal", "Eau": "1 Pompe à eau 10,56 MW" } },
  // pure node: Mk.1 gives 120/min ≥ 90 → 1 Mk.1, 90/120 × 5 = 3,75 MW
  { name: "Sculptrice biochimique 2/min · calcaire en gisement pur", ext: { Desc_Stone_C: { p: "Pure" } },
    cards: { "Calcaire": "1 Foreuse Mk.1 3,75 MW · gisement pur" } },
];

// Transport: one line carried by train, expected wagon count.
// Iron ore stacks to 100: 1 wagon = 32 × 100 = 3 200 per trip; round trip 240 s + 2 × 27 s = 4,9 min
// → 653,06/min per wagon → 1 400/min needs 3 wagons (Mk.6 belts feed 2 400/min per platform, not limiting).
const TRAIN_CASES = [
  { name: "Train : 1 400 minerai de fer/min, aller-retour 4 min avec arrêts", c: "Desc_OreIron_C", rate: 1400,
    T: { trainRT: 240, stops: true, belt: 6, maxW: 8, split: true }, wagons: 3 },
  // Same flow with Mk.3 belts to the platforms: 2 × 270 = 540/min per platform → ceil(1 400 / 540) = 3 platforms (= 3 wagons);
  // each platform handles 1 400 / 3 = 466,67/min, more than one Mk.3 belt (270) → 2 Mk.3 belts per platform.
  { name: "Train : 1 400 minerai de fer/min, tapis Mk.3 vers les quais", c: "Desc_OreIron_C", rate: 1400,
    T: { trainRT: 240, stops: true, belt: 3, maxW: 8, split: true }, wagons: 3,
    perQuai: "Chaque quai charge puis décharge 466,67/min : 2 tapis Mk.3 par quai" },
];

const num = (s) => parseFloat(s.replace(/\s/g, "").replace(",", "."));
let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? "OK  " : "FAIL"} ${msg}`); };

async function open(browser, storage, hash, viewport) {
  const page = await browser.newPage(viewport ? { viewport } : {});
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("response", (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on("requestfailed", (r) => errors.push(`échec réseau ${r.url()}`));
  await page.addInitScript((s) => {
    localStorage.clear();
    for (const k in s) localStorage.setItem(k, JSON.stringify(s[k]));
  }, storage);
  await page.goto(URL + hash);
  return { page, errors };
}

// Every icon the page can show exists on disk (lazy-loaded images are not all requested during the test).
function checkImages() {
  const D = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "data.json"), "utf8"));
  const img = (dir, c) => fs.existsSync(path.join(ROOT, "assets", "images", dir, c + ".png"));
  const items = Object.keys(D.items).filter((c) => D.items[c].ico && !img("items", c));
  const machines = Object.keys(D.machines).filter((m) => !img("machines", m));
  check(!items.length, `Icônes d'objets (ico: true) présentes : ${items.length ? "manquantes " + items.join(", ") : "toutes"}`);
  check(!machines.length, `Icônes de machines présentes : ${machines.length ? "manquantes " + machines.join(", ") : "toutes"}`);
}

(async () => {
  checkImages();
  const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  try {
    for (const t of FACTORY_CASES) {
      const { page, errors } = await open(browser, { "sp-factory": t.factory, "sp-choice-f": t.choice || {}, "sp-view": "factory" }, "#usine");
      await page.waitForSelector(".raws .raw", { timeout: 10000 });
      const raws = await page.$$eval(".raws .raw", (els) => els.map((e) => ({
        name: e.querySelector("button.link")?.textContent.trim(), value: e.querySelector("b")?.textContent.trim() })));
      for (const [k, v] of Object.entries(t.expect)) {
        const r = raws.find((x) => x.name === k);
        const got = r ? num(r.value) : NaN;
        check(Math.abs(got - v) < 0.01, `${t.name} · ${k} : attendu ${v}, obtenu ${r ? r.value : "absent"}`);
      }
      if (errors.length) check(false, `${t.name} · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    const extText = (page) => page.$$eval(".raws .raw", (els) => Object.fromEntries(els.map((e) =>
      [e.querySelector("button.link")?.textContent.trim(), e.querySelector(".ext")?.innerText.replace(/\s+/g, " ").trim()])));
    for (const t of EXTRACTION_CASES) {
      const { page, errors } = await open(browser, { "sp-factory": [{ c: "Desc_SpaceElevatorPart_10_C", rate: 2 }], "sp-extract": t.ext, "sp-view": "factory" }, "#usine");
      await page.waitForSelector(".raws .raw .ext", { timeout: 10000 });
      if (t.stats) {
        const st = await page.$$eval(".stat", (els) => els.slice(0, 2).map((e) => e.innerText.replace(/\s+/g, " ").trim()));
        check(JSON.stringify(st) === JSON.stringify(t.stats), `${t.name} · tuiles : attendu ${JSON.stringify(t.stats)}, obtenu ${JSON.stringify(st)}`);
      }
      const ex = await extText(page);
      for (const [k, v] of Object.entries(t.cards)) check(ex[k] === v, `${t.name} · ${k} : attendu « ${v} », obtenu « ${ex[k]} »`);
      if (!Object.keys(t.ext).length) {
        // choosing Mk.1 for limestone (normal node): 90/60 → 2 Mk.1, 1,5 × 5 = 7,5 MW; the choice is saved, then reset
        await page.click("#xb-Desc_Stone_C");
        await page.click('#xmenu [data-xm="Build_MinerMk1_C"]');
        const after = (await extText(page))["Calcaire"];
        const savedExt = () => page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem("sp-factories")).list[0].ext));
        const saved = await savedExt();
        check(after === "2 Foreuses Mk.1 7,5 MW · gisement normal" && saved === '{"Desc_Stone_C":{"m":"Build_MinerMk1_C"}}',
          `${t.name} · choix Mk.1 pour le Calcaire : obtenu « ${after} », enregistré ${saved}`);
        await page.click("#xmenu [data-xreset]");
        const back = (await extText(page))["Calcaire"];
        check(back === t.cards["Calcaire"] && await savedExt() === "{}",
          `${t.name} · retour au réglage par défaut : obtenu « ${back} »`);
        await page.keyboard.press("Escape");
        check(await page.$eval("#xmenu", (e) => e.hidden), `${t.name} · Échap ferme le choix d'extraction`);
      }
      if (errors.length) check(false, `${t.name} · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }
    {
      // extraction settings travel in the share link (third part), and "Partager" writes them back
      const sharedX = "#usine:ModularFrameHeavy*2;;Stone=MinerMk3.Pure";
      const { page, errors } = await open(browser, {}, sharedX);
      await page.waitForSelector(".raws .raw .ext", { timeout: 10000 });
      const lime = (await extText(page))["Calcaire"];   // 180/min on a pure node with a Mk.3: 180/480 × 45 = 16,88 MW
      check(lime === "1 Foreuse Mk.3 16,88 MW · gisement pur", `Lien partagé avec extraction · Calcaire : obtenu « ${lime} »`);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.click("[data-share]");
      await page.waitForTimeout(300);
      const code = await page.evaluate(async () => {
        const i = document.getElementById("share-url");
        const u = i ? i.value : await navigator.clipboard.readText();
        return u.slice(u.indexOf("#"));
      });
      check(code === sharedX, `Bouton Partager avec extraction · attendu ${sharedX}, obtenu ${code}`);
      if (errors.length) check(false, `Lien partagé avec extraction · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    for (const t of TRAIN_CASES) {
      const T = { src: "free", lines: [{ c: t.c, rate: t.rate }], via: { [t.c]: "train" }, mixed: false, ...t.T };
      const { page, errors } = await open(browser, { "sp-transport": T, "sp-view": "transport" }, "#transport");
      await page.waitForSelector('.vcell[data-via="train"] b', { timeout: 10000 });
      const txt = await page.$eval('.vcell[data-via="train"] b', (e) => e.textContent.trim());
      check(parseInt(txt, 10) === t.wagons && !/trains ×/.test(txt), `${t.name} : attendu ${t.wagons} wagons, obtenu « ${txt} »`);
      if (t.perQuai) {
        const li = await page.$$eval(".bgrp li", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
        check(li.includes(t.perQuai), `${t.name} · À construire : attendu « ${t.perQuai} », obtenu ${JSON.stringify(li)}`);
        const notes = await page.$$eval(".tnotes li", (els) => els.map((e) => e.textContent));
        check(notes.length === 1 && /conteneur industriel/.test(notes[0]), `${t.name} · Repères : seule la note des quais attendue, obtenu ${JSON.stringify(notes)}`);
      }
      if (errors.length) check(false, `${t.name} · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    // Sharing by URL: a link opens the factory with its recipe choices, the address goes back to #usine.
    const shared = "#usine:ModularFrameHeavy*2;IronIngot=Alternate_PureIronIngot";
    {
      const { page, errors } = await open(browser, {}, shared);
      await page.waitForSelector(".raws .raw", { timeout: 10000 });
      const ore = await page.$$eval(".raws .raw", (els) => els.find((e) => e.querySelector("button.link")?.textContent.trim() === "Minerai de fer")?.querySelector("b").textContent);
      check(ore && Math.abs(num(ore) - 341.54) < 0.01, `Lien partagé (lingot de fer pur) · minerai de fer : attendu 341,54, obtenu ${ore}`);
      check(await page.evaluate(() => location.hash) === "#usine", "Lien partagé · l'adresse redevient #usine");
      // the "Partager" button rebuilds the same code (clipboard, or the fallback dialog)
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.click("[data-share]");
      await page.waitForTimeout(300);
      const code = await page.evaluate(async () => {
        const i = document.getElementById("share-url");
        const u = i ? i.value : await navigator.clipboard.readText();
        return u.slice(u.indexOf("#"));
      });
      check(code === shared, `Bouton Partager · attendu ${shared}, obtenu ${code}`);
      if (errors.length) check(false, `Lien partagé · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }
    for (const replace of [false, true]) {
      // with a factory already there, the dialog asks where: a new factory by default, or replacing one (explicit button)
      const { page, errors } = await open(browser, { "sp-factory": [{ c: "Desc_IronPlate_C", rate: 30 }] }, "#usine:AluminumIngot*60");
      await page.waitForSelector("#modal:not([hidden]) [data-maction]", { timeout: 10000 });
      const before = await page.$$eval(".goal .g-name", (els) => els.map((e) => e.textContent.trim()).join());
      if (replace) await page.click('#modal [data-dest="1"]');
      const label = await page.$eval("#modal [data-maction]", (b) => b.textContent);
      await page.click("#modal [data-maction]");
      const after = await page.$$eval(".goal .g-name", (els) => els.map((e) => e.textContent.trim()).join());
      const fs = await page.evaluate(() => JSON.parse(localStorage.getItem("sp-factories")).list.map((f) => f.name + ":" + f.goals.map((g) => g.c).join("+")).join(" "));
      const want = replace ? ["Remplacer l'usine 1", "1:Desc_AluminumIngot_C"] : ["Ouvrir dans une nouvelle usine", "1:Desc_IronPlate_C 2:Desc_AluminumIngot_C"];
      check(before === "Plaque de fer" && label === want[0] && after === "Lingot d'aluminium" && fs === want[1],
        `Lien partagé sur une usine existante (${replace ? "remplacement" : "nouvelle usine"}) · « ${label} » : ${before} → ${after}, usines ${fs}`);
      if (errors.length) check(false, `Lien partagé (${replace ? "remplacement" : "nouvelle usine"}) · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    // "Importer": the link is checked in the field and again on "Importer", then the same flow as a link opened in the address bar.
    {
      const { page, errors } = await open(browser, { "sp-factory": [{ c: "Desc_IronPlate_C", rate: 30 }] }, "#usine");
      await page.waitForSelector("[data-import]", { timeout: 10000 });
      await page.click("[data-import]");
      // message and state of the "Importer" button after each entry: disabled until the link is valid
      const state = () => page.evaluate(() => {
        const m = document.getElementById("import-msg"), b = document.querySelector("#modal [data-maction]");
        return `${b.disabled ? "désactivé" : "actif"} · ${m.classList.contains("bad") ? "erreur : " : ""}${m.textContent}`;
      });
      const steps = [["", /^désactivé · $/],
        ["https://faimer-org.github.io/satisfactory-planif/#usine", /^désactivé · erreur : Ce lien ne contient aucune pièce : c'est l'adresse de Mon usine/],
        ["https://exemple.fr/#accueil", /^désactivé · erreur : Ce lien ne correspond pas à une usine partagée/],
        ["#usine:Inconnu*3", /^désactivé · erreur : Aucune pièce de ce lien n'est reconnue/],
        ["  https://faimer-org.github.io/satisfactory-planif/#usine:ModularFrameHeavy*2;IronIngot=Alternate_PureIronIngot  ", /^actif · Lien valide : 1 pièce \(Cadre modulaire lourd\)\.$/]];
      for (const [v, want] of steps) {
        if (v) await page.fill("#import-url", v);
        const got = await state();
        check(want.test(got), `Importer · « ${v.trim() || "(vide)"} » → ${got}`);
      }
      // the factory is replaced only on the explicit "Remplacer l'usine 1" button
      await page.click('#modal [data-dest="1"]');
      const label = await page.$eval("#modal [data-maction]", (b) => b.textContent);
      const warn = await page.$eval("#dest-warn", (e) => e.textContent);
      await page.click("#modal [data-maction]");
      await page.waitForSelector(".raws .raw", { timeout: 10000 });
      const goals = await page.$$eval(".goal .g-name", (els) => els.map((e) => e.textContent.trim()).join());
      const ore = await page.$$eval(".raws .raw", (els) => els.find((e) => e.querySelector("button.link")?.textContent.trim() === "Minerai de fer")?.querySelector("b").textContent);
      const nf = await page.evaluate(() => JSON.parse(localStorage.getItem("sp-factories")).list.length);
      check(label === "Remplacer l'usine 1" && /seront remplacés/.test(warn) && goals === "Cadre modulaire lourd" && nf === 1 && ore && Math.abs(num(ore) - 341.54) < 0.01,
        `Importer · remplacement de l'usine 1 : « ${label} », ${goals}, ${nf} usine, minerai de fer ${ore}`);
      if (errors.length) check(false, `Importer · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    // Trees: only the first level below is unfolded by default, and a click changes only the clicked node,
    // even when another step's detail is unfolded afterwards (the results are re-rendered then).
    {
      const hmf = { "sp-factory": [{ c: "Desc_ModularFrameHeavy_C", rate: 2 }] };
      const st = (page, sel) => page.$$eval(sel, (ds) => ds.map((d) => d.dataset.p.replace(/Desc_|_C/g, "") + "=" + (d.open ? 1 : 0)).join(" "));
      let { page, errors } = await open(browser, { ...hmf, "sp-tab-f": "tree" }, "#usine");
      await page.waitForSelector(".tree details", { timeout: 10000 });
      const before = await st(page, ".tree details");
      check(before === "ModularFrameHeavy=1 ModularFrameHeavy,ModularFrame=0 ModularFrameHeavy,SteelPipe=0 ModularFrameHeavy,SteelPlateReinforced=0 ModularFrameHeavy,IronScrew=0",
        `Arbres · seul le premier niveau est déplié : ${before}`);
      await page.click('.tree details[data-p="Desc_ModularFrameHeavy_C,Desc_IronScrew_C"] > summary', { position: { x: 3, y: 5 } });
      await page.waitForTimeout(150);
      const after = await st(page, ".tree details");
      check(after === "ModularFrameHeavy=1 ModularFrameHeavy,ModularFrame=0 ModularFrameHeavy,SteelPipe=0 ModularFrameHeavy,SteelPlateReinforced=0 ModularFrameHeavy,IronScrew=1 ModularFrameHeavy,IronScrew,IronRod=0",
        `Arbres · un clic sur Vis ne déplie que Vis : ${after}`);
      if (errors.length) check(false, `Arbres · erreurs JS : ${errors.join(" | ")}`);
      await page.close();

      ({ page, errors } = await open(browser, { ...hmf, "sp-tab-f": "steps" }, "#usine"));
      await page.waitForSelector("[data-xp]", { timeout: 10000 });
      await page.click('[data-xp="Desc_ModularFrame_C"]');
      const mf = "#row-Desc_ModularFrame_C + tr.xrow details";
      const d0 = await st(page, mf);
      check(d0 === "ModularFrame,IronPlateReinforced=0 ModularFrame,IronRod=0", `Étapes · détail du Cadre modulaire replié par défaut : ${d0}`);
      await page.click(`${mf}[data-p$="IronRod_C"] > summary`, { position: { x: 3, y: 5 } });
      await page.click('[data-xp="Desc_SteelPipe_C"]');
      await page.waitForTimeout(150);
      const d1 = await st(page, mf);
      check(d1 === "ModularFrame,IronPlateReinforced=0 ModularFrame,IronRod=1 ModularFrame,IronRod,IronIngot=0",
        `Étapes · Barre de fer reste seule dépliée après le dépliage d'une autre étape : ${d1}`);
      if (errors.length) check(false, `Étapes (arbre) · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    // By-products reused in the chain: shown under the step that makes them, no longer on the consuming step's row.
    // 150 aluminium ingots/min (90 scrap + 75 silica → 60 ingots): 225 scrap and 187,5 silica; 225 scrap (240 alumina → 360 scrap)
    // needs 150 alumina, whose refinery (120 alumina + 50 silica) gives 150 × 50/120 = 62,5 silica, all reused → 125 silica to make.
    {
      const { page, errors } = await open(browser, { "sp-factory": [{ c: "Desc_AluminumIngot_C", rate: 150 }], "sp-tab-f": "steps" }, "#usine");
      await page.waitForSelector("[data-xp]", { timeout: 10000 });
      await page.click('[data-xp="Desc_AluminaSolution_C"]');
      // the 62,5 silica all go to the aluminium ingots, the only consumer of silica
      const reu = await page.$$eval("#row-Desc_AluminaSolution_C + tr.xrow .reu", (els) => els.map((e) =>
        [e.querySelector(".chip"), ...e.querySelectorAll(".fromg > *")].map((x) => x.textContent.replace(/\s+/g, " ").trim()).join(" ")));
      const want = ["Silice +62,5/min pour Lingot d'aluminium"];
      check(JSON.stringify(reu) === JSON.stringify(want), `Étapes · Solution d'alumine, surplus réutilisé : attendu ${JSON.stringify(want)}, obtenu ${JSON.stringify(reu)}`);
      // Destination reads "quantity pour consumer": the 150 m³ of alumina all feed the aluminium scrap
      const dest = await page.$$eval("#row-Desc_AluminaSolution_C + tr.xrow .xcol:last-child > .eyebrow:first-child + .chips .chip", (els) =>
        els.map((c) => [...c.childNodes].map((x) => x.textContent.trim()).filter(Boolean).join(" ")));
      check(JSON.stringify(dest) === JSON.stringify(["150 m³/min pour Rebuts d'aluminium"]), `Étapes · Solution d'alumine, destination : attendu ["150 m³/min pour Rebuts d'aluminium"], obtenu ${JSON.stringify(dest)}`);
      const silica = await page.$eval("#row-Desc_Silica_C td.r", (e) => e.textContent.replace(/\s+/g, " ").trim());
      check(silica === "125/min", `Étapes · ligne Silice sans « récupérés » : attendu « 125/min », obtenu « ${silica} »`);
      if (errors.length) check(false, `Étapes (surplus réutilisé) · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    // Item sheet of Water: recipes giving water as a by-product sit in their own group, and their raw totals no longer
    // loop. Rebuts d'aluminium (240 alumina + 120 coal → 360 scrap + 120 water), per 1 m³ of water: 2 alumina + 1 coal,
    // and the 2 alumina (120 bauxite + 180 water → 120 alumina) need 2 bauxite + 3 water, in standard recipes.
    {
      const { page, errors } = await open(browser, { "sp-qmode": "unit" }, "#desc-water-c");
      await page.waitForSelector("details.others > summary", { timeout: 10000 });
      // both groups folded by default, no Alt. tag on their title (it stays on each alternative recipe card)
      const groups = await page.$$eval("details.others", (ds) => ds.map((d) => d.querySelector("summary").textContent.replace(/\s+/g, " ").trim() + (d.open ? " (ouvert)" : "")));
      check(JSON.stringify(groups) === JSON.stringify(["Autres recettes · 1", "Obtenu en sous-produit · 7"]), `Fiche Eau · groupes de recettes, fermés, sans Alt. : ${JSON.stringify(groups)}`);
      const alts = await page.$$eval('details.others[data-grp="byp"] .rcard .rc-head .tag.alt', (els) => els.length);
      check(alts === 4, `Fiche Eau · étiquette Alt. sur les 4 recettes alternatives : ${alts}`);
      const raws = await page.$$eval('details.others[data-grp="byp"] .rcard', (cards) => {
        const c = cards.find((x) => x.querySelector("b").textContent === "Rebuts d'aluminium");
        return c ? [...c.querySelectorAll(".rc-raw .chip")].map((x) => x.querySelector(".num").textContent.trim() + " " + x.textContent.replace(x.querySelector(".num").textContent, "").trim()) : null;
      });
      const want = ["3 m³ Eau", "2 Bauxite", "1 Charbon"];
      check(JSON.stringify(raws) === JSON.stringify(want), `Fiche Eau · Rebuts d'aluminium, ressources brutes pour 1 m³ : attendu ${JSON.stringify(want)}, obtenu ${JSON.stringify(raws)}`);
      // an unfolded group stays open through Mon usine and back, and folds again on another part's sheet
      const bypOpen = () => page.$eval('details.others[data-grp="byp"]', (d) => d.open);
      await page.click('details.others[data-grp="byp"] > summary');
      await page.click('.modes [data-view="factory"]');
      await page.click('.modes [data-view="item"]');
      await page.waitForSelector('details.others[data-grp="byp"]', { timeout: 10000 });
      const kept = await bypOpen();
      await page.evaluate(() => { location.hash = "#desc-aluminumscrap-c"; });
      await page.waitForFunction(() => /Rebuts/.test(document.querySelector(".sheet h2")?.textContent || ""), null, { timeout: 10000 });
      await page.evaluate(() => { location.hash = "#desc-water-c"; });
      await page.waitForFunction(() => document.querySelector(".sheet h2")?.textContent === "Eau", null, { timeout: 10000 });
      const again = await bypOpen();
      check(kept === true && again === false, `Fiche Eau · section dépliée gardée après Mon usine (${kept}), refermée après une autre fiche (${again})`);
      if (errors.length) check(false, `Fiche Eau · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    // Trees at 390 px: a long line wraps without leaving the fold marker alone on its line,
    // and the machine icon stays on the same line as its count.
    {
      const { page, errors } = await open(browser, { "sp-factory": [{ c: "Desc_AluminumIngot_C", rate: 150 }], "sp-tab-f": "tree" }, "#usine", { width: 390, height: 800 });
      await page.waitForSelector(".tree details", { timeout: 10000 });
      await page.click('.tree details[data-p="Desc_AluminumIngot_C,Desc_AluminumScrap_C"] > summary', { position: { x: 3, y: 8 } });
      await page.waitForSelector('.tree details[data-p$="Desc_AluminaSolution_C"]', { timeout: 10000 });
      const bad = await page.$$eval(".tree summary", (ss) => ss.flatMap((s) => {
        const out = [], k = s.parentElement.dataset.k, row = s.querySelector(".row").getBoundingClientRect();
        if (row.top - s.getBoundingClientRect().top > 6) out.push(`${k} : marqueur seul sur sa ligne`);
        const ic = s.querySelector(".mico").getBoundingClientRect(), tx = s.querySelector(".mico + .num").getBoundingClientRect();
        if (Math.abs((ic.top + ic.bottom) / 2 - (tx.top + tx.bottom) / 2) > 8) out.push(`${k} : icône de machine séparée du texte`);
        return out;
      }));
      check(!bad.length, `Arbres à 390 px · retours à la ligne : ${bad.length ? bad.join(", ") : "corrects"}`);
      // inputs of one recipe line up, whether they unfold (Solution d'alumine) or not (Charbon)
      const xs = await page.$$eval('.tree details[data-k="Desc_AluminumScrap_C"] > :is(details, .leaf)', (els) =>
        els.map((e) => Math.round((e.querySelector("summary") || e).querySelector(".nh .ico").getBoundingClientRect().left)));
      check(xs.length === 2 && xs[0] === xs[1], `Arbres · entrées des Rebuts d'aluminium alignées : abscisses des icônes ${xs.join(", ")}`);
      if (errors.length) check(false, `Arbres à 390 px · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    // Several factories (sp-factories). Iron plate, standard recipe: 2 plates every 6 s in a Constructor = 20/min per machine.
    const FSK = () => JSON.parse(localStorage.getItem("sp-factories"));
    const fsSummary = (page) => page.evaluate(() => { const s = JSON.parse(localStorage.getItem("sp-factories")); return s.list.map((f) => `${f.id === s.cur ? "*" : ""}${f.name}:` + f.goals.map((g) => g.c.replace(/Desc_|_C/g, "") + "*" + g.rate).join("+")).join(" "); });
    const mkF = (list, cur = 1) => ({ "sp-factories": { cur, list: list.map(([name, goals], i) => ({ id: i + 1, name, goals, choices: {}, ext: {}, via: {} })) } });
    {
      // old single factory → factory "1", with its recipes, extraction and transport choices
      const { page, errors } = await open(browser, { "sp-factory": [{ c: "Desc_IronPlate_C", rate: 30 }], "sp-choice-f": { Desc_IronIngot_C: "Recipe_Alternate_PureIronIngot_C" },
        "sp-extract": { Desc_OreIron_C: { p: "Pure" } }, "sp-transport": { via: { Desc_OreIron_C: "train" } } }, "#usine");
      await page.waitForSelector(".fsel [data-fsel]", { timeout: 10000 });
      const s = await page.evaluate(FSK);
      const f = s.list[0];
      check(s.list.length === 1 && f.name === "1" && f.goals[0].rate === 30 && f.choices.Desc_IronIngot_C === "Recipe_Alternate_PureIronIngot_C" && f.ext.Desc_OreIron_C.p === "Pure" && f.via.Desc_OreIron_C === "train",
        `Usines · reprise de l'ancienne usine : ${JSON.stringify(s)}`);
      if (errors.length) check(false, `Usines (reprise) · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }
    {
      // no factory: the popup has no factory choice, a factory "1" is created; the rate follows "Pour 1 pièce / Pour 1 machine/min"
      const { page, errors } = await open(browser, { "sp-qmode": "machine" }, "#desc-ironplate-c");
      await page.waitForSelector(".head [data-quickadd]", { timeout: 10000 });
      const seg = await page.$eval('[data-qmode="machine"]', (b) => b.textContent);
      await page.click(".head [data-quickadd]");
      const pre = await page.$eval("#add-rate", (i) => i.value);
      const destShown = await page.$$eval("#modal [data-dest]", (b) => b.length);
      await page.click("#modal [data-maction]");
      const s1 = await fsSummary(page);
      check(seg === "Pour 1 machine/min" && pre === "20" && destShown === 0 && s1 === "*1:IronPlate*20",
        `Ajouter (aucune usine, pour 1 machine/min) · libellé « ${seg} », pré-rempli ${pre}, choix d'usine ${destShown}, usines ${s1}`);
      // "Pour 1 pièce": 1; the same part again adds to its rate in the chosen factory, and says so
      await page.click('[data-qmode="unit"]');
      await page.click(".head [data-quickadd]");
      const pre2 = await page.$eval("#add-rate", (i) => i.value);
      const hint = await page.$eval("#add-msg", (m) => m.textContent);
      const dests = await page.$$eval("#modal [data-dest]", (bs) => bs.map((b) => b.textContent.trim() + (b.getAttribute("aria-pressed") === "true" ? "*" : "")).join(","));
      await page.keyboard.press("Enter");
      const s2 = await fsSummary(page);
      check(pre2 === "1" && dests === "1*,+ Nouvelle usine" && hint === "Déjà 20/min dans cette usine : le débit passera à 21/min." && s2 === "*1:IronPlate*21",
        `Ajouter (pour 1 pièce, usine existante) · pré-rempli ${pre2}, usines proposées ${dests}, « ${hint} », usines ${s2}`);
      // new factory from the popup, with its name; a name already used is refused
      await page.click(".head [data-quickadd]");
      await page.click('#modal [data-dest="new"]');
      const defName = await page.$eval("#dest-name", (i) => i.value);
      await page.fill("#dest-name", " 1 ");
      await page.click("#modal [data-maction]");
      const err = await page.$eval("#add-msg", (m) => m.textContent);
      await page.fill("#dest-name", "Nord");
      await page.fill("#add-rate", "12,5");
      await page.click("#modal [data-maction]");
      const s3 = await fsSummary(page);
      const count = await page.$eval('.mode[data-view="factory"] .count', (e) => e.textContent);
      check(defName === "2" && err === "Une autre usine porte déjà ce nom." && s3 === "1:IronPlate*21 *Nord:IronPlate*12.5" && count === "1",
        `Ajouter dans une nouvelle usine · nom proposé ${defName}, doublon « ${err} », usines ${s3}, compteur ${count}`);
      // the catalogue "+" opens the same popup
      await page.click('.pickrow:has([data-pick="Desc_IronPlate_C"]) [data-quickadd]', { force: true });
      const fromCat = await page.$eval("#mtitle", (e) => e.textContent);
      await page.keyboard.press("Escape");
      check(fromCat === "Ajouter à mon usine", `Catalogue · le « + » ouvre la popup : ${fromCat}`);
      if (errors.length) check(false, `Ajouter à mon usine · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }
    {
      // selector of Mon usine: switch, rename, empty (the factory stays), delete (after confirmation)
      const { page, errors } = await open(browser, mkF([["1", [{ c: "Desc_IronPlate_C", rate: 30 }]], ["2", [{ c: "Desc_AluminumIngot_C", rate: 60 }]]]), "#usine");
      await page.waitForSelector('[data-fsel="2"]', { timeout: 10000 });
      await page.click('[data-fsel="2"]');
      const g2 = await page.$$eval(".goal .g-name", (els) => els.map((e) => e.textContent.trim()).join());
      await page.click("[data-frename]");
      await page.fill("#fname", "1");
      await page.click("#modal [data-maction]");
      const dup = await page.$eval("#fname-msg", (m) => m.textContent);
      await page.fill("#fname", "Aluminium");
      await page.keyboard.press("Enter");
      const names = await page.$$eval(".fsel [data-fsel] .fname", (els) => els.map((e) => e.textContent).join(","));
      check(g2 === "Lingot d'aluminium" && dup === "Une autre usine porte déjà ce nom." && names === "1,Aluminium",
        `Mon usine · changer d'usine (${g2}), renommer (doublon « ${dup} ») : ${names}`);
      await page.click("[data-clear]");
      await page.click("#modal [data-maction]");
      const afterClear = await fsSummary(page);
      await page.click("[data-fdel]");
      const delTitle = await page.$eval("#mtitle", (e) => e.textContent);
      await page.click("#modal [data-maction]");
      const afterDel = await fsSummary(page);
      check(afterClear === "1:IronPlate*30 *Aluminium:" && delTitle === "Supprimer l'usine ?" && afterDel === "*1:IronPlate*30",
        `Mon usine · vider garde l'usine (${afterClear}), supprimer après confirmation (${afterDel})`);
      if (errors.length) check(false, `Mon usine (sélecteur) · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }
    {
      // at most 5 factories: the "+" is greyed out with an explanation, "Nouvelle usine" too in the popup
      const five = mkF([1, 2, 3, 4, 5].map((n) => [String(n), [{ c: "Desc_IronPlate_C", rate: n }]]));
      const { page, errors } = await open(browser, five, "#usine", { width: 390, height: 800 });
      await page.waitForSelector("[data-fnew]", { timeout: 10000 });
      const plus = await page.$eval("[data-fnew]", (b) => b.getAttribute("aria-disabled") + " · " + b.dataset.tip);
      await page.click("[data-fnew]", { force: true });   // greyed out with aria-disabled (keeps its tooltip): a click explains instead
      const noDialog = await page.$eval("#modal", (m) => m.hidden) && /Maximum de 5 usines/.test(await page.$eval("#toast", (t) => t.textContent));
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.evaluate(() => { location.hash = "#desc-ironplate-c"; });
      await page.waitForSelector(".head [data-quickadd]", { timeout: 10000 });
      await page.click(".head [data-quickadd]");
      const nw = await page.$eval('#modal [data-dest="new"]', (b) => b.getAttribute("aria-disabled"));
      check(plus === "true · Maximum de 5 usines atteint : supprimez-en une pour en créer une autre." && noDialog && nw === "true" && over <= 0,
        `5 usines · « + » grisé (${plus}), pas de fenêtre (${noDialog}), « Nouvelle usine » grisé (${nw}), débordement à 390 px ${over} px`);
      if (errors.length) check(false, `5 usines · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }
    {
      // Transport, Ressources de Mon usine: factory chooser; transport choices kept per factory
      const st = mkF([["1", [{ c: "Desc_IronPlate_C", rate: 20 }]], ["2", [{ c: "Desc_AluminumIngot_C", rate: 60 }]]]);
      st["sp-transport"] = { src: "factory", via: {} };
      const { page, errors } = await open(browser, st, "#transport");
      await page.waitForSelector(".tfbar [data-fsel]", { timeout: 10000 });
      const res = () => page.$$eval(".tline .g-name", (els) => els.map((e) => e.textContent.trim()).join());
      const r1 = await res();
      await page.click('.vcell[data-via="train"][data-viac="Desc_OreIron_C"]');
      await page.click('.tfbar [data-fsel="2"]');
      const r2 = await res();
      const s = await page.evaluate(FSK);
      check(r1 === "Minerai de fer" && r2 === "Bauxite,Eau,Charbon,Quartz brut" && s.cur === 2 && s.list[0].via.Desc_OreIron_C === "train" && !Object.keys(s.list[1].via).length,
        `Transport · usine 1 (${r1}) puis 2 (${r2}), choix du train gardé pour l'usine 1 : ${JSON.stringify(s.list.map((f) => f.via))}`);
      if (errors.length) check(false, `Transport (usines) · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    {
      // catalogue "+": shown only while its row is hovered; its hover colours do not linger once the pointer has left,
      // and after its dialog (opened with the mouse) closes, it does not stay shown through the focus given back
      const { page, errors } = await open(browser, {}, "#desc-ironplate-c", { width: 1400, height: 900 });
      const sel = '.pickrow [data-quickadd="Desc_IronRod_C"]';
      await page.waitForSelector(sel, { timeout: 10000 });
      const mid = async (s) => { const b = await (await page.$(s)).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
      const btn = await mid(sel), row = await mid('.pick[data-pick="Desc_IronRod_C"]'), other = await mid('.pick[data-pick="Desc_IronScrew_C"]');
      const look = () => page.$eval(sel, (b) => { const c = getComputedStyle(b); return `${(+c.opacity).toFixed(1)} ${c.backgroundColor}`; });
      await page.mouse.move(...btn); await page.mouse.move(...other); await page.mouse.move(...row);
      await page.waitForTimeout(40);
      const back = await look();   // still fading in, but no longer in hover colours
      await page.mouse.move(...btn); await page.mouse.click(...btn);
      await page.click("#modal .mbtn[data-mclose]");
      await page.mouse.move(...other); await page.waitForTimeout(300);
      const closed = await look();
      check(back.endsWith("rgb(27, 33, 36)") && closed.startsWith("0.0"), `Catalogue · « + » : couleurs au retour sur la ligne « ${back} », après la fenêtre, pointeur ailleurs « ${closed} »`);
      if (errors.length) check(false, `Catalogue « + » · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }

    // No horizontal scroll at 390 px on any view (CLAUDE.md), with a factory large enough to fill the steps table.
    const big = { "sp-factory": [{ c: "Desc_ModularFrameHeavy_C", rate: 2 }, { c: "Desc_AluminumIngot_C", rate: 60 }] };
    for (const [label, hash] of [["Fiche pièce", "#desc-modularframeheavy-c"], ["Mon usine", "#usine"], ["Transport", "#transport"]]) {
      const { page, errors } = await open(browser, big, hash, { width: 390, height: 800 });
      await page.waitForSelector(".sheet .card", { timeout: 10000 });
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(over <= 0, `${label} à 390 px · débordement horizontal : ${over} px`);
      if (errors.length) check(false, `${label} · erreurs JS : ${errors.join(" | ")}`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  process.exit(failed ? 1 : 0);
})();
