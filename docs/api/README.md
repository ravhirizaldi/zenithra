# Zenithra API guide

[Project overview](../../README.md) · [Native-client REST](native-rest.md) · [Business API / WebAPI](business-api.md)

Public migration snapshot: **12 November 2026**. Zenithra preserves the original ASPX-style protocols while replacing server behavior with Node.js. These are **not JSON REST endpoints**, and no `/api/v1` prefix is introduced.

## Choose the correct application

| Application           | Dispatcher                                           | Purpose                              | Current mapped-command status                                 |
| :-------------------- | :--------------------------------------------------- | :----------------------------------- | :------------------------------------------------------------ |
| Native-client REST    | `/ConMasWeb/Rests/ConMasIReporter.aspx?command=NAME` | Existing Designer and device clients | 27 local paths, 27 partial, 8 unimplemented, 1 scope-excluded |
| Business API / WebAPI | `/ConMasAPI/Rests/APIExecute.aspx?command=NAME`      | Business integrations                | 35 partial, 62 unimplemented, 12 unavailable mapping targets  |
| Manager               | `/ConMasManager`                                     | Browser management interface         | Separate web UI; not an alias for either API                  |

Prepend your configured server origin to the paths in these guides. They are **path examples**, not links to an externally hosted Zenithra service. A same-named command in two applications can have different behavior or be migrated in only one of them.

## What migration status means

| Label              | Meaning                                                                                                                          |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------- |
| **Local path**     | A locally implemented behavior is present. Complete feature, permission, licensing, locale and device parity is not established. |
| **Partial**        | Some request branches work; other modes or required side effects remain unsupported.                                             |
| **Unimplemented**  | The name may be recognized, but the requested business behavior is not migrated.                                                 |
| **Unavailable**    | The mapping target was not supplied by the original installation; it is not counted as implemented.                              |
| **Scope-excluded** | Intentionally outside the migration scope, not an implemented command.                                                           |

The native guide lists **all 54 mapped commands with local/partial paths**; the business guide lists **all 35 partial mapped commands**. Native local paths include `GetDefinitionPreview`, whose supplied behavior is an authenticated **empty response**, not preview generation. GeneralProcess operations and direct-only diagnostics are separate from those command totals.

The [README counters](../../README.md#where-it-stands) use rounded, explicitly different measures: Manager registration **276/461 ≈60%**, native local paths **27/62 ≈44%** after one scope exclusion, and business API partial paths **35/97 ≈36%** after 12 unavailable mappings. None measures full behavior, visual parity or production readiness. Native still has **13 missing entries**: eight mapped commands, four additional handlers and one GeneralProcess operation, plus remaining branches in 27 partial commands.

## Requests and sessions

- Keep the original command and parameter spelling. Command names and GeneralProcess `target`/`process` selections are case-sensitive; ASPX page lookup is case-insensitive.
- Use query parameters for reads, URL-encoded form fields for login/scalar writes, and `multipart/form-data` for uploads. JSON request bodies are not the documented protocol.
- Query and form scalar values are combined; avoid supplying the same parameter in both places.
- Log in separately to each application and preserve its cookies. Both use `ASP.NET_SessionId`, scoped to their own base paths. Manager authentication does not authenticate either API.
- The tables give **documented calling conventions**, not an exhaustive HTTP verb allowlist. Several legacy-compatible handlers accept more verbs than listed. Use **POST for state changes** and keep credentials out of URLs.
- Cross-site browser requests are rejected by Origin/Fetch Metadata checks. These APIs do not use Manager's CSRF token or automatically redirect to its login page.
- Accounts, roles, terminal approval, licenses and request-specific validation still apply. A listed path is not permission to bypass them.

## Responses and successful persistence

Responses are usually XML (`text/xml`), CSV or binary data, depending on the operation. Preserve the actual response MIME contract: successful image/file responses are not necessarily XML.

**HTTP 200 is not proof of success.** Inspect the XML result code, every login result and every import-row result. Errors can be returned in XML at HTTP 200. Known unfinished paths or modes can return HTTP 501; unknown routes/commands and authorization failures have their own protocol responses.

For staged native report uploads, top/sheet acknowledgements are not durable saves. Only a successful **RegistReportFinish** after the required transaction commits indicates a completed save. Some client success callbacks can delete the local report: never treat a staging response as permission to discard it.

## Safe use

- These guides are not a test console. Do not replay examples against customer data to verify the documentation.
- Registration, import, deletion, unlock and approval-related requests can mutate data. Use authorized isolated fixtures for development.
- Do not publish real credentials, cookies, license material, customer payloads or database exports in examples or bug reports.
- Sessions and staged transfers are process-local. Restarts can interrupt unfinished work.
- AD/MEID authentication is scope-excluded. MeID account/settings management remains a separate in-scope feature.

## Source references

The public descriptions are checked against the Node dispatch/configuration and reviewed migration inventories; private evidence is not bundled here.

- [Native routes](../../src/routes/client.ts) and [command configuration](../../config/client.xml).
- [Business API routes](../../src/routes/api.ts) and [command configuration](../../config/api.xml).
- [Shared GeneralProcess controller](../../src/controllers/client-general.ts).

No live-server, browser or original-device acceptance is implied by this documentation snapshot.
