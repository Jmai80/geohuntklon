# Stämpla – prototyp för digital orientering

Läraren ritar en bana på kartan och startar en omgång med en PIN-kod. Eleverna går med i mobilens webbläsare, utan att installera någon app, och kontrollerna stämplas automatiskt med GPS när de kommer fram. Läraren följer klassen live.

"Stämpla" är bara ett arbetsnamn. Byt det gärna (sök på "Stämpla" i mappen `public`).

## Kom igång

1. **Node.js** behövs. Öppna terminalen i VS Code (**Terminal → New Terminal**) och skriv `node -v`. Får du inget versionsnummer: installera LTS-versionen från [nodejs.org](https://nodejs.org) och starta om VS Code.
2. Starta servern i terminalen:

   ```
   npm start
   ```

3. Öppna lärarsidan i webbläsaren: <http://localhost:3000/larare.html>

Stoppa servern med `Ctrl+C`. Inga paket behöver installeras, så `npm install` behövs inte.

## Prova hela flödet vid datorn

1. På lärarsidan: **Rita din första bana**. Sök fram en plats, klicka ut start, några kontroller och mål, och tryck **Spara banan**.
2. Tryck **Starta omgång**, skriv t.ex. `7B` och bocka i **Testomgång**. Du får en PIN-kod.
3. Öppna ett privat fönster (eller en annan webbläsare) och gå till <http://localhost:3000>. Skriv PIN-koden och ett namn, bocka i **Testläge** och tryck **Starta**.
4. Tryck på kartan vid kontroll 1, sedan 2 och så vidare. Varje kontroll stämplas när "du" är inom radien.
5. Titta på lärarsidan: resultatlistan och kartan uppdateras varannan sekund. Klicka på en elev för att se sträcktider och rutt.

## Testa ute med riktiga mobiler

Mobiler delar bara sin GPS-position med sidor vars adress börjar med `https://`. Ute i skogen är eleverna dessutom på mobildata och når inte din dators lokala adress. Lösningen är en tunnel som ger din dator en tillfällig https-adress på internet.

1. Installera `cloudflared` (gratis, inget konto behövs). Med [Homebrew](https://brew.sh):

   ```
   brew install cloudflared
   ```

2. Låt servern köra. Öppna en **andra** terminal i VS Code (plustecknet i terminalfönstret) och skriv:

   ```
   cloudflared tunnel --url http://localhost:3000
   ```

3. Efter några sekunder skriver den ut en adress som slutar på `.trycloudflare.com`. Öppna **lärarsidan via den adressen** (lägg till `/larare.html`), så pekar QR-koden och länken rätt.
4. Eleverna skannar QR-koden eller går till adressen och skriver in PIN-koden.

Bra att veta:

- Datorn måste vara på och ha internet hela tiden. Det går bra att dela nät från din mobil.
- Adressen blir ny varje gång du startar tunneln.
- Tunneln klarar 200 samtidiga anrop, vilket räcker gott för en klass.
- Vill du hindra elever från att öppna lärarsidan: starta servern med ett lösenord, `LARARLOSEN=hemligt npm start`.
- Testa själv först: gå banan med din egen mobil. GPS:en blir sämre i tät skog och nära höga hus. Öka då stämpelradien till 15–20 meter.

## Så fungerar det

- **Stämplingen görs av servern.** Mobilen skickar sina GPS-positioner varannan sekund, och direkt när den är nära nästa kontroll. Servern räknar ut avståndet och stämplar om eleven är inom radien och positionen är noggrannare än 30 meter. Kontrollerna måste tas i nummerordning.
- **Tappat nät?** Positionerna sparas i mobilen och skickas när nätet är tillbaka. Stämplingstiden blir ändå rätt, eftersom den kommer från positionen.
- **Laddas sidan om** eller stängs webbläsaren kan eleven fortsätta där hen var.
- **Skärmen hålls tänd** under loppet (Wake Lock), och mobilen piper och vibrerar vid varje stämpling (vibration finns bara på Android).
- **Läraren ser** placering, antal kontroller, tid, sträcktider och rutt, och om en elev hoppat över kontroller, lämnat appen eller tappat kontakten. Resultatet kan laddas ner som CSV för Excel.
- **Data sparas** i `data/db.json`. Mappen skapas första gången du sparar något. Ta bort filen för att börja om.

## Filerna

| Fil | Vad den gör |
| --- | --- |
| `server.js` | Webbservern: API:t, stämplingen och lagringen. Inga beroenden. |
| `public/index.html`, `public/js/elev.js` | Elevens sida: PIN, GPS-koll, loppet och resultatet. |
| `public/larare.html`, `public/js/larare.js` | Lärarens sida: banor, banritning, omgångar och live-vyn. |
| `public/js/kartlager.js` | Kartorna och hur banan ritas (lila triangel, ringar och mål som på en orienteringskarta). |
| `public/js/geo.js` | Avstånd och tider. Används av både webbläsaren och servern. |
| `public/js/hjalp.js` | Små hjälpfunktioner, bland annat för anrop till servern. |
| `public/css/stil.css` | All stil. |
| `public/vendor/`, `public/fonts/` | Kartbiblioteket Leaflet, QR-kodgeneratorn och typsnitten. |

Inställningar som är lätta att ändra står överst i `server.js` (t.ex. hur noggrann GPS:en måste vara för att stämpla) och i `public/js/elev.js`. Servern kan också startas med `PORT=3001` för en annan port och `DATAMAPP=...` för att spara data någon annanstans. Med `npm run dev` startar servern om av sig själv när du ändrar i `server.js`.

## Det här saknas i prototypen

- **Inloggning för lärare.** Alla som når lärarsidan kan se och ändra allt, om du inte satt `LARARLOSEN`.
- **En riktig databas.** En JSON-fil på din dator räcker för att testa, men inte för många skolor samtidigt.
- **Egna kartservrar.** Kartbilderna kommer från OpenStreetMap och OpenTopoMap, vars gratisservrar bara är till för lätt användning. Inför skarp användning behövs en kartleverantör (t.ex. MapTiler) eller Lantmäteriets öppna kartor.
- **Skydd mot falsk GPS.** Servern kontrollerar ordning, avstånd och noggrannhet, men en elev med en app för falsk position kan fortfarande fuska.
- **GDPR-hantering.** Elevernas rutter är personuppgifter. Ta bort omgångar när ni är klara med dem.

## Idéer för nästa steg

Valfri ordning (Score-O), dold bana där nästa kontroll visas först när den förra är tagen, trygghetszon med larm, SOS-knapp, meddelanden till eleverna, fartkontroll mot cykel och moped, bonusfrågor vid kontrollerna, uppspelning av rutten, PDF-export och lärarkonton med en riktig databas (t.ex. Supabase).

## Licenser

Leaflet (BSD-2-Clause), qrcode-generator av Kazuhiko Arase (MIT), typsnitten Atkinson Hyperlegible Next och Barlow Condensed (SIL Open Font License). Licenstexterna ligger bredvid filerna. Kartdata © OpenStreetMap-bidragsgivare (ODbL), kartstil © OpenTopoMap (CC-BY-SA).
