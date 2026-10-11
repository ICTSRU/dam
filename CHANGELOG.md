# Changelog — SRU DAM Interface

Version numbering: one digit after the decimal point (1.9 → 2.0).

## [1.3] — 2026-10-11
### Changed
- Platform name changed to «منصة إدارة الأصول الرقمية» in the top bar, the browser tab title and the login screen.
- The access-code field no longer lets the browser autofill a saved code, which had caused false "incorrect code" errors.
- Version chip and footer updated to 1.3. `Code.gs` is unchanged.

## [1.2] — 2026-10-11
### Changed
- `APP.API_URL` now holds the production Apps Script Web App URL, so the page runs live on the SRU DAM Control Sheet. Demo mode is off.
- Version chip and footer updated to 1.2. `Code.gs` is unchanged.

## [1.1] — 2026-10-11
### Changed
- Header left: the Corporate Communication Administration logo (إدارة الاتصال المؤسسي) replaces the ICTD logo.
- Header right: the official Sulaiman Alrajhi University logo is now embedded.
- Footer far left: "Powered By" followed by the ICTD logo. This replaces the ITOC mark.
- Footer text now names إدارة الاتصال المؤسسي as the owning administration.
- All three logos are embedded in `index.html` as data URIs, so the page shows them with no external files. Copies are also kept in `assets/`.
- Version chip and footer updated to 1.1. `Code.gs` is unchanged.

## [1.0] — 2026-10-11
### Added
- `index.html`: Arabic RTL single-page interface with five views: Dashboard, Asset Library, Upload, Asset Detail and Approval Queue.
- Three roles (approver / uploader / viewer), with navigation and actions scoped to each role.
- Live file-name preview built from `Naming_Matrix`, `Variants`, `Sequence_Control` and `n8n_Config`.
- Extension validation for each asset type, plus automatic type detection from the file extension.
- Bulk approve and bulk reject in the approval queue. A rejection requires a reason.
- Data-quality panel: rows without an Asset_ID, the same File_ID registered more than once, file names that break the naming rule, and missing Arabic titles.
- Demo mode with sample records and a role switcher when `API_URL` is empty.
- `Code.gs`: Apps Script JSON API with these actions: login, init, list, history, upload, updateMeta, submit, review, archive.
- Sequence numbers reserved under LockService.
- MD5 duplicate check on upload.
- File moves to `03_Waiting_Approval`, `99_REJECTED` and `90_ARCHIVE`.
- Audit_Log sheet.
- Optional n8n webhook notifications.
- `setup()`: creates the Users and Audit_Log sheets and appends the review columns to Assets (columns A–V unchanged).
- Departments loaded from `sru-departments.json`.
