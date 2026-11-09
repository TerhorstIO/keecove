# KeeCove

Browserbasierter Passwortmanager für KeePass-Dateien. KeeCove entschlüsselt und bearbeitet KDBX-Dateien im Browser.

## Deployment mit Docker

Lade die [Compose-Datei](https://raw.githubusercontent.com/TerhorstIO/keecove/main/compose.yaml) in ein leeres Verzeichnis. Sie nutzt `ghcr.io/terhorstio/keevault:latest` für Linux auf AMD64 und ARM64.

```sh
curl -fsSLo compose.yaml https://raw.githubusercontent.com/TerhorstIO/keecove/main/compose.yaml
```

Trage deine Einstellungen direkt in `compose.yaml` unter `services.keevault.environment` ein. Setze `PUBLIC_ORIGIN` auf die öffentliche HTTPS-Adresse, zum Beispiel `https://vault.example.org`.

Der Reverse Proxy übernimmt HTTPS und leitet per HTTP an `http://127.0.0.1:8080` weiter. Er reicht den ursprünglichen `Host` einschließlich eines abweichenden Ports und den `Origin`-Header durch. Wenn beide Dienste im selben Docker-Netz liegen, kannst du `http://keevault:8080` als Ziel nutzen. [NGINX-Proxy-Header](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)

Verwende in Windows PowerShell für den Download `curl.exe`. Für Start und Updates:

```sh
docker compose up -d --pull always --wait
```

Öffne KeeCove über die HTTPS-Adresse des Reverse Proxys.

### Docker-Image offline importieren

Ein erfolgreicher [Docker-Build](https://github.com/TerhorstIO/keecove/actions/workflows/docker.yml) auf `main` aktualisiert das Image `:latest` und veröffentlicht einen Vorab-Release für den Commit. Ein Git-Tag wie `v0.1.0` erzeugt einen Versionsrelease mit dem gleichnamigen Image-Tag.

Lade in den [GitHub-Releases](https://github.com/TerhorstIO/keecove/releases) das Archiv für den Zielrechner herunter. Für x86-64 heißt es `keecove-linux-amd64.tar`, für ARM64 `keecove-linux-arm64.tar`. Die Prüfsummen stehen in `SHA256SUMS`. Kopiere das Archiv und die Compose-Datei auf den Zielrechner.

```sh
docker load -i keecove-linux-amd64.tar
docker compose up -d --pull never --wait
```

Vorab-Releases laden das Image mit `:latest`. Wenn du einen Versionsrelease importierst, setze in `compose.yaml` unter `image` den passenden Tag, etwa `ghcr.io/terhorstio/keevault:v0.1.0`.

## Datei öffnen oder erstellen

- **Lokale Datei direkt öffnen.** Chrome und Edge können nach deiner Freigabe dieselbe KDBX-Datei lesen und schreiben, die du in KeePass oder KeePassXC verwendest. KeeCove prüft die Dateiversion beim Fokuswechsel, regelmäßig während der geöffneten Sitzung und vor jedem Speichern. Änderungen an verschiedenen Feldern können zusammengeführt werden. Bei einem Konflikt im selben Feld bleibt der Entwurf offen. Zwischen der letzten Prüfung und dem Speichern bleibt bei einem zeitgleichen unabhängigen Schreibvorgang ein kleines Zeitfenster. [Chrome-Dateizugriff](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- **OneDrive und Dropbox direkt öffnen.** KeeCove prüft die Dateiversion regelmäßig und vor dem Speichern. Änderungen werden als verschlüsselte KDBX in dieselbe Datei zurückgeschrieben. Beim Speichern sendet KeeCove die erwartete Version mit.
- **Schreibgeschützt öffnen.** Tresore in Google Drive und lokale Dateien in Browsern ohne direkten Dateizugriff kannst du lesen. Eine über Google Drive für Desktop synchronisierte Datei kannst du in Chrome oder Edge als lokale Datei direkt öffnen und bearbeiten.
- **Neu.** KeeCove erstellt eine KDBX-4-Datei mit Argon2id und lädt sie auf dein Gerät herunter. Öffne sie anschließend als lokale Datei, um sie zu bearbeiten.

Für direkt geöffnete Tresore merkt sich KeeCove nur die Dateireferenz in der Browsersitzung. Du kannst den Tresor im selben Tab bis zu acht Stunden nach dem Öffnen erneut entsperren, auch nach einem Neuladen. Gib dafür das Master-Passwort und bei Bedarf die Schlüsseldatei ein. Nach fünf Minuten Inaktivität sperrt KeeCove. Nach Ablauf der Sitzung oder Schließen des Tabs wählst du die Datei erneut aus. Bei lokalen Dateien kann der Browser erneut um Zugriffsfreigabe bitten.

Die Cloud-Zugriffstokens liegen im Arbeitsspeicher des geöffneten Tabs. Nach einem Neuladen oder Tokenablauf verbindest du dasselbe Cloud-Konto erneut. Innerhalb der acht Stunden bleibt die Dateiauswahl erhalten.

KDBX 3 und 4 werden unterstützt, einschließlich AES, ChaCha20, AES-KDF, Argon2d, Argon2id und Schlüsseldateien. Das Importlimit beträgt 128 MiB. Die entsperrte Ansicht zeigt Gruppen und Unterordner links, die Einträge der ausgewählten Gruppe darüber im Arbeitsbereich und die Details darunter.

Wenn aus einer älteren Installation noch `data/vault.kdbx` vorhanden ist, kannst du sie über **Datei** öffnen. Docker bindet dieses Verzeichnis nicht mehr ein.

## Private Cloud-Dateien einrichten

Die folgenden Variablen unter `environment` in `compose.yaml` steuern die Cloud-Importe. Hänge für die Redirect-URI in der App-Registrierung `/cloud-callback.html` an die öffentliche KeeCove-Adresse an, zum Beispiel `https://vault.example.org/cloud-callback.html`. Übernimm die Änderungen mit `docker compose up -d`.

- **OneDrive.** Registriere in Microsoft Entra eine **Single-page application** mit delegiertem Microsoft-Graph-Recht `Files.ReadWrite`. Setze `CLOUD_ONEDRIVE_CLIENT_ID`. Der Standard `CLOUD_ONEDRIVE_TENANT=common` ist für eine Registrierung mit persönlichen und Organisationskonten gedacht. Verwende für eine mandanteninterne App die passende Mandanten-ID. Wenn deine App bisher `Files.Read` verwendet, ergänze `Files.ReadWrite`, verbinde OneDrive erneut und bestätige bei Bedarf die zusätzliche Berechtigung. Die bisherige Redirect-URI gilt weiter. [Microsoft OAuth](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) · [Dateiinhalt in Microsoft Graph ersetzen](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)
- **Google Drive.** Aktiviere die Drive API und lege einen OAuth-Client vom Typ **Webanwendung** an. Trage die KeeCove-Adresse als autorisierten JavaScript-Ursprung ein und setze `CLOUD_GOOGLE_CLIENT_ID`. Der Dateibrowser verwendet `drive.readonly` und Googles direkt im Browser dokumentierten Legacy-Tokenfluss. Für eine externe App im Testmodus füge die zugelassenen Testkonten hinzu. Google kann für eine Veröffentlichung eine Prüfung verlangen. [Google Browser-OAuth](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow) · [Drive-Berechtigungen](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- **Dropbox.** Registriere eine App mit **Scoped access** und **Full Dropbox**, um vorhandene Ordner auswählen zu können. Aktiviere `files.metadata.read`, `files.content.read` und `files.content.write`. Setze den öffentlichen App Key als `CLOUD_DROPBOX_CLIENT_ID`. Ergänze bei einer bestehenden App die Schreibberechtigung und verbinde Dropbox erneut. [Dropbox OAuth](https://docs.dropboxapi.com/dropbox-api/docs/oauth) · [Dropbox-Dateien aktualisieren](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/upload)

Die Anmeldung öffnet ein eigenes Fenster beim Anbieter. KeeCove verwendet nur kurzlebige Zugriffstokens im Browser. Dateien anderer Anbieter kannst du über einen lokal synchronisierten Ordner öffnen.

## Browser-Erweiterung

Öffne in KeeCove die Schaltfläche für deinen Browser. Wenn ein Installationsziel eingerichtet ist, öffnet sie den Store oder in Firefox die signierte XPI. Bestätige die Installation im Browser. Sonst zeigt KeeCove die manuellen Schritte und den passenden Download an. Die ZIP-Pakete stehen auch in den [GitHub-Releases](https://github.com/TerhorstIO/keecove/releases) zur Verfügung.

- **Chrome und Edge.** Entpacke `keecove-browser.zip`. Öffne `chrome://extensions` oder `edge://extensions`, aktiviere den Entwicklermodus und lade den entpackten Ordner. [Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) · [Edge](https://learn.microsoft.com/de-de/microsoft-edge/extensions/getting-started/extension-sideloading)
- **Firefox ab Version 153.** Öffne zum Testen `about:debugging`, wähle **Dieser Firefox** und **Temporäres Add-on laden**. Wähle `keecove-firefox.zip`. Die temporäre Installation endet mit dem nächsten Firefox-Neustart. Für eine dauerhafte Installation muss Mozilla das Paket signieren. [Temporäre Installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) · [Mozilla-Signierung](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)

Trage danach die HTTPS-Adresse deiner KeeCove-Instanz in der Erweiterung ein. KeeCove muss in einem Tab entsperrt sein. Die Erweiterung füllt die Zugangsdaten nach deiner Auswahl und nur auf der passenden Website ein. [Anleitung zur Erweiterung](extension/README.md)

### Installationsziele einrichten

Setze unter `environment` in `compose.yaml` die URLs für deine veröffentlichten Erweiterungen.

- `EXTENSION_CHROME_URL` verweist auf den Eintrag im Chrome Web Store unter `https://chromewebstore.google.com/detail/…`.
- `EXTENSION_EDGE_URL` verweist auf den Eintrag bei Microsoft Edge Add-ons unter `https://microsoftedge.microsoft.com/addons/detail/…`.
- `EXTENSION_FIREFOX_URL` verweist auf den Eintrag bei Mozilla Add-ons oder auf eine öffentlich erreichbare HTTPS-Adresse zu einer von Mozilla signierten `.xpi`. Der Downloadserver muss die XPI als `application/x-xpinstall` ausliefern. [Mozilla-Selbstverteilung](https://extensionworkshop.com/documentation/publish/self-distribution/)

Übernimm die Änderungen mit `docker compose up -d`.

## Lokale Entwicklung

Mit Node.js 24.15 oder neuer:

```sh
npm ci
npm test
npm run build
npm start
```

Beim direkten Node-Start aktiviert das Paar `TLS_CERT_PATH` und `TLS_KEY_PATH` HTTPS. Der Standardport ist 8080.

Für den lokalen Docker-Start über HTTPS erzeuge einmal ein Entwicklungszertifikat mit Node.js und OpenSSL 3. Unter Windows verwendet das Skript auch OpenSSL aus Git for Windows. Die TLS-Dateien liegen unter Windows in `%LOCALAPPDATA%\.keevault\tls`, sonst in `~/.keevault/tls`. Unter Linux kann `user` in `compose.dev.yaml` an den Besitzer des Verzeichnisses angepasst werden.

```sh
npm run tls:cert
docker compose -f compose.yaml -f compose.dev.yaml up --build -d
```

Öffne [https://localhost:8080](https://localhost:8080) und vertraue bei Bedarf dem öffentlichen Entwicklungszertifikat `localhost.crt` lokal.
