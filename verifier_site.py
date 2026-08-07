#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
VÉRIFICATION DU SITE BILINGUE pausecafe-app.fr
===============================================

Usage :
    python3 verifier_site.py /chemin/vers/le/dossier/du/site

Passe 10 contrôles sur la structure et le contenu.
Sortie : liste des anomalies, ou confirmation que tout est conforme.

Écrit le 6 août 2026, à relancer après chaque modification du site.
"""

import sys, os, re, glob, json
import xml.dom.minidom

# ── Correspondance FR → EN (décidée le 6 août, slugs anglais pour le SEO) ──
PAGES = {
    'index.html':              'en/index.html',
    'fonctionnalites.html':    'en/features.html',
    'cafeine-temps-reel.html': 'en/real-time-caffeine.html',
    'hydratation.html':        'en/hydration.html',
    'analyses.html':           'en/insights.html',
    'sante.html':              'en/health.html',
    'changelog.html':          'en/changelog.html',
    'cgu.html':                'en/terms.html',
    'privacy.html':            'en/privacy.html',
    'rgpd.html':               'en/gdpr.html',
    'desabonnement.html':      'en/unsubscribe.html',
}
# blog.html n'a pas encore d'équivalent anglais (chantier en cours)
PAGES_FR_SANS_EN = ['blog.html']

RACINE_ATTENDUE = ['base.css', 'sitemap.xml',
                   'app-store-badge-en.svg', 'works-with-apple-health-en.svg']

PAGES_LEGALES_EN = ['en/terms.html', 'en/privacy.html',
                    'en/gdpr.html', 'en/unsubscribe.html']

# Mots vides français : leur présence dans une page EN signale un oubli
MOTS_FR = re.compile(
    r'\b(le|la|les|des|une|dans|pour|avec|ton|ta|tes|tu|est|sont|jour|jours|'
    r'caféine|eau|sur|selon|entre|cette|qui|nous|vous|aux|leur|être|avoir|'
    r'toute|toutes|plus|moins|aussi|donc|mais|quand|comment|pourquoi)\b', re.I)

anomalies = []
def ko(categorie, message):
    anomalies.append((categorie, message))

def lire(chemin):
    try:
        return open(chemin, encoding='utf-8').read()
    except FileNotFoundError:
        return None

def texte_visible(html):
    """Contenu du <body>, débarrassé des scripts et des styles."""
    i = html.find('<body')
    if i < 0: return ''
    c = html[i:]
    c = re.sub(r'<script.*?</script>', '', c, flags=re.S)
    c = re.sub(r'<style.*?</style>', '', c, flags=re.S)
    return c


def verifier(racine):
    os.chdir(racine)
    print(f"Dossier analysé : {os.getcwd()}\n")

    # ══ 1. Fichiers d'infrastructure ══════════════════════════════
    print("1. Infrastructure à la racine")
    for f in RACINE_ATTENDUE:
        if not os.path.exists(f):
            ko('1', f"{f} MANQUANT à la racine")
            print(f"   ✗ {f}")
        else:
            print(f"   ✓ {f}  ({os.path.getsize(f)} octets)")

    # base.css doit contenir le socle attendu
    css = lire('base.css')
    if css:
        for sel in [':root', 'nav {', 'footer {', '.hero {', '.lang-switch',
                    '.page-legale', '@media (max-width: 768px)']:
            if sel not in css:
                ko('1', f"base.css : bloc « {sel} » absent")

    # Badges : ce sont bien les versions anglaises d'Apple ?
    for f, vb in [('app-store-badge-en.svg', '119.66'),
                  ('works-with-apple-health-en.svg', '122.7')]:
        t = lire(f)
        if t and vb not in t:
            ko('1', f"{f} : viewBox inattendu (badge EN officiel attendu)")

    # ══ 2. Pages françaises présentes ═════════════════════════════
    print("\n2. Pages françaises")
    for fr in list(PAGES) + PAGES_FR_SANS_EN:
        if not os.path.exists(fr):
            ko('2', f"{fr} MANQUANTE")
            print(f"   ✗ {fr}")
    if not any(a[0] == '2' for a in anomalies):
        print(f"   ✓ les {len(PAGES) + len(PAGES_FR_SANS_EN)} pages sont là")

    # ══ 3. Pages anglaises présentes ══════════════════════════════
    print("\n3. Pages anglaises")
    for en in PAGES.values():
        if not os.path.exists(en):
            ko('3', f"{en} MANQUANTE")
            print(f"   ✗ {en}")
    if not any(a[0] == '3' for a in anomalies):
        print(f"   ✓ les {len(PAGES)} pages sont là")

    # ══ 4. Chaque page FR : base.css + hreflang + sélecteur ═══════
    print("\n4. Balisage des pages françaises")
    for fr in list(PAGES) + PAGES_FR_SANS_EN:
        t = lire(fr)
        if t is None: continue
        if 'base.css' not in t:
            ko('4', f"{fr} : ne charge pas base.css")
        else:
            # base.css doit venir AVANT le <style> inline, sinon l'inline
            # ne peut plus surcharger le socle
            i_css = t.find('base.css'); i_style = t.find('<style>')
            if i_style > 0 and i_css > i_style:
                ko('4', f"{fr} : base.css chargé APRÈS le <style> inline")
        n = len(re.findall(r'rel="alternate"\s+hreflang=', t))
        if n != 3:
            ko('4', f"{fr} : {n} balise(s) hreflang au lieu de 3")
        if 'lang-switch' not in t:
            ko('4', f"{fr} : sélecteur de langue absent")
        if not re.search(r'<html lang="fr"', t):
            ko('4', f"{fr} : lang=\"fr\" absent sur <html>")
    if not any(a[0] == '4' for a in anomalies):
        print("   ✓ base.css, 3 hreflang et sélecteur sur chaque page")

    # ══ 5. Chaque page EN : lang, canonical, og:locale ════════════
    print("\n5. Balisage des pages anglaises")
    for fr, en in PAGES.items():
        t = lire(en)
        if t is None: continue
        if not re.search(r'<html lang="en"', t):
            ko('5', f"{en} : lang=\"en\" absent")
        m = re.search(r'canonical" href="([^"]+)"', t)
        if not m:
            ko('5', f"{en} : canonical absent")
        elif '/en/' not in m.group(1):
            ko('5', f"{en} : canonical pointe hors de /en/ ({m.group(1)})")
        m = re.search(r'og:locale" content="([^"]+)"', t)
        if m and m.group(1) != 'en_US':
            ko('5', f"{en} : og:locale = {m.group(1)} au lieu de en_US")
        if 'base.css' not in t:
            ko('5', f"{en} : ne charge pas base.css")
    if not any(a[0] == '5' for a in anomalies):
        print("   ✓ lang, canonical, og:locale et base.css conformes")

    # ══ 6. Résidus français dans les pages anglaises ══════════════
    print("\n6. Résidus français (pages anglaises)")
    total = 0
    for en in PAGES.values():
        t = lire(en)
        if t is None: continue
        c = texte_visible(t)
        res = set()
        for m in re.finditer(r'>([^<>]+)<', c):
            s = m.group(1).strip()
            if len(s) > 3 and MOTS_FR.search(s):
                res.add(s)
        if res:
            total += len(res)
            ko('6', f"{en} : {len(res)} texte(s) en français")
            for s in list(res)[:3]:
                print(f"   ✗ {en} → {s[:70]}")
    if total == 0:
        print("   ✓ aucun texte français dans les 11 pages")

    # ══ 7. Décimales et devises à la française ═══════════════════
    print("\n7. Formats numériques (pages anglaises)")
    n = 0
    for en in PAGES.values():
        t = lire(en)
        if t is None: continue
        c = texte_visible(t)
        c = re.sub(r'\sd="[^"]*"', ' ', c)      # ignore les tracés SVG
        c = re.sub(r'\sstyle="[^"]*"', ' ', c)
        for m in re.finditer(r'>([^<>]*\d,\d\s*(?:L|€|ml|mg|h)[^<>]*)<', c):
            ko('7', f"{en} : décimale française « {m.group(1).strip()[:40]} »")
            n += 1
    if n == 0:
        print("   ✓ aucune virgule décimale ni euro résiduel")

    # ══ 8. Liens croisés FR ↔ EN ═════════════════════════════════
    print("\n8. Cohérence des liens")
    n = 0
    for fr, en in PAGES.items():
        t = lire(en)
        if t is None: continue
        # une page EN ne doit pas renvoyer vers une page FR (sauf hreflang,
        # canonical, sélecteur de langue et bandeau légal)
        for m in re.finditer(r'href="(/[^"#][^"]*)"', t):
            u = m.group(1)
            if u.startswith('/en/'): continue
            if u in ('/base.css', '/logo.png'): continue
            if u.startswith(('/app-store', '/works-with')): continue
            # le sélecteur FR et le bandeau légal pointent volontairement en FR
            ctx = t[max(0, m.start()-260):m.start()]
            if 'lang-switch' in ctx or 'avis-langue' in ctx or 'hreflang="fr"' in ctx:
                continue
            ko('8', f"{en} : lien vers le FR → {u}")
            n += 1
    if n == 0:
        print("   ✓ aucun lien EN pointant vers une page FR")

    # ══ 9. Bandeau de primauté sur les pages légales ═════════════
    print("\n9. Mention légale (pages anglaises)")
    for en in PAGES_LEGALES_EN:
        t = lire(en)
        if t is None: continue
        if 'avis-langue' not in t:
            ko('9', f"{en} : bandeau de primauté du français ABSENT")
        elif 'legally binding' not in t:
            ko('9', f"{en} : bandeau présent mais texte inattendu")
    if not any(a[0] == '9' for a in anomalies):
        print("   ✓ les 4 pages légales portent la mention")

    # ══ 10. Sitemap ══════════════════════════════════════════════
    print("\n10. Sitemap")
    t = lire('sitemap.xml')
    if t is None:
        ko('10', "sitemap.xml absent")
    else:
        try:
            xml.dom.minidom.parseString(t.encode('utf-8'))
            print("   ✓ XML valide")
        except Exception as e:
            ko('10', f"XML invalide : {e}")
        if 'xmlns:xhtml' not in t:
            ko('10', "namespace xhtml absent (les xhtml:link seront ignorés)")
        # 11 pages principales + les articles de blog anglais publies
        nb_en = len(re.findall(r'<loc>https://pausecafe-app\.fr/en/', t))
        if nb_en < 11:
            ko('10', f"{nb_en} URL /en/ dans le sitemap, 11 au minimum attendues")
        else:
            print(f"   ✓ {nb_en} URL anglaises ({nb_en - 11} article(s) de blog)")
        nb_alt = t.count('xhtml:link')
        if nb_alt < 60:
            ko('10', f"seulement {nb_alt} liens hreflang (63 attendus)")
        else:
            print(f"   ✓ {nb_alt} liens hreflang croisés")
        print(f"   ✓ {t.count('<url>')} URL au total")

    # ══ 11. Attributs mal formés (guillemet ouvrant manquant) ════
    print("\n11. Attributs HTML bien formés")
    n = 0
    for f in list(PAGES) + PAGES_FR_SANS_EN + list(PAGES.values()):
        t = lire(f)
        if t is None: continue
        for m in re.finditer(r'(src|href|content)=([^"\'\s>][^\s>]*)', t):
            ko('11', f"{f} : {m.group(1)}={m.group(2)[:40]} (guillemet ouvrant manquant)")
            n += 1
    if n == 0:
        print("   ✓ tous les src/href/content sont correctement quotés")

    # ══ 12. Duplication de structure (page collée deux fois) ═════
    print("\n12. Structure des documents")
    n = 0
    for f in list(PAGES) + PAGES_FR_SANS_EN + list(PAGES.values()):
        t = lire(f)
        if t is None: continue
        nb = t.count('<body')
        if nb != 1:
            ko('12', f"{f} : {nb} balise(s) <body> (contenu dupliqué ?)")
            n += 1
        # rien ne doit suivre le premier </html>
        i = t.find('</html>')
        if i >= 0 and t[i+7:].strip():
            ko('12', f"{f} : {len(t)-i-7} caractères APRÈS le premier </html>")
            n += 1
    if n == 0:
        print("   ✓ un seul document par fichier")

    # ══ 13. Attributs alt/title restés en français (pages EN) ════
    print("\n13. Attributs alt/title (pages anglaises)")
    n = 0
    for en in PAGES.values():
        t = lire(en)
        if t is None: continue
        for m in re.finditer(r'(?:alt|title|aria-label)="([^"]+)"', t):
            s = m.group(1)
            if s != 'PauseCafé' and MOTS_FR.search(s):
                ko('13', f"{en} : attribut en français « {s[:45]} »")
                n += 1
    if n == 0:
        print("   ✓ aucun attribut français résiduel")

    # ══ 14. Cibles internes existantes ═══════════════════════════
    print("\n14. Liens internes")
    n = 0
    for f in list(PAGES) + PAGES_FR_SANS_EN + list(PAGES.values()):
        t = lire(f)
        if t is None: continue
        for m in re.finditer(r'(?:href|src)="([^"#?]+)', t):
            u = m.group(1)
            if u.startswith(('http', 'mailto:', 'tel:', 'data:')) or not u:
                continue
            c = u.lstrip('/') if u.startswith('/') else \
                os.path.normpath(os.path.join(os.path.dirname(f), u))
            if c in ('', '.'): continue
            # GitHub Pages sert /chemin via chemin.html ou chemin/index.html
            if not (os.path.exists(c) or os.path.isdir(c)
                    or os.path.exists(c + '.html')
                    or os.path.exists(os.path.join(c, 'index.html'))):
                ko('14', f"{f} : cible introuvable → {u}")
                n += 1
    if n == 0:
        print("   ✓ toutes les cibles internes existent")

    # ══ 15. Cibles hreflang correctes ════════════════════════════
    print("\n15. Cohérence des hreflang")
    BASE = 'https://pausecafe-app.fr'
    n = 0
    for fr, en in PAGES.items():
        u_fr = BASE + ('/' if fr == 'index.html' else '/' + fr)
        u_en = BASE + '/en/' + ('' if en == 'en/index.html' else en[3:])
        for page, attendu in ((fr, {'fr': u_fr, 'en': u_en, 'x-default': u_fr}),
                              (en, {'fr': u_fr, 'en': u_en, 'x-default': u_fr})):
            t = lire(page)
            if t is None: continue
            for lang, cible in attendu.items():
                m = re.search(r'hreflang="%s" href="([^"]*)"' % re.escape(lang), t)
                if not m:
                    ko('15', f"{page} : hreflang {lang} absent"); n += 1
                else:
                    got = m.group(1)
                    if not got.startswith('http'):
                        got = BASE + got
                    if got.rstrip('/') != cible.rstrip('/'):
                        ko('15', f"{page} : hreflang {lang} → {got} (attendu {cible})")
                        n += 1
    if n == 0:
        print("   ✓ chaque page pointe vers sa vraie contrepartie")

    # ══ Bilan ════════════════════════════════════════════════════
    print("\n" + "=" * 62)
    if not anomalies:
        print("RÉSULTAT : tout est conforme. Le site peut être déployé.")
    else:
        print(f"RÉSULTAT : {len(anomalies)} anomalie(s)\n")
        for cat, msg in anomalies:
            print(f"  [{cat}] {msg}")
    print("=" * 62)
    return len(anomalies)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    sys.exit(1 if verifier(sys.argv[1]) else 0)
