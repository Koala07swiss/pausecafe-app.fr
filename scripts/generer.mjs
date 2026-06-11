// ============================================================================
//  generer.mjs — Agent de rédaction PauseCafé
//  Flux : rédige → vérifie → CORRIGE (auto) → re-vérifie → PR
//  À chaque article : crée la page + insère la carte dans blog.html + l'URL dans sitemap.xml
//  Règle dure : rien de douteux ne survit. Corrigé, supprimé, ou signalé ⛔.
//  Ne publie RIEN : c'est la PR + ton merge qui publient.
// ============================================================================
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT      = process.cwd();
const BLOG      = path.join(ROOT, 'blog');
const SUJETS    = path.join(ROOT, 'scripts', 'sujets.json');
const GABARIT   = path.join(ROOT, 'scripts', 'gabarit-systeme.md');
const BLOG_HTML = path.join(ROOT, 'blog.html');
const SITEMAP   = path.join(ROOT, 'sitemap.xml');

const API_KEY   = process.env.ANTHROPIC_API_KEY;
const UNSPLASH  = process.env.UNSPLASH_ACCESS_KEY;
const MODELE    = process.env.MODELE || 'claude-sonnet-4-6';
const SUJET_ARG = (process.env.SUJET || '').trim();
const DRY       = process.env.DRY_RUN === '1';

const log = (...a) => console.log('•', ...a);
const erreur = (m) => { console.error('✗', m); process.exit(1); };
function dormir(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 1. Outils
// ---------------------------------------------------------------------------
function slugify(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}
function echapHTML(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const MOIS = ['janvier','février','mars','avril','mai','juin','juillet','août',
              'septembre','octobre','novembre','décembre'];
function dateAffichee(d) { return `${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}`; }
function dateISO(d) { return d.toISOString().slice(0, 10); }

async function listerSlugsExistants() {
  if (!existsSync(BLOG)) return [];
  const ent = await readdir(BLOG, { withFileTypes: true });
  return ent.filter(e => e.isDirectory()).map(e => e.name);
}

function compterProblemes(rapport) {
  const avert = (rapport.match(/⚠️/g) || []).length;
  const bloq  = (rapport.match(/⛔/g) || []).length;
  return { avert, bloq, total: avert + bloq };
}

// ---------------------------------------------------------------------------
// 2. Appel API Anthropic (recherche web + ré-essai auto si limite de débit)
// ---------------------------------------------------------------------------
async function appelerClaude(prompt, { web = true, maxTokens = 8000, essai = 0 } = {}) {
  const body = {
    model: MODELE,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  };
  if (web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (r.status === 429 && essai < 3) {
    const attente = Number(r.headers.get('retry-after')) || 65;
    log(`Limite de débit atteinte — pause ${attente}s puis nouvel essai…`);
    await dormir(attente * 1000);
    return appelerClaude(prompt, { web, maxTokens, essai: essai + 1 });
  }
  if (!r.ok) throw new Error(`API Anthropic ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

function extraireJSON(txt) {
  let t = txt.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b === -1) throw new Error('Pas de JSON dans la réponse du modèle.');
  return JSON.parse(t.slice(a, b + 1));
}

// ---------------------------------------------------------------------------
// 3. Vérification des FAITS
// ---------------------------------------------------------------------------
async function verifierFaits(corpsHTML, sourcesHTML) {
  return appelerClaude(
`Tu es un fact-checker rigoureux pour un site santé. Vérifie via recherche web CHAQUE étude, chiffre, date, revue et affirmation factuelle de cet article.

Règles de notation STRICTES :
- ✅ = vérifié et exact (source réelle, métadonnées correctes).
- ⚠️ = douteux, imprécis, ou non confirmé par la recherche.
- ⛔ = FAUX ou invérifiable (étude introuvable, mauvaise revue, chiffre erroné, mauvaise attribution).

Signale en particulier : toute revue/journal mal attribué, toute date non confirmée, toute source que tu ne retrouves pas, tout chiffre attribué au mauvais auteur, tout numéro de page douteux.

Réponds en Markdown : une ligne ✅/⚠️/⛔ par affirmation, puis une dernière ligne "VERDICT: PROPRE" si tout est ✅, sinon "VERDICT: A_CORRIGER".

ARTICLE (corps HTML) :
${corpsHTML}

SOURCES CITÉES :
${sourcesHTML}`,
    { web: true, maxTokens: 2500 }
  );
}

// ---------------------------------------------------------------------------
// 4. CORRECTION automatique : réécrit l'article d'après le rapport
// ---------------------------------------------------------------------------
async function corrigerArticle(d, rapport) {
  const txt = await appelerClaude(
`Voici un article de blog santé (JSON) et un rapport de fact-checking qui a relevé des problèmes.

RÈGLE ABSOLUE : pour CHAQUE point marqué ⚠️ ou ⛔ dans le rapport, tu DOIS soit le corriger avec une information vérifiée, soit SUPPRIMER l'affirmation/source/chiffre concerné. Dans le moindre doute : SUPPRIME plutôt que de garder. Ne laisse passer aucun problème signalé. Ne nomme une revue/journal que si tu es certain ; sinon retire le nom de la revue. N'indique pas de numéros de page si tu n'en es pas certain.

Ne change RIEN d'autre (garde le ton, la structure, les parties ✅). Renvoie l'article corrigé au MÊME format JSON strict (mêmes clés : titre, slug, categorie, description, motsCles, tempsLecture, heroQuery, heroAlt, corpsHTML, sourcesHTML, connexes), sans aucun texte autour.

RAPPORT DE FACT-CHECKING :
${rapport}

ARTICLE ACTUEL (JSON) :
${JSON.stringify(d)}`,
    { web: true, maxTokens: 8000 }
  );
  const corrige = extraireJSON(txt);
  corrige.slug = d.slug;
  return corrige;
}

// ---------------------------------------------------------------------------
// 5. Image : Unsplash (hotlink + crédit, conforme), repli SVG si échec
// ---------------------------------------------------------------------------
async function imageUnsplash(query, alt) {
  if (!UNSPLASH || DRY) return null;
  try {
    const u = `https://api.unsplash.com/search/photos?per_page=1&orientation=landscape&query=${encodeURIComponent(query)}`;
    const r = await fetch(u, { headers: { Authorization: `Client-ID ${UNSPLASH}` } });
    if (!r.ok) return null;
    const j = await r.json();
    const photo = j.results?.[0];
    if (!photo) return null;
    fetch(`${photo.links.download_location}&client_id=${UNSPLASH}`).catch(() => {});
    const src = `${photo.urls.raw}&w=900&q=80&fm=jpg&fit=crop`;
    const srcCarte = `${photo.urls.raw}&w=600&q=75&fm=jpg&fit=crop`;
    const prof = `${photo.user.links.html}?utm_source=pausecafe&utm_medium=referral`;
    const credit = `Photo : <a href="${prof}" target="_blank" rel="noopener">${photo.user.name}</a> / <a href="https://unsplash.com/?utm_source=pausecafe&utm_medium=referral" target="_blank" rel="noopener">Unsplash</a>`;
    return { html: `<img src="${src}" alt="${alt}" loading="lazy">`, credit, srcCarte };
  } catch { return null; }
}

function heroSVG(alt) {
  return `<svg viewBox="0 0 900 360" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${alt}" style="width:100%;max-width:900px;display:block;margin:0 auto;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
  <rect width="900" height="360" rx="16" fill="#1A0F0A"/>
  <ellipse cx="450" cy="150" rx="380" ry="220" fill="#C4873A" opacity="0.12"/>
  <path d="M360 150 L540 150 L518 280 L382 280 Z" fill="#E8D5B0"/>
  <ellipse cx="450" cy="150" rx="90" ry="16" fill="#5C3A21"/>
  <path d="M540 175 C 590 182 590 250 512 258" fill="none" stroke="#E8D5B0" stroke-width="12" stroke-linecap="round"/>
  <text x="450" y="330" font-family="'Playfair Display',serif" font-size="22" font-weight="700" fill="#F5EDD6" text-anchor="middle">PauseCafé</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// 6. Disclaimer médical
// ---------------------------------------------------------------------------
function blocDisclaimer() {
  return `  <div class="disclaimer-box" style="background:#FBF5E9;border:1px solid rgba(196,135,58,0.35);border-radius:12px;padding:18px 22px;margin-top:48px;">
    <p style="margin:0;font-size:0.82rem;line-height:1.6;color:#5C4033;">
      <strong>⚕️ Information importante.</strong> Cet article a une vocation purement informative et de bien-être. Il ne constitue pas un avis médical, un diagnostic ou une prescription. Les effets de la caféine varient d'une personne à l'autre. En cas de question sur votre consommation, de symptôme, de grossesse, de traitement médical ou de problème de santé, consultez un professionnel de santé (médecin, pharmacien). Ne modifiez pas un traitement sur la seule base de cet article.
    </p>
  </div>`;
}

// ---------------------------------------------------------------------------
// 7. Vérification des LIENS
// ---------------------------------------------------------------------------
async function verifierLiens(html, slugsExistants) {
  const liens = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]);
  const lignes = [];
  let ko = 0;
  const vus = new Set();
  for (const lien of liens) {
    if (vus.has(lien)) continue; vus.add(lien);
    if (lien.startsWith('/blog/')) {
      const slug = lien.replace('/blog/', '').replace(/\/$/, '').split('#')[0];
      if (!slug) continue;
      const ok = slugsExistants.includes(slug);
      if (!ok) ko++;
      lignes.push(`- ${ok ? '✅' : '⛔'} interne \`${lien}\`${ok ? '' : ' — SLUG INEXISTANT'}`);
    } else if (/^https?:\/\//.test(lien)) {
      let ok = false, code = '?';
      try {
        const r = await fetch(lien, { method: 'GET', redirect: 'follow' });
        code = r.status; ok = r.ok;
      } catch (e) { code = 'erreur réseau'; }
      if (!ok) ko++;
      lignes.push(`- ${ok ? '✅' : '⚠️'} externe \`${lien}\` (${code})`);
    }
  }
  return { rapport: lignes.join('\n') || '- (aucun lien)', ko };
}

// ---------------------------------------------------------------------------
// 8. Mise à jour de blog.html (insère la carte au repère AGENT)
// ---------------------------------------------------------------------------
async function majBlogHTML(d, srcCarte, today) {
  if (!existsSync(BLOG_HTML)) { log('⚠️ blog.html introuvable, étape ignorée'); return false; }
  let html = await readFile(BLOG_HTML, 'utf8');
  const REPERE = '<!-- AGENT:NOUVELLE-CARTE -->';
  if (!html.includes(REPERE)) { log('⚠️ repère AGENT absent de blog.html, étape ignorée'); return false; }
  if (html.includes(`/blog/${d.slug}"`)) { log('Carte déjà présente dans blog.html'); return true; }

  const imgSrc = srcCarte || 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=600&q=75&auto=format&fit=crop';
  const carte = `
    <a href="/blog/${d.slug}" class="article-card">
      <div class="card-img">
        <img src="${imgSrc}" alt="${echapHTML(d.heroAlt || d.titre)}" loading="lazy">
      </div>
      <div class="card-top">
        <p class="card-tag">${echapHTML(d.categorie)}</p>
        <h3 class="card-title">${echapHTML(d.titre)}</h3>
        <p class="card-excerpt">${echapHTML(d.description)}</p>
      </div>
      <div class="card-footer"><span class="card-date">${today}</span><span class="card-read">${echapHTML(d.tempsLecture).replace(' de lecture','')} →</span></div>
    </a>`;
  html = html.replace(REPERE, REPERE + carte);

  // Ajoute la catégorie dans l'objet JS `categories = {`
  const ancre = 'const categories = {';
  if (html.includes(ancre) && !html.includes(`'${d.slug}':`)) {
    html = html.replace(ancre, `${ancre}\n    '${d.slug}': '${d.categorie}',`);
  }
  await writeFile(BLOG_HTML, html);
  log('blog.html : carte insérée');
  return true;
}

// ---------------------------------------------------------------------------
// 9. Mise à jour de sitemap.xml (insère l'URL au repère AGENT)
// ---------------------------------------------------------------------------
async function majSitemap(d, isoToday) {
  if (!existsSync(SITEMAP)) { log('⚠️ sitemap.xml introuvable, étape ignorée'); return false; }
  let xml = await readFile(SITEMAP, 'utf8');
  const REPERE = '<!-- AGENT:NOUVELLE-URL -->';
  if (!xml.includes(REPERE)) { log('⚠️ repère AGENT absent de sitemap.xml, étape ignorée'); return false; }
  if (xml.includes(`/blog/${d.slug}/`)) { log('URL déjà présente dans sitemap.xml'); return true; }

  const bloc = `${REPERE}
  <url>
    <loc>https://pausecafe-app.fr/blog/${d.slug}/</loc>
    <lastmod>${isoToday}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.85</priority>
  </url>`;
  xml = xml.replace(REPERE, bloc);
  // Met à jour le lastmod de la page /blog
  xml = xml.replace(
    /(<loc>https:\/\/pausecafe-app\.fr\/blog<\/loc>\s*<lastmod>)[^<]*(<\/lastmod>)/,
    `$1${isoToday}$2`
  );
  await writeFile(SITEMAP, xml);
  log('sitemap.xml : URL ajoutée + date /blog actualisée');
  return true;
}

// ---------------------------------------------------------------------------
// 10. Assemblage du fichier HTML article
// ---------------------------------------------------------------------------
function construireHTML(d, heroBlock, dHero, creditHTML, today) {
  const connexes = d.connexes.map(c =>
    `      <a href="/blog/${c.slug}" class="related-card"><div class="r-cat">${c.cat}</div><div class="r-title">${c.titre}</div></a>`
  ).join('\n');
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${d.titre} | PauseCafé</title>
  <meta name="description" content="${echapHTML(d.description)}">
  <meta name="keywords" content="${echapHTML(d.motsCles)}">
  <link rel="canonical" href="https://pausecafe-app.fr/blog/${d.slug}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://pausecafe-app.fr/blog/${d.slug}">
  <meta property="og:title" content="${echapHTML(d.titre)}">
  <meta property="og:description" content="${echapHTML(d.description)}">
  <meta property="og:image" content="https://pausecafe-app.fr/logo.png">
  <meta property="og:site_name" content="PauseCafé">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${echapHTML(d.titre)}">
  <meta name="twitter:description" content="${echapHTML(d.description)}">
  <meta name="twitter:image" content="https://pausecafe-app.fr/logo.png">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${d.titre.replace(/"/g,'\\"')}","author":{"@type":"Person","name":"Kévin Beguerie"},"publisher":{"@type":"Organization","name":"PauseCafé","url":"https://pausecafe-app.fr"},"datePublished":"${dHero}","dateModified":"${dHero}","mainEntityOfPage":"https://pausecafe-app.fr/blog/${d.slug}"}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    :root{--cafe:#2C1810;--cream:#F5EDD6;--espresso:#1A0F0A;--caramel:#C4873A;--mousse:#E8D5B0;}
    *{margin:0;padding:0;box-sizing:border-box;}html{scroll-behavior:smooth;}
    body{font-family:'DM Sans',sans-serif;background:var(--cream);color:var(--cafe);overflow-x:hidden;line-height:1.7;}
    nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:14px 48px;background:rgba(245,237,214,0.95);backdrop-filter:blur(12px);border-bottom:1px solid rgba(196,135,58,0.2);}
    .nav-logo{font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:900;color:var(--cafe);text-decoration:none;display:flex;align-items:center;gap:10px;}
    .nav-logo img{width:32px;height:32px;border-radius:8px;}
    .nav-back{font-size:0.82rem;color:var(--cafe);text-decoration:none;opacity:0.6;}
    .article-hero{background:var(--espresso);padding:140px 48px 80px;position:relative;overflow:hidden;}
    .article-hero::before{content:'☕';position:absolute;font-size:22vw;right:-2vw;top:50%;transform:translateY(-50%);opacity:0.05;pointer-events:none;}
    .hero-inner{max-width:780px;margin:0 auto;}
    .article-cat{display:inline-block;background:var(--caramel);color:white;font-size:0.72rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:5px 14px;border-radius:100px;margin-bottom:24px;}
    .article-hero h1{font-family:'Playfair Display',serif;font-size:clamp(2rem,4.5vw,3.2rem);font-weight:900;line-height:1.12;color:var(--cream);margin-bottom:20px;}
    .article-meta{display:flex;gap:20px;flex-wrap:wrap;}
    .meta-item{font-size:0.82rem;color:rgba(245,237,214,0.5);}
    .meta-sep{color:rgba(245,237,214,0.2);}
    .hero-image-wrap{padding:0 48px;margin-top:-40px;}
    .hero-image-wrap img{width:100%;max-width:900px;display:block;margin:0 auto;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,0.3);}
    .hero-credit{max-width:900px;margin:8px auto 0;text-align:right;font-size:0.72rem;color:#9E8070;}
    .hero-credit a{color:#9E8070;}
    .article-body{max-width:780px;margin:0 auto;padding:64px 48px 80px;}
    .article-body h2{font-family:'Playfair Display',serif;font-size:1.7rem;font-weight:700;color:var(--cafe);margin:48px 0 16px;line-height:1.2;}
    .article-body h3{font-family:'Playfair Display',serif;font-size:1.2rem;font-weight:700;color:var(--cafe);margin:32px 0 12px;}
    .article-body p{font-size:1rem;line-height:1.85;color:#3D2010;margin-bottom:20px;font-weight:300;}
    .article-body strong{font-weight:500;color:var(--cafe);}
    .article-body a{color:var(--caramel);text-decoration:underline;text-underline-offset:2px;}
    .article-body ul,ol{padding-left:24px;margin-bottom:20px;}
    .article-body li{font-size:1rem;line-height:1.8;color:#3D2010;font-weight:300;margin-bottom:6px;}
    .highlight-box{background:white;border-left:4px solid var(--caramel);border-radius:0 12px 12px 0;padding:20px 24px;margin:32px 0;box-shadow:0 4px 16px rgba(44,24,16,0.06);}
    .highlight-box p{margin:0;font-size:0.95rem;color:#3D2010;}
    .range-viz{background:white;border-radius:16px;padding:28px;margin:32px 0;box-shadow:0 4px 16px rgba(44,24,16,0.06);}
    .range-viz h4{font-size:0.85rem;color:#9E8070;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:20px;}
    .range-row{display:flex;align-items:center;gap:12px;margin-bottom:14px;}
    .range-label{font-size:0.8rem;color:var(--cafe);min-width:160px;}
    .range-track{position:relative;flex:1;height:16px;background:#F0E9D8;border-radius:100px;}
    .range-fill{position:absolute;height:16px;border-radius:100px;background:var(--caramel);}
    .range-val{font-size:0.78rem;color:#9E8070;min-width:78px;text-align:right;}
    .range-scale{font-size:0.72rem;color:#B0A088;margin-top:6px;font-style:italic;}
    .profile-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:32px 0;}
    .profile-card{background:white;border-radius:12px;padding:20px;box-shadow:0 4px 12px rgba(44,24,16,0.06);}
    .profile-card h4{font-size:0.9rem;font-weight:500;color:var(--cafe);margin-bottom:8px;}
    .profile-card p{font-size:0.82rem;color:#5C4033;font-weight:300;margin:0;line-height:1.6;}
    .profile-icon{font-size:1.8rem;margin-bottom:8px;}
    .sources-section{background:var(--mousse);border-radius:16px;padding:28px 32px;margin-top:48px;}
    .sources-section h4{font-size:0.85rem;font-weight:500;color:var(--cafe);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.08em;}
    .sources-section ul{list-style:none;padding:0;}
    .sources-section li{font-size:0.82rem;color:#5C4033;margin-bottom:6px;padding-left:16px;position:relative;}
    .sources-section li::before{content:'→';position:absolute;left:0;color:var(--caramel);}
    .cta-section{background:var(--espresso);border-radius:20px;padding:48px 40px;text-align:center;margin-top:64px;position:relative;overflow:hidden;}
    .cta-section::before{content:'';position:absolute;width:400px;height:400px;border-radius:50%;background:radial-gradient(circle,rgba(196,135,58,0.12) 0%,transparent 70%);top:50%;left:50%;transform:translate(-50%,-50%);}
    .cta-section h3{font-family:'Playfair Display',serif;font-size:1.8rem;font-weight:900;color:var(--cream);margin-bottom:12px;position:relative;}
    .cta-section p{color:rgba(245,237,214,0.6);margin-bottom:32px;font-weight:300;position:relative;}
    .cta-badge img{height:56px;width:auto;display:block;}
    .cta-badge{display:inline-block;transition:opacity 0.2s,transform 0.2s;}
    .cta-badge:hover{opacity:0.85;transform:translateY(-2px);}
    .related{margin-top:64px;}
    .related h3{font-family:'Playfair Display',serif;font-size:1.3rem;font-weight:700;color:var(--cafe);margin-bottom:24px;}
    .related-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;}
    .related-card{background:var(--espresso);border-radius:12px;padding:20px;text-decoration:none;transition:transform 0.2s;}
    .related-card:hover{transform:translateY(-2px);}
    .related-card .r-cat{font-size:0.7rem;color:var(--caramel);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;}
    .related-card .r-title{font-size:0.9rem;font-weight:500;color:var(--cream);line-height:1.35;}
    footer{background:var(--espresso);color:var(--cream);padding:48px;text-align:center;}
    footer p{font-size:0.82rem;opacity:0.4;}footer a{color:var(--caramel);text-decoration:none;}
    @media(max-width:768px){nav{padding:12px 20px;}.article-hero{padding:110px 24px 60px;}.hero-image-wrap{padding:0 24px;}.article-body{padding:40px 24px 60px;}.profile-grid{grid-template-columns:1fr;}.range-label{min-width:108px;font-size:0.72rem;}.range-val{min-width:64px;font-size:0.72rem;}}
  </style>
</head>
<body>
<nav>
  <a href="https://pausecafe-app.fr" class="nav-logo"><img src="/logo.png" alt="PauseCafé">PauseCafé</a>
  <a href="/blog" class="nav-back">← Tous les articles</a>
</nav>

<section class="article-hero">
  <div class="hero-inner">
    <span class="article-cat">${d.categorie}</span>
    <h1>${d.titre}</h1>
    <div class="article-meta">
      <span class="meta-item">${today}</span>
      <span class="meta-sep">·</span>
      <span class="meta-item">${d.tempsLecture}</span>
      <span class="meta-sep">·</span>
      <span class="meta-item">Par Kévin Beguerie</span>
    </div>
  </div>
</section>

<div class="hero-image-wrap">
  ${heroBlock}
</div>
${creditHTML}

<article class="article-body">

${d.corpsHTML}

  <div class="sources-section">
    <h4>Sources scientifiques</h4>
    <ul>
${d.sourcesHTML}
    </ul>
  </div>

${blocDisclaimer()}

  <div class="cta-section">
    <h3>Arrêtez d'estimer. Mesurez.</h3>
    <p>PauseCafé enregistre la teneur réelle en caféine de chaque boisson pour un cumul du jour fiable. Gratuit, sans pub.</p>
    <a href="https://apps.apple.com/fr/app/pausecafe/id6761892198" target="_blank" rel="noopener" class="cta-badge">
      <img src="/app-store-badge-fr.svg" alt="Télécharger PauseCafé sur l'App Store">
    </a>
  </div>

  <div class="related">
    <h3>Articles connexes</h3>
    <div class="related-grid">
${connexes}
    </div>
  </div>

</article>
<footer><p>© 2026 PauseCafé · <a href="https://pausecafe-app.fr">pausecafe-app.fr</a> · <a href="/blog">Tous les articles</a></p></footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// 11. Programme principal
// ---------------------------------------------------------------------------
async function main() {
  if (!API_KEY && !DRY) erreur('ANTHROPIC_API_KEY manquante (secret GitHub).');
  const today = new Date();

  const conf = JSON.parse(await readFile(SUJETS, 'utf8'));
  const gabarit = await readFile(GABARIT, 'utf8');
  const slugsExistants = await listerSlugsExistants();
  log('Articles déjà publiés :', slugsExistants.join(', ') || '(aucun)');

  let sujet;
  if (SUJET_ARG) {
    sujet = { titre: SUJET_ARG, slug: slugify(SUJET_ARG), angle: '', categorie: 'Conseils pratiques', heroQuery: 'coffee cup' };
  } else {
    sujet = conf.sujets.find(s => s.statut === 'a_faire' && !slugsExistants.includes(s.slug));
  }
  if (!sujet) erreur('Aucun sujet à traiter dans sujets.json.');
  log('Sujet choisi :', sujet.titre, `(${sujet.slug})`);

  const contexte = `${gabarit}

## Contexte de cette commande
- Date du jour : ${dateAffichee(today)}
- Sujet : ${sujet.titre}
- Angle imposé : ${sujet.angle || '(libre)'}
- Catégorie suggérée : ${sujet.categorie}
- Slug imposé : ${sujet.slug}
- Articles DÉJÀ publiés (ne pas refaire, à utiliser pour les liens internes) :
${slugsExistants.map(s => `  - /blog/${s}`).join('\n') || '  (aucun)'}

Rédige l'article maintenant. Réponds en JSON strict uniquement. Utilise le slug imposé.`;

  let d, rapportFaits, problemesRestants = { avert: 0, bloq: 0, total: 0 }, corrige = false;

  if (DRY) {
    d = {
      titre: sujet.titre, slug: sujet.slug, categorie: sujet.categorie,
      description: 'Description de test.', motsCles: 'caféine, test',
      tempsLecture: '5 min de lecture', heroQuery: sujet.heroQuery || 'coffee',
      heroAlt: 'Image de test',
      corpsHTML: '  <p>Test.</p>',
      sourcesHTML: '      <li>Auteur A. (2020). Titre. Revue.</li>',
      connexes: [{ slug: 'cafeine-sommeil', cat: 'Sommeil', titre: 'Caféine et sommeil' }],
    };
    rapportFaits = '_(dry run)_';
  } else {
    log('1/4 Rédaction (API + recherche web)…');
    d = extraireJSON(await appelerClaude(contexte, { web: true, maxTokens: 8000 }));
    d.slug = sujet.slug;

    log('Pause anti-limite…'); await dormir(65000);
    log('2/4 Vérification des faits…');
    rapportFaits = await verifierFaits(d.corpsHTML, d.sourcesHTML);
    let pb = compterProblemes(rapportFaits);
    log(`   → ${pb.total} problème(s) détecté(s) (${pb.bloq} ⛔ / ${pb.avert} ⚠️)`);

    if (pb.total > 0) {
      log('Pause anti-limite…'); await dormir(65000);
      log('3/4 Correction automatique…');
      d = await corrigerArticle(d, rapportFaits);
      log('Pause anti-limite…'); await dormir(65000);
      log('4/4 Re-vérification…');
      rapportFaits = await verifierFaits(d.corpsHTML, d.sourcesHTML);
      problemesRestants = compterProblemes(rapportFaits);
      corrige = true;
      log(`   → après correction : ${problemesRestants.total} problème(s) restant(s)`);
    } else {
      log('Article propre dès la 1ère passe.');
    }
  }

  const dossier = path.join(BLOG, d.slug);
  await mkdir(dossier, { recursive: true });

  const img = await imageUnsplash(d.heroQuery, d.heroAlt || d.titre);
  const heroBlock = img ? img.html : heroSVG(d.heroAlt || d.titre);
  const creditHTML = img ? `<p class="hero-credit">${img.credit}</p>` : '';
  log('Image :', img ? 'photo Unsplash (hotlink + crédit)' : 'repli SVG généré');

  const html = construireHTML(d, heroBlock, dateISO(today), creditHTML, dateAffichee(today));
  await writeFile(path.join(dossier, 'index.html'), html);
  log('Écrit :', `blog/${d.slug}/index.html`);

  // 🆕 Mise à jour automatique de la page liste + sitemap
  const blogOk = await majBlogHTML(d, img ? img.srcCarte : null, dateAffichee(today));
  const sitemapOk = await majSitemap(d, dateISO(today));

  const connexesHrefs = d.connexes.map(c => `href="/blog/${c.slug}"`).join(' ');
  const contenuVariable = `${d.corpsHTML}\n${d.sourcesHTML}\n${connexesHrefs}`;
  const { rapport: liens, ko } = await verifierLiens(contenuVariable, slugsExistants.concat(d.slug));

  if (!SUJET_ARG) {
    const i = conf.sujets.findIndex(s => s.slug === d.slug);
    if (i >= 0) { conf.sujets[i].statut = 'brouillon'; await writeFile(SUJETS, JSON.stringify(conf, null, 2)); }
  }

  let bandeau = '';
  if (problemesRestants.bloq > 0) {
    bandeau = `> # ⛔ À CORRIGER À LA MAIN AVANT MERGE\n> Il reste **${problemesRestants.bloq} problème(s) bloquant(s)** non résolus (voir ⛔ ci-dessous). **Ne pas merger en l'état.**\n\n`;
  } else if (problemesRestants.avert > 0) {
    bandeau = `> # ⚠️ À RELIRE\n> Il reste **${problemesRestants.avert} point(s)** à vérifier (voir ⚠️ ci-dessous).\n\n`;
  } else if (corrige) {
    bandeau = `> # ✅ Corrigé automatiquement\n> Des problèmes avaient été détectés puis corrigés. Plus aucun problème après correction.\n\n`;
  } else {
    bandeau = `> # ✅ Propre dès la première passe\n\n`;
  }

  const rapport = `${bandeau}# 📋 Brouillon : ${d.titre}

**Slug :** \`blog/${d.slug}/\` · **Catégorie :** ${d.categorie} · **${d.tempsLecture}**
**Image :** ${img ? 'photo Unsplash (hotlink + crédit)' : 'SVG généré (repli)'}
**Disclaimer médical :** ✅ ajouté automatiquement
**Correction auto :** ${corrige ? 'oui' : 'non nécessaire'}
**Page liste (blog.html) :** ${blogOk ? '✅ carte ajoutée' : '⚠️ non mise à jour'}
**Sitemap :** ${sitemapOk ? '✅ URL ajoutée' : '⚠️ non mis à jour'}

## 🔗 Liens (internes + externes)
${liens}
${ko ? `\n> ⚠️ **${ko} lien(s) à corriger avant merge.**` : '\n> ✅ Tous les liens sont valides.'}

## 🔬 Vérification des faits ${corrige ? '(après correction)' : ''}
${rapportFaits}

---
*Généré automatiquement. Relis, puis **merge** pour publier — ou ferme pour rejeter.*
`;
  await writeFile(path.join(ROOT, 'VERIFICATION.md'), rapport);
  log('Rapport écrit : VERIFICATION.md');

  if (process.env.GITHUB_ENV) {
    await writeFile(process.env.GITHUB_ENV, `PR_TITRE=Article : ${d.titre}\n`, { flag: 'a' });
  }
  console.log('\n✓ Terminé.');
}

main().catch(e => erreur(e.message));
