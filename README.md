# 🎛️ Mood Meter

**how to read moods online _(fast)_**

Un misuratore di umore per due, in stile *How to Sell Drugs Online (Fast)*: schermo scuro, verde neon, finestre `.exe` retrò ed effetto CRT.
Ognuno imposta il proprio umore su un quadrante con la lancetta e lo vedete entrambi **in tempo reale**, ognuno sul suo telefono.

È una **PWA**: si apre da qualsiasi browser e si installa sulla schermata Home di Android e iPhone come un'app vera, funziona anche offline.

## Cosa fa

- **Quadrante con lancetta** da trascinare (o slider) con 7 fasce: ☠️ Zona rossa → 😤 Nervi a fior di pelle → 🪫 Batteria scarica → 😐 Meh → 🙂 Tutto ok → 😎 Good vibes → 🤩 Al top
- **"Mi serve…"**: coccole, spazio, fame, sonno, silenzio, cioccolato, ciclo…
- **Due parole**: una nota breve (max 140 caratteri) che appare come un post-it
- **Manda al volo**: 💋 bacio, 🫂 abbraccio, 👀 ti penso, ☕ caffè?, 🍕 pizza?
- **cose_da_fare.txt**: una lista condivisa, tutti e due potete aggiungere, spuntare ed eliminare (con *Annulla*)
- **log.txt**: lo storico degli ultimi aggiornamenti di entrambi
- **Notifiche** quando arriva un nuovo umore o un messaggio (con l'app aperta o in background recente)
- **Offline**: l'app si apre anche senza rete e invia appena torna la connessione

## Come si usa

1. Apri il sito, scrivi il tuo nome e scegli un avatar.
2. Premi **Crea una stanza nuova** e manda il link (Copia, Condividi o WhatsApp).
3. Chi riceve il link lo apre, sceglie nome e avatar, ed è dentro.
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
- ntfy.sh conserva i messaggi per circa 12 ore: per questo l'app ripubblica il tuo ultimo stato e la lista ogni 3 ore quando è aperta, e ognuno tiene in memoria l'ultimo umore ricevuto e la lista. Se un telefono non trova niente di recente, chiede all'altro di ripubblicare.
- La lista si sincronizza voce per voce (vince la modifica più recente), così due modifiche fatte insieme non si cancellano a vicenda.
- ntfy.sh permette 250 messaggi al giorno per connessione: ogni modifica è un solo messaggio, quindi per un uso normale si resta molto sotto.

Chi ha il link entra nella stanza: non condividerlo con nessun altro.

**Server personalizzato**: se hai un tuo server ntfy, aggiungi `&s=https://tuo-server` al link della stanza (es. `…/#r=XXXXX-XXXXX-XXXXX-XXXXX&s=https://ntfy.example.com`).

## Limiti noti

- Le notifiche arrivano solo se l'app è aperta o è stata in background da poco: senza un server push dedicato i browser non possono svegliare un'app chiusa.
- Su iPhone notifiche e installazione richiedono iOS 16.4+ e l'app aggiunta alla schermata Home.
- Se installi l'app su un **nuovo** telefono e dall'altra parte nessuno la apre da più di 12 ore, il suo umore compare solo alla prossima apertura.

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
