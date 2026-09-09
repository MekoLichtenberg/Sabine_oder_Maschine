## Spielprinzip

**Runde 1 — Finde die KI (Werwolf):**
Eine:r (bei großen Gruppen mehrere) ist heimlich die KI. Alle bekommen dieselbe Frage. Menschen tippen frei, die KI wählt aus vorformulierten Antworten (mit eingebauten Tippfehlern, um sich zu tarnen). Danach Diskussion, dann Abstimmung: die verdächtigste Person fliegt raus. In der Runde lässt die KI heimlich jemanden verschwinden. Menschen gewinnen, wenn die KI entlarvt wird; die KI gewinnt, wenn sie die Menschen einholt.

**Runde 2 — Sei die KI:**
Die KIs haben das Netz übernommen. Jetzt müssen alle so antworten, dass sie wie eine KI klingen; wer ins Menschliche abrutscht (Tippfehler, Slang, Gefühl), fliegt raus. Jeder gegen jeden, bis eine:r übrig bleibt. Die Zahl der Eliminierungen pro Runde steigt mit der Gruppengröße.

Alle Spielenden bekommen beim Beitreten einen zufälligen Spaß-Namen (Brigitte, Reinhardt, Alfons …).

## Schnellstart

**Ohne Technik-Kenntnisse:** Node.js (LTS) installieren, dann `Start.bat` (Windows) oder `Start.command` (Mac) doppelklicken. Der Browser öffnet sich von selbst, in der Lobby steht groß die Adresse für die Mitspielenden.
**Per Terminal:**

```bash
cp .env.example .env
npm install
npm start
```

`http://<IP-des-Rechners>:8080` im Browser öffnen. Der Server zeigt die Netzwerkadresse beim Start an, die Lobby ebenfalls. Alle im selben WLAN/LAN treten mit dem 4-stelligen Code bei. Wer den Raum öffnet, ist Host und steuert den Ablauf. Mindestens 3 Spielende.

### Docker (für Schulen)

```bash
cp .env.example .env
docker compose up --build -d
```

Läuft auf jedem Rechner mit Docker, auch auf einem Raspberry Pi. Kein Cloud-Zugang. Die `.env` ist optional; ohne sie gelten die Standardwerte.

### Auf Proxmox (LXC-Container)

1. In Proxmox einen LXC-Container anlegen (Debian 12 oder Ubuntu 24.04, 1 CPU, 512 MB RAM, 4 GB Disk reichen). Bei den Optionen **Nesting** aktivieren, sonst läuft Docker im Container nicht.
2. Im Container Docker installieren:
   ```bash
   apt update && apt install -y curl git
   curl -fsSL https://get.docker.com | sh
   ```
3. Projekt in den Container bringen (per `git clone`, `scp` oder als ZIP) und starten:
   ```bash
   cd SabineOderMaschine
   cp .env.example .env
   docker compose up --build -d
   ```
4. Im Browser `http://<Container-IP>:8080` öffnen. Der Container startet dank `restart: unless-stopped` automatisch mit dem Host neu.

Alternativ ohne Docker: Node 20 im Container installieren (`apt install nodejs npm` oder NodeSource), `npm install`, und `node server.js` per systemd-Service laufen lassen.

## Wie wird die KI-Rolle gespielt? (Host-Wahl in der Lobby)

- **Mensch wählt Vorschläge** (Standard): Ein Mensch ist heimlich die KI und wählt aus Antwortvorschlägen, aus `questions.json` oder live von der echten KI.
- **Mensch + Chat mit NULL**: Wie oben, aber die KI-Person wird auf ihrem Handy von „NULL, deinem KI-Agenten“ mit einer Tipp-Animation begrüßt und kann NULL live um Formulierungen bitten („kürzer“, „was mit pizza“). Jede Antwort von NULL lässt sich per Knopf übernehmen. Braucht eine verbundene echte KI.
- **KI spielt selbst (Bot-Sitz)**: In der Spielerliste erscheint ein zusätzlicher Name, hinter dem kein Mensch sitzt. Der Bot ist immer eine KI, antwortet mit menschlich klingendem Text (echte KI oder Liste), stimmt ab, wählt nachts ein Opfer und spielt in Runde 2 als perfekt klingende Maschine mit. Beim Rollen-Reveal und im Endstand wird er als „echter Bot“ enttarnt. Am besten einschalten, bevor die Klasse beitritt, damit niemand den neuen Namen auftauchen sieht. Der Bot braucht 6 bis 20 Sekunden für jede Aktion, damit er nicht sofort „fertig“ ist (`BOT_MIN_DELAY_MS` / `BOT_MAX_DELAY_MS`).

## Echte KI anbinden (optional)

Statt der vorformulierten Antworten aus `questions.json` kann ein lokales Sprachmodell die Antwortvorschläge für die KI-Rolle live erzeugen. Der Host klappt dafür in der Lobby **„Echte KI anbinden“** auf, trägt die Adresse des Servers ein (z. B. `http://192.168.1.50:11434` für Ollama) und klickt **Verbinden & testen**. Der Server holt die Modellliste, macht eine Probe-Anfrage und zeigt den Status. Erst bei „ok“ wird die KI im Spiel benutzt.

Unterstützt wird jeder **OpenAI-kompatible** Endpunkt (`/v1/models`, `/v1/chat/completions`): Ollama, LM Studio, llama.cpp-Server, vLLM, LocalAI usw. Ein API-Key ist bei lokalen Servern meist nicht nötig.

Wichtig bei **Ollama**: Standardmäßig hört Ollama nur auf `localhost`. Damit der Spielserver es erreicht, muss es auf allen Interfaces lauschen, z. B. per Umgebungsvariable `OLLAMA_HOST=0.0.0.0` (bei systemd: `systemctl edit ollama` und `Environment="OLLAMA_HOST=0.0.0.0"` eintragen, dann neu starten).

Ablauf im Spiel:
- Beim Start jeder Runde-1-Frage werden 5 Antworten generiert. Die KI-Spieler:in sieht solange „ki generiert antworten …“, alle anderen merken nichts.
- Die nächste Frage wird schon im Hintergrund vorbereitet, damit es ab der zweiten Runde keine Wartezeit gibt.
- Fällt die Anfrage aus oder dauert sie länger als `LLM_TIMEOUT_MS` (Standard 60 s), springen automatisch die vorformulierten Antworten ein. Das Spiel bleibt nie hängen.
- In der Auflösung steht, ob die Vorschläge der Runde von der echten KI kamen.

Die Vorbelegung des Panels kann in der `.env` gesetzt werden (`LLM_URL`, `LLM_MODEL`, `LLM_KEY`), dann muss der Host nur noch auf „Verbinden & testen“ klicken.

Kleine Modelle (z. B. SmolLM2 1.7B) liefern auf Deutsch manchmal holprige oder englische Zeilen. Ein 3–8B-Modell mit gutem Deutsch (Apertus 8B, Gemma 3 4B, Qwen 2.5/3, Llama 3.x) wirkt deutlich glaubwürdiger.

### Apertus (Schweizer Open-Source-Modell) in Ollama

Apertus 8B Instruct liegt als inoffizieller GGUF-Upload in der Ollama-Registry. Auf dem Ollama-Rechner:

```bash
ollama run MichelRosselli/apertus:8b-instruct-2509-q4_k_m
```

Danach in der Lobby als Modellname `MichelRosselli/apertus:8b-instruct-2509-q4_k_m` eintragen (oder leer lassen, dann wird das erste gefundene Modell genommen). Ollama muss aktuell sein, da Apertus eine eigene Architektur mitbringt.

### Output klein halten

Die Anfragen sind absichtlich winzig: standardmäßig 3 Vorschläge mit je maximal 12 Wörtern und ein Budget von 120 Tokens. Das bleibt auch auf CPU in wenigen Sekunden. In der `.env` einstellbar:

```
LLM_ANSWERS=3        # 2 bis 5 Vorschläge
LLM_MAX_WORDS=12     # Wörter pro Vorschlag
LLM_MAX_TOKENS=120   # Token-Budget pro Anfrage
LLM_SYSTEM_PROMPT=   # eigener Prompt, ersetzt den eingebauten komplett
```

## Inhalte anpassen

Alles in `questions.json`:
- `names` — Pool der Spaß-Namen.
- `round1` — Objekte mit `q` (Frage) und `ki` (vorformulierte KI-Antworten; ruhig mit Tippfehlern und lockerer Sprache, damit sie nicht auffallen). Pool groß genug halten, damit sich Antworten nicht jede Runde wiederholen.
- `round2` — Liste von Fragen (alle tippen frei als KI).

Fragen wiederholen sich innerhalb eines Spiels nicht, bis der Pool einmal durch ist.

## Hinweis zu den Schriften

Das Theme lädt Orbitron / Rajdhani / VT323 vom Google-Fonts-CDN. Mit Internet sieht es am besten aus; ohne Internet fällt es sauber auf System-Monospace/Sans zurück (CRT-Feeling bleibt). Für komplett offline: woff2-Dateien herunterladen, in `public/fonts/` legen und per `@font-face` in `style.css` einbinden.

## Verbindungsabbruch / Reload

Wer die Seite neu lädt oder kurz die Verbindung verliert, kommt automatisch auf seinen Platz zurück — Rolle, Status und schon abgegebene Antwort bleiben erhalten (per Sitzungs-Token im Browser). Abgemeldete Spielende werden in der Liste als „offline“ angezeigt; der Host kann sie mit ✕ entfernen (im Spiel gelten sie dann als ausgeschieden). Fällt der Host weg, kann jede:r andere per Knopf den Host übernehmen, damit das Spiel weiterläuft. Der Server prüft alle 30 s per Ping, ob Handys im Standby noch da sind.

## Testen ohne Mitspieler

```bash
node _mockllm.mjs            # Fake-KI-Server auf Port 8111 (optional)
PORT=8099 node server.js     # Spielserver
PORT=8099 N=6 LLM=http://localhost:8111 node _sim.mjs   # 6 Bots spielen beide Runden durch
```

Das Skript prüft u. a. feste Antwort-Reihenfolge, Zuschauer-Status, Nacht-Hinweis und KI-Vorschläge und meldet am Ende „ALLES OK“.

## Status

v0.5 — Werwolf-Loop, zweite Runde, Rollen-/KI-Skalierung, Retro-CRT/Synthwave-Theme mit Glitch, Live-Bereit-Status, Rollen-Reveal, Reconnect, Jokey-„Ich bin kein Roboter“-Login, 3-Wörter-Minimum, „ist der Tippfehler gewollt?“-Nachfrage, Zuschauer-Ansicht für Ausgeschiedene, Heartbeat, Kick für Offline-Spieler, keine Fragen-Wiederholung, optional echte KI über OpenAI-kompatiblen Endpunkt. Discussion läuft per Voice/im Raum; die App ist der Spielleiter.
