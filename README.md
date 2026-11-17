# GetReady — Organisez votre prochain voyage

**Un espace unique pour préparer un séjour, suivre son itinéraire et partager les informations utiles.**

[Découvrir la simulation New York](https://getready-app.github.io/getready/?demo=newyork) · [Voir le dépôt GitHub](https://github.com/getready-app/getready)

GetReady est une application web progressive (PWA) qui aide à planifier des vacances, un week-end, un déplacement professionnel ou un événement, seul·e ou à plusieurs. Le tableau de bord rassemble les dates, l’itinéraire, les préparatifs, le budget et les réservations.

## Fonctionnalités

| Espace | Ce qu’il permet de faire |
|---|---|
| **Vue d’ensemble** | Retrouver les prochaines dates, l’avancement des préparatifs, les réservations à prévoir et le budget du séjour. |
| **Itinéraire** | Organiser le voyage par étapes et par journées, planifier des activités, consulter une carte et exporter les éléments datés vers un calendrier `.ics`. |
| **Préparatifs** | Gérer une liste générale et des listes par destination, puis filtrer les éléments à faire ou terminés. |
| **Budget** | Suivre les dépenses par catégorie et participant, répartir les parts et convertir les montants dans différentes devises. Les taux sont indicatifs. |
| **Carnet pratique** | Conserver les billets, lieux, horaires, références, notes et liens utiles ; filtrer, trier, partager ou exporter les réservations. |
| **Réglages** | Choisir l’apparence, le mode clair ou sombre et les préférences de mouvement. |

L’application comprend également un compte à rebours, des informations météo liées à l’étape en cours, la sauvegarde locale des données et une recherche de vols par numéro configurable en option.

## Essayer la démo

La démo principale présente une semaine de Noël à New York, du 23 au 30 décembre 2026, pour Mohamed et Mélissa :

**[Lancer GetReady · New York à Noël](https://getready-app.github.io/getready/?demo=newyork)**

Le parcours propose notamment Midtown et le sapin du Rockefeller Center, Central Park, Lower Manhattan, la Statue de la Liberté, Brooklyn et Chelsea. Il sert à parcourir les différentes pages avec des données concrètes. Les six enveloppes de budget totalisent **5 000 € pour deux**, à titre fictif : ce ne sont ni des prix en direct ni des devis. Aucun vol, hébergement, ferry ou billet n’est réservé. Les créneaux sont des suggestions ; les horaires spéciaux de Noël, tarifs et conditions d’accès doivent être revérifiés auprès des organismes officiels avant un vrai voyage. Les liens consultés sont disponibles dans le carnet de la simulation.

La démo fonctionne sans compte, ne synchronise rien avec Firebase et conserve les modifications dans le navigateur utilisé. Pour retrouver les données de départ après modification, ajoutez `&reset=1` une fois à l’adresse de la démo. Une deuxième démonstration Lisbonne–Sintra reste accessible à l’adresse [getready-app.github.io/getready/?demo=lisbonne](https://getready-app.github.io/getready/?demo=lisbonne).


## Démarrer en local

Le front-end est statique et ne nécessite pas d’installation de dépendances pour découvrir la démo. Depuis la racine du dépôt, lancez un serveur HTTP local :

```bash
python3 -m http.server 8000
```

Puis ouvrez [http://localhost:8000/?demo=newyork](http://localhost:8000/?demo=newyork).

Les tests automatisés utilisent le module intégré `node:test` de Node.js :

```bash
node --test tests/*.test.mjs
```

## Technologies et organisation

- **Interface :** HTML, CSS et JavaScript natif avec modules ES.
- **Synchronisation facultative des séjours personnels :** Firebase Authentication et Cloud Firestore, avec règles d’accès dans `firestore.rules`.
- **Application installable :** manifest PWA et service worker pour la mise en cache et l’usage hors ligne.
- **Fonctions complémentaires :** taux de change, météo, liens cartographiques et export de calendriers/réservations.
- **Recherche de vols par numéro :** relais Cloudflare Worker optionnel ; configuration et prérequis dans [`flight-api/README.md`](flight-api/README.md).

| Fichier | Rôle |
|---|---|
| `index.html` | Pages, navigation et formulaires |
| `css/styles.css`, `css/getready-shell.css` | Identité visuelle, composants et adaptation aux écrans |
| `js/app.js` | Données locales, affichage et interactions |
| `js/firebase-sync.js` | Connexion, synchronisation et invitations de séjour |
| `js/currency.js` | Conversion et affichage des devises |
| `js/pwa.js`, `sw.js`, `manifest.json` | Installation PWA et cache hors ligne |
| `firestore.rules` | Règles d’accès Firestore |
| `tests/` | Tests automatisés Node.js |

## Synchronisation et sécurité

La découverte en mode démo ne nécessite pas de compte et ne synchronise pas les données avec Firebase. Les séjours personnels peuvent être associés à un compte et synchronisés entre appareils ; le partage se fait par invitation à une adresse e-mail. Les règles Firestore fournies dans le dépôt doivent être publiées et vérifiées dans le projet Firebase utilisé.

La recherche de vols est facultative et dépend d’un fournisseur externe, de sa couverture et de ses quotas. Gardez toute clé de fournisseur dans les secrets du relais serveur ; ne publiez jamais de clé privée ou de fichier de compte de service dans le dépôt.

## Ce que le projet met en pratique

- Concevoir une interface responsive pour plusieurs parcours de préparation.
- Structurer une application JavaScript native en modules.
- Gérer des données locales et une synchronisation cloud avec contrôle d’accès.
- Créer une PWA installable, avec prise en charge du mode hors ligne.
- Intégrer des services complémentaires tout en documentant leurs limites.
- Tester les principales interactions avec `node:test`.

## Auteur

**Mohamed Aiteur** — projet personnel réalisé dans le cadre du BTS SIO, option SLAM.
