# Stämpla – prototyp för digital orientering

Läraren ritar en bana på kartan och startar en omgång med en PIN-kod. Eleverna går med i mobilens webbläsare, utan att installera någon app, och kontrollerna stämplas automatiskt med GPS när de kommer fram. Läraren följer klassen live.

Sidan ligger på **GitHub Pages**, och databasen och lärarnas inloggning ligger hos **Supabase** (gratis). Pages kan bara visa färdiga filer, så allt som måste delas mellan lärare och elever, och själva stämplingen, sköts av databasen.

"Stämpla" är bara ett arbetsnamn. Byt det gärna (sök på "Stämpla" i mappen `docs`).

## Sätt upp den (ungefär 10 minuter, görs en gång)

### 1. Skapa databasen i Supabase

1. Gå till [supabase.com](https://supabase.com), skapa ett gratis konto och välj **New project**. Välj en region i Europa, t.ex. Stockholm (eu-north-1) eller Frankfurt. Lösenordet till databasen behöver du inte senare.
2. Vänta tills projektet är klart (en–två minuter).
3. Öppna **SQL Editor** i menyn till vänster och välj **New query**. Klistra in hela innehållet i filen `supabase.sql` och tryck **Run**. Det ska stå "Success. No rows returned".

### 2. Koppla sidan till databasen

1. I Supabase: öppna **Project Settings** (kugghjulet) → **API Keys**. Kopiera den **publika** nyckeln: *Publishable key* (börjar med `sb_publishable_`) eller, i äldre projekt, *anon public*.
2. Kopiera projektets adress. Den står under **Project Settings → Data API** (eller överst på projektets startsida) och ser ut som `https://abcdefghijklm.supabase.co`.
3. Öppna `docs/config.js` och klistra in båda:

   ```js
   export const SUPABASE_URL = 'https://abcdefghijklm.supabase.co';
   export const SUPABASE_NYCKEL = 'sb_publishable_...';
   ```

   Den publika nyckeln får synas på webben, det är så den är tänkt. Lägg **aldrig** in den hemliga nyckeln (*secret* eller *service_role*).

4. Spara, gör en commit och pusha till GitHub.

### 3. Slå på GitHub Pages

1. I repot på GitHub: **Settings → Pages**.
2. Under **Build and deployment**: välj **Source: Deploy from a branch**, **Branch: main** och mappen **/docs**. Tryck **Save**.
3. Efter någon minut visas adressen överst på samma sida, t.ex. `https://jmai80.github.io/geohuntklon/`.

### 4. Ställ in inloggningen

I Supabase: **Authentication → URL Configuration**. Skriv in din Pages-adress under **Site URL** (t.ex. `https://jmai80.github.io/geohuntklon/larare.html`) och lägg till samma adress under **Redirect URLs**. Annars leder länken i bekräftelsemejlet till fel ställe.

Supabase skickar ett mejl som nya lärare måste bekräfta. Den inbyggda mejltjänsten får bara skicka ett fåtal mejl i timmen. När du bara testar själv kan du slå av det under **Authentication → Sign In / Providers → Email → Confirm email**.

När alla lärare som ska använda sidan har skapat konton kan du stänga för fler under **Authentication → Sign In / Providers → Allow new users to sign up**.

## Använd den

- **Lärare:** gå till `.../geohuntklon/larare.html`, skapa ett konto, rita en bana och starta en omgång. Visa PIN-koden eller QR-koden för klassen.
- **Elever:** gå till `.../geohuntklon/`, eller skanna QR-koden, och skriv in PIN-koden.

Pages använder https, så mobilernas GPS fungerar direkt. Ingen tunnel behövs.

**Prova vid datorn först:** bocka i **Testomgång** när du startar omgången. Öppna elevsidan i ett privat fönster, bocka i **Testläge** och tryck på kartan för att "springa" till kontrollerna.

## Testa på din egen dator

```
npm start
```

Öppna sedan <http://localhost:3000/larare.html>. Sidorna hämtas från mappen `docs` och använder samma Supabase-databas som den publicerade sidan. Mobiler kan inte använda GPS mot din dators adress, så riktiga GPS-tester gör du på Pages-adressen.

## Så fungerar det

- **Stämplingen görs av databasen.** Mobilen skickar sina GPS-positioner varannan sekund, och direkt när den är nära nästa kontroll. Funktionen `elev_positioner` i `supabase.sql` räknar ut avståndet och stämplar om eleven är inom radien och positionen är noggrannare än 30 meter. Kontrollerna måste tas i nummerordning.
- **Ingen kan läsa tabellerna direkt.** Webbsidan får bara anropa funktionerna i `supabase.sql`. Lärare ser bara sina egna banor och omgångar. Elever känns igen på en hemlig nyckel som deras mobil fick när de gick med.
- **Tappat nät?** Positionerna sparas i mobilen och skickas när nätet är tillbaka. Stämplingstiden blir ändå rätt, eftersom den kommer från positionen.
- **Laddas sidan om** eller stängs webbläsaren kan eleven fortsätta där hen var.
- **Skärmen hålls tänd** under loppet, och mobilen piper och vibrerar vid varje stämpling (vibration finns bara på Android).
- **Läraren ser** placering, antal kontroller, tid, sträcktider och rutt, och om en elev hoppat över kontroller, lämnat appen eller tappat kontakten. Resultatet kan laddas ner som CSV för Excel.

## Filerna

| Fil | Vad den gör |
| --- | --- |
| `supabase.sql` | Databasen: tabeller, stämplingen och alla funktioner som sidan anropar. Kör den igen i SQL Editor om du ändrar i den. |
| `docs/config.js` | Adressen och den publika nyckeln till din Supabase-databas. |
| `docs/index.html`, `docs/js/elev.js` | Elevens sida: PIN, GPS-koll, loppet och resultatet. |
| `docs/larare.html`, `docs/js/larare.js` | Lärarens sida: inloggning, banor, banritning, omgångar och live-vyn. |
| `docs/js/backend.js` | Kopplingen till Supabase: inloggning och anrop till databasfunktionerna. |
| `docs/js/kartlager.js` | Kartorna och hur banan ritas (lila triangel, ringar och mål som på en orienteringskarta). |
| `docs/js/geo.js` | Avstånd och tider. |
| `docs/js/hjalp.js` | Små hjälpfunktioner. |
| `docs/css/stil.css` | All stil. |
| `docs/vendor/`, `docs/fonts/` | Kartbiblioteket Leaflet, QR-kodgeneratorn och typsnitten. |
| `dev-server.js` | Visar mappen `docs` på din dator när du kör `npm start`. |

Inställningar för stämplingen (hur noggrann GPS:en måste vara) står överst i `supabase.sql`. Inställningar för mobilen står överst i `docs/js/elev.js`.

## Bra att veta om gratisnivåerna

- **Supabase** pausar ett gratisprojekt som inte använts på en vecka. Du startar det igen med en knapp i Supabase. Datan finns kvar.
- **Kartbilderna** kommer från OpenStreetMap och OpenTopoMap, vars gratisservrar bara är till för lätt användning. Det räcker för några klasser. Inför bredare användning behövs en kartleverantör (t.ex. MapTiler) eller Lantmäteriets öppna kartor.
- **Glömt lösenord** finns inte i sidan än. Du kan byta en lärares lösenord eller ta bort kontot i Supabase under **Authentication → Users**.

## Det här saknas i prototypen

- **Skydd mot falsk GPS.** Databasen kontrollerar ordning, avstånd och noggrannhet, men en elev med en app för falsk position kan fortfarande fuska.
- **GDPR-hantering.** Elevernas rutter är personuppgifter. Ta bort omgångar när ni är klara med dem. Om sidan ska användas i en skola behövs ett personuppgiftsbiträdesavtal med Supabase och en bedömning av var datan lagras.

## Idéer för nästa steg

Valfri ordning (Score-O), dold bana där nästa kontroll visas först när den förra är tagen, trygghetszon med larm, SOS-knapp, meddelanden till eleverna, fartkontroll mot cykel och moped, bonusfrågor vid kontrollerna, uppspelning av rutten, PDF-export och "glömt lösenord".

## Licenser

Leaflet (BSD-2-Clause), qrcode-generator av Kazuhiko Arase (MIT), typsnitten Atkinson Hyperlegible Next och Barlow Condensed (SIL Open Font License). Licenstexterna ligger bredvid filerna. Kartdata © OpenStreetMap-bidragsgivare (ODbL), kartstil © OpenTopoMap (CC-BY-SA).
