/**
 * SRU DAM — Apps Script backend · v1.0
 * Sulaiman Al Rajhi University · ICTD · IT Operations Center
 *
 * Serves the DAM interface (index.html) as a JSON API over the
 * "SRU DAM Control Sheet" (sheets: Assets, Naming_Matrix, Variants,
 * Sequence_Control, n8n_Config, README) and adds Users + Audit_Log.
 *
 * Deploy: Deploy → New deployment → Web app
 *   Execute as: Me (the DAM owner account)   Who has access: Anyone
 *   Access is enforced by the Users sheet (email + access code → session token).
 */

const CONFIG = {
  SHEET_ID: '1TFCzFOkDwaNguoXFQi0_u0_9hnYKX1VIdQjLOqnGi-o',   // SRU DAM Control Sheet
  ROOT_FOLDER_ID: '',      // DAM root that contains 00_INBOX / 90_ARCHIVE / 99_REJECTED. Blank = the sheet's parent folder.
  PUBLISHED_FOLDER: '',    // optional path under root for published assets, e.g. '10_PUBLISHED'. Blank = leave in place.
  N8N_WEBHOOK: '',         // optional: n8n webhook notified on upload / submit / publish / reject / archive
  DEPARTMENTS_URL: 'https://dt.sr.edu.sa/digital-enablement/packages/sru-departments.json',
  SESSION_SECONDS: 21600,  // 6 hours (CacheService maximum)
  MAX_UPLOAD_MB: 25,
  TIMEZONE: 'Asia/Riyadh'
};

const STATUS_REJECTED = 'Rejected';
const STATUS_ARCHIVED = 'Archived';
const PRE_REVIEW = ['New', 'Renamed', 'AI Classified', STATUS_REJECTED];
const REQUIRED_META = ['Title_AR', 'Title_EN', 'Asset_Type', 'Category', 'Department'];
const EDITABLE = ['Title_AR', 'Title_EN', 'Category', 'Department', 'Event_Date', 'Description_AR', 'Description_EN',
                  'Keywords_AR', 'Keywords_EN', 'Confidentiality', 'Notes'];
const EXTRA_ASSET_COLUMNS = ['Confidentiality', 'Reviewed_By', 'Review_Date', 'Review_Note', 'Duplicate_Status', 'File_Hash'];
const FORBIDDEN_WORDS = ['final', 'new', 'latest', 'copy'];

/* ======================= HTTP entry points ======================= */

function doGet(e) {
  return json_({ ok: true, data: { service: 'SRU DAM API', version: '1.0', time: new Date().toISOString() } });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = req.action;
    if (action === 'login') return json_({ ok: true, data: login_(req.email, req.code) });

    const user = session_(req.token);
    if (!user) return json_({ ok: false, code: 'AUTH', error: 'انتهت الجلسة أو غير صالحة. سجّل الدخول مجدداً.' });

    const routes = {
      init: () => init_(),
      list: () => list_(user),
      history: () => history_(req.id),
      upload: () => upload_(user, req),
      updateMeta: () => updateMeta_(user, req.id, req.meta || {}),
      submit: () => submit_(user, req.id),
      review: () => review_(user, req.ids || [], req.decision, req.note),
      archive: () => archive_(user, req.id, req.note)
    };
    if (!routes[action]) throw new Error('إجراء غير معروف: ' + action);
    return json_({ ok: true, data: routes[action]() });
  } catch (err) {
    console.error(err && err.stack || err);
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ======================= One-time setup ======================= */

/** Run once from the editor: adds Users + Audit_Log sheets and the extra Assets columns. */
function setup() {
  const ss = ss_();
  ensureSheet_(ss, 'Users', ['Email', 'Name', 'Role', 'Access_Code_Hash', 'Active', 'Notes']);
  ensureSheet_(ss, 'Audit_Log', ['Timestamp', 'Asset_ID', 'Action', 'By', 'Note']);
  const sh = ss.getSheetByName('Assets');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  EXTRA_ASSET_COLUMNS.forEach(function (c) {
    if (headers.indexOf(c) === -1) { sh.getRange(1, sh.getLastColumn() + 1).setValue(c); headers.push(c); }
  });
  const users = ss.getSheetByName('Users');
  users.getRange('C2:C').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['approver', 'uploader', 'viewer'], true).build());
  users.getRange('E2:E').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Yes', 'No'], true).build());
  SpreadsheetApp.flush();
  Logger.log('Setup complete. Add users to the Users sheet, then run setAccessCode() for each.');
}

/** Example: edit and run from the editor to set (or reset) a user's access code. */
function setAccessCodeExample() {
  setAccessCode('m.elmahdy@sr.edu.sa', 'change-me-now');
}

function setAccessCode(email, code) {
  const sh = ss_().getSheetByName('Users');
  const t = table_(sh);
  const row = t.rows.find(function (r) { return String(r.Email).toLowerCase() === String(email).toLowerCase(); });
  if (!row) throw new Error('User not found in Users sheet: ' + email);
  sh.getRange(row._row, t.col.Access_Code_Hash + 1).setValue(hash_(email, code));
  Logger.log('Access code set for ' + email);
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ======================= Auth ======================= */

function hash_(email, code) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    String(email).toLowerCase() + '|' + String(code), Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function login_(email, code) {
  email = String(email || '').trim().toLowerCase();
  if (!email || !code) throw new Error('أدخل البريد ورمز الدخول.');
  const t = table_(ss_().getSheetByName('Users'));
  const u = t.rows.find(function (r) { return String(r.Email).toLowerCase() === email; });
  if (!u || String(u.Active || 'Yes') === 'No' || !u.Access_Code_Hash || u.Access_Code_Hash !== hash_(email, code)) {
    Utilities.sleep(600);
    throw new Error('البريد أو رمز الدخول غير صحيح.');
  }
  const user = { email: email, name: u.Name || email, role: String(u.Role || 'viewer').toLowerCase() };
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('s_' + token, JSON.stringify(user), CONFIG.SESSION_SECONDS);
  return { token: token, user: user };
}

function session_(token) {
  if (!token) return null;
  const v = CacheService.getScriptCache().get('s_' + token);
  return v ? JSON.parse(v) : null;
}

function requireRole_(user, roles) {
  if (roles.indexOf(user.role) === -1) throw new Error('لا تملك صلاحية تنفيذ هذا الإجراء.');
}

/* ======================= Read ======================= */

function init_() {
  const ss = ss_();
  const types = table_(ss.getSheetByName('Naming_Matrix')).rows.map(function (r) {
    return { ar: r.Asset_Type_AR, en: r.Asset_Type_EN, code: r.Type_Code, example: r.Example_Description,
             variant: r.Default_Variant, ext: String(r.Allowed_Extensions || '*'), active: String(r.Active) !== 'No' };
  });
  const variants = table_(ss.getSheetByName('Variants')).rows.map(function (r) {
    return { code: r.Variant, ar: r.Arabic_Description, use: r.Usage };
  });
  const sequence = table_(ss.getSheetByName('Sequence_Control')).rows.map(function (r) {
    return { Type_Code: r.Type_Code, Year: String(r.Year), Last_Number: Number(r.Last_Number) || 0, Next_Number: Number(r.Next_Number) || 1 };
  });
  return { config: config_(), types: types, variants: variants, sequence: sequence, departments: departments_() };
}

function config_() {
  const out = {};
  table_(ss_().getSheetByName('n8n_Config')).rows.forEach(function (r) { if (r.Setting) out[r.Setting] = String(r.Value); });
  return out;
}

function departments_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('departments');
  if (hit) return JSON.parse(hit);
  try {
    const res = UrlFetchApp.fetch(CONFIG.DEPARTMENTS_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const txt = res.getContentText();
    if (txt.length < 95000) cache.put('departments', txt, 21600);
    return JSON.parse(txt);
  } catch (e) { return null; }
}

function list_(user) {
  let rows = table_(ss_().getSheetByName('Assets')).rows.map(clean_);
  if (user.role === 'viewer') rows = rows.filter(function (r) { return r.Status === config_().Published_Status && r.Asset_ID; });
  return rows;
}

function history_(id) {
  return table_(ss_().getSheetByName('Audit_Log')).rows
    .filter(function (r) { return r.Asset_ID === id; })
    .map(clean_)
    .sort(function (a, b) { return a.Timestamp < b.Timestamp ? 1 : -1; });
}

/* ======================= Write ======================= */

function upload_(user, req) {
  requireRole_(user, ['uploader', 'approver']);
  const meta = req.meta || {}, file = req.file || {};
  if (!file.data) throw new Error('لم يصل محتوى الملف.');
  if (file.size > CONFIG.MAX_UPLOAD_MB * 1048576) throw new Error('الملف أكبر من الحد المسموح (' + CONFIG.MAX_UPLOAD_MB + ' ميجابايت).');

  const ss = ss_(), cfg = config_();
  const type = table_(ss.getSheetByName('Naming_Matrix')).rows.find(function (r) { return r.Type_Code === meta.Type_Code; });
  if (!type || String(type.Active) === 'No') throw new Error('نوع الأصل غير صالح أو غير مفعّل.');
  const ext = (String(file.name).match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
  const allowed = String(type.Allowed_Extensions || '*').split(',').map(function (s) { return s.trim().toLowerCase(); });
  if (allowed[0] !== '*' && allowed.indexOf(ext) === -1) throw new Error('الامتداد .' + ext + ' غير مسموح لنوع ' + type.Asset_Type_AR + '.');
  const variant = meta.Variant || type.Default_Variant || 'MASTER';
  const desc = slug_(meta.Description) || type.Example_Description || 'Digital-Asset';

  const bytes = Utilities.base64Decode(file.data);
  const md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, bytes)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  const assets = table_(ss.getSheetByName('Assets'));
  const dup = assets.rows.find(function (r) { return r.File_Hash && r.File_Hash === md5; });
  if (dup && !req.allowDuplicate) throw new Error('هذا الملف مرفوع مسبقاً بالمعرّف ' + (dup.Asset_ID || '(بلا معرّف)') + '.');

  // Reserve the sequence number under a lock so two uploads never share an ID.
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let assetId, fileName, driveFile;
  try {
    const year = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy');
    const seq = nextSequence_(ss, type.Type_Code, year);
    const sep = cfg.Separator || '-';
    const digits = Number(cfg.Sequence_Digits) || 5;
    assetId = [cfg.Organization_Code || 'SRU', type.Type_Code, year, ('0000000000' + seq).slice(-digits)].join(sep);
    fileName = [assetId, desc, variant].join(sep) + '.' + ext;

    // Saved straight to Waiting_Approval (not the n8n inbox) so WF-1 does not rename it a second time.
    const folder = folderByPath_(cfg.Waiting_Approval_Folder || '00_INBOX/03_Waiting_Approval');
    driveFile = folder.createFile(Utilities.newBlob(bytes, file.mime || 'application/octet-stream', fileName));
    driveFile.setDescription(assetId + ' · ' + (meta.Title_AR || '') + ' · ' + (meta.Title_EN || ''));

    const now = new Date().toISOString();
    const row = {
      Asset_ID: assetId, Original_File_Name: file.name, File_Name: fileName, File_ID: driveFile.getId(),
      Drive_URL: driveFile.getUrl(), Asset_Type: type.Asset_Type_EN, Variant: variant,
      Uploaded_By: user.email, Created_Date: now, Processed_Date: now,
      Status: req.submit ? (cfg.Review_Status || 'Under Review') : (cfg.Default_Status || 'New'),
      Confidentiality: meta.Confidentiality || cfg.Default_Confidentiality || 'Internal',
      Duplicate_Status: dup ? 'Duplicate of ' + (dup.Asset_ID || dup.File_ID) : 'Unique',
      File_Hash: md5
    };
    EDITABLE.forEach(function (k) { if (meta[k] !== undefined) row[k] = meta[k]; });
    row.Metadata_Status = complete_(row) ? 'Complete' : (cfg.Default_Metadata_Status || 'Needs Review');
    if (req.submit && !complete_(row)) row.Status = cfg.Default_Status || 'New';
    appendRow_(ss.getSheetByName('Assets'), row);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  audit_(assetId, 'Created', user.email, req.submit ? 'رفع وإرسال للاعتماد' : 'رفع كمسودة');
  if (req.submit) audit_(assetId, 'Submitted for review', user.email, '');
  notify_('upload', assetId, user);
  return findAsset_(assetId).data;
}

function nextSequence_(ss, code, year) {
  const sh = ss.getSheetByName('Sequence_Control');
  const t = table_(sh);
  let r = t.rows.find(function (x) { return x.Type_Code === code && String(x.Year) === String(year); });
  if (!r) {
    sh.appendRow([code, Number(year), 0, 1]);
    SpreadsheetApp.flush();
    r = table_(sh).rows.find(function (x) { return x.Type_Code === code && String(x.Year) === String(year); });
  }
  const n = (Number(r.Last_Number) || 0) + 1;
  sh.getRange(r._row, t.col.Last_Number + 1).setValue(n);
  sh.getRange(r._row, t.col.Next_Number + 1).setValue(n + 1);
  return n;
}

function updateMeta_(user, id, meta) {
  requireRole_(user, ['uploader', 'approver']);
  const f = findAsset_(id);
  const cfg = config_();
  if (user.role !== 'approver' && [cfg.Published_Status, STATUS_ARCHIVED].indexOf(f.data.Status) !== -1)
    throw new Error('الأصل منشور؛ التعديل للمعتمِد فقط.');
  const patch = {};
  EDITABLE.forEach(function (k) { if (meta[k] !== undefined) patch[k] = meta[k]; });
  const merged = Object.assign({}, f.data, patch);
  patch.Metadata_Status = complete_(merged) ? 'Complete' : (cfg.Default_Metadata_Status || 'Needs Review');
  writeRow_(f, patch);
  audit_(id, 'Metadata updated', user.email, '');
  return findAsset_(id).data;
}

function submit_(user, id) {
  requireRole_(user, ['uploader', 'approver']);
  const f = findAsset_(id), cfg = config_();
  if (PRE_REVIEW.indexOf(f.data.Status) === -1) throw new Error('لا يمكن إرسال أصل حالته ' + f.data.Status + '.');
  if (!complete_(f.data)) throw new Error('أكمل الحقول الإلزامية قبل الإرسال للاعتماد.');
  writeRow_(f, { Status: cfg.Review_Status || 'Under Review', Review_Note: '' });
  moveFile_(f.data.File_ID, cfg.Waiting_Approval_Folder);
  audit_(id, 'Submitted for review', user.email, '');
  notify_('submit', id, user);
  return findAsset_(id).data;
}

function review_(user, ids, decision, note) {
  requireRole_(user, ['approver']);
  if (!ids.length) throw new Error('لم يُحدد أي أصل.');
  if (decision !== 'publish' && decision !== 'reject') throw new Error('قرار غير صالح.');
  if (decision === 'reject' && !String(note || '').trim()) throw new Error('سبب الرفض مطلوب.');
  const cfg = config_(), now = new Date().toISOString(), out = [];
  ids.forEach(function (id) {
    const f = findAsset_(id);
    if (f.data.Status !== (cfg.Review_Status || 'Under Review')) throw new Error(id + ' ليس بانتظار الاعتماد.');
    const status = decision === 'publish' ? (cfg.Published_Status || 'Published') : STATUS_REJECTED;
    writeRow_(f, { Status: status, Reviewed_By: user.email, Review_Date: now, Review_Note: note || '', Processed_Date: now });
    if (decision === 'reject') moveFile_(f.data.File_ID, cfg.Rejected_Folder);
    else if (CONFIG.PUBLISHED_FOLDER) moveFile_(f.data.File_ID, CONFIG.PUBLISHED_FOLDER);
    audit_(id, decision === 'publish' ? 'Published' : 'Rejected', user.email, note || '');
    notify_(decision, id, user);
    out.push(findAsset_(id).data);
  });
  return out;
}

function archive_(user, id, note) {
  requireRole_(user, ['approver']);
  const f = findAsset_(id), cfg = config_();
  writeRow_(f, { Status: STATUS_ARCHIVED, Processed_Date: new Date().toISOString() });
  moveFile_(f.data.File_ID, cfg.Archive_Folder);
  audit_(id, 'Archived', user.email, note || '');
  notify_('archive', id, user);
  return findAsset_(id).data;
}

/* ======================= Helpers ======================= */

function ss_() { return SpreadsheetApp.openById(CONFIG.SHEET_ID); }

function table_(sh) {
  const values = sh.getDataRange().getValues();
  const headers = values.shift() || [];
  const col = {};
  headers.forEach(function (h, i) { if (h !== '') col[String(h).trim()] = i; });
  const rows = values.map(function (v, i) {
    const o = { _row: i + 2 };
    headers.forEach(function (h, j) { if (h !== '') o[String(h).trim()] = v[j]; });
    return o;
  }).filter(function (o) { return Object.keys(o).some(function (k) { return k !== '_row' && o[k] !== ''; }); });
  return { sheet: sh, headers: headers, col: col, rows: rows };
}

function clean_(r) {
  const o = {};
  Object.keys(r).forEach(function (k) {
    if (k === '_row') return;
    const v = r[k];
    o[k] = v instanceof Date ? v.toISOString() : v;
  });
  return o;
}

function findAsset_(id) {
  if (!id) throw new Error('المعرّف مطلوب.');
  const t = table_(ss_().getSheetByName('Assets'));
  const r = t.rows.find(function (x) { return x.Asset_ID === id; });
  if (!r) throw new Error('لم يُعثر على الأصل ' + id + '.');
  return { table: t, row: r._row, data: clean_(r) };
}

function writeRow_(found, patch) {
  const sh = found.table.sheet, col = found.table.col;
  Object.keys(patch).forEach(function (k) {
    if (col[k] === undefined) throw new Error('العمود ' + k + ' غير موجود في ورقة Assets. شغّل setup() أولاً.');
    sh.getRange(found.row, col[k] + 1).setValue(patch[k]);
  });
  SpreadsheetApp.flush();
}

function appendRow_(sh, obj) {
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const missing = Object.keys(obj).filter(function (k) { return headers.indexOf(k) === -1; });
  if (missing.length) throw new Error('أعمدة ناقصة في ورقة Assets: ' + missing.join(', ') + '. شغّل setup() أولاً.');
  sh.appendRow(headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
}

function complete_(r) {
  return REQUIRED_META.every(function (k) { return String(r[k] || '').trim() !== ''; });
}

function slug_(s) {
  return String(s || '').replace(/[^A-Za-z0-9]+/g, '-').split('-')
    .filter(function (p) { return p && FORBIDDEN_WORDS.indexOf(p.toLowerCase()) === -1 && !/^SRU$/i.test(p); })
    .join('-').replace(/[A-Z]{2}-\d{4}-\d{5}-?/g, '').slice(0, 60).replace(/-+$/, '');
}

function rootFolder_() {
  if (CONFIG.ROOT_FOLDER_ID) return DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  const parents = DriveApp.getFileById(CONFIG.SHEET_ID).getParents();
  if (!parents.hasNext()) throw new Error('حدّد ROOT_FOLDER_ID في CONFIG.');
  return parents.next();
}

function folderByPath_(path) {
  let f = rootFolder_();
  String(path || '').split('/').filter(String).forEach(function (name) {
    const it = f.getFoldersByName(name);
    f = it.hasNext() ? it.next() : f.createFolder(name);
  });
  return f;
}

function moveFile_(fileId, path) {
  if (!fileId || !path) return;
  try { DriveApp.getFileById(fileId).moveTo(folderByPath_(path)); }
  catch (e) { console.warn('moveFile_ failed for ' + fileId + ': ' + e.message); }
}

function audit_(id, action, by, note) {
  const sh = ss_().getSheetByName('Audit_Log');
  if (sh) sh.appendRow([new Date().toISOString(), id, action, by, note || '']);
}

function notify_(event, id, user) {
  if (!CONFIG.N8N_WEBHOOK) return;
  try {
    UrlFetchApp.fetch(CONFIG.N8N_WEBHOOK, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ source: 'SRU-DAM-UI', version: '1.0', event: event, asset_id: id, by: user.email, at: new Date().toISOString() })
    });
  } catch (e) { console.warn('n8n notify failed: ' + e.message); }
}
