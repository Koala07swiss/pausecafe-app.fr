// Agent social PauseCafé — génère un thread X + un carrousel Instagram (texte + images PNG).
// Lit le gabarit + le prochain sujet "a_faire", appelle l'API Claude, rend les slides
// du carrousel à la charte PauseCafé, écrit le tout dans social-drafts/ et marque le sujet.
// Le workflow GitHub Actions ouvre ensuite une PR pour ta validation.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Resvg } from "@resvg/resvg-js";

const RACINE = process.cwd();
const CHEMIN_GABARIT = path.join(RACINE, "scripts", "gabarit-social.md");
const CHEMIN_SUJETS = path.join(RACINE, "scripts", "sujets-social.json");
const DOSSIER_BROUILLONS = path.join(RACINE, "social-drafts");

// Qualité/coût. Passe à "claude-opus-4-8" si tu veux une rédaction plus fine.
const MODELE = "claude-sonnet-4-6";

function aujourdhui() {
  return new Date().toISOString().slice(0, 10); // yyyy-mm-dd
}

// ─────────────────────────────────────────────────────────────
//  Polices de la charte (installées via npm dans le workflow)
// ─────────────────────────────────────────────────────────────
function fichiersPolices() {
  const dossiers = [
    path.join(RACINE, "node_modules", "@expo-google-fonts", "playfair-display"),
    path.join(RACINE, "node_modules", "@expo-google-fonts", "dm-sans"),
  ];
  const fichiers = [];
  for (const d of dossiers) {
    if (fs.existsSync(d)) {
      for (const f of fs.readdirSync(d)) {
        if (f.toLowerCase().endsWith(".ttf")) fichiers.push(path.join(d, f));
      }
    }
  }
  return fichiers;
}

// ─────────────────────────────────────────────────────────────
//  Slide Instagram (1080 x 1350) — mise en page validée
// ─────────────────────────────────────────────────────────────
function echapper(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function couper(texte, maxCar) {
  const mots = String(texte).split(/\s+/);
  const lignes = [];
  let ligne = "";
  for (const m of mots) {
    const test = ligne ? ligne + " " + m : m;
    if (test.length > maxCar && ligne) {
      lignes.push(ligne);
      ligne = m;
    } else {
      ligne = test;
    }
  }
  if (ligne) lignes.push(ligne);
  return lignes;
}
function slideSvg({ title, body, index, total, cta }) {
  const W = 1080,
    H = 1350,
    MX = 110;
  const ty = 470,
    titreFs = 78,
    titreLh = 94,
    corpsFs = 42,
    corpsLh = 60;

  const titreLignes = couper(title, 20);
  const titreSvg = titreLignes
    .map(
      (l, i) =>
        `<text x="${MX}" y="${ty + i * titreLh}" font-family="Playfair Display" font-weight="700" font-size="${titreFs}" fill="#2C1810">${echapper(l)}</text>`
    )
    .join("");

  const by = ty + titreLignes.length * titreLh + 30;
  const corpsSvg = couper(body, 38)
    .map(
      (l, i) =>
        `<text x="${MX}" y="${by + i * corpsLh}" font-family="DM Sans" font-weight="400" font-size="${corpsFs}" fill="#3A2A1E">${echapper(l)}</text>`
    )
    .join("");

  const ctaSvg = cta
    ? `<text x="${MX}" y="${H - 150}" font-family="DM Sans" font-weight="700" font-size="44" fill="#C4873A">${echapper(cta)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#F6E1C8"/>
<text x="${MX}" y="135" font-family="Playfair Display" font-weight="700" font-size="46" fill="#2C1810">PauseCafé</text>
<text x="${W - MX}" y="135" text-anchor="end" font-family="DM Sans" font-weight="700" font-size="34" fill="#C4873A">${index}/${total}</text>
<rect x="${MX}" y="300" width="96" height="10" rx="5" fill="#C4873A"/>
${titreSvg}${corpsSvg}${ctaSvg}
</svg>`;
}
function rendrePng(svg, sortie) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1080 },
    font: {
      fontFiles: fichiersPolices(),
      loadSystemFonts: true, // secours si une police manque
      defaultFontFamily: "DM Sans",
    },
  });
  fs.writeFileSync(sortie, resvg.render().asPng());
}

// ─────────────────────────────────────────────────────────────
//  1) Charger le gabarit + le prochain sujet
// ─────────────────────────────────────────────────────────────
const gabarit = fs.readFileSync(CHEMIN_GABARIT, "utf8");
const sujets = JSON.parse(fs.readFileSync(CHEMIN_SUJETS, "utf8"));
const idx = sujets.findIndex((s) => s.statut === "a_faire");
if (idx === -1) {
  console.log('Aucun sujet "a_faire" dans sujets-social.json — rien à générer.');
  process.exit(0);
}
const sujet = sujets[idx];

// ─────────────────────────────────────────────────────────────
//  2) Appel à Claude
// ─────────────────────────────────────────────────────────────
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const consigne = [
  "Génère les posts pour ce sujet, en respectant le FORMAT DE SORTIE à la lettre.",
  `Archétype : ${sujet.archetype}`,
  `Angle : ${sujet.angle}`,
  sujet.feature ? `Fonctionnalité à mettre en avant : ${sujet.feature}` : "",
  sujet.source && sujet.source !== "standalone"
    ? `Tu peux t'appuyer sur l'article de blog : ${sujet.source}`
    : "",
]
  .filter(Boolean)
  .join("\n");

const reponse = await client.messages.create({
  model: MODELE,
  max_tokens: 3000,
  system: gabarit,
  messages: [{ role: "user", content: consigne }],
});
const texte = reponse.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("\n");
if (!texte.trim()) {
  console.error("Réponse vide du modèle, abandon.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
//  3) Séparer le thread X et le bloc JSON Instagram
// ─────────────────────────────────────────────────────────────
const m = texte.match(/```json\s*([\s\S]*?)```/i);
const threadX = (m ? texte.slice(0, m.index) : texte).trim();
let ig = null;
if (m) {
  try {
    ig = JSON.parse(m[1].trim());
  } catch (e) {
    console.error("Bloc JSON Instagram illisible :", e.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  4) Dossier de sortie
// ─────────────────────────────────────────────────────────────
const slug = `${aujourdhui()}-${sujet.id}`;
const dossier = path.join(DOSSIER_BROUILLONS, slug);
fs.mkdirSync(dossier, { recursive: true });

// ─────────────────────────────────────────────────────────────
//  5) Rendre les slides du carrousel
// ─────────────────────────────────────────────────────────────
const lignesImages = [];
if (ig && Array.isArray(ig.slides)) {
  const total = ig.slides.length;
  ig.slides.forEach((s, i) => {
    const estCTA = i === total - 1;
    const svg = slideSvg({
      title: s.title || "",
      body: s.body || "",
      index: i + 1,
      total,
      cta: estCTA ? ig.cta || "Télécharge PauseCafé · App Store" : null,
    });
    const nom = `slide-${i + 1}.png`;
    try {
      rendrePng(svg, path.join(dossier, nom));
      lignesImages.push(`![slide ${i + 1}](./${nom})`);
    } catch (e) {
      console.error(`Rendu de la slide ${i + 1} échoué :`, e.message);
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  6) Brouillon markdown (à relire dans la PR)
// ─────────────────────────────────────────────────────────────
let md = `# Brouillon posts sociaux — ${sujet.id}\n\n`;
md += `- Archétype : ${sujet.archetype}\n- Angle : ${sujet.angle}\n- Généré le : ${aujourdhui()}\n\n`;
md += `> À relire et ajuster. Remplace [lien App Store] par ton lien (UTM).\n\n---\n\n`;
md += `## X (thread)\n\n${threadX}\n\n`;
if (ig) {
  md += `## Instagram\n\n`;
  md += `**Légende :** ${ig.caption || ""}\n\n`;
  if (Array.isArray(ig.hashtags)) md += `**Hashtags :** ${ig.hashtags.join(" ")}\n\n`;
  md += `**Visuel du thread X :** ${ig.visuel_x || ""}\n\n`;
  if (lignesImages.length) {
    md += `**Carrousel (images générées) :**\n\n${lignesImages.join("\n")}\n\n`;
  }
  md += `**Textes des slides :**\n\n`;
  md += (ig.slides || []).map((s, i) => `${i + 1}. **${s.title}** — ${s.body}`).join("\n") + "\n";
}
fs.writeFileSync(path.join(dossier, "post.md"), md, "utf8");

// ─────────────────────────────────────────────────────────────
//  7) Marquer le sujet comme généré
// ─────────────────────────────────────────────────────────────
sujets[idx].statut = "genere";
fs.writeFileSync(CHEMIN_SUJETS, JSON.stringify(sujets, null, 2) + "\n", "utf8");

console.log(`Brouillon écrit : social-drafts/${slug}/ (${lignesImages.length} slide(s) générée(s))`);
