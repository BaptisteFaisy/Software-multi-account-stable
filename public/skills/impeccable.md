# Impeccable — design & audit d'interfaces (anti-patterns)

> Source amont : https://github.com/pbakaus/impeccable (Apache-2.0, v3.9.1, par Paul Bakaus).
> Skill **adapté pour CE projet** : le détecteur navigateur est déjà intégré (bouton « Audit »).
> Les règles de design ci-dessous sont autonomes (aucun script requis).

Conçoit et améliore des interfaces frontend production-grade : vrai code, choix de design assumés, craft exceptionnel. Pour concevoir/refondre/critiquer/auditer/polir une UI. Pas pour du backend.

## Comment Impeccable est disponible dans ce projet
- **Bouton « Audit » (barre d'outils) → vue « Audit design »** : lance le détecteur Impeccable (bundle navigateur autonome vendu dans `public/impeccable/`) sur la VUE COURANTE et liste les anti-patterns (sévérité/catégorie, clic → surlignage). 100 % côté navigateur (desktop + web + mobile, aucun backend). Déclenché uniquement au clic (`autoScan:false`, aucun overlay auto).
- **CLI** (nécessite Node) : `npx impeccable detect <dossier|fichier.html|URL> --json` — 46 règles déterministes, sans clé API ni LLM. Ex. : `npx impeccable detect src/ --json`.
- **Skill complet** (24 commandes `craft/shape/audit/polish/…`, scripts, hooks) : `npx impeccable install`, ou sous Claude Code `/plugin marketplace add pbakaus/impeccable`.

## Design guidance (règles à appliquer)
Produire du code prêt à livrer (beau, responsive, rapide, précis, sans bug, on-brand). Pas de raccourcis sauf demande explicite. Attention au détail : chaque page/section/composant est éprouvé (screenshot navigateur, computer use, etc.).

### Couleur
- **Vérifier le contraste.** Corps ≥ 4.5:1 ; grand texte (≥18px ou gras ≥14px) ≥ 3:1 ; placeholder 4.5:1 aussi. Échec le plus courant : gris atténué sur un quasi-blanc teinté. En cas de doute, foncer vers l'encre — le gris clair « pour l'élégance » est la 1re raison pour laquelle une UI IA est illisible.
- Gris sur fond coloré = délavé. Utiliser une nuance plus foncée de la teinte du fond, ou une transparence de la couleur du texte.

### Typographie
- Longueur de ligne du corps : 65–75ch.
- Ne pas associer deux polices similaires-mais-pas-identiques (deux sans géométriques, deux humanistes). Contraster (serif + sans, géométrique + humaniste) ou une seule famille en plusieurs graisses.
- Titres hero/display : `clamp()` max ≤ 6rem (~96px) ; letter-spacing display ≥ -0.04em.
- `text-wrap: balance` sur h1–h3 ; `text-wrap: pretty` sur le corps long.

### Layout
- Varier l'espacement pour le rythme.
- Les cartes sont la réponse paresseuse ; **cartes imbriquées = toujours faux**.
- Flexbox pour 1D, Grid pour 2D. Grille responsive sans breakpoints : `repeat(auto-fit, minmax(280px, 1fr))`.
- Échelle de z-index sémantique (dropdown → sticky → modal-backdrop → modal → toast → tooltip). Jamais 999/9999.

### Motion
- Intentionnel, pensé dès le build ; ease-out exponentiel (quart/quint/expo), **pas de bounce/elastic**.
- Ne pas animer les propriétés de layout sauf réelle nécessité.
- `@media (prefers-reduced-motion: reduce)` **obligatoire** pour chaque animation.
- Le stagger d'une liste est légitime ; le tell est le réflexe uniforme (une même entrée sur chaque section). Une reveal doit enrichir un défaut **déjà visible** (ne jamais conditionner la visibilité à une transition — elle ne se déclenche pas en onglet caché/headless et la section part vide).

### Interaction
- Un dropdown `position:absolute` dans un conteneur `overflow:hidden/auto` sera coupé : utiliser `<dialog>`/popover, `position:fixed`, ou un portail.

### Nouveaux projets — couleur & thème
- **OKLCH** partout.
- **Le fond crème/sable/beige est le défaut IA 2026** (bande L 0.84–0.97, C < 0.06, teinte 40–100). Noms `--paper/--cream/--sand/--linen/--parchment…` = tells. Préférer (a) une couleur de marque saturée en fond, (b) un vrai off-white à chroma 0, ou (c) un mid-tone teinté clairement de la marque. La « chaleur » vient de l'accent + typo + imagerie, pas du fond.
- Choisir une **stratégie couleur** avant les couleurs : Restrained (neutres teintés + 1 accent ≤10%) · Committed (1 couleur saturée 30–60%) · Full palette (3–4 rôles) · Drenched (la surface EST la couleur).

## Absolute bans (match-and-refuse — réécrire l'élément)
- **Bordures side-stripe** : `border-left/right` > 1px coloré sur cartes/listes/callouts/alertes.
- **Texte en dégradé** (`background-clip:text` + gradient) — couleur unie + emphase par graisse/taille.
- **Glassmorphism par défaut** (blur/verre décoratifs).
- **Template hero-metric** (gros chiffre + petit label + stats + accent dégradé).
- **Grilles de cartes identiques** (icône + titre + texte répétés).
- **Eyebrow tracked majuscules au-dessus de chaque section** (kicker 2023).
- **Marqueurs numérotés 01/02/03 comme scaffolding par défaut** (sauf vraie séquence ordonnée).
- **Texte qui déborde son conteneur** — tester les titres à chaque breakpoint.

## Le test « AI slop »
Si on peut dire « c'est de l'IA » sans hésiter, c'est raté.
- **Premier ordre** : si le thème + la palette sont devinables depuis la catégorie seule → premier réflexe des données d'entraînement. Retravailler la scène + la stratégie couleur.
- **Second ordre** : si la famille esthétique est devinable depuis « catégorie + anti-références » → le piège d'un cran plus loin. Retravailler jusqu'à ce que les deux réponses ne soient plus évidentes.

## Commandes du skill complet (via `npx impeccable install`)
Build : `craft`, `shape`, `init`, `document`, `extract` · Évaluer : `critique`, `audit` · Affiner : `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard` · Enrichir : `animate`, `colorize`, `typeset`, `layout`, `delight`, `overdrive` · Corriger : `clarify`, `adapt`, `optimize` · Itérer : `live`. Plus `pin`/`unpin`/`hooks` (hook détecteur post-édition).