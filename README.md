# Zenithra

**An in-progress migration of i-Reporter’s .NET server applications to a new Node.js application stack.**

Zenithra uses strict TypeScript, Express, EJS and PostgreSQL. The current phase is **migration and compatibility—not a frontend redesign**. The goal is to reproduce the original application's default behavior before making intentional visual or functional changes.

## Parity first

During migration, the original installation is the reference for:

- Default behavior, validation, permissions, licensing gates and error responses.
- Existing URLs, sessions and Designer/device API contracts.
- Database effects, transactions, report revisions and file transfers.
- UI layout, JavaScript behavior, CSS, icons, images, headers and menus.

Frontend redesigns and other deliberate departures come **after parity has been verified**, not as shortcuts around missing migration work. Existing clients should not need to change to accommodate the new server.

## Status: migration in progress

**Zenithra is incomplete and is not a production-ready or drop-in replacement.** Some workflows are implemented, some are partial, and others explicitly return unsupported responses. Approval, report copying, parts of Documents details and other feature branches remain unfinished. Passing tests, registered routes and HTTP 200 responses do not establish full compatibility or visual acceptance.

The migration covers three separate application surfaces:

| Surface            | Base path        | Purpose                                    |
| ------------------ | ---------------- | ------------------------------------------ |
| Manager            | `/ConMasManager` | Web interface for management and documents |
| Native-client REST | `/ConMasWeb`     | Designer and device communication          |
| Business API       | `/ConMasAPI`     | Separate business API contracts            |

Each surface retains its own session and protocol boundaries. Documents Index is the current Manager priority; System, Labels, Library and Data Output also have ongoing migration work. Other Manager tabs are not automatically enabled.

## What this public repository includes

The Node/TypeScript migration implementation, EJS views, application configuration, dependency lockfile and tests.

**Not included:** original vendor JavaScript/CSS/images, installed binaries and licenses, decompiled .NET projects, reverse-engineering evidence, private migration notes, database backups, customer data, logs or credentials. These remain local and Git-ignored. Compatibility code still reads some resources, query XML and views from a privately supplied original installation, so a fresh clone is **not self-contained**.

Use only an installation and data you are authorized to access. Publishing Zenithra does not grant redistribution rights to i-Reporter or its proprietary components. This is an independent migration project, not an official vendor release.

## Development prerequisites

- Node.js with support for the project's `node --watch` workflow.
- pnpm **10.30.3**, as pinned in `package.json`.
- PostgreSQL with a compatible, separately prepared schema and authorized data.
- Your own legally obtained original installation and required local reference resources/assets. Several source paths still reflect the migration workstation and are not portable yet.
- A private `.env` based on [`.env.example`](.env.example), including database access, a strong session secret and the compatibility keys required by your installation.

Do not commit real environment values, licenses or database exports. Original Manager assets belong in the ignored `public/Content/` and `public/Scripts/` directories only when you have the right to use them locally.

After the private prerequisites have been prepared:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Manager login: `http://127.0.0.1:3000/ConMasManager/Account/LogOn`.

Do not start a second server on an occupied port. Sessions and transfer staging currently live in process memory; restarting can interrupt unfinished transfers.

**Database preparation is not automatic.** Review the effects of `pnpm db:prepare` before using it. `pnpm import:samples` writes sample forms and documents; it is not a safe setup shortcut for an existing customer database. There is no clean-install database bootstrap provided by this public snapshot.

## Project structure

```text
src/
  config/         Application configuration readers
  controllers/    Request handlers
  middleware/     Authentication, security and request handling
  models/         Business logic and persistence
  routes/         Route registration
  services/       Rendering and application services
  shared/         Shared protocol and utility code
views/            EJS templates
test/             Unit checks and isolated integration fixtures
config/           Native-client and business-API configuration
```

Manager MVC layers stay separate: `src/controllers/manager/<menu>/`, `src/models/manager/<menu>/` and `views/manager/<menu>/`. Tests mirror the layers; cross-layer workflows belong under `test/integration/`.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Database-backed tests need private local configuration and may otherwise skip. Some tests also require the excluded original resources. Use isolated fixtures; never use customer-data changes as verification. The current UI acceptance target is manual Microsoft Edge testing at 80% zoom.

`pnpm build` emits production JavaScript to `dist/`; tests are not included in that output. A successful build is not proof of behavioral parity. Do not rebuild, restart or replay requests against a running migration environment merely to verify documentation or publishing changes.

## Diagnostics

The **ZENITHRA SERVER** terminal shows real request activity. Keys **1–4** select All/Manager/Windows/API; **E** filters errors; arrows and PgUp/PgDn scroll; **End** resumes live follow. **Credit: NaVhi** stays in the footer.

Safe request diagnostics are stored locally under `logs/`. Inspect protocol result codes and committed transfer state—not HTTP status alone. Credentials, raw sessions, request bodies and customer file contents must not be logged or published.
