# Strates

**Une cartographie 3D de tes écoutes Last.fm.** Chaque album devient une tour, chaque écoute une couche de la tour. On voit d'un coup d'œil ce qu'on a écouté, combien de fois, et quand.

## L'idée

Une pile de disques grandit à chaque fois qu'on en remet un. Strates pousse l'image jusqu'à la ville :

| Ce que tu vois | Ce que ça veut dire |
| --- | --- |
| Une **tour** posée sur une case | un album (ou un single) écouté au moins 3 fois sur la période (tous les albums si la période est courte) |
| Une **couche** de la tour | une écoute : on peut littéralement les compter. Sur « 1 an » et « Tout », une couche regroupe 10, 50… écoutes (indiqué en haut de l'écran) pour que les tours restent lisibles |
| La **hauteur** | le nombre d'écoutes |
| La **pochette** sur le toit | l'album, elle se soulève et se tourne vers toi quand une couche tombe dessous |
| Le **centre-ville** | les albums les plus écoutés ; on s'éloigne vers les écoutes de passage |
| Un **quartier** | les albums d'un même artiste, sur un sol à leur couleur (contour lumineux, hachures). Chaque quartier a sa propre forme et s'emboîte dans ses voisins ; la plus haute tour est en son cœur. Son nom flotte au-dessus avec le nombre d'albums et d'écoutes ; survoler une tour éclaire tout son quartier |
| Une couche qui **brille** | une écoute récente ; les anciennes s'éteignent |
| Les **tons** d'une même tour | des morceaux différents de l'album |
| Le **ciel, la brume, la poussière** | les couleurs des pochettes les plus écoutées |
| Un **faisceau** vers le ciel | le morceau en cours d'écoute (couche fantôme qui pulse) |
| Un **arc** lumineux entre deux tours | un feat : les deux artistes ont chanté ensemble sur un morceau que tu as écouté. L'arc relie leurs tours principales, passe de la couleur de l'un à celle de l'autre, et il est plus épais si tu as beaucoup écouté leurs feats |

La **frise** en bas est un histogramme peint avec les couleurs des pochettes. On peut la parcourir pour remonter le temps : la ville se démonte et se reconstruit couche par couche. Le bouton ▶ rejoue toute la période, de quelques heures à plusieurs années.

## Démarrer

Prérequis : Docker, et une clé API Last.fm ([créer une clé](https://www.last.fm/api/account/create)).

```bash
git clone https://github.com/Alexlp05/strates.git
cd strates
cp .env.example .env      # puis mets ta clé et ton pseudo dans .env
docker compose up
```

Ouvre ensuite **http://localhost:3000**.

En ligne : **https://student15.wt.thomasjuldo.com** (voir [Mise en ligne](#mise-en-ligne)).

Sans `.env`, l'application démarre quand même et la page explique qu'il manque la clé.

**Premier lancement** : le serveur récupère tout l'historique Last.fm en tâche de fond (200 écoutes par appel, environ 2 min 30 pour 28 000 écoutes). La page s'affiche tout de suite avec ce qui est déjà là, et un bandeau montre l'avancement. L'archive est ensuite gardée dans le volume Docker `strates-data` : aux lancements suivants, seules les nouvelles écoutes sont demandées. `docker compose down -v` efface l'archive.

Sans Docker (Node 20 ou plus) : `npm install` puis `npm run dev`.

### Variables (`.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LASTFM_API_KEY` | — | clé API (obligatoire, reste sur le serveur) |
| `LASTFM_USER` | — | utilisateur affiché par défaut |
| `CACHE_TTL_SECONDS` | `60` | Last.fm est consulté au plus une fois par période, quel que soit le nombre de visiteurs |
| `MIN_PLAYS` | `3` | une tour par album écouté au moins 3 fois (sur une petite période de 200 albums ou moins : tous les albums). C'est la valeur « Auto » du panneau Réglages |
| `MAX_ALBUMS` | `1500` | sécurité pour les très grosses bibliothèques : nombre maximum de tours |
| `HISTORY_MAX_PAGES` | `1000` | limite de l'historique récupéré, en pages de 200 écoutes (1000 = 200 000 écoutes) |
| `PORT` | `3000` | port exposé |

## Utilisation

- **Glisser** pour tourner autour de la ville, **molette / pincer** pour zoomer, clic droit ou deux doigts pour se déplacer.
- **Survoler** une tour : pochette, nombre d'écoutes, et le morceau et l'heure de la couche pointée.
- **Cliquer** une tour : les couches s'écartent (une par écoute) et le panneau détaille les morceaux, puis les feats de l'artiste ; cliquer un invité emmène à son quartier.
- **Vue carte** : vue du dessus, la ville devient une mosaïque de pochettes.
- **Classement** : la liste des albums, pour tout retrouver sans la 3D.
- **Réglages** : voir ci-dessous.
- **Période** : 200 dernières écoutes, 24 h, 7 jours, 30 jours, 1 an, tout l'historique.
- `?user=pseudo` dans l'URL affiche la ville de quelqu'un d'autre.

La page se rafraîchit toute seule (toutes les 60 s) : une nouvelle écoute tombe sur sa tour et envoie une onde sur la carte.

### Réglages

Le bouton **Réglages** ouvre un panneau qui change la ville sans toucher au code. Les choix sont gardés dans le navigateur (`localStorage`).

| Réglage | Choix | Effet |
| --- | --- | --- |
| Écoutes par couche | Auto, 1, 2, 5… 100 | l'échelle des tours. Le serveur respecte le choix tant que la ville reste dessinable (au plus 3 000 couches, 150 par tour) ; sinon il prend la plus petite unité possible et le panneau le dit |
| Minimum d'écoutes pour une tour | Auto, 1, 2, 3… 20 | quels albums deviennent des tours (Auto : la valeur de `MIN_PLAYS`) |
| Couleurs des tours | Pochettes, Artistes, Récence, Écoutes, Unie | la couleur de la pochette ; une couleur par artiste ; froid → chaud selon la dernière écoute ; sombre → clair selon le nombre d'écoutes ; une seule couleur au choix. La frise et le classement prennent les mêmes couleurs |
| Fond | Nuit, Minuit, Aurore, Crépuscule, Encre | le ciel, la brume et la carte |
| Forme | Carré, Rond, Hexagone | la forme des couches et des pochettes (Rond : une pile de vinyles) |
| Disposition | Quartiers par artiste, Par écoutes | avec ou sans quartiers |
| Feats | Tous, Au survol, Masqués | les arcs entre artistes : les plus écoutés en permanence (et tous ceux d'une tour quand on la survole) ; seulement ceux de la tour survolée ou ouverte ; aucun |
| Effets | interrupteurs | noms et sols des quartiers, étoiles, grille, halo lumineux, rotation automatique |

Les deux premiers réglages partent au serveur avec la demande (`/api/listening?unit=5&minPlays=2`) : il reconstruit la vue à partir de son archive, **sans rappeler Last.fm**. Les autres ne changent que l'affichage et s'appliquent tout de suite.

## Comment ça marche

```
Navigateur ──/api/listening──▶ Serveur Node (Express) ──user.getRecentTracks──▶ Last.fm
           ──/api/sync───────▶   archive des écoutes   ──image──────────────────▶ CDN Last.fm
           ──/api/cover/…────▶   (mémoire + disque)
           ◀── JSON simplifié, images ──
```

```
server/
  index.js    routes, Content-Security-Policy, fichiers statiques
  lastfm.js   appel à Last.fm, gestion des erreurs, lecture des réponses
  history.js  l'archive : nouvelles écoutes (HIT / MISS / STALE), récupération de l'historique, disque
  view.js     une période → albums, couches, frise, feats, statistiques
  feats.js    les feats lus dans les titres des morceaux
  cache.js    cache LRU des pochettes
public/
  index.html  structure de la page
  css/        interface (verre dépoli, version téléphone en feuilles du bas)
  js/main.js      chargement, rafraîchissement, temps (direct / rejouer / parcourir), erreurs
  js/city.js      la scène Three.js : tours, couches, pochettes, ciel, carte, caméra
  js/timeline.js  la frise (canvas 2D)
  js/covers.js    pochettes : chargement, couleur dominante, pochette générée si absente
  js/ui.js        panneau, classement, info-bulle, messages
  js/settings.js  le panneau Réglages
compose.server.yaml   mise en ligne (voir plus bas)
```

- **L'archive** (`history.js`) : le serveur garde toutes les écoutes déjà vues. Un rafraîchissement ne demande à Last.fm que la page 1 (les 200 plus récentes et le morceau en cours) et y ajoute ce qui est nouveau. Pour « 1 an » et « Tout », il remonte une seule fois l'historique avec le paramètre `to` (« écoutes avant telle date »), page après page, en faisant une courte pause entre deux appels, puis l'enregistre sur le disque.
- **La vue** (`view.js`) : pour une période, le serveur regroupe les écoutes par album, garde les albums écoutés au moins 3 fois, choisit l'unité (1 couche = 1, 10, 50… écoutes, pour que la plus haute tour ait au plus 40 couches) et compte la frise par tranches (heure, jour, semaine…). Le navigateur reçoit au plus ~3 000 couches, soit 45 Ko compressés pour 28 000 écoutes. La réponse brute de Last.fm (très verbeuse) ne sort jamais du serveur.
- **La disposition** (`districtLayout` dans `city.js`) : les artistes sont posés du plus écouté au moins écouté. Chaque quartier part d'une case libre au bord de la ville, la plus proche du centre, puis « pousse » case par case : on ajoute la case voisine qui garde le quartier compact et proche du centre, plus un peu de hasard (toujours le même pour un artiste donné) qui donne des formes irrégulières. Les quartiers se touchent et s'emboîtent ; les artistes d'un seul album bouchent les trous (aucun trou sur les données testées). L'album le plus écouté prend la case au cœur du quartier. Environ 30 ms pour 1 200 albums.
- **Les feats** (`feats.js`) : Last.fm ne donne qu'un artiste par écoute ; les invités sont dans le titre, « Titre (feat. A & B) », « [ft. A] », « (with A) ». Le serveur cherche d'abord les noms d'artistes qu'il connaît déjà dans l'archive (du plus long au plus court, pour garder « Bigflo & Oli » ou « Tyler, The Creator » entiers), puis coupe le reste sur « , & et and x ». Chaque paire d'artistes compte ses écoutes et ses morceaux ; la vue envoie les 300 paires les plus écoutées (7 Ko compressés sur tout l'historique). Le navigateur trace un arc (un tube le long d'une courbe de Bézier, avec un shader qui fait circuler des impulsions) entre les tours principales des deux artistes, seulement si les deux sont en ville. Les arcs s'effacent pendant la relecture, car ils résument toute la période.
- **Les sols de quartier** : une dalle par case, toutes dans un seul `InstancedMesh`. Chaque dalle reçoit un masque de 8 bits (quels voisins font partie du même quartier) ; le shader en déduit la distance au bord du quartier et ne trace le contour que du côté des autres. On obtient la forme exacte de chaque quartier, angles arrondis compris, et entre deux quartiers voisins un double trait, comme une rue. Le sol apparaît avec la première tour pendant la relecture et s'éclaire au survol.
- **Les pochettes** : les ~220 albums les plus écoutés ont leur pochette en 300×300, les autres en 64×64 (20 fois moins de mémoire graphique), remplacée par la grande quand on ouvre l'album.
- **La 3D** : toutes les couches sont dans un seul `InstancedMesh` (un seul appel de dessin pour des milliers de couches). La lueur de chaque couche est un attribut par instance ajouté au shader standard. Le sol, le ciel et le faisceau sont des shaders écrits à la main.
- **Les couleurs** : chaque pochette est réduite à 32×32 px dans un canvas, les pixels sont regroupés par teinte en favorisant les plus saturés, et on garde le groupe le plus lourd.
- **Les réglages d'apparence** (`City.setLook`) : changer la forme remplace la géométrie partagée par toutes les couches (un seul objet pour des milliers d'instances) ; changer les couleurs recalcule la couleur de chaque tour ; changer le fond change les couleurs de base du ciel et de la brume. Rien n'est rechargé.

## Mise en ligne

L'app tourne sur le serveur du cours, derrière **Caddy** qui ajoute le HTTPS : **https://student15.wt.thomasjuldo.com**.

Le serveur héberge plusieurs projets derrière **un seul Caddy** (dossier `caddy/` sur le serveur, à côté des projets) : c'est le seul service ouvert sur Internet, et il donne un port à chaque projet (Strates sur 443, le compteur de visites sur 8443). Le serveur utilise le même `docker-compose.yml` plus `compose.server.yaml`, qui retire le port de l'app et la branche sur le réseau Docker `web` partagé avec Caddy, sous le nom `strates` : on ne peut la joindre qu'à travers Caddy, qui lui envoie toutes les requêtes (l'app sert la page et l'API au même endroit).

Première installation (sur le serveur, une fois le réseau `web` créé et Caddy lancé) :

```bash
git clone https://github.com/Alexlp05/strates.git
cd strates
nano .env                 # LASTFM_API_KEY=… et LASTFM_USER=… (jamais commité)
docker compose -f docker-compose.yml -f compose.server.yaml up -d --build
```

Mise à jour, après un `git push` :

```bash
cd strates
git pull
docker compose -f docker-compose.yml -f compose.server.yaml up -d --build
```

Les volumes restent : l'archive des écoutes survit aux mises à jour (et le certificat HTTPS, gardé par Caddy, aussi). Les logs : `docker compose -f docker-compose.yml -f compose.server.yaml logs --tail 50`.

## Les règles du projet, et où les vérifier

| Règle | Comment c'est fait | Comment le vérifier |
| --- | --- | --- |
| Le navigateur ne parle qu'au serveur | Three.js est servi depuis `node_modules`, les pochettes passent par `/api/cover`, et l'en-tête `Content-Security-Policy: connect-src 'self'` interdit au navigateur tout autre hôte | onglet Réseau : uniquement `localhost:3000` |
| La clé reste sur le serveur | lue dans `process.env.LASTFM_API_KEY`, `.env` est dans `.gitignore` et `.dockerignore`, la clé est masquée (`***`) dans les logs ; l'archive (`data/`) ne contient pas la clé et n'est pas commitée non plus | `git log -p \| grep -i api_key` ne trouve rien |
| Cache | l'archive : Last.fm est consulté au plus une fois toutes les 60 s (deux visiteurs simultanés partagent le même appel), l'historique n'est téléchargé qu'une fois et survit aux redémarrages | recharger deux fois : les logs montrent un seul `[last.fm] appel`, l'en-tête `X-Cache` passe de `MISS` à `HIT`, `/api/health` compte les appels |
| Last.fm en panne | le serveur sert les écoutes archivées (`STALE`) ; sinon la page affiche un message, réessaie seule toutes les 30 s, et montre la dernière ville sauvegardée sur l'appareil s'il y en a une | voir ci-dessous |
| Téléphone et ordinateur | mise en page adaptative, panneaux en feuilles du bas, rendu allégé sur mobile (pas de bloom ni d'ombres) | outils de dev → mode appareil |
| `docker compose up` | `Dockerfile` + `docker-compose.yml`, healthcheck sur `/api/health` | sur une copie neuve du dépôt |

### Simuler une panne de Last.fm

```bash
LASTFM_API_URL=http://127.0.0.1:9/ docker compose up            # bash
$env:LASTFM_API_URL="http://127.0.0.1:9/"; docker compose up    # PowerShell
```

Ou couper Internet pendant que l'application tourne.
