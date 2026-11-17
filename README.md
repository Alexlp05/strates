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

Sans `.env`, l'application démarre quand même et la page explique qu'il manque la clé.

**Premier lancement** : le serveur récupère tout l'historique Last.fm en tâche de fond (200 écoutes par appel, environ 2 min 30 pour 28 000 écoutes). La page s'affiche tout de suite avec ce qui est déjà là, et un bandeau montre l'avancement. L'archive est ensuite gardée dans le volume Docker `strates-data` : aux lancements suivants, seules les nouvelles écoutes sont demandées. `docker compose down -v` efface l'archive.

Sans Docker (Node 20 ou plus) : `npm install` puis `npm run dev`.

### Variables (`.env`)

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `LASTFM_API_KEY` | — | clé API (obligatoire, reste sur le serveur) |
| `LASTFM_USER` | — | utilisateur affiché par défaut |
| `CACHE_TTL_SECONDS` | `60` | Last.fm est consulté au plus une fois par période, quel que soit le nombre de visiteurs |
| `MIN_PLAYS` | `3` | une tour par album écouté au moins 3 fois (sur une petite période de 200 albums ou moins : tous les albums) |
| `MAX_ALBUMS` | `1500` | sécurité pour les très grosses bibliothèques : nombre maximum de tours |
| `HISTORY_MAX_PAGES` | `1000` | limite de l'historique récupéré, en pages de 200 écoutes (1000 = 200 000 écoutes) |
| `PORT` | `3000` | port exposé |

## Utilisation

- **Glisser** pour tourner autour de la ville, **molette / pincer** pour zoomer, clic droit ou deux doigts pour se déplacer.
- **Survoler** une tour : pochette, nombre d'écoutes, et le morceau et l'heure de la couche pointée.
- **Cliquer** une tour : les couches s'écartent (une par écoute) et le panneau détaille les morceaux.
- **Vue carte** : vue du dessus, la ville devient une mosaïque de pochettes.
- **Classement** : la liste des albums, pour tout retrouver sans la 3D.
- **Période** : 200 dernières écoutes, 24 h, 7 jours, 30 jours, 1 an, tout l'historique.
- `?user=pseudo` dans l'URL affiche la ville de quelqu'un d'autre.

La page se rafraîchit toute seule (toutes les 60 s) : une nouvelle écoute tombe sur sa tour et envoie une onde sur la carte.

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
  view.js     une période → albums, couches, frise, statistiques
  cache.js    cache LRU des pochettes
public/
  index.html  structure de la page
  css/        interface (verre dépoli, version téléphone en feuilles du bas)
  js/main.js      chargement, rafraîchissement, temps (direct / rejouer / parcourir), erreurs
  js/city.js      la scène Three.js : tours, couches, pochettes, ciel, carte, caméra
  js/timeline.js  la frise (canvas 2D)
  js/covers.js    pochettes : chargement, couleur dominante, pochette générée si absente
  js/ui.js        panneau, classement, info-bulle, messages
```

- **L'archive** (`history.js`) : le serveur garde toutes les écoutes déjà vues. Un rafraîchissement ne demande à Last.fm que la page 1 (les 200 plus récentes et le morceau en cours) et y ajoute ce qui est nouveau. Pour « 1 an » et « Tout », il remonte une seule fois l'historique avec le paramètre `to` (« écoutes avant telle date »), page après page, en faisant une courte pause entre deux appels, puis l'enregistre sur le disque.
- **La vue** (`view.js`) : pour une période, le serveur regroupe les écoutes par album, garde les albums écoutés au moins 3 fois, choisit l'unité (1 couche = 1, 10, 50… écoutes, pour que la plus haute tour ait au plus 40 couches) et compte la frise par tranches (heure, jour, semaine…). Le navigateur reçoit au plus ~3 000 couches, soit 45 Ko compressés pour 28 000 écoutes. La réponse brute de Last.fm (très verbeuse) ne sort jamais du serveur.
- **La disposition** (`districtLayout` dans `city.js`) : les artistes sont posés du plus écouté au moins écouté. Chaque quartier part d'une case libre au bord de la ville, la plus proche du centre, puis « pousse » case par case : on ajoute la case voisine qui garde le quartier compact et proche du centre, plus un peu de hasard (toujours le même pour un artiste donné) qui donne des formes irrégulières. Les quartiers se touchent et s'emboîtent ; les artistes d'un seul album bouchent les trous (aucun trou sur les données testées). L'album le plus écouté prend la case au cœur du quartier. Environ 30 ms pour 1 200 albums.
- **Les sols de quartier** : une dalle par case, toutes dans un seul `InstancedMesh`. Chaque dalle reçoit un masque de 8 bits (quels voisins font partie du même quartier) ; le shader en déduit la distance au bord du quartier et ne trace le contour que du côté des autres. On obtient la forme exacte de chaque quartier, angles arrondis compris, et entre deux quartiers voisins un double trait, comme une rue. Le sol apparaît avec la première tour pendant la relecture et s'éclaire au survol.
- **Les pochettes** : les ~220 albums les plus écoutés ont leur pochette en 300×300, les autres en 64×64 (20 fois moins de mémoire graphique), remplacée par la grande quand on ouvre l'album.
- **La 3D** : toutes les couches sont dans un seul `InstancedMesh` (un seul appel de dessin pour des milliers de couches). La lueur de chaque couche est un attribut par instance ajouté au shader standard. Le sol, le ciel et le faisceau sont des shaders écrits à la main.
- **Les couleurs** : chaque pochette est réduite à 32×32 px dans un canvas, les pixels sont regroupés par teinte en favorisant les plus saturés, et on garde le groupe le plus lourd.

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
