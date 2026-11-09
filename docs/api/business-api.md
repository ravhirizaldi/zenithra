# Business API / WebAPI

[API guide](README.md) · [Native-client REST](native-rest.md) · [Project overview](../../README.md)

Base path: **`/ConMasAPI`**. This is a separate application from `/ConMasWeb` and Manager, with its own session, login checks, configuration and command contracts.

## URL forms

```text
Dispatcher: /ConMasAPI/Rests/APIExecute.aspx?command=GetUser&type=xml
Direct:     /ConMasAPI/Rests/GetUser.aspx?type=xml
Generic:    /ConMasAPI/Rests/GeneralProcess.aspx?target=Library&process=DocumentList
Alias:      /ConMasAPI/Rests/APIExecute.aspx?command=WebAPI&target=Library&process=DocumentList
```

**`WebAPI` maps to `GeneralProcess.aspx`**, not `WebAPI.aspx`. Other commands listed below map to their same-name direct pages. A native command's implementation does not imply a working ConMasAPI equivalent.

All **35 mapped commands listed here are partial**, not complete parity. The `Request` column gives documented calling conventions, not an exhaustive verb allowlist; see the [shared method/session notes](README.md#requests-and-sessions).

## Login and API identity

```http
POST /ConMasAPI/Rests/Login.aspx HTTP/1.1
Content-Type: application/x-www-form-urlencoded

user=YOUR_USER&password=YOUR_PASSWORD
```

These are placeholders, not sample credentials. Preserve the returned **API-scoped** session cookie. Manager/native cookies are not substitutes. Login requires the applicable API/alternate entitlement and `role_api_execute`; there is no invented administrator bypass or native terminal-approval requirement.

Inspect **all** returned `loginResult` elements. Password expiry can produce an additional failure after another result, and an HTTP 200 or initial zero code alone is insufficient. API password-storage behavior differs from native/Manager authentication.

The current ordinary dispatcher path uses `executeType=1`. General-command `executeType=0`, token-licensing checks, independent FollowLogin and other-use branches remain unfinished. AD/MEID authentication is excluded; standard account security remains in scope.

## Account commands — 2 partial

| Command | Direct URL                     | Request   | Local path                                                         |
| :------ | :----------------------------- | :-------- | :----------------------------------------------------------------- |
| Login   | `/ConMasAPI/Rests/Login.aspx`  | POST form | Standard API identity, licensing, roles, lock/expiry checks.       |
| Logout  | `/ConMasAPI/Rests/Logout.aspx` | POST      | Destroy API identity/session and retain applicable audit behavior. |

## List/export commands — 14 partial

Use **`type=xml` or `type=csv`**. CSV supports code pages **932** and **65001**; unsupported numeric encodings fail explicitly, while omitted/invalid values follow the configured fallback where available. XML/CSV ordering, locale and permission branches are not exhaustively accepted.

| Command                  | Direct URL                                       | Request  | Data / important options                                              |
| :----------------------- | :----------------------------------------------- | :------- | :-------------------------------------------------------------------- |
| GetCommon                | `/ConMasAPI/Rests/GetCommon.aspx`                | GET/POST | Common master/settings export.                                        |
| GetUser                  | `/ConMasAPI/Rests/GetUser.aspx`                  | GET/POST | `withAdmin`, `withImprint`, `userId`.                                 |
| GetGroup                 | `/ConMasAPI/Rests/GetGroup.aspx`                 | GET/POST | Group export.                                                         |
| GetGroupAffiliation      | `/ConMasAPI/Rests/GetGroupAffiliation.aspx`      | GET/POST | User/group memberships.                                               |
| GetTerminal              | `/ConMasAPI/Rests/GetTerminal.aspx`              | GET/POST | `deleted` filtering.                                                  |
| GetUserMeId              | `/ConMasAPI/Rests/GetUserMeId.aspx`              | GET/POST | MeID account mapping, not MeID authentication.                        |
| GetDefinitionRole        | `/ConMasAPI/Rests/GetDefinitionRole.aspx`        | GET/POST | Definition roles.                                                     |
| GetReportRole            | `/ConMasAPI/Rests/GetReportRole.aspx`            | GET/POST | Report roles.                                                         |
| GetDefinitionReference   | `/ConMasAPI/Rests/GetDefinitionReference.aspx`   | GET/POST | Definition references.                                                |
| GetReportReference       | `/ConMasAPI/Rests/GetReportReference.aspx`       | GET/POST | Report references.                                                    |
| GetReportLabelDefinition | `/ConMasAPI/Rests/GetReportLabelDefinition.aspx` | GET/POST | Definition/report-label relationships.                                |
| GetDefinitionLabelMaster | `/ConMasAPI/Rests/GetDefinitionLabelMaster.aspx` | GET/POST | Optional `useAuth=0` or `1`; supplied values must be valid.           |
| GetReportLabelMaster     | `/ConMasAPI/Rests/GetReportLabelMaster.aspx`     | GET/POST | Optional `useAuth=0` or `1`; supplied values must be valid.           |
| GetReference             | `/ConMasAPI/Rests/GetReference.aspx`             | GET/POST | Configured reference-file metadata; symlink traversal is not exposed. |

Example read after an API login:

```text
GET /ConMasAPI/Rests/GetUser.aspx?type=xml&withAdmin=0
```

## Import/write commands — 14 partial

**These requests mutate data.** Use POST multipart with the original XML/CSV schema, not arbitrary JSON. Except `RegistReference`, imports require `type=xml|csv` and the first multipart file; CSV encoding rules above apply. Preserve returned per-row codes, not just the outer HTTP result.

| Command                     | Direct URL                                          | Request        | Local path / important boundary                                       |
| :-------------------------- | :-------------------------------------------------- | :------------- | :-------------------------------------------------------------------- |
| RegistCommon                | `/ConMasAPI/Rests/RegistCommon.aspx`                | POST multipart | Common rows.                                                          |
| RegistUserMeId              | `/ConMasAPI/Rests/RegistUserMeId.aspx`              | POST multipart | Nonempty MeID account-mapping import, not authentication.             |
| RegistGroupAffiliation      | `/ConMasAPI/Rests/RegistGroupAffiliation.aspx`      | POST multipart | Membership rows and API-tagged audit.                                 |
| RegistDefinitionRole        | `/ConMasAPI/Rests/RegistDefinitionRole.aspx`        | POST multipart | Definition/report role mode/target options apply.                     |
| RegistReportRole            | `/ConMasAPI/Rests/RegistReportRole.aspx`            | POST multipart | Report-role rows.                                                     |
| RegistDefinitionReference   | `/ConMasAPI/Rests/RegistDefinitionReference.aspx`   | POST multipart | Definition-reference rows.                                            |
| RegistReportReference       | `/ConMasAPI/Rests/RegistReportReference.aspx`       | POST multipart | Report-reference rows.                                                |
| RegistDefinitionLabel       | `/ConMasAPI/Rests/RegistDefinitionLabel.aspx`       | POST multipart | Definition label links.                                               |
| RegistReportLabelDefinition | `/ConMasAPI/Rests/RegistReportLabelDefinition.aspx` | POST multipart | Report-label/definition links.                                        |
| RegistReportLabel           | `/ConMasAPI/Rests/RegistReportLabel.aspx`           | POST multipart | Report label links.                                                   |
| RegistDefinitionLabelMaster | `/ConMasAPI/Rests/RegistDefinitionLabelMaster.aspx` | POST multipart | Definition-label master hierarchy.                                    |
| RegistReportLabelMaster     | `/ConMasAPI/Rests/RegistReportLabelMaster.aspx`     | POST multipart | Numeric-ID mode only; configured system-key mode fails before writes. |
| UpdateSelectItem            | `/ConMasAPI/Rests/UpdateSelectItem.aspx`            | POST multipart | Selection items; original `force` option applies.                     |
| RegistReference             | `/ConMasAPI/Rests/RegistReference.aspx`             | POST multipart | Upload reference files; each nonempty file is processed sequentially. |

Imports preserve their own row/transaction rules; they are **not one universal atomic batch**. In particular, earlier `RegistReference` files can remain if a later file fails. User/group creation commands are not implemented merely because Manager CRUD exists.

The API multipart request limit is **160,000,000 bytes** in the current configuration, separate from the native API's limit. Large-upload acceptance is not established by this limit.

## Master commands — 4 partial

| Command              | Direct URL                                   | Request  | Local path                                           |
| :------------------- | :------------------------------------------- | :------- | :--------------------------------------------------- |
| GetMasterList        | `/ConMasAPI/Rests/GetMasterList.aspx`        | GET/POST | Master metadata/defaults/attachments and filters.    |
| GetCustomMasterLabel | `/ConMasAPI/Rests/GetCustomMasterLabel.aspx` | GET/POST | Master label metadata.                               |
| GetMasterRecordList  | `/ConMasAPI/Rests/GetMasterRecordList.aspx`  | GET/POST | Records/paging/deltas/row roles.                     |
| GetMasterImage       | `/ConMasAPI/Rests/GetMasterImage.aspx`       | GET/POST | Image binary with original data/schema dependencies. |

These share selected business logic with native REST, but retain API identity and behavior; native terminal approval and native-only caps are not added. Original parameters include `masterType`, `masterId`, `masterKey`, `defTopId`, `repTopId`, `recordId`, `recordKey`, `fieldNo`, `fieldSearch`, `startNo`, `max`, `recordVersion`, `isColumn`, `isDeleteTran`, `lastDownloadTime` and `ignoreExpire`, as applicable to each command. Full locale/consumer synchronization parity remains open.

## WebAPI / GeneralProcess — 1 partial mapped command, 7 partial operations

Mapped command **`WebAPI`** is the 35th partial command. Use the direct URLs below or `/ConMasAPI/Rests/APIExecute.aspx?command=WebAPI` with the same `target`/`process` parameters. Names are case-sensitive. Authenticate with the API session; do not substitute a native session.

| Exact direct URL selection                                                           | Request             | Local path                                               |
| :----------------------------------------------------------------------------------- | :------------------ | :------------------------------------------------------- |
| `/ConMasAPI/Rests/GeneralProcess.aspx?target=System&process=LicenseStatusInquiry`    | GET/POST            | `item=ConMasIoTGateway`; system role/entitlement checks. |
| `/ConMasAPI/Rests/GeneralProcess.aspx?target=InputReport&process=TopDetailInquiry`   | GET/POST            | `repTopId` and `items`; report-top inquiry.              |
| `/ConMasAPI/Rests/GeneralProcess.aspx?target=Library&process=DocumentList`           | GET/POST            | Authorized library list.                                 |
| `/ConMasAPI/Rests/GeneralProcess.aspx?target=Library&process=DocumentDownload`       | GET/POST            | Authorized document download.                            |
| `/ConMasAPI/Rests/GeneralProcess.aspx?target=Library&process=DocumentDeletion`       | POST                | Delete library document rows/files.                      |
| `/ConMasAPI/Rests/GeneralProcess.aspx?target=Library&process=DocumentRegistration`   | POST multipart/form | Register a library file/URL using the shared workflow.   |
| `/ConMasAPI/Rests/GeneralProcess.aspx?target=Schedule&process=ReportListForDownload` | GET/POST            | Assigned scheduled auto-download reports.                |

The generic Library registration path is **not** the separate unimplemented `RegistDocument` or `RegistDocumentMaster` mapped command. The eighth operation, `target=InputReport&process=DownloadMergedPdf`, is unimplemented. Shared model tests are not independent acceptance of every API-host branch. Shared file registration/deletion also retains late-failure filesystem rollback limits.

## What is not migrated

Of **109 mappings**, **97 targets were supplied** by the original installation: 35 have partial paths above and **62 remain unimplemented**. Examples of recognized-but-unimplemented direct URLs include:

```text
/ConMasAPI/Rests/GetDefinitionList.aspx
/ConMasAPI/Rests/GetReportList.aspx
/ConMasAPI/Rests/RegistUser.aspx
/ConMasAPI/Rests/RegistGroup.aspx
/ConMasAPI/Rests/RegistDocument.aspx
/ConMasAPI/Rests/CopyReport.aspx
/ConMasAPI/Rests/GetDocumentInfo.aspx
```

Do not infer business API support from same-named native/Manager behavior. There are also **11 unfinished direct-only business pages**, including independent FollowLogin; the dispatcher is not a business operation.

**Twelve unavailable mapping targets** are retained for traceability, not counted as migrated: `GetUserInfo`, `RegistTerminal`, `ApprovalTerminal`, `GetDefinitionPreview`, `MakeReportFromDefinitionTop`, `GetReportDataTop`, `MakeReportFromDefinitionSheet`, `GetReportDataSheet`, `RegistReportTop`, `RegistReportSheet`, `RegistReportFinish`, `RegistDocumentMaster`.

Deployed-but-unresolved source classes remain unknown—not proven unavailable. For example, this API's `GetDocumentInfo` is not a safe alias for the native implementation.

## Original static pages

`/ConMasAPI/Rests/Error.htm`, `/ConMasAPI/Rests/Test/Test.htm` and `/ConMasAPI/Rests/Test/js/jquery-1.7.1.min.js` are served byte-for-byte for GET/HEAD from verified original copies under `public/ConMasAPI/Rests` in every environment, including production. These static pages no longer require a Windows installation path, and their existing allowlist/security checks remain. The test forms can mutate data and are neither a new console nor an exhaustive support matrix.

## Public source

[Routes](../../src/routes/api.ts) · [Command configuration](../../config/api.xml) · [Account](../../src/controllers/api-account.ts) · [Data/imports](../../src/controllers/api-data.ts) · [List models](../../src/models/api-data.ts) · [GeneralProcess](../../src/controllers/client-general.ts)
