# Native-client REST

[API guide](README.md) · [Business API](business-api.md) · [Project overview](../../README.md)

Base path: **`/ConMasWeb`**. This surface serves the original Designer, Windows, Android and iPad protocols. Server compatibility work does not migrate those client applications.

## URL forms

```text
Dispatcher: /ConMasWeb/Rests/ConMasIReporter.aspx?command=GetDefinitionList
Direct:     /ConMasWeb/Rests/GetDefinitionList.aspx
Generic:    /ConMasWeb/Rests/GeneralProcess.aspx?target=Library&process=DocumentList
```

Each mapped command below supports the dispatcher form with its exact command name and the listed same-name direct page. **GeneralProcess is direct-only**, not `command=GeneralProcess`.

The documented `Request` column is a calling convention; see the [method and session notes](README.md#requests-and-sessions). Reads generally accept GET/form POST. Use POST for writes, even where a legacy-compatible handler does not enforce it.

## Login and native identity

Standard login uses URL-encoded form data, not a JSON body:

```http
POST /ConMasWeb/Rests/Login.aspx HTTP/1.1
Content-Type: application/x-www-form-urlencoded

user=YOUR_USER&password=YOUR_PASSWORD&client=iPad&platform=Windows&terminalId=YOUR_TERMINAL_ID&version=YOUR_CLIENT_VERSION&encrypted=0
```

The values above are placeholders. Windows uses **`client=iPad&platform=Windows`**, not `client=Windows`; Designer uses `client=Designer` with its own identity/version fields. Preserve the returned native session cookie and inspect the login result, including version and terminal registration/approval outcomes.

Most commands require an authenticated, approved terminal; `DownloadReportList`, `PickOutReportTopData` and GeneralProcess have separate rules. `GetAuthenticationType` handles standard discovery without a login. Login/password/settings branches are incomplete; new-password login requests remain unsupported. AD/MEID authentication is excluded.

## Mapped commands with local paths — 23

“Local” is not a full-parity or all-device acceptance claim. Additional branch/permission/licensing work can remain.

| Command                    | Direct URL                                         | Request  | Local behavior                                                           |
| :------------------------- | :------------------------------------------------- | :------- | :----------------------------------------------------------------------- |
| Logout                     | `/ConMasWeb/Rests/Logout.aspx`                     | POST     | Clear native identity/session.                                           |
| ApprovalTerminal           | `/ConMasWeb/Rests/ApprovalTerminal.aspx`           | POST     | Terminal approval path with its existing gates.                          |
| UnlockReport               | `/ConMasWeb/Rests/UnlockReport.aspx`               | POST     | Report unlock.                                                           |
| GetSheetBackgroundImage    | `/ConMasWeb/Rests/GetSheetBackgroundImage.aspx`    | GET/POST | Stored sheet background image.                                           |
| GetLocalReferenceList      | `/ConMasWeb/Rests/GetLocalReferenceList.aspx`      | GET/POST | Accessible library/reference metadata.                                   |
| GetLocalReference          | `/ConMasWeb/Rests/GetLocalReference.aspx`          | GET/POST | Authorized reference binary/preview.                                     |
| GetCalendarList            | `/ConMasWeb/Rests/GetCalendarList.aspx`            | GET/POST | Calendar/schedule metadata.                                              |
| GetCustomMasterLabel       | `/ConMasWeb/Rests/GetCustomMasterLabel.aspx`       | GET/POST | Custom-master label metadata.                                            |
| GetLicense                 | `/ConMasWeb/Rests/GetLicense.aspx`                 | GET/POST | Effective encrypted license download.                                    |
| GetUser                    | `/ConMasWeb/Rests/GetUser.aspx`                    | GET/POST | User export with original options.                                       |
| GetCustomMenuSettings      | `/ConMasWeb/Rests/GetCustomMenuSettings.aspx`      | GET/POST | Menu ZIP/settings.                                                       |
| GetMessageImage            | `/ConMasWeb/Rests/GetMessageImage.aspx`            | GET/POST | Message image binary.                                                    |
| GetVoiceGrammar            | `/ConMasWeb/Rests/GetVoiceGrammar.aspx`            | GET/POST | Definition/report voice grammar with license gates.                      |
| GetVoiceCommonGrammar      | `/ConMasWeb/Rests/GetVoiceCommonGrammar.aspx`      | GET/POST | Common voice grammar.                                                    |
| GetCustomMultiMenuSettings | `/ConMasWeb/Rests/GetCustomMultiMenuSettings.aspx` | GET/POST | Multi-menu ZIP/settings.                                                 |
| DownloadReportList         | `/ConMasWeb/Rests/DownloadReportList.aspx`         | GET/POST | Assigned auto-download report list.                                      |
| PickOutReportTopData       | `/ConMasWeb/Rests/PickOutReportTopData.aspx`       | GET/POST | Report-top inquiry with selected properties.                             |
| GetDesignerInstallerUrl    | `/ConMasWeb/Rests/GetDesignerInstallerUrl.aspx`    | GET/POST | Installer URL lookup; does not migrate Designer.                         |
| RemoveTerminal             | `/ConMasWeb/Rests/RemoveTerminal.aspx`             | POST     | Session terminal removal path.                                           |
| UnlockDocument             | `/ConMasWeb/Rests/UnlockDocument.aspx`             | POST     | Library/document unlock.                                                 |
| GetDocumentInfo            | `/ConMasWeb/Rests/GetDocumentInfo.aspx`            | GET/POST | Common/image/FreeDraw document metadata.                                 |
| IdentifyApprover           | `/ConMasWeb/Rests/IdentifyApprover.aspx`           | POST     | Approver identification check, not a complete Manager approval workflow. |
| GetAuthenticationType      | `/ConMasWeb/Rests/GetAuthenticationType.aspx`      | GET/POST | Standard authentication discovery.                                       |

## Partially migrated mapped commands — 27

| Command                       | Direct URL                                            | Request        | Working family / important boundary                                                    |
| :---------------------------- | :---------------------------------------------------- | :------------- | :------------------------------------------------------------------------------------- |
| Login                         | `/ConMasWeb/Rests/Login.aspx`                         | POST           | Standard account/version/terminal path; password-change and other branches unfinished. |
| GetUserInfo                   | `/ConMasWeb/Rests/GetUserInfo.aspx`                   | GET/POST       | Native session user metadata.                                                          |
| RegistTerminal                | `/ConMasWeb/Rests/RegistTerminal.aspx`                | POST           | Terminal registration; full notification/error parity unfinished.                      |
| GetDefinitionList             | `/ConMasWeb/Rests/GetDefinitionList.aspx`             | GET/POST       | Form listing/filtering/permissions.                                                    |
| GetDefinitionDetail           | `/ConMasWeb/Rests/GetDefinitionDetail.aspx`           | GET/POST       | Form detail envelope.                                                                  |
| GetReportList                 | `/ConMasWeb/Rests/GetReportList.aspx`                 | GET/POST       | Report listing/filtering/permissions.                                                  |
| GetReportDetail               | `/ConMasWeb/Rests/GetReportDetail.aspx`               | GET/POST       | Report detail envelope.                                                                |
| GetDefinitionData             | `/ConMasWeb/Rests/GetDefinitionData.aspx`             | GET/POST       | Designer-only definition download.                                                     |
| RegistDefinition              | `/ConMasWeb/Rests/RegistDefinition.aspx`              | POST multipart | Designer-only definition persistence; unsupported pipelines fail before commit.        |
| UnlockDefinition              | `/ConMasWeb/Rests/UnlockDefinition.aspx`              | POST           | Designer-only owned-lock release.                                                      |
| MakeReportFromDefinitionTop   | `/ConMasWeb/Rests/MakeReportFromDefinitionTop.aspx`   | GET/POST       | Begin form-derived report download.                                                    |
| GetReportDataTop              | `/ConMasWeb/Rests/GetReportDataTop.aspx`              | GET/POST       | Begin report download; ordinary copy supported, newest-revision copy unfinished.       |
| MakeReportFromDefinitionSheet | `/ConMasWeb/Rests/MakeReportFromDefinitionSheet.aspx` | GET/POST       | Sheet from the active form-derived download.                                           |
| GetReportDataSheet            | `/ConMasWeb/Rests/GetReportDataSheet.aspx`            | GET/POST       | Sheet from the active report download.                                                 |
| RegistReportTop               | `/ConMasWeb/Rests/RegistReportTop.aspx`               | POST multipart | Start upload staging, not a committed save.                                            |
| RegistReportSheet             | `/ConMasWeb/Rests/RegistReportSheet.aspx`             | POST multipart | Stage sheet XML and named binaries.                                                    |
| RegistReportFinish            | `/ConMasWeb/Rests/RegistReportFinish.aspx`            | POST           | Validate and commit the supported report pipeline atomically.                          |
| GetSheetBinaries              | `/ConMasWeb/Rests/GetSheetBinaries.aspx`              | GET/POST       | Sheet binary ZIP for the active download.                                              |
| GetBackgroundImage            | `/ConMasWeb/Rests/GetBackgroundImage.aspx`            | GET/POST       | Background PDF; special copy variants unfinished.                                      |
| GetMasterList                 | `/ConMasWeb/Rests/GetMasterList.aspx`                 | GET/POST       | Master metadata/defaults; culture/sync branches remain open.                           |
| GetMasterImage                | `/ConMasWeb/Rests/GetMasterImage.aspx`                | GET/POST       | Master image; original schema/data dependencies still apply.                           |
| GetMasterRecordList           | `/ConMasWeb/Rests/GetMasterRecordList.aspx`           | GET/POST       | Master records/deltas/roles; exhaustive sync parity unfinished.                        |
| GetDefinitionExcel            | `/ConMasWeb/Rests/GetDefinitionExcel.aspx`            | GET/POST       | Excel binary; special copy variants unfinished.                                        |
| RegistReportFreeDrawSheet     | `/ConMasWeb/Rests/RegistReportFreeDrawSheet.aspx`     | POST multipart | Stage FreeDraw sheet bytes in the active upload.                                       |
| GetReportFreeDrawSheet        | `/ConMasWeb/Rests/GetReportFreeDrawSheet.aspx`        | GET/POST       | Stored FreeDraw sheet PDF/IRFD retrieval.                                              |
| RegistFreeDrawSheetInfo       | `/ConMasWeb/Rests/RegistFreeDrawSheetInfo.aspx`       | POST multipart | Stage FreeDraw ordering/metadata.                                                      |
| GetFreeDrawSheetInfo          | `/ConMasWeb/Rests/GetFreeDrawSheetInfo.aspx`          | GET/POST       | FreeDraw index metadata.                                                               |

### Key parameter and transfer boundaries

- List/detail requests use the original `topId`, label/filter/history and sort fields; detail/data commands validate signed Int32 identifiers.
- Download top precedes sheet/binary requests. Sheet requests use `topId` and `sheetNo` in the same native session. FreeDraw retrieval uses `repTopId`, optionally `fdSheetNo`, and `fileType`.
- Upload order is top → sheets → optional FreeDraw metadata/data → finish. Keep one session throughout. Report uploads select **named XML/binary multipart parts**, including pictures/ink/audio; an XML-only upload is not interchangeable with a complete transfer.
- Designer definition uploads use the **first multipart file**. Do not apply report named-part assumptions to them.
- Native multipart requests use a **1,000,000,000-byte total limit**; this is not proof of tested large-file acceptance.
- `copy=1` ordinary report copying has local implementation; `copyReportMode=1` newest-revision copying remains unsupported. URL-scheme/createReportMode/ResultType definition variants also remain unsupported.
- Advanced numbering/history/applicant-lock/binder/output/notification branches remain incomplete. Configured unsupported effects can reject a save before commit rather than be silently omitted.

## GeneralProcess — seven local operations

All use **`/ConMasWeb/Rests/GeneralProcess.aspx`** with exact `target` and `process` parameters. Authentication is the native session; these operations do not impose the ordinary approved-terminal gate. Their own role/license checks still apply.

| Exact URL selection                                                                  | Request             | Behavior                                                                               |
| :----------------------------------------------------------------------------------- | :------------------ | :------------------------------------------------------------------------------------- |
| `/ConMasWeb/Rests/GeneralProcess.aspx?target=System&process=LicenseStatusInquiry`    | GET/POST            | `item=ConMasIoTGateway`; requires appropriate system-read/admin and entitlement rules. |
| `/ConMasWeb/Rests/GeneralProcess.aspx?target=InputReport&process=TopDetailInquiry`   | GET/POST            | `repTopId` and `items`; report-top inquiry.                                            |
| `/ConMasWeb/Rests/GeneralProcess.aspx?target=Library&process=DocumentList`           | GET/POST            | Accessible document list/filtering.                                                    |
| `/ConMasWeb/Rests/GeneralProcess.aspx?target=Library&process=DocumentDownload`       | GET/POST            | Document download.                                                                     |
| `/ConMasWeb/Rests/GeneralProcess.aspx?target=Library&process=DocumentDeletion`       | POST                | Document deletion; mutates rows/files.                                                 |
| `/ConMasWeb/Rests/GeneralProcess.aspx?target=Library&process=DocumentRegistration`   | POST multipart/form | File/URL registration; defaults, references, labels and permissions apply.             |
| `/ConMasWeb/Rests/GeneralProcess.aspx?target=Schedule&process=ReportListForDownload` | GET/POST            | Assigned scheduled auto-download reports.                                              |

Generic Library registration is **not** the unimplemented mapped `DocumentRegistration` command. File registration/deletion retains late-failure file rollback limits; do not assume every filesystem effect can be undone after a commit failure.

`target=InputReport&process=DownloadMergedPdf` is the eighth operation and remains **unimplemented**.

## Direct diagnostics and static pages

| URL                                      | Calling convention | Caution                                                |
| :--------------------------------------- | :----------------- | :----------------------------------------------------- |
| `/ConMasWeb/Rests/Test/GetTest.aspx`     | GET                | Echo diagnostic; clears native authentication.         |
| `/ConMasWeb/Rests/Test/PostTest.aspx`    | POST form          | Echo diagnostic; clears native authentication.         |
| `/ConMasWeb/Rests/Test/UploadTest.aspx`  | POST multipart     | XML echo diagnostic; clears native authentication.     |
| `/ConMasWeb/Rests/Test/SessionTest.aspx` | GET                | Prior diagnostic result, not authenticated health.     |
| `/ConMasWeb/Rests/Test/Sample.aspx`      | GET                | Legacy sample lookup; requires database configuration. |
| `/ConMasWeb/Rests/Error.htm`             | GET/HEAD           | Original error page.                                   |
| `/ConMasWeb/Rests/Test/Test.htm`         | GET/HEAD           | Original forms; can issue writes.                      |
| `/ConMasWeb/Rests/Test/system.htm`       | GET/HEAD           | Original forms; can issue writes.                      |

The static bodies ship as verified original copies under `public/ConMasWeb/Rests`, served byte-for-byte in every environment, including production. They no longer require a Windows installation path. The existing GET/HEAD allowlist and security checks remain; the original forms can issue writes and are not an exhaustive test console. Diagnostic handlers are not additional mapped business commands; do not call them mid-authenticated workflow.

## Recognized but not migrated

These **12 mapped commands** are not working implementations. Their direct URLs follow `/ConMasWeb/Rests/NAME.aspx`, and the dispatcher recognizes their names:

`GetDefinitionUpdateList`, `GetReportData`, `GetDefinitionPreview`, `MakeReportFromDefinition`, `RegistReport`, `GetEdgeOCRCertificate`, `RegistDocumentMaster`, `PutLog`, `RegistFile`, `GetReportFile`, `DocumentRegistration`, `GetDocumentList`.

Direct-only `FollowLogin.aspx`, `GetReportPreview.aspx`, `EditReport.aspx` and `Test/Uploader.aspx`, all below `/ConMasWeb/Rests/`, remain unfinished. `EditReport` and `Test/Uploader` have unresolved original classes; they are not proven removed features. Mapped `GetUserId` is authentication-scope-excluded, not implemented.

## Public source

[Routes](../../src/routes/client.ts) · [Command configuration](../../config/client.xml) · [Account](../../src/controllers/client-account.ts) · [Definitions](../../src/controllers/client-definitions.ts) · [Reports](../../src/controllers/client-reports.ts) · [Catalog](../../src/controllers/client-catalog.ts) · [Files](../../src/controllers/client-files.ts) · [Voice](../../src/controllers/client-voice.ts) · [GeneralProcess](../../src/controllers/client-general.ts)
