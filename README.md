<div align="center">

<img src=".github/assets/zenithra-mark.png" alt="Zenithra Z logo" width="96" height="96">

<h1>Zenithra</h1>
<p><strong>Same mission. New machinery. More freedom.</strong></p>
<p>Rebuilding i-Reporter’s server workflows for a more portable future—without changing the clients.</p>

<p>
  <img alt="Phase: migration" src="https://img.shields.io/badge/phase-migration-2563eb?style=flat-square">
  <img alt="Release: not production ready" src="https://img.shields.io/badge/release-not_production_ready-b45309?style=flat-square">
</p>

<p><code>Node.js</code> &nbsp; / &nbsp; <code>Strict TypeScript</code> &nbsp; / &nbsp; <code>Express</code> &nbsp; / &nbsp; <code>EJS</code> &nbsp; / &nbsp; <code>PostgreSQL</code></p>

<p><a href="#where-it-stands">Progress</a> &nbsp; · &nbsp; <a href="#code-graph">Code graph</a> &nbsp; · &nbsp; <a href="#what-remains">Next milestones</a> &nbsp; · &nbsp; <a href="docs/api/README.md">API guide</a> &nbsp; · &nbsp; <a href="DEVELOPMENT.md">Development</a></p>

</div>

---

## Where it stands

![Migration coverage: Zenithra Hub (ConMasManager) 60% registered routes; ConMasWeb / Rests 44% local paths; ConMasAPI / Rests 36% partial paths. Not feature-completion percentages.](.github/assets/migration-progress.svg)

<sub>12 November 2026 · Different coverage measures, not overall completion. <a href="docs/api/README.md#what-migration-status-means">Counting rules and detailed status →</a></sub>

### Latest progress

- **Zenithra Hub** — the ConMas Manager replacement: Documents list/detail, Basic and sheet edits, completion, approval and revision-copy paths; System, Labels, Library and Data Output are reachable but incomplete.
- **Native saves** — transactional report persistence and Designer-defined automatic numbering, including generated names, read-only fields and applicable thumbnails.
- **Native commands** — document browsing/search (`GetDocumentList`) and private client-log uploads (`PutLog`). `GetDefinitionPreview` matches the supplied empty-response placeholder; it does not generate previews.
- **Business integrations** — 35 mapped commands have partial paths, with separate authentication from native clients and Hub.

**Latest implementation checks:** 158 affected tests passed; typecheck, targeted lint/format and documentation integrity passed. [Verification details →](DEVELOPMENT.md#focused-native-migration-checks)

## Code graph

```mermaid
flowchart TD
    entry["server.ts → app.ts<br/>Express composition"]
    entry --> hub["Zenithra Hub<br/>ConMasManager · routes/manager/"]
    entry --> native["Native REST<br/>ConMasWeb · routes/client.ts"]
    entry --> api["Business integrations<br/>ConMasAPI · routes/api.ts"]
    hub --> views["EJS interface<br/>src/views/manager/"]
    hub --> logic["Controllers + models<br/>src/controllers/ · src/models/"]
    native --> logic
    api --> logic
    logic --> database[("PostgreSQL")]
    logic --> files["Private file storage"]

    classDef core fill:#332b29,color:#ffffff,stroke:#332b29
    classDef hub fill:#743b4a,color:#ffffff,stroke:#743b4a
    classDef native fill:#35665d,color:#ffffff,stroke:#35665d
    classDef api fill:#936129,color:#ffffff,stroke:#936129
    class entry core
    class hub hub
    class native native
    class api api
```

Zenithra contains all three applications. Each has its own session; selected business helpers and persistence are shared.

## What remains

- [ ] **Finish native dependencies:** binder/journalizing, pin/deferred generation, remaining numbering, output and notifications; close 13 missing native entry points.
- [ ] **Complete Hub workflows:** remaining Documents edits/exports, Manager branches and original-screen parity. Six other tabs remain blocked.
- [ ] **Expand business API coverage:** finish partial paths and the remaining supplied commands.
- [ ] **Prove portability and compatibility:** reduce installation dependencies and verify complete workflows with unchanged Designer, Windows, Android and iPad clients.

> **Still a migration, not a production-ready drop-in replacement.** Required unsupported save effects fail before success; original-installation dependencies and real-client acceptance remain.

## Explore

[Development](DEVELOPMENT.md) · [Native REST](docs/api/native-rest.md) · [Business API](docs/api/business-api.md) · [Database setup](database/README.md)

---

<sub>Zenithra is an independent project, not an official CIMTOPS/i-Reporter release. Included original assets and base database files retain their licensing terms. Vendor executables, licenses, decompiled sources, private evidence, credentials and live customer data stay local and Git-ignored. Use only installations and data you are authorized to access.</sub>
