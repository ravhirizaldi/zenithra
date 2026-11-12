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
- Native `PutLog` output uses private `<project root>/logs/operationLogs/` files, named by a hashed session device identity and local date. Writes require `intervalLog=1` or `IPAD_SETTING/LOG_OUTPUT_MODE=1`, plus an existing native session identity. New directories/files use restrictive permissions; installed log/settings paths stay unchanged. Treat these uploaded client logs as sensitive, back them up or retain them deliberately, and never publish them. This storage is separate from safe request diagnostics.
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

### Focused native migration checks

```sh
pnpm exec tsx --test test/integration/client/definition-preview.test.ts test/integration/client/log.test.ts test/integration/client/library.test.ts test/integration/client/definition-upload.test.ts test/integration/client/reports.test.ts
```

These cover the supplied preview no-op, document browsing/log storage, Designer numbering rules and native transactional saves. Numbering checks use private sequences: PostgreSQL sequence gaps/reset effects can survive rollback, so public/customer sequences must never be used as fixtures. Required cooperation/thumbnail failures must roll back before finish success. Run the shared Manager numbering/content regressions when changing those helpers.

The 12 November publication check passed **158 affected tests across 15 files**, with no failures/skips; it was not the full suite. The existing Manager fixture warning about overlapping `client.query()` calls remains and needs attention before a future `pg@9` upgrade.

The [README coverage counters](README.md#where-it-stands) are a dated, self-contained SVG snapshot, not a live service. When updating them, keep the SVG and [documented ratios/API counts](docs/api/README.md#what-migration-status-means) consistent. Manager route registration, native local paths and business API partial paths are intentionally different measures; never average them into a parity percentage or silently count excluded/unavailable mappings as migrated. Zenithra names the whole application; Zenithra Hub replaces ConMas Manager only.

`pnpm build` uses plain TypeScript (`tsc`) to emit readable server JavaScript into `dist/`; tests are excluded. `pnpm start` uses `dist/server.js`. **No additional minification runs on `main`**, including production EJS pages, AJAX fragments and inline JS/CSS. Assets come from `public/`; native/API static allowlists use bundled `public/ConMasWeb/Rests` and `public/ConMasAPI/Rests`, not Windows installation paths. Original vendor `.min.js` files stay unchanged.

The former minified implementation is preserved separately on branch **`minification` at `d365ac6`**. Existing output/running processes change only after a user-managed rebuild/restart. Do not rebuild, restart or replay live requests merely to verify documentation. Manual Edge UAT at 80% zoom and unchanged-client acceptance remain separate from automated fixture checks.
