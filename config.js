/* ===========================================================================
   AR THAI REHAB — SHARED CONFIGURATION
   ---------------------------------------------------------------------------
   Edit THIS file only. index.html and dashboard.html both read it, so the
   endpoint URL and the tuning options live in one place and survive an
   update of either HTML file.

   Loaded with <script src="config.js"></script>, NOT fetch(), so it works
   from file:// as well as from GitHub Pages.

   Anything you delete or omit falls back to a sensible default, so a partial
   config is fine.
   - Rattapoom Waranusast
   =========================================================================== */

window.APP_CONFIG = {

  /* -----------------------------------------------------------------------
     1. GOOGLE SHEET ENDPOINT   ← the one thing you must set
     Apps Script ▸ Deploy ▸ Web app ▸ Execute as: Me ▸ Who has access: Anyone
     Paste the URL that ends in /exec (not /dev).
     ----------------------------------------------------------------------- */
  endpoint : 'https://script.google.com/macros/s/AKfycbx-ms2fnyijVnDhKK6szcUsfRce7HOivr0B_nOWGvxYiMa9q7NEdbe4lgJXt5FA1nhuYg/exec',

  /* Only if you set READ_KEY in apps_script_stats.gs. Note this is visible to
     anyone who views the page source — it deters casual access, nothing more. */
  readKey  : '',

  /* Set false to run the game fully offline (local archive + CSV only). */
  upload   : true,

  /* Satisfaction survey shown on the end screen. Paste a Google Form link
     (the "Send ▸ 🔗 link" URL). Leave '' and the button is hidden.
 
     Tip: a Form can be pre-filled from the URL. Get a prefilled link via
     Google Forms ▸ ⋮ ▸ Get pre-filled link, then paste the entry.xxxxx id
     below and the game will pass the player's name through automatically,
     so the patient does not have to type it twice.                        */
  survey: {
    url        : 'https://docs.google.com/forms/d/e/1FAIpQLSdYeMV0lco5eTKzyoFMo3QPdYY_7hZpexlrsSOqvP8JWgBegA/viewform',     // e.g. 'https://docs.google.com/forms/d/e/XXXX/viewform'
    nameField  : 'entry.1022541388',     // e.g. 'entry.1234567890'  (optional)
    sidField   : 'entry.1333325407'      // e.g. 'entry.0987654321'  (optional, links the form to the session)
  },


  /* -----------------------------------------------------------------------
     2. GAME
     ----------------------------------------------------------------------- */
  game: {
    /* Default selection in the "จำนวนข้อต่อด่าน" dropdown, and the choices
       offered. The sentence bank holds 50 per length, so max 50.            */
    questionsPerStage : 5,
    questionOptions   : [1, 2, 3, 5, 8, 10],

    /* ---- scoring ----------------------------------------------------
       A question is worth more when it has more words. Points are taken
       off THIS question's value, never off the running total, so the
       score the patient sees never goes down.                          */
    pointsByLength : { 3: 60, 4: 80, 5: 100 },
    pointsPerQuestion : 100,          // fallback for lengths not listed above

    /* Each wrong submission costs this many points from the question,
       but never below floorPct of its starting value.                  */
    wrongWordPenalty : 10,            // per misplaced word, per submission
    floorPct         : 0.4,           // 40% of the question value

    /* Bonus for consecutive first-try correct answers. A wrong answer
       PAUSES the streak (count is kept) rather than resetting it.       */
    streakBonus  : 25,
    streakLength : 3,

    /* Show the running score to the patient while playing?
       Some therapists hide it to reduce performance anxiety; the total
       is always shown on the summary screen either way.                */
    showScore : true,

    /* How a question is submitted once every slot is filled.
         'countdown' – short delay with a cancel ring (no extra reaching)
         'button'    – an explicit ตรวจคำตอบ button the patient must press
         'instant'   – check immediately, as the game did before          */
    submitMode    : 'countdown',
    submitDelayMs : 4000,

    /* Pre-selected values on the player form.
       side:    'left' | 'right' | 'both' | ''   ('' = force a choice)
       posture: 'sit'  | 'stand' | 'wheelchair' | ''                     */
    defaultSide    : 'both',
    defaultPosture : 'sit',

    /* Show the full Thai sentence as the prompt at the start of each question?
       false (default) = concealed. The patient must work out the correct word
       order from the cards alone, which adds a working-memory and syntax task.
       The sentence is always revealed once the answer is correct.           */
    revealSentence : false,

    /* Camera framing on first run: 'fill' (height-fill, sides cropped —
       best for a 4:3 webcam on a wide screen), 'contain', or 'cover'.       */
    fit : 'fill',

    /* Hold time in ms for the จบเกม button (dwell-to-confirm). */
    endHoldMs : 1200,

    /* Show the English meaning for this long when เฉลย / H is pressed. */
    hintMs : 2500,

    /* Score multiplier for a question where the reveal button was used.
       0.5 = half marks · 1 = no penalty · 0 = no score for that question. */
    hintScoreFactor : 0.5,
  },


  /* -----------------------------------------------------------------------
     3. HAND / GRASP TUNING
     Aperture = dist(thumb tip, index tip) / dist(wrist, middle knuckle).
     Roughly 0.3 fully pinched, 1.6 fully open. LOWER close = the patient must
     pinch harder to grab. Both values are logged with every session, so a
     change here can never be mistaken for a change in the patient.
     ----------------------------------------------------------------------- */
  grip: {
    close : 0.62,   // aperture must fall below this to grab
    open  : 0.95,   // must rise above this to release
    fistFingers : 3 // curled fingers needed for a power-grasp pick
  },

  /* Pre-game open/close baseline test. */
  pinchCheck: {
    enabled : true,
    cycles  : 5,
    timeoutMs : 20000
  },


  /* -----------------------------------------------------------------------
     4. DASHBOARD
     ----------------------------------------------------------------------- */
  dashboard: {
    /* Days of history to request. '' = everything. */
    sinceDays : 90,

    /* Hide patient names by default — useful on a shared or projected screen. */
    maskNames : false,

    /* Printed at the top of the progress report. */
    clinicName : 'แผนกกิจกรรมบำบัด',

    /* Data-quality gates. Anything failing these is excluded from trends and
       reported as excluded — never silently averaged in.                     */
    gates: {
      fpsMin       : 20,   // below this, velocity and smoothness are noise
      minDistPct   : 5,    // % of screen height; smaller = a nudge, not a reach
      minMovements : 10,   // per session, before it appears on a trend line
      palmMin      : 0.45  // hand turned edge-on foreshortens the aperture
    },

    /* Sessions apart by more than this many days ⇒ "ขาดการติดตาม". */
    lapsedDays : 14,

    /* Mean % change across metrics needed to call a trend up or down. */
    trendThreshold : 8
  }
};
