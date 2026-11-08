# Keevault für Chrome und Edge

1. Öffne `chrome://extensions` in Chrome oder `edge://extensions` in Edge.
2. Aktiviere den Entwicklermodus und wähle **Entpackte Erweiterung laden**. Wähle den Ordner `extension`, der die `manifest.json` enthält.
3. Öffne über das Keevault-Symbol die **Einstellungen**. Trage die Startadresse deiner Keevault-Instanz ein, etwa `https://vault.example.com`. Für eine lokale Instanz kannst du HTTP über `localhost` oder `127.0.0.1` verwenden. Speichere die Adresse und erlaube den Zugriff auf den Keevault-Host.

[Installation in Chrome](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) · [Installation in Edge](https://learn.microsoft.com/de-de/microsoft-edge/extensions/getting-started/extension-sideloading)

## Anmeldedaten ausfüllen

Öffne und entsperre Keevault in einem Tab. Wechsle zur Anmeldeseite und klicke auf das Keevault-Symbol. Die Erweiterung zeigt Einträge, deren KeePass-URL bei Protokoll, Hostname und Port genau mit der Anmeldeseite übereinstimmt. `https://example.com` und `https://login.example.com` sind unterschiedliche Adressen. Wähle den Eintrag, prüfe die eingefügten Daten und sende das Formular selbst ab.

Die Erweiterung unterstützt eindeutige, sichtbare Passwortfelder im Hauptdokument, POST-Formulare mit einem Ziel auf derselben Origin und Felder ohne HTML-Formular. Für andere Formulare kannst du die Zugangsdaten aus dem Vault übernehmen.

Die Erweiterung speichert die Keevault-Adresse als Einstellung. Für jeden Klick auf einen Eintrag fragt sie das Passwort beim entsperrten Keevault-Tab ab und übergibt es im Browser an das ausgewählte Anmeldeformular. Verwende dafür die Adresse deiner eigenen vertrauenswürdigen Keevault-Instanz.
