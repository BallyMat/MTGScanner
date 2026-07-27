# MTG Scanner PWA

Application web installable sur iPhone pour :
- photographier une carte et tenter de lire son nom par OCR ;
- rechercher la carte dans Scryfall ;
- afficher toutes ses impressions avec l'image exacte de chaque version ;
- choisir la finition et l'état ;
- conserver un inventaire local ;
- estimer la valeur totale ;
- jouer un son de plus en plus marqué selon la valeur ;
- exporter l'inventaire en CSV.

## Test rapide sur PC

Un serveur local est nécessaire :

```bash
python -m http.server 8080
```

Puis ouvrir http://localhost:8080

## Mise en ligne gratuite

Le dossier peut être déposé sur Netlify Drop, GitHub Pages ou Vercel.
Une adresse HTTPS est nécessaire pour l'installation PWA et l'accès caméra sur iPhone.

## Installation sur iPhone

1. Ouvrir l'adresse HTTPS dans Safari.
2. Toucher Partager.
3. Choisir « Sur l'écran d'accueil ».
4. Ouvrir ensuite MTG Scanner depuis son icône.

## Remarques

- Les prix sont des estimations issues des données Scryfall disponibles.
- La reconnaissance OCR utilise Tesseract.js chargé depuis un CDN : une connexion est nécessaire lors de la première utilisation.
- L'inventaire est enregistré dans le stockage local du navigateur. Exporter régulièrement le CSV est conseillé.
