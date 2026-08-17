#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
//  reprendre.mjs — Reprise d'un article après ton arbitrage
//
//  Le problème que ce script résout : jusqu'ici, le rapport de vérification
//  disait « ⛔ ne pas merger » et tu n'avais que deux issues, aussi mauvaises
//  l'une que l'autre — publier un texte imprécis, ou ne rien publier.
//
//  Désormais, chaque problème signalé devient une décision séparée :
//     ✅ Corriger      → l'agent applique la correction proposée
//     ❌ Garder        → tu estimes que l'article a raison, on n'y touche pas
//     ✏️ Autre         → l'agent suit TON instruction, écrite à côté
//
//  Ce script lit tes réponses dans le commentaire de la Pull Request,
//  reconstruit l'article en conséquence, et repose une nouvelle checklist.
//  Tu peux boucler autant de fois que nécessaire.
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ROOT    = process.cwd();
const BLOG    = path.join(ROOT, 'blog');
const BLOG_EN = path.join(ROOT, 'en', 'blog');

const CLE      = process.env.ANTHROPIC_API_KEY;
const TOKEN    = process.env.GITHUB_TOKEN;
const REPO     = process.env.GITHUB_REPOSITORY;          // ex. Koala07swiss/pausecafe-app.fr
const NUM_PR   = process.env.NUMERO_PR;
const ID_COMM  = process.env.ID_COMMENTAIRE;

const log    = (...a) => console.log(...a);
const erreur = (m) => { console.error('❌', m); process.exit(1); };

if (!CLE)    erreur('ANTHROPIC_API_KEY manquante.');
if (!TOKEN)  erreur('GITHUB_TOKEN manquant.');
if (!NUM_PR) erreur('NUMERO_PR manquant.');

// ── API GitHub ───────────────────────────────────────────────────────────
async function github(chemin, options = {}) {
  const r = await fetch(`https://api.github.com${chemin}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} sur ${chemin} : ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// ── API Claude ───────────────────────────────────────────────────────────
async function appelerClaude(prompt, { maxTokens = 8000 } = {}) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': CLE,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status} : ${await r.text()}`);
  const j = await r.json();
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function extraireJSON(txt) {
  const net = txt.replace(/```json|```/g, '').trim();
  const i = net.indexOf('{'), f = net.lastIndexOf('}');
  if (i < 0 || f < 0) throw new Error('Réponse sans JSON exploitable.');
  return JSON.parse(net.slice(i, f + 1));
}

// ── Lecture de tes décisions ─────────────────────────────────────────────
// Format attendu dans le commentaire (généré par generer.mjs) :
//
//   ### ⛔ P3 — Demi-vie annoncée à 6 h
//   <!-- pb:3 -->
//   > **Signalé :** …
//
//   - [x] ✅ Corriger comme proposé
//   - [ ] ❌ Garder tel quel
//   - [ ] ✏️ Autre — voir mon instruction
//
//   **Mon instruction :**
//   ```
//   remplace par 5 h en citant l'EFSA
//   ```
function lireDecisions(corps) {
  const decisions = [];
  // Chaque bloc commence à un marqueur <!-- pb:N --> et court jusqu'au suivant
  const blocs = corps.split(/<!--\s*pb:(\d+)\s*-->/);
  for (let i = 1; i < blocs.length; i += 2) {
    const num  = parseInt(blocs[i], 10);
    const bloc = blocs[i + 1] || '';

    // Titre : la ligne ### juste AVANT le marqueur
    const avant = blocs[i - 1] || '';
    const lignesAvant = avant.trimEnd().split('\n');
    const titre = (lignesAvant[lignesAvant.length - 1] || '').replace(/^#+\s*/, '').trim();

    // Énoncé du problème (les lignes en citation)
    const signale = (bloc.match(/^>\s?.*$/gm) || [])
      .map(l => l.replace(/^>\s?/, '')).join(' ').trim();

    // Case cochée
    let choix = null;
    if (/- \[x\][^\n]*Corriger/i.test(bloc))    choix = 'corriger';
    if (/- \[x\][^\n]*Garder/i.test(bloc))      choix = 'garder';
    if (/- \[x\][^\n]*Autre/i.test(bloc))       choix = 'autre';

    // Instruction libre : le premier bloc de code après « Mon instruction »
    let instruction = '';
    const mi = bloc.match(/\*\*Mon instruction[^*]*\*\*\s*```([\s\S]*?)```/i);
    if (mi) instruction = mi[1].trim();
    // Le texte d'invite ne doit jamais être pris pour une consigne réelle.
    if (/^\(écris ici/i.test(instruction)) instruction = '';

    decisions.push({ num, titre, signale, choix, instruction });
  }
  return decisions;
}

// ── Reconstruction de l'article ──────────────────────────────────────────
async function reprendreArticle(article, decisions, langue) {
  const aCorriger = decisions.filter(d => d.choix === 'corriger');
  const aGarder   = decisions.filter(d => d.choix === 'garder');
  const surMesure = decisions.filter(d => d.choix === 'autre' && d.instruction);

  const consignes = [
    aCorriger.length ? `À CORRIGER (l'auteur valide la correction proposée) :\n`
      + aCorriger.map(d => `  ${d.num}. ${d.titre}\n     Problème signalé : ${d.signale}`).join('\n') : '',
    surMesure.length ? `\nÀ TRAITER SELON L'INSTRUCTION DE L'AUTEUR (elle prime sur le rapport) :\n`
      + surMesure.map(d => `  ${d.num}. ${d.titre}\n     Problème signalé : ${d.signale}\n     ➜ INSTRUCTION : ${d.instruction}`).join('\n') : '',
    aGarder.length ? `\nÀ NE PAS TOUCHER (l'auteur a tranché : l'article a raison) :\n`
      + aGarder.map(d => `  ${d.num}. ${d.titre}`
          + (d.instruction ? `\n     Précision de l'auteur : ${d.instruction}` : '')).join('\n') : '',
  ].filter(Boolean).join('\n');

  const prompt = `Tu reprends un article de blog déjà rédigé pour PauseCafé, après arbitrage de l'auteur.

RÈGLES ABSOLUES
1. Tu n'appliques QUE les changements demandés ci-dessous. Tout le reste du texte
   doit rester STRICTEMENT identique — même formulation, même structure, mêmes
   titres, mêmes liens, même longueur.
2. Les points marqués « À NE PAS TOUCHER » sont des décisions de l'auteur.
   Tu ne les corriges pas, tu ne les reformules pas, tu ne les atténues pas,
   même si tu penses qu'ils sont inexacts.
3. Quand l'auteur donne une instruction, elle prime sur le rapport de
   vérification. Tu l'appliques telle quelle.
4. Tu ne rajoutes aucune source, aucun chiffre, aucune étude qui n'était pas
   déjà là — sauf si une instruction te le demande explicitement.
5. Langue de l'article : ${langue === 'en' ? 'anglais' : 'français'}. N'en change pas.

CE QUE L'AUTEUR A DÉCIDÉ
${consignes}

ARTICLE ACTUEL (JSON)
${JSON.stringify({ titre: article.titre, corpsHTML: article.corpsHTML, sourcesHTML: article.sourcesHTML }, null, 2)}

Réponds en JSON strict, sans aucun texte autour :
{"titre":"…","corpsHTML":"…","sourcesHTML":"…","resume":"une phrase par changement appliqué"}`;

  return extraireJSON(await appelerClaude(prompt, { maxTokens: 8000 }));
}

// ── Remplacement dans la page HTML déjà écrite ───────────────────────────
// On ne régénère pas la page : on remplace chirurgicalement le corps et les
// sources. Régénérer risquerait de perdre l'image, les hreflang, la date.
async function remplacerDansPage(fichier, article) {
  let html = await readFile(fichier, 'utf8');

  // On remplace chirurgicalement le corps et les sources, sans régénérer la
  // page : régénérer ferait perdre l'image, les hreflang, la date, le crédit.
  const c = html.match(/(<article class="article-body">)([\s\S]*?)(<\/article>)/);
  if (!c) throw new Error(`Corps introuvable dans ${fichier}`);
  html = html.replace(c[0], `${c[1]}\n${article.corpsHTML}\n${c[3]}`);

  if (article.sourcesHTML) {
    const s = html.match(/(<div class="sources-section">[\s\S]*?<ul>)([\s\S]*?)(<\/ul>)/);
    if (s) html = html.replace(s[0], `${s[1]}\n${article.sourcesHTML}\n${s[3]}`);
  }

  await writeFile(fichier, html);
}

// ── Extraction de l'article depuis la page HTML ──────────────────────────
async function lireArticle(fichier) {
  const html = await readFile(fichier, 'utf8');
  const titre = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';

  // Structure réelle des pages produites par generer.mjs :
  //   <article class="article-body"> … </article>
  //   <div class="sources-section"> … <ul> … </ul> </div>
  const c = html.match(/<article class="article-body">([\s\S]*?)<\/article>/);
  if (!c) throw new Error(`Corps introuvable dans ${fichier}`);

  const s = html.match(/<div class="sources-section">[\s\S]*?<ul>([\s\S]*?)<\/ul>/);

  return {
    titre: titre.replace(/<[^>]+>/g, '').trim(),
    corpsHTML: c[1].trim(),
    sourcesHTML: s ? s[1].trim() : '',
  };
}

// ── Programme principal ──────────────────────────────────────────────────
async function main() {
  log('▶️  Reprise après arbitrage\n');

  // 1. Récupérer le commentaire qui porte tes décisions
  const commentaire = ID_COMM
    ? await github(`/repos/${REPO}/issues/comments/${ID_COMM}`)
    : (await github(`/repos/${REPO}/issues/${NUM_PR}/comments`))
        .reverse().find(c => c.body.includes('<!-- pb:'));

  if (!commentaire) erreur('Aucune checklist trouvée dans les commentaires de cette PR.');

  const decisions = lireDecisions(commentaire.body);
  if (!decisions.length) erreur('Checklist trouvée, mais aucun problème n’a pu être lu.');

  const nonRepondus = decisions.filter(d => !d.choix);
  const corriger = decisions.filter(d => d.choix === 'corriger').length;
  const garder   = decisions.filter(d => d.choix === 'garder').length;
  const autre    = decisions.filter(d => d.choix === 'autre').length;

  log(`  ${decisions.length} problème(s) · ✅ ${corriger} à corriger · ❌ ${garder} gardé(s) · ✏️ ${autre} sur mesure`);
  if (nonRepondus.length) {
    log(`  ⚠️ ${nonRepondus.length} sans réponse : ils seront laissés tels quels.`);
  }
  if (!corriger && !autre) {
    log('\n  Rien à modifier : tu as tout gardé en l’état. L’article est prêt à merger.');
    await github(`/repos/${REPO}/issues/${NUM_PR}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body:
        `## ✅ Arbitrage enregistré\n\nTu as choisi de conserver l'article tel quel sur les ${garder} point(s) signalé(s). `
        + `Aucune modification n'a été appliquée.\n\n**L'article est prêt à merger.**` }),
    });
    return;
  }

  // 2. Retrouver l'article concerné
  const pr = await github(`/repos/${REPO}/pulls/${NUM_PR}`);
  const fichiers = await github(`/repos/${REPO}/pulls/${NUM_PR}/files?per_page=100`);
  const pageFR = fichiers.find(f => /^blog\/[^/]+\/index\.html$/.test(f.filename));
  const pageEN = fichiers.find(f => /^en\/blog\/[^/]+\/index\.html$/.test(f.filename));
  if (!pageFR) erreur('Aucune page d’article française trouvée dans cette PR.');

  const cheminFR = path.join(ROOT, pageFR.filename);
  log(`  Article : ${pageFR.filename}`);

  // 3. Reprendre le français
  const artFR = await lireArticle(cheminFR);
  log('\n1/2 Reprise du texte français…');
  const neufFR = await reprendreArticle(artFR, decisions, 'fr');
  await remplacerDansPage(cheminFR, neufFR);
  log('   ✓ ' + pageFR.filename);

  // 4. Reprendre l'anglais, avec les MÊMES décisions
  let neufEN = null;
  if (pageEN) {
    log('\n2/2 Reprise du texte anglais (mêmes décisions)…');
    await new Promise(r => setTimeout(r, 65000));   // pause anti-limite
    const cheminEN = path.join(ROOT, pageEN.filename);
    const artEN = await lireArticle(cheminEN);
    neufEN = await reprendreArticle(artEN, decisions, 'en');
    await remplacerDansPage(cheminEN, neufEN);
    log('   ✓ ' + pageEN.filename);
  } else {
    log('\n2/2 Pas de version anglaise dans cette PR.');
  }

  // 5. Rendre compte
  const recap = [
    `## 🔄 Article repris selon tes réponses`,
    ``,
    `| Décision | Nombre |`,
    `|---|---|`,
    `| ✅ Corrigés comme proposé | ${corriger} |`,
    `| ✏️ Traités selon ton instruction | ${autre} |`,
    `| ❌ Gardés tels quels | ${garder} |`,
    nonRepondus.length ? `| ⏭️ Sans réponse, laissés tels quels | ${nonRepondus.length} |` : '',
    ``,
    `### Ce qui a changé dans le texte`,
    neufFR.resume ? neufFR.resume : '_(aucun résumé fourni)_',
    ``,
    pageEN ? `La version anglaise a reçu **exactement les mêmes décisions**.` : '',
    ``,
    `---`,
    ``,
    `**Relis les modifications dans l'onglet « Files changed », puis merge.**`,
    `Si un point ne te convient toujours pas, réédite la checklist ci-dessus`,
    `et recoche la case de relance : tu peux boucler autant de fois que nécessaire.`,
  ].filter(l => l !== '').join('\n');

  await github(`/repos/${REPO}/issues/${NUM_PR}/comments`, {
    method: 'POST', body: JSON.stringify({ body: recap }),
  });

  // 6. Marquer la checklist comme traitée, pour ne pas la rejouer en boucle
  await github(`/repos/${REPO}/issues/comments/${commentaire.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      body: commentaire.body
        .replace(/- \[x\](\s*)(▶️\s*)?\*\*Relancer/i, '- [ ]$1$2**Relancer')
        + `\n\n> _Arbitrage appliqué le ${new Date().toLocaleString('fr-FR')}. `
        + `Pour relancer à nouveau, modifie tes réponses puis recoche la case._`,
    }),
  });

  log('\n✓ Terminé. Les modifications sont poussées sur la branche de la PR.');
}

main().catch(e => erreur(e.message));
