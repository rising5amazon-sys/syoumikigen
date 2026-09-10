/**
 * 賞味期限管理 — サーバー側（Google Apps Script）
 *
 * 役割: スプレッドシートを DB として読み書きする JSON API。画面（HTML）は持たない。
 *
 * なぜ画面を持たないか:
 *   GAS の Web アプリは sandboxed iframe（opaque origin）の中で動くため、
 *   ブラウザが getUserMedia（カメラ）を拒否する。利用者が「許可」を押しても弾かれ、
 *   Apps Script 側では回避できない。よって画面は GitHub Pages に置き、
 *   ここは API に徹する。詳細は README.md を参照。
 *
 * 扱うシートは2枚:
 *   登録シート … A:JAN  B:商品名  C:属性  D:賞味期限   ← 読んだJANと選んだ期限を書き足す
 *   DBシート   … A:JAN  B:商品名  C:属性              ← 商品の台帳。未知のJANはここに足す
 * どちらも1行目が見出し。列の位置は固定（利用者のシートのレイアウトに合わせてある）。
 */

// ---------------------------------------------------------------- 定数

// 使うシート。既定は gid（シートのURLの #gid= の数字）で特定する。
// gid はシート名を変えても変わらないので、名前より壊れにくい。
// 別のスプレッドシートで使うときは、スクリプト プロパティ
// REGISTER_SHEET / DB_SHEET にシート名か gid を入れて上書きする。
var GID = { REGISTER: 0, DB: 391546061 };

// 列の位置（1始まり）。利用者のシートのレイアウトに合わせた固定値。
var COL = { JAN: 1, NAME: 2, ATTR: 3, EXPIRY: 4 };

var LOG_SHEET = 'ログ';
var LOG_HEADER = ['日時', '操作', '対象行', '内容', '担当者'];

// 画面で「期限が近い」として色を付ける日数。ここから「あと〜日」が強調表示になる。
var DEFAULT_SOON_DAYS = 7;

// 通知する日。期限まで「ちょうどこの日数」のものだけを Slack に流す。
// 7日以内を毎日流すと同じ商品が7回来てしまうので、回数を絞っている。
var DEFAULT_NOTIFY_DAYS = [1, 3, 7];

// B列・C列に数式が入っているかを見るとき、先頭から何行ぶん確かめるか
var FORMULA_PROBE_ROWS = 50;

// ---------------------------------------------------------------- 入口

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'リクエストが空です' });
    }
    return handle_(JSON.parse(e.postData.contents));
  } catch (err) {
    return json_({ ok: false, error: errText_(err) });
  }
}

/**
 * ブラウザのアドレスバーから動作確認できるように GET も受ける。
 *   例) <URL>?action=ping
 *       <URL>?action=list&pass=xxxx
 */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    return handle_({ action: p.action || 'ping', pass: p.pass || '', payload: p });
  } catch (err) {
    return json_({ ok: false, error: errText_(err) });
  }
}

function handle_(req) {
  var action = req.action || '';
  var fn = ACTIONS[action];
  if (!fn) return json_({ ok: false, error: '不明な操作です: ' + action });

  // ping だけはパスコード不要（疎通確認に使うため）
  if (action !== 'ping' && !checkPass_(req.pass)) {
    return json_({ ok: false, error: 'パスコードが違います', code: 'BAD_PASS' });
  }
  try {
    return json_({ ok: true, data: fn(req.payload || {}, req) });
  } catch (err) {
    return json_({ ok: false, error: errText_(err) });
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errText_(err) {
  return String((err && err.message) ? err.message : err);
}

function checkPass_(pass) {
  var expected = prop_('PASSCODE');
  if (!expected) return false;          // 未設定なら全拒否（開けっ放しにしない）
  return String(pass || '') === expected;
}

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function tz_() {
  return Session.getScriptTimeZone() || 'Asia/Tokyo';
}

// ---------------------------------------------------------------- 操作一覧

var ACTIONS = {

  /** 疎通確認。パスコード不要。どのシートを掴んでいるかも返す。 */
  ping: function () {
    var reg = null, db = null, errs = [];
    try { reg = registerSheet_(); } catch (e) { errs.push(errText_(e)); }
    try { db = dbSheet_(); } catch (e) { errs.push(errText_(e)); }

    return {
      name: '賞味期限管理 API',
      sheet: SpreadsheetApp.getActiveSpreadsheet().getName(),
      registerSheet: reg ? reg.getName() : '',
      dbSheet: db ? db.getName() : '',
      dbCount: db ? Math.max(0, db.getLastRow() - 1) : 0,
      sheetErrors: errs,
      timezone: tz_(),
      today: todayYMD_(),
      soonDays: soonDays_(),
      notifyDays: notifyDays_(),
      passcodeSet: !!prop_('PASSCODE'),
      janSources: janSourceStatus_()
    };
  },

  /**
   * JANコード照会。
   * まず DBシートを見る。無ければ外部の JANコードDB を「候補」として引く。
   * 見つからなくてもエラーにはしない（新規登録に進むため）。
   *
   * DBシートに無いときは name / attr を空で返す。画面側はそこで
   * 「商品名を入力」「属性を入力」の案内を出す。外部から取れた名前は
   * 確定ではないので値そのものには入れず、suggest として別に返す。
   */
  lookup: function (p) {
    var jan = normJan_(p.jan);
    if (!jan) throw new Error('JANコードが空です');

    var hit = findInDb_(jan);
    if (hit) {
      return {
        jan: jan,
        found: true,
        name: hit.name,
        attr: hit.attr,
        source: 'db',
        dbRow: hit.row,
        history: recentByJan_(jan, 5)
      };
    }

    var ext = lookupExternal_(jan);
    return {
      jan: jan,
      found: false,
      name: '',
      attr: '',
      suggest: { name: ext.name || '', source: ext.source || '' },
      skipped: ext.skipped,
      history: []
    };
  },

  /**
   * 登録。登録シートの末尾に1行足し、A列にJAN・D列に賞味期限を書く。
   * そのJANがDBシートに無ければ、DBシートにも JAN・商品名・属性を足す。
   */
  addItem: function (p) {
    var jan = normJan_(p.jan);
    var name = String(p.name || '').trim();
    var attr = String(p.attr || '').trim();
    var expiry = normYMD_(p.expiry);
    var user = userName_(p.user);

    if (!jan) throw new Error('JANコードが空です');
    if (!name) throw new Error('商品名が空です');
    if (!expiry) throw new Error('賞味期限の形式が不正です（yyyy-mm-dd）');

    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var isNewProduct = !findInDb_(jan);
      if (isNewProduct) addToDb_(jan, name, attr);

      var row = writeRegisterRow_(jan, name, attr, expiry);

      log_('登録', row, name + ' / 属性' + (attr || '(なし)') + ' / 期限' + expiry
        + (isNewProduct ? ' / 新規商品としてDBシートに追加' : ''), user);

      return {
        row: row, jan: jan, name: name, attr: attr, expiry: expiry,
        daysLeft: daysUntil_(expiry), newProduct: isNewProduct
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * 一覧。既定では賞味期限が入っている行だけ返す。
   * 登録シートには期限が空のままの行（商品リストを貼っただけの行）が混ざるので、
   * 賞味期限管理の一覧としては数えない。all=1 でそれも含める。
   */
  list: function (p) {
    var all = String(p.all || '') === '1' || p.all === true;
    var rows = readRegister_();
    var withExpiry = rows.filter(function (r) { return !!r.expiry; });
    return {
      items: all ? rows : withExpiry,
      noExpiryCount: rows.length - withExpiry.length,
      today: todayYMD_(),
      soonDays: soonDays_()
    };
  },

  /**
   * 通知の対象を返す。GitHub Actions の通知が使う。
   *
   * 「期限まで◯日以内」ではなく「期限まで ちょうど◯日」で拾う（既定 7日前・3日前・前日）。
   * 以内で拾うと同じ商品が毎日通知に載ってしまい、読まれなくなるため。
   * days は "7,3,1" のようにカンマ区切りで渡す。未指定ならスプレッドシート側の設定。
   *
   * 期限切れだけは別扱いで、日数にかかわらず毎回載せる。
   * 放置されている在庫を通知から落とすと、誰も気づかないまま残るため。
   */
  due: function (p) {
    var days = parseDays_(p.days);
    if (!days.length) days = notifyDays_();

    var rows = readRegister_().filter(function (r) { return r.daysLeft !== null; });

    var expired = rows.filter(function (r) { return r.daysLeft < 0; });
    var soon = rows.filter(function (r) { return days.indexOf(r.daysLeft) >= 0; });

    expired.sort(byDaysLeft_);
    soon.sort(byDaysLeft_);

    return {
      today: todayYMD_(),
      notifyDays: days,
      soonDays: soonDays_(),      // 画面の色分けの設定。通知には使わないが参考に返す
      expired: expired,
      soon: soon
    };
  }
};

// ---------------------------------------------------------------- シートの特定

function registerSheet_() { return resolveSheet_('REGISTER'); }
function dbSheet_() { return resolveSheet_('DB'); }

/**
 * 使うシートを1枚返す。
 * スクリプト プロパティ（シート名 or gid）→ 既定の gid の順に探す。
 * 見つからないときは当てずっぽうで別のシートを触らず、エラーにする。
 */
function resolveSheet_(kind) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var label = kind === 'REGISTER' ? '登録シート' : 'DBシート';
  var override = prop_(kind + '_SHEET');
  var sh = null;

  if (override) {
    sh = ss.getSheetByName(override);
    if (!sh && /^[0-9]+$/.test(override)) sh = sheetByGid_(ss, Number(override));
    if (!sh) {
      throw new Error(label + 'が見つかりません（' + kind + '_SHEET = ' + override + '）。'
        + 'メニュー「賞味期限管理 → 使うシートを指定する」で直してください。');
    }
  } else {
    sh = sheetByGid_(ss, GID[kind]);
    if (!sh) {
      throw new Error(label + 'が見つかりません（gid ' + GID[kind] + '）。'
        + 'メニュー「賞味期限管理 → 使うシートを指定する」で指定してください。');
    }
  }

  // 掴んだシートが本当にそのシートかを見出しで確かめる。
  // 違うシートに書き込むのがいちばん怖いので、疑わしければ触らない。
  var head = String(sh.getRange(1, COL.JAN).getValue()).trim();
  if (head.toUpperCase().indexOf('JAN') < 0) {
    throw new Error(label + '（' + sh.getName() + '）の A1 が「JAN」ではありません（実際: "'
      + head + '"）。シートの指定が違っている可能性があるので、書き込みを中止しました。');
  }
  return sh;
}

function sheetByGid_(ss, gid) {
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getSheetId() === gid) return all[i];
  }
  return null;
}

// ---------------------------------------------------------------- 読み書き

/**
 * 登録シートの末尾に1行足す。書くのは A列（JAN）と D列（賞味期限）。
 *
 * B列（商品名）・C列（属性）に触らないのは、そこが DBシートを引く数式のことがあるため。
 * ただし数式が入っていないシートだと、書かなければ名前が空の行が残って人が読めない。
 * そこで「その列に数式が1つも無く、かつ書き込む先が空のとき」だけ値を入れる。
 * 数式に上書きして #REF! を撒く事故を避けつつ、値だけのシートでも読める形にする。
 */
function writeRegisterRow_(jan, name, attr, expiry) {
  var sh = registerSheet_();
  var row = sh.getLastRow() + 1;

  // 13桁のJANが 4.9012E+12 になるのを防ぐ。書く前に文字列書式にする。
  sh.getRange(row, COL.JAN).setNumberFormat('@');
  sh.getRange(row, COL.JAN).setValue(jan);

  sh.getRange(row, COL.EXPIRY).setNumberFormat('yyyy-mm-dd');
  sh.getRange(row, COL.EXPIRY).setValue(ymdToDate_(expiry));

  fillIfPlainColumn_(sh, row, COL.NAME, name);
  fillIfPlainColumn_(sh, row, COL.ATTR, attr);

  return row;
}

function fillIfPlainColumn_(sh, row, col, value) {
  if (value === '') return;
  if (hasFormula_(sh, col)) return;                            // 数式の列には触らない
  if (String(sh.getRange(row, col).getValue()).trim() !== '') return;
  sh.getRange(row, col).setValue(value);
}

/** その列の先頭 FORMULA_PROBE_ROWS 行に数式が1つでもあるか。 */
function hasFormula_(sh, col) {
  var last = sh.getLastRow();
  if (last < 2) return false;
  var n = Math.min(last - 1, FORMULA_PROBE_ROWS);
  var f = sh.getRange(2, col, n, 1).getFormulas();
  for (var i = 0; i < f.length; i++) {
    if (String(f[i][0]).charAt(0) === '=') return true;
  }
  return false;
}

/** DBシートの末尾に商品を1件足す。 */
function addToDb_(jan, name, attr) {
  var sh = dbSheet_();
  var row = sh.getLastRow() + 1;
  sh.getRange(row, COL.JAN).setNumberFormat('@');
  sh.getRange(row, COL.JAN, 1, 3).setValues([[jan, name, attr]]);
  return row;
}

/** DBシートから JAN を引く。無ければ null。 */
function findInDb_(jan) {
  var sh = dbSheet_();
  if (sh.getLastRow() < 2) return null;
  var values = sh.getRange(2, COL.JAN, sh.getLastRow() - 1, 3).getValues();
  for (var i = 0; i < values.length; i++) {
    if (normJan_(values[i][0]) === jan) {
      return {
        name: String(values[i][1] || '').trim(),
        attr: String(values[i][2] || '').trim(),
        row: i + 2
      };
    }
  }
  return null;
}

/**
 * 登録シートを読む。
 * 商品名と属性は DBシート側を正とする（登録シートの B・C は数式でも値でもよいので、
 * どちらの作りでも同じ結果になる）。DBシートに無い JAN のときだけ、
 * 登録シートに書かれている値を使う。
 */
function readRegister_() {
  var sh = registerSheet_();
  if (sh.getLastRow() < 2) return [];

  var values = sh.getRange(2, COL.JAN, sh.getLastRow() - 1, 4).getValues();
  var db = dbIndex_();

  return values.map(function (v, i) {
    var jan = normJan_(v[0]);
    var hit = db[jan];
    var expiry = toYMD_(v[3]);
    return {
      row: i + 2,
      jan: jan,
      name: (hit ? hit.name : '') || String(v[1] || '').trim(),
      attr: (hit ? hit.attr : '') || String(v[2] || '').trim(),
      inDb: !!hit,
      expiry: expiry,
      daysLeft: expiry ? daysUntil_(expiry) : null
    };
  }).filter(function (r) {
    return r.jan || r.expiry;      // 完全な空行は落とす
  });
}

/** DBシート全体を JAN -> {name, attr} の辞書にする（一覧で1行ずつ引かないため）。 */
function dbIndex_() {
  var sh = dbSheet_();
  var out = {};
  if (sh.getLastRow() < 2) return out;
  var values = sh.getRange(2, COL.JAN, sh.getLastRow() - 1, 3).getValues();
  values.forEach(function (v) {
    var jan = normJan_(v[0]);
    if (!jan || out[jan]) return;                 // 先に出てきた行を優先する
    out[jan] = { name: String(v[1] || '').trim(), attr: String(v[2] || '').trim() };
  });
  return out;
}

/** 同じ JAN の登録履歴。後から登録したものほど下の行にあるので、行番号の降順。 */
function recentByJan_(jan, limit) {
  return readRegister_()
    .filter(function (r) { return r.jan === jan && r.expiry; })
    .sort(function (a, b) { return b.row - a.row; })
    .slice(0, limit);
}

// ---------------------------------------------------------------- ログ

function logSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(LOG_SHEET);
  if (!sh) {
    sh = ss.insertSheet(LOG_SHEET);
    sh.appendRow(LOG_HEADER);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, LOG_HEADER.length).setFontWeight('bold');
  }
  return sh;
}

function log_(op, row, note, user) {
  try {
    logSheet_().appendRow([new Date(), op, row, note, user]);
  } catch (e) {
    console.warn('ログ書き込み失敗: ' + errText_(e));   // ログが書けなくても本処理は止めない
  }
}

function userName_(v) {
  return String(v || '').trim().slice(0, 40) || '(未設定)';
}

// ---------------------------------------------------------------- 日付・値の正規化

function todayYMD_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

/** セルの値（Date でも文字列でも）を yyyy-MM-dd に正規化する。 */
function toYMD_(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  }
  return normYMD_(v);
}

/** 2026-09-01 / 2026/9/1 / 2026年9月1日 のどれでも受ける。 */
function normYMD_(v) {
  var m = String(v).trim().match(/^(\d{4})[-\/年.](\d{1,2})[-\/月.](\d{1,2})/);
  if (!m) return '';
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return y + '-' + pad2_(mo) + '-' + pad2_(d);
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** yyyy-MM-dd を、そのタイムゾーンの「その日」を表す Date にする。 */
function ymdToDate_(ymd) {
  var p = ymd.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

/**
 * 今日から見た残り日数。
 * カレンダー日どうしの引き算にして、時刻やタイムゾーンの影響を受けないようにする。
 */
function daysUntil_(ymd) {
  var a = String(ymd).split('-');
  var b = todayYMD_().split('-');
  var t1 = Date.UTC(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
  var t2 = Date.UTC(Number(b[0]), Number(b[1]) - 1, Number(b[2]));
  return Math.round((t1 - t2) / 86400000);
}

function normJan_(v) {
  if (v === null || v === undefined) return '';
  // Sheets が数値として持っていると 4.9012E+12 になるので、指数表記を避けて文字列化する
  if (typeof v === 'number') v = v.toFixed(0);
  return String(v).replace(/[^0-9]/g, '');
}

function soonDays_() {
  var n = Number(prop_('SOON_DAYS'));
  return (!n || isNaN(n) || n < 0) ? DEFAULT_SOON_DAYS : n;
}

function byDaysLeft_(a, b) { return a.daysLeft - b.daysLeft; }

/**
 * "7,3,1" や [7,3,1] を、重複なし・昇順の数値配列にする。
 * 読めない値は黙って捨てる（1つ壊れていても他の日は通知したいため）。
 */
function parseDays_(v) {
  if (v === undefined || v === null || v === '') return [];
  var arr = Object.prototype.toString.call(v) === '[object Array]' ? v : String(v).split(/[,、\s]+/);
  var out = [];
  arr.forEach(function (x) {
    var s = String(x).trim();
    if (!s) return;
    var n = Math.floor(Number(s));
    if (!isNaN(n) && n >= 0 && out.indexOf(n) < 0) out.push(n);
  });
  return out.sort(function (a, b) { return a - b; });   // 差し迫っている方から
}

function notifyDays_() {
  var d = parseDays_(prop_('NOTIFY_DAYS'));
  return d.length ? d : DEFAULT_NOTIFY_DAYS.slice();
}
