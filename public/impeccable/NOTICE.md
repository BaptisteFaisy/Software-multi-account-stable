# Impeccable — détecteur d'anti-patterns de design (vendored)

Ce dossier embarque le **détecteur navigateur** du projet Impeccable, utilisé par
la fonctionnalité « Audit design » (bouton dans la barre d'outils).

- **Source** : https://github.com/pbakaus/impeccable
- **Fichier** : `.claude/skills/impeccable/scripts/detector/detect-antipatterns-browser.js`
- **Version du paquet** : impeccable `3.2.1`
- **Auteur** : Paul Bakaus
- **Licence** : Apache-2.0 (voir `LICENSE`)

`detect-antipatterns-browser.js` est un bundle **généré** et autonome (aucune
dépendance externe, aucun appel réseau). Il ne doit pas être édité à la main :
pour le mettre à jour, re-télécharger le fichier depuis le dépôt amont à la
version voulue.

Il expose sur `window` : `impeccableDetect()` (détection → données),
`impeccableScan()` (détection + overlays sur la page), et lit sa configuration
depuis `window.__IMPECCABLE_CONFIG__`. L'app force `{ autoScan: false }` avant de
charger le script pour éviter tout scan/overlay automatique au chargement ; la
détection n'est déclenchée que par le bouton « Auditer cette page ».
