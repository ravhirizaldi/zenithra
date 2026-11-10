# Developing Zenithra

[Project overview](README.md) · [API guide](docs/api/README.md) · [Database bootstrap](database/README.md)

## Prerequisites and setup

A fresh clone includes the runtime CSS, JavaScript and images under `public/Content` and `public/Scripts`, plus original database base backups under `database/`. **It is not self-contained:** some compatibility paths still load private installation settings/query XML, and workstation-specific dependencies remain. Manager templates are project-owned EJS; installed Razor/decompiled source is reference-only.

Required:

- Node.js supporting the project’s `node --watch` workflow and pnpm **10.30.3**.
- PostgreSQL 16 with a compatible schema and authorized data. See the [database bootstrap guide](database/README.md) before restoring the supplied backups into new databases.
- Your own legally obtained original installation and required private settings/resources.
- A private `.env` based on [`.env.example`](.env.example), with database access, a strong session secret and your installation’s compatibility keys.

After preparing those prerequisites:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Manager login: `http://127.0.0.1:3000/ConMasManager/Account/LogOn`.

Do not start another server on an occupied port. Sessions, transfer staging and finish deduplication are process-local; restarting can interrupt transfers. Restart durability and orphan cleanup remain unreviewed.

**Schema changes and imports are separate operations.** Review `pnpm db:prepare` and its effects before applying additional Node schema changes. `pnpm import:samples` writes forms/documents and is not a setup shortcut for customer databases. Never reset customer data or public sequences to run tests.

## Architecture

Three application surfaces share selected business helpers and PostgreSQL/file storage—not authentication sessions:

| Application        | Base path        | Boundary                                                                     |
| :----------------- | :--------------- | :--------------------------------------------------------------------------- |
| Manager            | `/ConMasManager` | EJS web interface; own session                                               |
| Native-client REST | `/ConMasWeb`     | Original Designer/Windows/Android/iPad XML and binary protocols; own session |
| Business API       | `/ConMasAPI`     | Separate integration contracts and session; not a native-REST alias          |

```text
src/
  config/         Configuration readers and UI resources
  controllers/    Request handlers
  middleware/     Authentication and request security
  models/         Business logic and persistence
  routes/         Route registration
  services/       Rendering and application services
  shared/         Shared protocol utilities
  views/          Project-owned EJS templates
test/             Layer-specific and integration checks
config/           Native-client and business-API configuration
public/           Original runtime assets and Node-owned branding/styles
database/         Original base SQL backups and provenance
```

Manager MVC stays layer-first: `src/controllers/manager/<menu>/`, `src/models/manager/<menu>/` and `src/views/manager/<menu>/`. `server.ts` starts the listener; `app.ts` composes the applications.

## Storage and rendering

- Library uploads default to `<project root>/SettingFiles/xml/Library/<document_id>`, independently of the installed reference settings and working directory. An explicit `LIBRARY/BASE_FOLDER` database setting overrides it. This directory is Git-ignored; back it up with the active databases.
- Multipart uploads/report staging use Node’s cross-platform `os.tmpdir()`.
- Unicode PDF output may require `PDF_SETTING/FONT_FILE_PATH` on hosts without the installed Windows CJK fonts. PDF audit-trail appendices and unsupported formats still fail explicitly; full visual/font parity remains unverified.
- English UI text lives in `src/config/manager/<area>/resources.ts`, with shared header/navbar resources and a common rendering context. Language switching is not enabled.
- Zenithra Hub’s generated PNG branding lives in `public/branding/`; Node-owned `public/manager-theme.css` supplies the shared header/navigation treatment. Original vendor assets stay unchanged.

## Checks and build behavior

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Database-backed checks need private configuration and may otherwise skip; some checks require excluded original resources/evidence. Use affected isolated fixtures, never customer-data changes. These commands do not establish device acceptance or complete compatibility.

`pnpm build` uses plain TypeScript (`tsc`) to emit readable server JavaScript into `dist/`; tests are excluded. `pnpm start` uses `dist/server.js`. **No additional minification runs on `main`**, including production EJS pages, AJAX fragments and inline JS/CSS. Assets come from `public/`; native/API static allowlists use bundled `public/ConMasWeb/Rests` and `public/ConMasAPI/Rests`, not Windows installation paths. Original vendor `.min.js` files stay unchanged.

The former minified implementation is preserved separately on branch **`minification` at `d365ac6`**. Existing output/running processes change only after a user-managed rebuild/restart. Do not rebuild, restart or replay live requests merely to verify documentation. Manual Edge UAT at 80% zoom and unchanged-client acceptance remain separate from automated fixture checks.
