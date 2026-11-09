export class VaultSourceConflictError extends Error {
  constructor(message = 'Die KDBX-Datei wurde zwischenzeitlich geändert. Lade sie vor dem Speichern neu.', options) {
    super(message, options);
  }
}

export class CloudAuthError extends Error {
  constructor(provider) {
    super(`Die Anmeldung bei ${provider} ist abgelaufen. Verbinde das Konto erneut.`);
  }
}
