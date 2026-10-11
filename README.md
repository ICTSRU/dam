# SRU DAM — Digital Asset Management Interface · v1.3

**منصة إدارة الأصول الرقمية** — Sulaiman Al Rajhi University · Corporate Communication Administration (owner) · Powered by ICTD

A single-page, Arabic (RTL) interface for the media team's Digital Asset Management system (Project 147).
It runs on top of the existing **SRU DAM Control Sheet** and the n8n naming workflow. It does not replace them.

| Item | Value |
|---|---|
| Version | 1.3 (shown in the page header chip and footer) |
| Front end | `index.html`: static, for GitHub Pages (ictsru.github.io) |
| Backend | `Code.gs`: Google Apps Script Web App |
| Data | Google Sheet **SRU DAM Control Sheet** (`1TFCzFOkDwaNguoXFQi0_u0_9hnYKX1VIdQjLOqnGi-o`) |
| Files | Google Drive DAM folder tree (`00_INBOX/…`, `90_ARCHIVE`, `99_REJECTED`) |

---

## 1. Screens

| Screen | Arabic | Who sees it | What it does |
|---|---|---|---|
| Dashboard | لوحة المؤشرات | All roles | KPIs, processing pipeline (New → Renamed → AI Classified → Under Review → Published), assets by type, data-quality checks, sequence counters |
| Asset library | مكتبة الأصول | All roles | Search by ID, title or keywords. Filter by type, status, variant and category. Grid or table view |
| Upload | رفع أصل | Uploader, Approver | Drag-and-drop file, type/extension validation, live file-name preview, metadata, then submit or save as draft |
| Asset detail | تفاصيل الأصل | All roles | Preview, standard file name, Drive link, download, copy ID/link, metadata, action history, role actions |
| Approval queue | قائمة الاعتماد | Approver (Uploader sees "استكمال البيانات") | Approve or reject one asset or several at once. Rejection requires a reason |

## 2. Roles

| Role | Library | Upload | Edit metadata | Approve / reject | Archive |
|---|---|---|---|---|---|
| `viewer` (مستعرض) | Published only | ✗ | ✗ | ✗ | ✗ |
| `uploader` (رافع أصول) | All statuses | ✓ | ✓ (not after publishing) | ✗ | ✗ |
| `approver` (معتمِد) | All statuses + data-quality view | ✓ | ✓ | ✓ | ✓ |

The server (`Code.gs`) enforces every permission. Hiding a button in the UI is not what protects an action.

## 3. Status flow (from `n8n_Config`)

```
New ─┐
Renamed ─┼─► Under Review ─► Published ─► Archived (90_ARCHIVE)
AI Classified ─┘        └─► Rejected (99_REJECTED) ─► fix metadata ─► Under Review
```

Required metadata before a submission is accepted: `Title_AR`, `Title_EN`, `Asset_Type`, `Category`, `Department`.
`Metadata_Status` becomes `Complete` once these are filled; otherwise it stays `Needs Review`.

## 4. Naming

The interface and the backend use the rule from the Control Sheet:

```
{ORG}-{TYPE}-{YEAR}-{SEQ}-{DESCRIPTION}-{VARIANT}.{EXT}
SRU-PH-2026-00065-Graduation-Ceremony-MASTER.jpg
```

- `TYPE` and the allowed extensions come from `Naming_Matrix`. `VARIANT` comes from `Variants`.
- `SEQ` is reserved from `Sequence_Control` under a **script lock**, so two simultaneous uploads never get the same number. This addresses the README warning about concurrent edits.
- The description is cleaned automatically: spaces and symbols are removed, Final/New/Latest/Copy are dropped, and any embedded old IDs are stripped.

## 5. Deployment

### 5.1 Backend (Apps Script)
1. Open **SRU DAM Control Sheet** → Extensions → Apps Script. Paste `Code.gs`.
2. In `CONFIG`, set `ROOT_FOLDER_ID` to the DAM root folder that contains `00_INBOX`. If you leave it blank, the backend uses the sheet's parent folder.
3. Run `setup()` once. It creates the **Users** and **Audit_Log** sheets and appends these columns to **Assets**:
   `Confidentiality, Reviewed_By, Review_Date, Review_Note, Duplicate_Status, File_Hash`. Columns A–V stay unchanged, so n8n keeps working.
4. Add the media team to **Users**: `Email`, `Name`, `Role` (approver / uploader / viewer), `Active` = Yes.
5. For each user, run `setAccessCode('email@sr.edu.sa', 'code')`. Only a SHA-256 hash is stored.
6. Deploy → New deployment → **Web app** → Execute as **Me**, access **Anyone** → copy the `/exec` URL.

### 5.2 Front end (GitHub Pages)
1. Put this folder in the repo, for example `ITOC/DAM-v1.3/`.
2. `APP.API_URL` in `index.html` is already set to the production `/exec` URL. After a new Apps Script deployment, update it here.
3. Logos are already embedded in `index.html`. The originals are in `assets/`: `sru-logo.png` (header right), `corp-comm-logo.png` (header left) and `ictd-logo.png` (footer, "Powered By").
4. If `API_URL` is empty, the page runs in **demo mode** with sample records and a role switcher.

## 6. Automation hooks

| Hook | How |
|---|---|
| n8n notifications | Set `CONFIG.N8N_WEBHOOK`. Events posted: `upload`, `submit`, `publish`, `reject`, `archive` |
| Large files (> 25 MB) | Drop them into `00_INBOX/01_New_Uploads`. The existing WF-1 names them, and they then appear in "استكمال البيانات" |
| Duplicate detection | MD5 hash on upload. A duplicate is blocked and the user is told the existing Asset ID |
| Departments | Loaded from `sru-departments.json` (server-side, cached 6 h), grouped with `optgroup` |

## 7. Findings from the current Assets sheet (for the n8n owner)

The dashboard's **Data quality** panel shows these issues live. They come from the WF-1 workflow, not from this interface:

1. **Rows without `Asset_ID`**: WF-1 appends a "New" row and then a separate "Renamed" row instead of updating the first one.
2. **The same `File_ID` registered several times**: for example, `test101 (3).jpg` appears 5 times.
3. **Recursive names**, for example `SRU-PH-2026-00004-SRU-PH-2026-00003-SRU-PH-2026-00002-…-MASTER-MASTER-MASTER`. WF-1 re-processes files it has already renamed.

**Recommended WF-1 fix:**
- Skip any file whose name already matches `^SRU-[A-Z]{2}-\d{4}-\d{5}-`.
- Update the existing row by `File_ID` instead of appending a new one.

Uploads through this interface go straight to `03_Waiting_Approval`, so WF-1 does not touch them.

## 8. Security notes
- Sessions are random UUID tokens in CacheService and expire after 6 hours. The browser keeps the token in `sessionStorage` only.
- Login failures are delayed by about 0.6 s to slow down guessing.
- **Optional hardening:** serve `index.html` from Apps Script (`HtmlService`) under "Anyone in Sulaiman Al Rajhi University". You can then replace access codes with `Session.getActiveUser()` (Google SSO).
- Thumbnails and previews load from Drive with the viewer's own Google session. Users without access to the Shared Drive see a type placeholder.

---
Mohamed ElMahdy, IT Operations Manager, Sulaiman Al Rajhi University
