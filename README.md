# 🎛️ Mood Meter

**how to read moods online _(fast)_**

Un misuratore di umore per coppie, in stile *How to Sell Drugs Online (Fast)*: schermo scuro, verde neon, finestre `.exe` retrò ed effetto CRT.
Ognuno imposta il proprio umore su un quadrante con la lancetta, e l'altro lo vede **in tempo reale** sul suo telefono.

È una **PWA**: si apre da qualsiasi browser e si installa sulla schermata Home di Android e iPhone come un'app vera, funziona anche offline.

## Cosa fa

- **Quadrante con lancetta** da trascinare (o slider) con 7 fasce: ☠️ Zona rossa → 😤 Nervi a fior di pelle → 🪫 Batteria scarica → 😐 Meh → 🙂 Tutto ok → 😎 Good vibes → 🤩 Al top
- **"Mi serve…"**: coccole, spazio, fame, sonno, silenzio, cioccolato, ciclo…
- **Due parole**: una nota breve (max 140 caratteri) che appare come un post-it
- **Manda al volo**: 💋 bacio, 🫂 abbraccio, 👀 ti penso, ☕ caffè?, 🍕 pizza?
- **log.txt**: lo storico degli ultimi aggiornamenti di entrambi
- **Notifiche** quando il partner cambia umore (con l'app aperta o in background recente)
- **Offline**: l'app si apre anche senza rete e invia appena torna la connessione

## Come si usa

1. Apri il sito, scrivi il tuo nome e scegli un avatar.
2. Premi **Crea una stanza nuova** e manda il link al partner (Copia, Condividi o WhatsApp).
3. Il partner apre il link, sceglie nome e avatar, ed è dentro.
4. Installala: **Android/Chrome** → menu ⋮ → *Installa app*; **iPhone/Safari** → tasto Condividi → *Aggiungi alla schermata Home*.

## Online

👉 **https://protsky.github.io/Moodmeter/**

Il sito è servito da GitHub Pages a partire dal branch `gh-pages`. Non va toccato a mano: a ogni push sul branch principale del repository, il workflow `.github/workflows/pages.yml` copia lì i file del sito e GitHub lo ripubblica in un paio di minuti.
Puoi anche avviarlo a mano da **Actions → Pubblica su GitHub Pages → Run workflow**.

Se il sito non risponde, controlla in **Settings → Pages** che la sorgente sia *Deploy from a branch* → `gh-pages` / `(root)`.

> Va bene anche qualsiasi altro hosting statico con HTTPS (Netlify, Vercel, Cloudflare Pages): basta caricare la cartella così com'è, non c'è nessuna build.

## Come funziona la sincronizzazione (e la privacy)

Non c'è un backend da gestire. I due telefoni si scambiano messaggi tramite [ntfy.sh](https://ntfy.sh), un servizio pub/sub gratuito e open source.

- Dal **codice della stanza** (20 caratteri casuali, 100 bit) ogni dispositivo ricava il nome del canale e una **chiave AES-256-GCM**.
- Ogni messaggio è **cifrato end-to-end** prima di partire: ntfy.sh vede solo testo illeggibile.
- Il codice è nella parte `#…` del link, che il browser non invia mai al server che ospita il sito.
- ntfy.sh conserva i messaggi per circa 12 ore: per questo l'app ripubblica il tuo ultimo stato ogni 3 ore quando è aperta, e ognuno tiene in memoria l'ultimo umore ricevuto.

Chi ha il link entra nella stanza: condividilo solo con il partner.

**Server personalizzato**: se hai un tuo server ntfy, aggiungi `&s=https://tuo-server` al link della stanza (es. `…/#r=XXXXX-XXXXX-XXXXX-XXXXX&s=https://ntfy.example.com`).

## Limiti noti

- Le notifiche arrivano solo se l'app è aperta o è stata in background da poco: senza un server push dedicato i browser non possono svegliare un'app chiusa.
- Su iPhone notifiche e installazione richiedono iOS 16.4+ e l'app aggiunta alla schermata Home.
- Se il partner non apre l'app per più di 12 ore e tu la installi su un **nuovo** telefono, vedrai il suo umore solo quando la riapre.

## Sviluppo in locale

È tutto HTML/CSS/JS statico, senza dipendenze né build:

```bash
npx http-server -p 8080 -c-1
# poi apri http://localhost:8080
```

`localhost` è considerato sicuro, quindi crittografia e service worker funzionano anche in locale.

### Struttura

```
index.html              pagina unica (onboarding, dashboard, impostazioni)
styles.css              stile neon/CRT
js/app.js               logica dell'app e interfaccia
js/sync.js              stanza, cifratura e connessione a ntfy
js/gauge.js             quadrante SVG con lancetta trascinabile
js/moods.js             fasce di umore, bisogni, avatar, messaggi al volo
sw.js                   service worker (offline)
manifest.webmanifest    manifest PWA
icons/                  icone dell'app
```
