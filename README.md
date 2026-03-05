# TNTVillage Archive

Webapp locale per consultare il dump del database di TNTVillage (2019-08-30).

## Requisiti

- Node.js v22+ (il progetto usa `node:sqlite` integrato, nessun `npm install`)

## Setup e avvio

### 1. Posiziona il file CSV

Copia il dump CSV nella directory del progetto con esattamente questo nome:

```
dump_release_tntvillage_2019-08-30.csv
```

### 2. Avvia il server

```bash
node server.js
```

Al **primo avvio**, se il database non esiste ancora, il server lo crea automaticamente importando il CSV (circa 134.000 torrent). L'operazione richiede qualche decina di secondi e mostra il progresso in console.

Agli **avvii successivi**, il database già esistente viene usato direttamente.

Se il CSV non viene trovato, il server mostra un messaggio di errore con le istruzioni e si ferma.

### 3. Apri il browser

```
http://localhost:3000
```

Per cambiare porta:

```bash
PORT=8080 node server.js
```

## Funzionalità

- **Ricerca full-text** su titolo, descrizione e autore (SQLite FTS5)
- **Filtro per categoria** (ordinate alfabeticamente, con conteggio)
- **Ordinamento** per data, titolo, dimensione o autore (crescente/decrescente)
- **Paginazione** configurabile (25/50/100 risultati per pagina)
- **Link magnet** generato automaticamente per ogni torrent
- **Preferiti** — aggiungi la stella ★ ai torrent preferiti e consultali nella tab dedicata
- **Scaricati** — segna i torrent scaricati ✓ e tienine traccia nella tab dedicata
- Preferiti e scaricati sono **persistenti** nel database SQLite locale

## Reimportare il database

Per ripartire da zero (es. dopo aver spostato il progetto):

```bash
rm tntvillage.db
node server.js   # rileva l'assenza del DB e reimporta automaticamente
```

In alternativa puoi eseguire l'import manualmente:

```bash
node import_csv.js
```

## Categorie

| ID | Nome |
|----|------|
| 1  | Programmi TV Italiani |
| 2  | Musica Lossless |
| 3  | E-book |
| 4  | Film |
| 6  | Software Linux |
| 7  | Animazione Giapponese |
| 8  | Cartoni Animati |
| 9  | Software macOS |
| 10 | Software Windows |
| 11 | Giochi PC |
| 12 | Giochi PlayStation |
| 13 | Varie |
| 14 | Documentari |
| 21 | Concerti e Musica Video |
| 22 | Motorsport |
| 23 | Teatro e Spettacoli |
| 24 | Wrestling e Sport Estremi |
| 25 | Emulatori e ROM |
| 26 | Giochi Xbox 360 |
| 27 | Sfondi e Wallpaper |
| 28 | Giochi da Tavolo |
| 29 | Serie TV |
| 30 | Fumetti |
| 31 | Animazione Storica |
| 32 | Giochi Wii |
| 34 | Audiolibri |
| 35 | Radio e Podcast |
| 36 | Riviste |
| 37 | Software Android |
| 38 | Speciali e Varie |

## API

| Endpoint | Descrizione |
|----------|-------------|
| `GET /api/search?q=&cat=&sort=data&order=desc&view=all&page=1&per_page=25` | Ricerca/browse |
| `GET /api/categories` | Lista categorie con conteggio |
| `GET /api/stats` | Statistiche (totale, preferiti, scaricati) |
| `GET /api/torrent/:hash` | Dettaglio singolo torrent |
| `POST /api/toggle/star/:id` | Toggle preferito |
| `POST /api/toggle/downloaded/:id` | Toggle scaricato |

Il parametro `view` accetta: `all`, `starred`, `downloaded`.

## Struttura file

```
tntvillage/
├── dump_release_tntvillage_2019-08-30.csv   ← metti qui il CSV (ignorato da git)
├── tntvillage.db                             ← generato automaticamente (ignorato da git)
├── import_csv.js                             # import manuale
├── server.js                                 # web server (gestisce anche il primo import)
├── public/
│   └── index.html
├── .gitignore
└── README.md
```
