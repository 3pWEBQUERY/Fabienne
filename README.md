# Für Fabienne

Interaktive Geschichte (mobile-first) mit privatem Antwort-Dashboard.

- `/` – die Geschichte
- `/alexander` – deine Antworten (Passwort = Railway-Variable `ADMIN_PASSWORD`, Benutzername egal)

## Umgebungsvariablen
- `DATABASE_URL` – Postgres (auf Railway: `${{Postgres.DATABASE_URL}}`)
- `ADMIN_PASSWORD` – mind. 8 Zeichen
- `PORT` – optional, Standard 3000

Tabellen werden beim Start automatisch angelegt.
