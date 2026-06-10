// Agent social PauseCafé — thread X + carrousel Instagram (texte + images PNG).
// Carrousel MIXTE : photo (couverture + slide finale) via Unsplash, texte au milieu.
// Lit le gabarit + le prochain sujet "a_faire", appelle Claude, rend les slides à la
// charte, écrit le tout dans social-drafts/ et marque le sujet. Le workflow ouvre une PR.

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

// Ton lien App Store, inséré automatiquement dans le dernier tweet.
// Pour suivre les clics, ajoute par ex. : "...id6761892198?utm_source=x&utm_medium=social"
const LIEN_APP_STORE = "https://apps.apple.com/app/id6761892198";

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
//  Photos d'ambiance (Unsplash — même principe que l'agent blog)
//  Sans clé UNSPLASH_ACCESS_KEY ou sans requête → carrousel 100% texte
//  (aucune erreur, repli propre).
// ─────────────────────────────────────────────────────────────
async function chargerPhotos(query, nb) {
  const cle = process.env.UNSPLASH_ACCESS_KEY;
  if (!cle || !query) return [];
  try {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${nb}&orientation=portrait`;
    const r = await fetch(url, { headers: { Authorization: `Client-ID ${cle}` } });
    const j = await r.json();
    const out = [];
    for (const ph of (j.results || []).slice(0, nb)) {
      const u = ph.urls?.regular;
      if (!u) continue;
      const img = await fetch(u);
      const buf = Buffer.from(await img.arrayBuffer());
      out.push({
        dataUri: `data:image/jpeg;base64,${buf.toString("base64")}`,
        credit: ph.user?.name || "",
      });
    }
    return out;
  } catch (e) {
    console.error("Unsplash indisponible :", e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
//  Rendu des slides (1080 x 1350)
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

// Blocs de texte communs (marque, numéro, filet, titre, corps, CTA)
function blocsTexte({ title, body, index, total, cta, couleurTitre, couleurCorps, couleurAccent }) {
  const W = 1080,
    H = 1350,
    MX = 110,
    ty = 470,
    titreFs = 78,
    titreLh = 94,
    corpsFs = 42,
    corpsLh = 60;

  const titreLignes = couper(title, 20);
  const titreSvg = titreLignes
    .map(
      (l, i) =>
        `<text x="${MX}" y="${ty + i * titreLh}" font-family="Playfair Display" font-weight="700" font-size="${titreFs}" fill="${couleurTitre}">${echapper(l)}</text>`
    )
    .join("");

  const by = ty + titreLignes.length * titreLh + 30;
  const corpsSvg = couper(body, 38)
    .map(
      (l, i) =>
        `<text x="${MX}" y="${by + i * corpsLh}" font-family="DM Sans" font-weight="400" font-size="${corpsFs}" fill="${couleurCorps}">${echapper(l)}</text>`
    )
    .join("");

  const ctaSvg = cta
    ? `<text x="${MX}" y="${H - 150}" font-family="DM Sans" font-weight="700" font-size="44" fill="${couleurAccent}">${echapper(cta)}</text>`
    : "";

  const haut = `<text x="${MX}" y="135" font-family="Playfair Display" font-weight="700" font-size="46" fill="${couleurTitre}">PauseCafé</text>
<text x="${W - MX}" y="135" text-anchor="end" font-family="DM Sans" font-weight="700" font-size="34" fill="${couleurAccent}">${index}/${total}</text>
<rect x="${MX}" y="300" width="96" height="10" rx="5" fill="${couleurAccent}"/>`;

  return haut + titreSvg + corpsSvg + ctaSvg;
}

// Slide texte (fond beige, texte foncé)
function slideTexte(opts) {
  const blocs = blocsTexte({
    ...opts,
    couleurTitre: "#2C1810",
    couleurCorps: "#3A2A1E",
    couleurAccent: "#C4873A",
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1350">
<rect width="1080" height="1350" fill="#F6E1C8"/>
${blocs}
</svg>`;
}

// Slide photo (photo plein cadre + voile sombre + texte clair)
function slidePhoto(opts) {
  const blocs = blocsTexte({
    ...opts,
    couleurTitre: "#F6E1C8",
    couleurCorps: "#F0E4D2",
    couleurAccent: "#E3A24F",
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1350">
<image href="${opts.imgDataUri}" x="0" y="0" width="1080" height="1350" preserveAspectRatio="xMidYMid slice"/>
<rect width="1080" height="1350" fill="#1A0F0A" opacity="0.55"/>
${blocs}
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
//  5) Photos + rendu du carrousel (mixte)
// ─────────────────────────────────────────────────────────────
const lignesImages = [];
const credits = [];
if (ig && Array.isArray(ig.slides)) {
  const total = ig.slides.length;
  const photos = await chargerPhotos(ig.photo_query, 2);
  for (const p of photos) if (p.credit) credits.push(p.credit);
  const photoCouv = photos[0]?.dataUri || null;
  const photoCta = photos[1]?.dataUri || photos[0]?.dataUri || null;

  ig.slides.forEach((s, i) => {
    const estCouv = i === 0;
    const estCTA = i === total - 1;
    const base = { title: s.title || "", body: s.body || "", index: i + 1, total };
    let svg;
    if (estCouv && photoCouv) {
      svg = slidePhoto({ ...base, imgDataUri: photoCouv });
    } else if (estCTA && photoCta) {
      svg = slidePhoto({ ...base, cta: ig.cta || "Télécharge PauseCafé · App Store", imgDataUri: photoCta });
    } else {
      svg = slideTexte({ ...base, cta: estCTA ? ig.cta || "Télécharge PauseCafé · App Store" : null });
    }
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
md += `> À relire et ajuster avant publication. (Le lien App Store est déjà inséré.)\n\n---\n\n`;
md += `## X (thread)\n\n${threadX}\n\n`;
if (ig) {
  let legende = ig.caption || "";
  if (credits.length) legende += `\n\n📷 Photos : ${[...new Set(credits)].join(", ")} / Unsplash`;
  md += `## Instagram\n\n**Légende :** ${legende}\n\n`;
  if (Array.isArray(ig.hashtags)) md += `**Hashtags :** ${ig.hashtags.join(" ")}\n\n`;
  md += `**Visuel du thread X :** ${ig.visuel_x || ""}\n\n`;
  if (lignesImages.length) {
    md += `**Carrousel (images générées) :**\n\n${lignesImages.join("\n")}\n\n`;
  }
  md += `**Textes des slides :**\n\n`;
  md += (ig.slides || []).map((s, i) => `${i + 1}. **${s.title}** — ${s.body}`).join("\n") + "\n";
}
// Insère ton vrai lien App Store partout où le modèle a laissé le repère.
md = md.replace(/\[lien App Store\]/gi, LIEN_APP_STORE);
fs.writeFileSync(path.join(dossier, "post.md"), md, "utf8");

// ─────────────────────────────────────────────────────────────
//  7) Marquer le sujet comme généré
// ─────────────────────────────────────────────────────────────
sujets[idx].statut = "genere";
fs.writeFileSync(CHEMIN_SUJETS, JSON.stringify(sujets, null, 2) + "\n", "utf8");

console.log(
  `Brouillon écrit : social-drafts/${slug}/ (${lignesImages.length} slide(s), ${credits.length} photo(s))`
);
