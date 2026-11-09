# KeeCove für Chrome, Edge und Firefox

Öffne die Erweiterungsansicht deiner KeeCove-Instanz. Wenn dein Betreiber einen Store-Eintrag hinterlegt hat, führt der Installationslink zur passenden Browser-Erweiterung. Ansonsten findest du dort das ZIP-Paket für deinen Browser.

## Manuelle Installation

### Chrome und Edge

1. Lade `keecove-browser.zip` herunter und entpacke es.
2. Öffne `chrome://extensions` in Chrome oder `edge://extensions` in Edge.
3. Aktiviere den Entwicklermodus und wähle **Entpackte Erweiterung laden**. Wähle den entpackten Ordner mit der `manifest.json`.

[Installation in Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) · [Installation in Edge](https://learn.microsoft.com/de-de/microsoft-edge/extensions/getting-started/extension-sideloading)

### Firefox ab Version 153

1. Lade `keecove-firefox.zip` herunter.
2. Öffne `about:debugging#/runtime/this-firefox` und wähle **Temporäres Add-on laden**.
3. Wähle das ZIP-Paket aus. Firefox lädt es bis zum nächsten Neustart. Für eine dauerhafte Installation brauchst du ein von Mozilla signiertes Add-on.

[Temporäre Installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) · [Signierung und Veröffentlichung](https://extensionworkshop.com/documentation/publish/)

## Erweiterung einrichten

Öffne über das KeeCove-Symbol die **Einstellungen**. Trage die Startadresse deiner eigenen vertrauenswürdigen KeeCove-Instanz ein, etwa `https://vault.example.com`. Für eine lokale Instanz kannst du HTTP über `localhost` oder `127.0.0.1` verwenden. Speichere die Adresse und erlaube den Zugriff auf den KeeCove-Host.

## Anmeldedaten ausfüllen

Öffne und entsperre KeeCove in einem Tab. Wechsle zur Anmeldeseite und klicke auf das KeeCove-Symbol. Die Erweiterung zeigt Einträge, deren KeePass-URL bei Protokoll, Hostname und Port genau mit der Anmeldeseite übereinstimmt. `https://example.com` und `https://login.example.com` sind unterschiedliche Adressen. Wähle den Eintrag, prüfe die eingefügten Daten und sende das Formular selbst ab.

Die Erweiterung unterstützt eindeutige, sichtbare Passwortfelder im Hauptdokument, POST-Formulare mit einem Ziel auf derselben Origin und Felder ohne HTML-Formular. Für andere Formulare kannst du die Zugangsdaten aus dem Vault übernehmen.

## Datenschutz

Die Erweiterung speichert die KeeCove-Adresse lokal als Einstellung. Sie verwendet den entsperrten KeeCove-Tab im selben Browserprofil. Erst wenn du einen Eintrag auswählst, fragt die Erweiterung dessen Passwort ab und übergibt es innerhalb des Browsers an das passende Anmeldeformular. Der Vault, das Masterpasswort und die ausgefüllten Zugangsdaten bleiben außerhalb des Erweiterungsspeichers.
