/**
 * Google Apps Script receiver for the AR rehab games (hub + per-patient files).
 *
 * SHAPE
 *   THIS spreadsheet ("the hub") never stores raw session data. It holds one
 *   tab, "patients" — one row per patient with contact fields, a link to
 *   their own file, and a small cached history (last ~14 valid sessions'
 *   key metrics) so the caseload screen is fast without opening anyone's
 *   file.
 *
 *   Each PATIENT gets their own spreadsheet file, created automatically on
 *   their first session, holding a single "log" tab with every row that
 *   patient has ever produced — across every game, distinguished by a
 *   `game` column. A patient's history is therefore never split across
 *   files, no matter how long their course runs or how many other patients
 *   join.
 *
 *   You never edit this script when a new patient starts, or when their
 *   file grows — all of that happens at runtime. You only redeploy when
 *   the script's own code changes.
 *
 * SETUP
 *  1. Create a new Google Sheet — this becomes the hub.
 *  2. Extensions ▸ Apps Script. Paste this file in.
 *  3. Set ADMIN_KEY below if you want the delete-patient action available.
 *  4. Deploy ▸ New deployment ▸ Web app. Execute as: Me. Who has access: Anyone.
 *  5. Copy the /exec URL into `endpoint` in config.js.
 *
 * The game POSTs text/plain (not application/json) on purpose — that keeps
 * it a "simple request", so the browser skips the CORS preflight Apps
 * Script cannot answer.
 */

var HUB_SHEET = 'patients';
var LOG_TAB   = 'log';
var GAME_DEFAULT = 'thai_sentence';

var HEADERS = ['rid','type','game','ts','sid','player_key','display_name',
               'note','side','posture','round','stage','q',
               'mv','sent_id','sent_th','n_words','card_th','grasp',
               'plan_ms','solve_ms','move_ms','grasp_ms','path_pct','dist_pct',
               'path_ratio','peak_vel','ttp_pct','submoves','drop_err_pct','to_slot',
               'attempts','misplaced','correct_first','wrong_first','pct_first','pickups',
               'reposition','fail_grasp','hint_used','completed','ap_max','ap_min',
               'ap_exc','close_ms','release_ms','hold_sd','palm_face','cycles',
               'cycle_ms','grip_close_th','grip_open_th','reveal','q_points','q_max',
               'streak','bonus','score','rounds_done','rounds_total','q_per_level',
               'stages_cleared','max_words','words_ok','words_wrong','duration_ms','no_hand_ms',
               'ended_early','end_reason','input','fps_mean','fps_min','screen',
               'ua','app','bank','received_at'];

/* One row per patient in the hub. m_* columns are JSON arrays of the last
   SPARK_CAP valid sessions' metric values — a cheap preview, not the source
   of truth. Opening a patient re-reads their real file and recomputes fresh. */
var HUB_HEADERS = ['player_key','display_name','note','side','posture',
                    'file_id','file_url','first_ts','last_ts','n_sessions','n_valid',
                    'last_score','updated_at','m_path_ratio','m_submoves','m_move_ms','m_drop_err_pct'];

/* Mirrors the dashboard's default quality gates (config.js `dashboard.gates`)
   closely enough for a fast preview. If you change those, update here too —
   drift only affects the caseload sparkline, never the authoritative numbers
   shown once a patient is opened.                                          */
var GATE = { fpsMin: 20, minDistPct: 5, minMovements: 10 };
var SPARK_CAP = 14;

var READ_KEY  = '';   // required on every ?action= request if set
var ADMIN_KEY = '';   // required for deletePatient; leave empty to disable it
var MAX_ROWS  = 20000;

/* =========================================================================
   WRITE — game → patient file (+ hub summary)
   ========================================================================= */
function doPost(e) {
  var rows = JSON.parse(e.postData.contents).rows || [];
  if (!rows.length) return json_({ ok: true, n: 0 });

  // A queue can hold rows for more than one player_key: a shared clinic
  // device may still have an earlier patient's unsent rows queued when the
  // next patient starts, so every batch is grouped and routed individually.
  var groups = {};
  rows.forEach(function (r) {
    var k = String(r.player_key || '').trim() || '(unknown)';
    (groups[k] = groups[k] || []).push(r);
  });

  var byPatient = {}, total = 0, allOk = true;
  for (var key in groups) {
    try {
      var res = writePatientBatch(key, groups[key]);
      byPatient[key] = res; total += res.n;
    } catch (err) {
      byPatient[key] = { ok: false, error: String(err) }; allOk = false;
    }
  }
  return json_({ ok: allOk, n: total, byPatient: byPatient });
}

function writePatientBatch(playerKey, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pf = resolveOrCreatePatientFile(ss, playerKey, rows[0]);
  var sheet = pf.sheet;

  var ridCol = HEADERS.indexOf('rid') + 1;
  var seen = {};
  if (sheet.getLastRow() > 1) {
    var have = sheet.getRange(2, ridCol, sheet.getLastRow() - 1, 1).getValues();
    for (var h = 0; h < have.length; h++) if (have[h][0]) seen[String(have[h][0])] = 1;
  }
  var now = new Date();
  var fresh = rows.filter(function (r) {
    if (!r.rid) return true;
    if (seen[String(r.rid)]) return false;
    seen[String(r.rid)] = 1;
    return true;
  });
  var out = fresh.map(function (r) {
    return HEADERS.map(function (h) {
      if (h === 'received_at') return now;
      if (h === 'game') return r.game || GAME_DEFAULT;
      return (r[h] === undefined || r[h] === null) ? '' : r[h];
    });
  });
  // this append is NOT globally locked: two DIFFERENT patients write to two
  // different files and structurally cannot collide on getLastRow(). The
  // same patient racing themselves (e.g. two devices at once) is the one
  // residual case, and the rid check above makes a duplicate append harmless
  // even if that ever happens.
  if (out.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, out.length, HEADERS.length).setValues(out);
  }

  updateHubRow(ss, playerKey, rows, pf);
  return { ok: true, n: out.length, fileId: pf.fileId };
}

/* Look up (or create) the spreadsheet file for one patient. Cached in
   PropertiesService so a returning patient never needs to scan the hub.
   Locked only for the short "does this patient have a file yet" moment —
   not for the row append itself, which is the actual bulk of the work.    */
function resolveOrCreatePatientFile(ss, playerKey, sampleRow) {
  var props = PropertiesService.getScriptProperties();
  var cacheKey = 'pf:' + playerKey;
  var fileId = props.getProperty(cacheKey);

  if (!fileId) {
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      fileId = props.getProperty(cacheKey);          // another request may have just created it
      if (!fileId) {
        var hub = hubSheet(ss);
        var existing = findHubRow(hub, playerKey);
        if (existing) {
          fileId = existing.file_id;
        } else {
          var label = (sampleRow && sampleRow.display_name) || playerKey;
          var file = SpreadsheetApp.create(label + ' — ' + playerKey);
          var sh = file.getSheets()[0];
          sh.setName(LOG_TAB);
          sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
          moveNextToOriginal(ss, file);
          fileId = file.getId();
          appendHubRow(hub, playerKey, sampleRow, fileId, file.getUrl());
        }
        props.setProperty(cacheKey, fileId);
      }
    } finally { lock.releaseLock(); }
  }
  var pfile = SpreadsheetApp.openById(fileId);
  var sheet = pfile.getSheetByName(LOG_TAB) || pfile.getSheets()[0];
  return { fileId: fileId, file: pfile, sheet: sheet };
}

/* Update the hub's one-row summary for this patient: last-seen time, session
   counts, and — only when this batch includes the session-close row — a
   fresh point pushed onto each metric's rolling spark array.               */
function updateHubRow(ss, playerKey, rows, pf) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var hub = hubSheet(ss);
    var rec = findHubRow(hub, playerKey);
    if (!rec) return;

    var latestTs = rec.last_ts;
    rows.forEach(function (r) { if (r.ts && String(r.ts) > String(latestTs || '')) latestTs = r.ts; });

    var sessionRow = null;
    rows.forEach(function (r) { if (r.type === 'session') sessionRow = r; });

    var patch = { last_ts: latestTs, updated_at: new Date() };
    if (sessionRow) {
      patch.n_sessions = (Number(rec.n_sessions) || 0) + 1;
      if (sessionRow.score !== undefined) patch.last_score = sessionRow.score;
      if (sessionRow.display_name) patch.display_name = sessionRow.display_name;
      if (sessionRow.side)         patch.side = sessionRow.side;
      if (sessionRow.posture)      patch.posture = sessionRow.posture;
      if (sessionRow.note)         patch.note = sessionRow.note;

      var m = computeSessionMetrics(pf.sheet, sessionRow.sid, sessionRow);
      if (m) {
        patch.n_valid = (Number(rec.n_valid) || 0) + 1;
        ['path_ratio', 'submoves', 'move_ms', 'drop_err_pct'].forEach(function (k) {
          var col = 'm_' + k;
          var arr = safeArr(rec[col]);
          arr.push(m[k]);
          if (arr.length > SPARK_CAP) arr = arr.slice(arr.length - SPARK_CAP);
          patch[col] = JSON.stringify(arr);
        });
      }
    }
    var range = hub.getRange(rec._row, 1, 1, HUB_HEADERS.length);
    var current = range.getValues()[0];
    HUB_HEADERS.forEach(function (h, i) { if (patch[h] !== undefined) current[i] = patch[h]; });
    range.setValues([current]);
  } finally { lock.releaseLock(); }
}

/* Simplified mirror of the dashboard's quality gate + median, run over just
   this one session's rows in the patient's own (small) file.               */
function computeSessionMetrics(sheet, sid, sessionRow) {
  if (!sid) return null;
  var fps = Number(sessionRow.fps_mean);
  if (fps && fps < GATE.fpsMin) return null;
  if (sheet.getLastRow() < 2) return null;

  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
  var sidCol = HEADERS.indexOf('sid'), typeCol = HEADERS.indexOf('type');
  var inputCol = HEADERS.indexOf('input'), roundCol = HEADERS.indexOf('round');
  var distCol = HEADERS.indexOf('dist_pct');
  var prC = HEADERS.indexOf('path_ratio'), smC = HEADERS.indexOf('submoves');
  var mmC = HEADERS.indexOf('move_ms'), deC = HEADERS.indexOf('drop_err_pct');

  var mouseRounds = {};
  values.forEach(function (r) {
    if (String(r[sidCol]) === String(sid) && r[typeCol] === 'round' && r[inputCol] === 'mouse')
      mouseRounds[String(r[roundCol])] = 1;
  });

  var pr = [], sm = [], mm = [], de = [];
  values.forEach(function (r) {
    if (String(r[sidCol]) !== String(sid) || r[typeCol] !== 'movement') return;
    if (mouseRounds[String(r[roundCol])]) return;
    if (Number(r[distCol]) < GATE.minDistPct) return;
    if (r[prC] !== '') pr.push(Number(r[prC]));
    if (r[smC] !== '') sm.push(Number(r[smC]));
    if (r[mmC] !== '') mm.push(Number(r[mmC]));
    if (r[deC] !== '') de.push(Number(r[deC]));
  });
  if (pr.length < GATE.minMovements) return null;
  return { path_ratio: median_(pr), submoves: median_(sm), move_ms: median_(mm), drop_err_pct: median_(de) };
}
function median_(a) {
  if (!a.length) return null;
  var s = a.slice().sort(function (x, y) { return x - y; });
  var m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function safeArr(s) { try { var a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch (e) { return []; } }

/* =========================================================================
   READ + ADMIN — dashboard → hub / patient files
     ?action=roster        every patient's summary row (caseload screen)
     ?action=data           one patient's full raw log (their own file)
     ?action=has             delivery confirmation for one rid
     ?action=deletePatient   erase one patient permanently (file + hub row)
   ========================================================================= */
function doGet(e) {
  var p = (e && e.parameter) || {};
  var ACTIONS = ['roster', 'data', 'has', 'deletePatient'];
  if (ACTIONS.indexOf(p.action) < 0) {
    return ContentService.createTextOutput('AR rehab stats endpoint is running.');
  }
  var out;
  try {
    if (READ_KEY && p.key !== READ_KEY) throw new Error('bad key');
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (p.action === 'roster')            out = actionRoster(ss);
    else if (p.action === 'data')         out = actionData(ss, p);
    else if (p.action === 'has')          out = actionHas(ss, p);
    else                                    out = actionDeletePatient(ss, p);
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return reply(out, p);
}

function actionRoster(ss) {
  var hub = hubSheet(ss);
  if (hub.getLastRow() < 2) return { ok: true, columns: HUB_HEADERS, rows: [] };
  var vals = hub.getRange(2, 1, hub.getLastRow() - 1, HUB_HEADERS.length).getValues();
  var rows = vals.map(function (r) {
    return r.map(function (v) { return v instanceof Date ? v.toISOString() : v; });
  });
  return { ok: true, columns: HUB_HEADERS, rows: rows };
}

function actionData(ss, p) {
  if (!p.player_key) throw new Error('player_key required');
  var rec = findHubRow(hubSheet(ss), p.player_key);
  if (!rec) return { ok: true, columns: HEADERS, rows: [] };

  var pfile = SpreadsheetApp.openById(rec.file_id);
  var sh = pfile.getSheetByName(LOG_TAB) || pfile.getSheets()[0];
  if (sh.getLastRow() < 2) return { ok: true, columns: HEADERS, rows: [] };

  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var cols = values.shift().map(String);
  var tsIdx = cols.indexOf('ts');
  var since = p.since ? String(p.since) : null;
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (since && tsIdx >= 0 && String(r[tsIdx]) < since) continue;
    for (var c = 0; c < r.length; c++) if (r[c] instanceof Date) r[c] = r[c].toISOString();
    rows.push(r);
  }
  if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS);
  return { ok: true, columns: cols, rows: rows, truncated: rows.length >= MAX_ROWS, fileUrl: rec.file_url };
}

function actionHas(ss, p) {
  if (!p.player_key) return { ok: true, found: false };
  var rec = findHubRow(hubSheet(ss), p.player_key);
  if (!rec) return { ok: true, found: false };
  var pfile = SpreadsheetApp.openById(rec.file_id);
  var sh = pfile.getSheetByName(LOG_TAB) || pfile.getSheets()[0];
  var found = false, rc = HEADERS.indexOf('rid') + 1;
  if (sh.getLastRow() > 1) {
    var col = sh.getRange(2, rc, sh.getLastRow() - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) if (String(col[i][0]) === String(p.rid)) { found = true; break; }
  }
  return { ok: true, found: found };
}

/* Permanent erasure of one patient: their file goes to Drive trash, their
   hub row and cached file-id are removed. Needs ADMIN_KEY + literal DELETE. */
function actionDeletePatient(ss, p) {
  requireAdmin(p);
  if (p.confirm !== 'DELETE') throw new Error('confirm phrase missing');
  if (!p.player_key) throw new Error('player_key required');
  var hub = hubSheet(ss);
  var rec = findHubRow(hub, p.player_key);
  if (!rec) throw new Error('no such patient');
  try { DriveApp.getFileById(rec.file_id).setTrashed(true); } catch (e) {}
  hub.deleteRow(rec._row);
  PropertiesService.getScriptProperties().deleteProperty('pf:' + p.player_key);
  return { ok: true, deleted: p.player_key };
}

/* =========================================================================
   HELPERS
   ========================================================================= */
function requireAdmin(p) { if (!ADMIN_KEY || p.admin !== ADMIN_KEY) throw new Error('admin key required'); }

function hubSheet(ss) {
  var sh = ss.getSheetByName(HUB_SHEET);
  if (!sh) { sh = ss.insertSheet(HUB_SHEET); sh.getRange(1, 1, 1, HUB_HEADERS.length).setValues([HUB_HEADERS]); }
  return sh;
}

function findHubRow(hub, playerKey) {
  if (hub.getLastRow() < 2) return null;
  var vals = hub.getRange(2, 1, hub.getLastRow() - 1, HUB_HEADERS.length).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === String(playerKey)) {
      var o = {}; HUB_HEADERS.forEach(function (h, j) { o[h] = vals[i][j]; });
      o._row = i + 2; return o;
    }
  }
  return null;
}

function appendHubRow(hub, playerKey, sampleRow, fileId, url) {
  var now = new Date();
  var rec = {};
  HUB_HEADERS.forEach(function (h) { rec[h] = ''; });
  rec.player_key = playerKey;
  rec.display_name = (sampleRow && sampleRow.display_name) || playerKey;
  rec.note = (sampleRow && sampleRow.note) || '';
  rec.side = (sampleRow && sampleRow.side) || '';
  rec.posture = (sampleRow && sampleRow.posture) || '';
  rec.file_id = fileId; rec.file_url = url;
  rec.first_ts = now; rec.last_ts = now;
  rec.n_sessions = 0; rec.n_valid = 0; rec.last_score = '';
  rec.updated_at = now;
  rec.m_path_ratio = '[]'; rec.m_submoves = '[]'; rec.m_move_ms = '[]'; rec.m_drop_err_pct = '[]';
  hub.appendRow(HUB_HEADERS.map(function (h) { return rec[h]; }));
}

/* Best-effort tidiness: put each patient's file next to the hub in Drive
   instead of loose in "My Drive". Never fatal if it can't.                 */
function moveNextToOriginal(ss, newFile) {
  try {
    var parents = DriveApp.getFileById(ss.getId()).getParents();
    if (parents.hasNext()) {
      var folder = parents.next();
      var f = DriveApp.getFileById(newFile.getId());
      folder.addFile(f);
      DriveApp.getRootFolder().removeFile(f);
    }
  } catch (err) { /* not fatal */ }
}

function json_(out) { return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON); }

/* JSONP when a callback is given (the dashboard is on another origin), plain
   JSON otherwise. */
function reply(out, p) {
  var json = JSON.stringify(out);
  if (p.callback) {
    return ContentService.createTextOutput(p.callback + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
