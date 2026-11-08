# KeeCove

Browserbasierter Passwortmanager für KeePass-Dateien. Docker liefert die Web-App per HTTPS aus. Öffnen, Entschlüsseln, Bearbeiten und Speichern der KDBX-Datei erfolgen auf deinem Gerät.

## Deployment mit Docker

Der [Docker-Workflow](https://github.com/TerhorstIO/keevault/actions/workflows/docker.yml) veröffentlicht das Image für Linux auf AMD64 und ARM64. Pushes auf `main` aktualisieren `ghcr.io/terhorstio/keevault:latest`. Git-Tags wie `v0.1.0` erzeugen einen gleichnamigen Image-Tag.

Klonen und Konfiguration anlegen:

```sh
git clone https://github.com/TerhorstIO/keevault.git
cd keevault
cp .env.example .env
```

In `.env`:

```dotenv
KEEVAULT_IMAGE=ghcr.io/terhorstio/keevault:latest
```

Erzeuge einmal das lokale TLS-Zertifikat mit Node.js ab 24.15 und OpenSSL 3. Unter Windows verwendet das Skript auch OpenSSL aus Git for Windows. Unter Linux setze `KEEVAULT_UID` und `KEEVAULT_GID` in `.env` auf die UID und GID des Benutzers, der das TLS-Verzeichnis besitzt, falls sie von 1000 abweichen.

```sh
npm run tls:cert
docker compose pull
docker compose up -d --no-build --wait
```

Falls das Paket privat ist, melde dich vor dem Pull bei `ghcr.io` mit einem GitHub-Konto mit Paketzugriff und einem klassischen persönlichen Zugriffstoken mit `read:packages` an. Für Updates wiederholst du die beiden Compose-Befehle. [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

Öffne [https://localhost:8080](https://localhost:8080). Vertraue bei Bedarf dem öffentlichen Zertifikat `localhost.crt` lokal. Unter Windows liegen Zertifikat und Schlüssel in `%LOCALAPPDATA%\.keevault\tls`, sonst in `~/.keevault/tls`. Der private Schlüssel bleibt beim Server.

## Datei öffnen oder erstellen

- **Lokale Datei direkt öffnen.** Chrome und Edge können nach deiner Freigabe dieselbe KDBX-Datei lesen und schreiben, die du in KeePass oder KeePassXC verwendest. KeeCove prüft die Dateiversion beim Fokuswechsel, regelmäßig während der geöffneten Sitzung und vor jedem Speichern. Änderungen an verschiedenen Feldern können zusammengeführt werden. Bei einem Konflikt im selben Feld bleibt der Entwurf offen. Zwischen der letzten Prüfung und dem Speichern bleibt bei einem zeitgleichen unabhängigen Schreibvorgang ein kleines Zeitfenster. [Chrome-Dateizugriff](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- **Datei oder Cloud als Sitzungskopie öffnen.** KeeCove lädt eine verschlüsselte Kopie in den Browser. Cloud-Dateien werden nach der Anmeldung mit Leserechten geöffnet. Lade bearbeitete Sitzungskopien über **KDBX exportieren** herunter.
- **Neu.** KeeCove erstellt eine KDBX-4-Datei mit Argon2id und lädt sie auf dein Gerät herunter. Die geöffnete Sitzungskopie kann weiter bearbeitet werden. Mit **KDBX exportieren** lädst du ihren aktuellen Stand herunter.

Ein gesperrter Tresor kann bis zu acht Stunden nach dem Öffnen im selben Tab erneut entsperrt werden, auch nach einem Neuladen. KeeCove speichert dafür die verschlüsselte KDBX und gegebenenfalls die Referenz zur lokalen Datei im Browser. Master-Passwort, Schlüsseldatei, Cloud-Tokens und Download-Links werden für die Wiederaufnahme nicht gespeichert. Bei Tresoren mit Schlüsseldatei wird diese erneut benötigt. Nach fünf Minuten Inaktivität sperrt KeeCove. Nach Ablauf der Sitzung oder Schließen des Tabs musst du die Datei erneut auswählen. Browser können bei direkt geöffneten Dateien erneut um Zugriffsfreigabe bitten.

KDBX 3 und 4 werden unterstützt, einschließlich AES, ChaCha20, AES-KDF, Argon2d, Argon2id und Schlüsseldateien. Das Importlimit beträgt 128 MiB. Die entsperrte Ansicht zeigt Gruppen und Unterordner links, die Einträge der ausgewählten Gruppe darüber im Arbeitsbereich und die Details darunter.

Wenn aus einer älteren Installation noch `data/vault.kdbx` vorhanden ist, kannst du sie über **Datei** öffnen. Docker bindet dieses Verzeichnis nicht mehr ein.

## Private Cloud-Dateien einrichten

Die folgenden Variablen in `.env` steuern die Cloud-Importe. Der Redirect in der App-Registrierung muss genau `https://localhost:8080/cloud-callback.html` lauten. Bei einer anderen KeeCove-Adresse passe den Ursprung an. Starte den Container nach Änderungen mit `docker compose up -d` neu.

- **OneDrive.** Registriere in Microsoft Entra eine **Single-page application** mit delegiertem Microsoft-Graph-Recht `Files.Read`. Setze `CLOUD_ONEDRIVE_CLIENT_ID`. Der Standard `CLOUD_ONEDRIVE_TENANT=common` ist für eine Registrierung mit persönlichen und Organisationskonten gedacht. Verwende für eine mandanteninterne App die passende Mandanten-ID. [Microsoft OAuth](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- **Google Drive.** Aktiviere die Drive API und lege einen OAuth-Client vom Typ **Webanwendung** an. Trage die KeeCove-Adresse als autorisierten JavaScript-Ursprung ein und setze `CLOUD_GOOGLE_CLIENT_ID`. Der Dateibrowser verwendet `drive.readonly` und Googles direkt im Browser dokumentierten Legacy-Tokenfluss. Für eine externe App im Testmodus füge die zugelassenen Testkonten hinzu. Google kann für eine Veröffentlichung eine Prüfung verlangen. [Google Browser-OAuth](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow) · [Drive-Berechtigungen](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- **Dropbox.** Registriere eine App mit **Scoped access** und **Full Dropbox**, um vorhandene Ordner auswählen zu können. Aktiviere `files.metadata.read` und `files.content.read`. Setze den öffentlichen App Key als `CLOUD_DROPBOX_CLIENT_ID`. [Dropbox OAuth](https://docs.dropboxapi.com/dropbox-api/docs/oauth)

Die Anmeldung öffnet ein eigenes Fenster beim Anbieter. KeeCove verwendet nur kurzlebige Zugriffstokens im Browser. Dateien anderer Anbieter kannst du über einen lokal synchronisierten Ordner öffnen.

## Chrome und Edge

Lade in KeeCove **Browser-Erweiterung** herunter und entpacke `keecove-browser.zip`. Öffne `chrome://extensions` oder `edge://extensions`, aktiviere den Entwicklermodus und lade den entpackten Ordner. Trage `https://localhost:8080` als KeeCove-Adresse ein. Die Erweiterung füllt nur nach deiner Auswahl und nur für die passende Website. Dazu muss KeeCove in einem Tab entsperrt sein. [Anleitung zur Erweiterung](extension/README.md)

## Betrieb und Entwicklung

Compose veröffentlicht HTTPS nur lokal. Für einen HTTPS-Reverse-Proxy setzt du `PUBLIC_ORIGIN` auf die externe Adresse. Der Proxy spricht HTTPS zum Backend, prüft dessen Zertifikat und reicht den ursprünglichen `Host` weiter. Optional schützen `VAULT_HTTP_USER` und `VAULT_HTTP_PASSWORD` den Zugriff auf die App.

Mit Node.js 24.15 oder neuer:

```sh
npm ci
npm test
npm run build
npm start
```

Beim direkten Node-Start aktiviert das Paar `TLS_CERT_PATH` und `TLS_KEY_PATH` HTTPS. Der Standardport ist 8080.

Für einen lokalen Docker-Build verwende `docker compose up --build -d`. Ohne `KEEVAULT_IMAGE` heißt das lokal gebaute Image `keevault:local`.
