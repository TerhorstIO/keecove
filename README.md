# KeeCove

Browserbasierter Passwortmanager für KeePass-Dateien. Docker liefert die Web-App per HTTPS aus. Öffnen, Entschlüsseln, Bearbeiten und Speichern der KDBX-Datei erfolgen auf deinem Gerät.

## Deployment mit Docker

Lade die [Compose-Datei](https://raw.githubusercontent.com/TerhorstIO/keevault/main/compose.yaml) in ein leeres Verzeichnis. Sie nutzt `ghcr.io/terhorstio/keevault:latest` für Linux auf AMD64 und ARM64.

```sh
curl -fsSLo compose.yaml https://raw.githubusercontent.com/TerhorstIO/keevault/main/compose.yaml
```

Trage deine Einstellungen direkt in `compose.yaml` unter `services.keevault.environment` ein. Die Vorgaben starten KeeCove lokal auf Port 8080. Wenn du den Port änderst, passe `PORT` und beide Portnummern unter `ports` gemeinsam an. Unter Linux muss `user` zur UID und GID des Besitzers des TLS-Verzeichnisses passen.

Der Container liest `localhost.crt` und `localhost.key` aus dem schreibgeschützt eingebundenen TLS-Verzeichnis. Falls du noch kein Zertifikat hast, kannst du es einmalig mit Node.js und OpenSSL 3 erzeugen. Unter Windows verwendet das Skript auch OpenSSL aus Git for Windows. Verwende in Windows PowerShell für die Downloads `curl.exe`.

```sh
curl -fsSLo create-local-cert.mjs https://raw.githubusercontent.com/TerhorstIO/keevault/main/scripts/create-local-cert.mjs
node create-local-cert.mjs
```

Für Start und Updates:

```sh
docker compose up -d --pull always --wait
```

Öffne [https://localhost:8080](https://localhost:8080). Vertraue bei Bedarf dem öffentlichen Zertifikat `localhost.crt` lokal. Unter Windows liegen Zertifikat und Schlüssel in `%LOCALAPPDATA%\.keevault\tls`, sonst in `~/.keevault/tls`. Der private Schlüssel bleibt beim Server.

### Docker-Image offline importieren

Ein erfolgreicher [Docker-Build](https://github.com/TerhorstIO/keevault/actions/workflows/docker.yml) auf `main` aktualisiert das Image `:latest` und veröffentlicht einen Vorab-Release für den Commit. Ein Git-Tag wie `v0.1.0` erzeugt einen Versionsrelease mit dem gleichnamigen Image-Tag.

Lade in den [GitHub-Releases](https://github.com/TerhorstIO/keevault/releases) das Archiv für den Zielrechner herunter. Für x86-64 heißt es `keecove-linux-amd64.tar`, für ARM64 `keecove-linux-arm64.tar`. Die Prüfsummen stehen in `SHA256SUMS`. Kopiere die Compose-Datei auf den Zielrechner und stelle dort die TLS-Dateien wie oben bereit.

```sh
docker load -i keecove-linux-amd64.tar
docker compose up -d --pull never --wait
```

Vorab-Releases laden das Image mit `:latest`. Wenn du einen Versionsrelease importierst, setze in `compose.yaml` unter `image` den passenden Tag, etwa `ghcr.io/terhorstio/keevault:v0.1.0`.

## Datei öffnen oder erstellen

- **Lokale Datei direkt öffnen.** Chrome und Edge können nach deiner Freigabe dieselbe KDBX-Datei lesen und schreiben, die du in KeePass oder KeePassXC verwendest. KeeCove prüft die Dateiversion beim Fokuswechsel, regelmäßig während der geöffneten Sitzung und vor jedem Speichern. Änderungen an verschiedenen Feldern können zusammengeführt werden. Bei einem Konflikt im selben Feld bleibt der Entwurf offen. Zwischen der letzten Prüfung und dem Speichern bleibt bei einem zeitgleichen unabhängigen Schreibvorgang ein kleines Zeitfenster. [Chrome-Dateizugriff](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- **Datei oder Cloud als Sitzungskopie öffnen.** KeeCove lädt eine verschlüsselte Kopie in den Browser. Cloud-Dateien werden nach der Anmeldung mit Leserechten geöffnet. Lade bearbeitete Sitzungskopien über **KDBX exportieren** herunter.
- **Neu.** KeeCove erstellt eine KDBX-4-Datei mit Argon2id und lädt sie auf dein Gerät herunter. Die geöffnete Sitzungskopie kann weiter bearbeitet werden. Mit **KDBX exportieren** lädst du ihren aktuellen Stand herunter.

Ein gesperrter Tresor kann bis zu acht Stunden nach dem Öffnen im selben Tab erneut entsperrt werden, auch nach einem Neuladen. KeeCove speichert dafür die verschlüsselte KDBX und gegebenenfalls die Referenz zur lokalen Datei im Browser. Master-Passwort, Schlüsseldatei, Cloud-Tokens und Download-Links werden für die Wiederaufnahme nicht gespeichert. Bei Tresoren mit Schlüsseldatei wird diese erneut benötigt. Nach fünf Minuten Inaktivität sperrt KeeCove. Nach Ablauf der Sitzung oder Schließen des Tabs musst du die Datei erneut auswählen. Browser können bei direkt geöffneten Dateien erneut um Zugriffsfreigabe bitten.

KDBX 3 und 4 werden unterstützt, einschließlich AES, ChaCha20, AES-KDF, Argon2d, Argon2id und Schlüsseldateien. Das Importlimit beträgt 128 MiB. Die entsperrte Ansicht zeigt Gruppen und Unterordner links, die Einträge der ausgewählten Gruppe darüber im Arbeitsbereich und die Details darunter.

Wenn aus einer älteren Installation noch `data/vault.kdbx` vorhanden ist, kannst du sie über **Datei** öffnen. Docker bindet dieses Verzeichnis nicht mehr ein.

## Private Cloud-Dateien einrichten

Die folgenden Variablen unter `environment` in `compose.yaml` steuern die Cloud-Importe. Der Redirect in der App-Registrierung muss genau `https://localhost:8080/cloud-callback.html` lauten. Bei einer anderen KeeCove-Adresse passe den Ursprung an. Übernimm die Änderungen mit `docker compose up -d`.

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

Im Quellverzeichnis kannst du das lokale Docker-Image `keevault:local` mit dem Entwicklungs-Override bauen und starten:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up --build -d
```
