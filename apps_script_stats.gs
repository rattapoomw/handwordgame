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
var HEADERS = ['type','ts','sid','player_key','display_name','note',
               'side','posture','round','stage','q','mv',
               'sent_id','sent_th','n_words','card_th','grasp','plan_ms',
               'solve_ms','move_ms','grasp_ms','path_pct','dist_pct','path_ratio',
               'peak_vel','ttp_pct','submoves','drop_err_pct','to_slot','attempts',
               'misplaced','pickups','fail_grasp','hint_used','completed','ap_max',
               'ap_min','ap_exc','close_ms','release_ms','hold_sd','palm_face',
               'cycles','cycle_ms','grip_close_th','grip_open_th','score','rounds_done',
               'rounds_total','q_per_level','duration_ms','no_hand_ms','ended_early','end_reason',
               'input','fps_mean','fps_min','screen','ua','app',
               'bank','received_at'];

function doPost(e) {
  // a whole class submitting at once will collide without this
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
    if (sh.getLastRow() === 0) sh.appendRow(HEADERS);

    var rows = JSON.parse(e.postData.contents).rows || [];
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
      .createTextOutput(JSON.stringify({ ok: true, n: out.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return ContentService.createTextOutput('AR Thai stats endpoint is running.');
}
