<div align="center">

<h1>Zenithra</h1>
<p><strong>Same mission. New machinery. More freedom.</strong></p>
<p>Recreating i-Reporter’s workflows with different code and a different composition.</p>

<p>
  <img alt="Phase: migration" src="https://img.shields.io/badge/phase-migration-2563eb?style=flat-square">
  <img alt="Approach: parity first" src="https://img.shields.io/badge/approach-parity_first-0f766e?style=flat-square">
  <img alt="Release: not production ready" src="https://img.shields.io/badge/release-not_production_ready-b45309?style=flat-square">
</p>

<p><code>Node.js</code> &nbsp; / &nbsp; <code>Strict TypeScript</code> &nbsp; / &nbsp; <code>Express</code> &nbsp; / &nbsp; <code>EJS</code> &nbsp; / &nbsp; <code>PostgreSQL</code></p>

<p><a href="#why-zenithra">Why</a> &nbsp; · &nbsp; <a href="#where-it-stands">Progress</a> &nbsp; · &nbsp; <a href="#what-remains">Remaining work</a> &nbsp; · &nbsp; <a href="docs/api/README.md">API guide</a> &nbsp; · &nbsp; <a href="DEVELOPMENT.md">Development</a></p>

</div>

---

## Why Zenithra?

**A customer’s reporting workflow should not dictate their server operating system.** Zenithra is building a new foundation for familiar forms, reports, approvals and integrations—so customers can eventually run the product on non-Windows servers, including Linux, without losing the workflows they rely on.

The long-term ambition is an independently maintained product, free of CIMTOPS/ConMas runtime dependencies. **That is the destination, not today’s release.** The migration still relies on parts of a legally obtained original installation, private settings/query XML and the compatible database schema. Original clients and bundled assets also remain in use; this repository does not make proprietary components freely licensed.

> **Same goals. Different code. Different composition.** Preserve the experience first; earn the freedom to evolve it next.

## The approach

| 01 / Preserve                                                     | 02 / Recompose                                                        | 03 / Become independent                                                        |
| :---------------------------------------------------------------- | :-------------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| Match workflows, original UI, permissions, errors and saved data. | Replace .NET server behavior with Node.js, TypeScript and PostgreSQL. | Remove remaining platform/vendor dependencies after compatibility is verified. |

Today’s work is **server-side**. Designer, Windows, Android and iPad clients retain their original wire contracts; their application migration has not started. Intentional redesigns come after the compatibility baseline, not instead of it.

## Where it stands

<sub>Recounted 10 November 2026 · Registration and implementation paths, not a completion score</sub>

| Surface                         | Current evidence                                                                 | Remaining boundary                                                                                              |
| :------------------------------ | :------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| **Manager** · `/ConMasManager`  | **270 / 461** source action signatures registered; **91** EJS templates/partials | **191** signatures unregistered; 5 of 11 tabs reachable, none complete                                          |
| **Native REST** · `/ConMasWeb`  | **24 local + 27 partial** mapped commands; 7 local GeneralProcess operations     | **11** mapped commands unimplemented; 1 command scope-excluded; advanced branches remain                        |
| **Business API** · `/ConMasAPI` | **35 partial** mapped commands; 7 partial GeneralProcess operations              | **62** supplied mapped commands unimplemented; 12 additional mappings not supplied by the original installation |

Manager’s baseline spans **17 controllers / 321 distinct action paths**. Native REST has **63** mapped commands; the business API has **109**, of which **97** have supplied targets. Each API has **8** separately counted GeneralProcess operations. Direct-only pages are additional work, not duplicate commands.

Registered routes include blocked shells and explicit unsupported responses. Local paths are not exhaustive compatibility; templates include partials, not just screens. There is **no verified overall completion percentage**.

### Working foundations

- **Documents:** list/detail navigation, Basic and sheet views, input history/downloads, label/permission editors, guarded metadata saves, lifecycle controls and populated PDF previews.
- **Manager tools:** System management/settings, Labels, ordinary Library workflows and CSV Data Output paths.
- **Native clients:** standard form/report transfers, definition update checks, ordinary report copying and master/catalog/library paths. Report finish commits required data transactionally; history/change reasons, initial-input baselines and applicant locks now have isolated regression coverage.
- **Business integrations:** selected account, list/import/master and shared GeneralProcess paths, with separate sessions and contracts.

## What remains

- [ ] **Finish report saves:** numbering, journalizing, binder/pin/deferred work and required output/notification pipelines. Unsupported effects must fail before success.
- [ ] **Complete Documents:** cluster/binary editing, approval/copy/completion, remaining lifecycle effects and PDF audit-trail/layout/font parity.
- [ ] **Close Manager gaps:** remaining System, Labels, Library and Data Output branches, permissions/licensing, locale and original-screen parity. Six other tabs remain blocked.
- [ ] **Finish supplied APIs:** remaining mapped/direct handlers, newest-revision copying, merged PDF, authentication continuations and cross-device compatibility.
- [ ] **Prove portability and independence:** replace remaining installation-specific runtime dependencies and verify non-Windows deployment; rebuild client applications as separate future work.
- [ ] **Accept the real experience:** manual UI and unchanged-device testing across complete workflows, not just successful requests.

Scope excludes AD/MEID authentication/provider continuations and Manager’s External system linkage settings subtree. Shared user/device/license and MeID management, optional PDF license upload and native GetEdgeOCRCertificate remain in scope. Proven vendor-unsupplied features are tracked separately, never counted as completed.

> **Not a drop-in replacement yet.** Passing tests, HTTP 200 responses and one working device workflow do not establish full behavior, visual parity or production readiness.

## Explore

| Start here                                        | What you’ll find                                                        |
| :------------------------------------------------ | :---------------------------------------------------------------------- |
| [Development](DEVELOPMENT.md)                     | Prerequisites, setup, architecture, storage and verification boundaries |
| [API guide](docs/api/README.md)                   | Application boundaries, sessions and protocol conventions               |
| [Native-client REST](docs/api/native-rest.md)     | Original Designer/device command paths and current limits               |
| [Business API / WebAPI](docs/api/business-api.md) | Separate integration commands and unfinished branches                   |
| [Database bootstrap](database/README.md)          | Original base backups, provenance and safe preparation                  |

---

<sub>Zenithra is an independent project, not an official CIMTOPS/i-Reporter release. Included original assets and base database files retain their licensing terms. Vendor executables, licenses, decompiled sources, private evidence, credentials and live customer data stay local and Git-ignored. Use only installations and data you are authorized to access.</sub>
