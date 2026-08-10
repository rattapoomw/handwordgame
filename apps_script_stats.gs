/**
 * Google Apps Script receiver for the AR Thai Sentence Builder (rehab log).
 * One flat sheet. Every row has a `type`: session | round | movement.
 *
 * SETUP
 *  1. Create a Google Sheet. Extensions ▸ Apps Script. Paste this file in.
 *  2. Deploy ▸ New deployment ▸ type "Web app".
 *       Execute as:        Me
 *       Who has access:    Anyone
 *  3. Copy the /exec URL and paste it into STATS.URL in index.html.
 *
 * The game sends text/plain (not application/json) on purpose: that keeps it a
 * "simple request", so the browser skips the CORS preflight that Apps Script
 * cannot answer. Responses are never read by the page.
 */

var SHEET   = 'log';   // one flat table; filter by the `type` column
var HEADERS = ['rid','type','ts','sid','player_key','display_name',
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

function doPost(e) {
  // a whole class submitting at once will collide without this
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
    if (sh.getLastRow() === 0) sh.appendRow(HEADERS);

    var rows = JSON.parse(e.postData.contents).rows || [];

    // Retries are expected (the client resends anything it could not confirm),
    // so drop rows whose rid is already present. Only the rid column is read.
    var ridCol = HEADERS.indexOf('rid') + 1;
    var seen = {};
    if (ridCol > 0 && sh.getLastRow() > 1) {
      var have = sh.getRange(2, ridCol, sh.getLastRow() - 1, 1).getValues();
      for (var h = 0; h < have.length; h++) if (have[h][0]) seen[String(have[h][0])] = 1;
    }
    rows = rows.filter(function (r) {
      if (!r.rid) return true;
      if (seen[String(r.rid)]) return false;
      seen[String(r.rid)] = 1;
      return true;
    });

    var now  = new Date();
    var out  = rows.map(function (r) {
      return HEADERS.map(function (h) {
        if (h === 'received_at') return now;
        return r[h] === undefined || r[h] === null ? '' : r[h];
      });
    });
    if (out.length) {
      sh.getRange(sh.getLastRow() + 1, 1, out.length, HEADERS.length).setValues(out);
    }
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, n: out.length, skipped: 0 }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

/**
 * READ endpoint for the dashboard.
 *   ?action=data&callback=fn   → JSONP (works cross-origin from GitHub Pages)
 *   ?action=data               → plain JSON
 *   ?since=2026-07-01          → only rows at/after this ISO date
 *   ?key=SECRET                → required only if READ_KEY is set below
 *
 * Returns columns + rows-as-arrays rather than objects: for ~10k rows that is
 * roughly a third of the payload size.
 */
var READ_KEY = '';          // set to a string to require ?key= on reads
var MAX_ROWS = 20000;

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action !== 'data' && p.action !== 'has') {
    return ContentService.createTextOutput('AR Thai stats endpoint is running.');
  }
  var out;
  try {
    if (READ_KEY && p.key !== READ_KEY) throw new Error('bad key');

    // delivery check: did this rid land? used by the game to confirm a write
    // whose HTTP response it could not read
    if (p.action === 'has') {
      var shh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET);
      var found = false;
      var rc = HEADERS.indexOf('rid') + 1;
      if (shh && rc > 0 && shh.getLastRow() > 1) {
        var col = shh.getRange(2, rc, shh.getLastRow() - 1, 1).getValues();
        for (var i2 = 0; i2 < col.length; i2++) {
          if (String(col[i2][0]) === String(p.rid)) { found = true; break; }
        }
      }
      out = { ok: true, found: found };
      var j2 = JSON.stringify(out);
      return p.callback
        ? ContentService.createTextOutput(p.callback + '(' + j2 + ');').setMimeType(ContentService.MimeType.JAVASCRIPT)
        : ContentService.createTextOutput(j2).setMimeType(ContentService.MimeType.JSON);
    }
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET);
    if (!sh || sh.getLastRow() < 2) {
      out = { ok: true, columns: HEADERS, rows: [] };
    } else {
      var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
      var cols = values.shift().map(String);
      var tsIdx = cols.indexOf('ts');
      var since = p.since ? String(p.since) : null;
      var rows = [];
      for (var i = 0; i < values.length; i++) {
        var r = values[i];
        if (since && tsIdx >= 0 && String(r[tsIdx]) < since) continue;
        for (var c = 0; c < r.length; c++) {
          if (r[c] instanceof Date) r[c] = r[c].toISOString();
        }
        rows.push(r);
      }
      // keep the NEWEST rows when the sheet is larger than MAX_ROWS —
      // truncating from the top would hide the most recent sessions
      if (rows.length > MAX_ROWS) rows = rows.slice(rows.length - MAX_ROWS);
      out = { ok: true, columns: cols, rows: rows, truncated: rows.length >= MAX_ROWS };
    }
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  var json = JSON.stringify(out);
  if (p.callback) {
    return ContentService
      .createTextOutput(p.callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}
