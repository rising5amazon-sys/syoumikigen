/**
 * セットアップ用のメニュー。
 * スプレッドシートを開くと上部に「賞味期限管理」メニューが出る。
 * 開発者でない担当者でも、ここから設定を確認・変更できるようにしてある。
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('賞味期限管理')
    .addItem('① 使うシートを確かめる / 整える', 'setupSheets')
    .addItem('② パスコードを設定する', 'setPasscode')
    .addSeparator()
    .addItem('使うシートを指定する', 'setSheetTargets')
    .addItem('通知する日を変える（既定: 7日前・3日前・前日）', 'setNotifyDays')
    .addItem('画面で色が変わる日数を変える（既定: 7日）', 'setSoonDays')
    .addItem('JANコードDBのAPIキーを設定する', 'setJanKeys')
    .addSeparator()
    .addItem('接続情報を表示する', 'showConnectionInfo')
    .addToUi();
}

/**
 * 使うシートを確かめ、列の書式だけを整える。何度実行しても安全。
 *
 * 登録シート・DBシートは利用者が作ったものを使う（勝手に作らない）。
 * 見つからないときは「どこを直せばよいか」を出して止める。
 * ログシートだけは無ければ作る。
 */
function setupSheets() {
  var lines = [];

  var reg = null, db = null;
  try { reg = registerSheet_(); } catch (e) { lines.push('✕ ' + errText_(e)); }
  try { db = dbSheet_(); } catch (e) { lines.push('✕ ' + errText_(e)); }

  if (reg) {
    // JANコードは 13桁の数値として扱われると 4.9012E+12 になるので、必ず文字列書式にする
    reg.getRange(1, COL.JAN, reg.getMaxRows(), 1).setNumberFormat('@');
    reg.getRange(2, COL.EXPIRY, reg.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
    lines.push('○ 登録シート: ' + reg.getName()
      + '（gid ' + reg.getSheetId() + ' / ' + Math.max(0, reg.getLastRow() - 1) + '行）'
      + '\n    A:JAN  B:商品名  C:属性  D:賞味期限 として読み書きします');
  }
  if (db) {
    db.getRange(1, COL.JAN, db.getMaxRows(), 1).setNumberFormat('@');
    lines.push('○ DBシート: ' + db.getName()
      + '（gid ' + db.getSheetId() + ' / ' + Math.max(0, db.getLastRow() - 1) + '件）'
      + '\n    A:JAN  B:商品名  C:属性 として読み書きします');
  }

  var logExisted = !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  var log = logSheet_();
  log.getRange(2, 1, log.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  lines.push('○ ログシート: ' + LOG_SHEET + (logExisted ? '' : '（作成しました）'));

  ui_().alert('シートの確認結果',
    lines.join('\n\n')
    + '\n\n'
    + ((reg && db)
      ? '次は「② パスコードを設定する」に進んでください。'
      : '上の ✕ を直してから、もう一度実行してください。\n'
        + '「使うシートを指定する」でシート名を直接指定できます。'),
    ui_().ButtonSet.OK);
}

/**
 * 登録シート・DBシートを名前（または gid）で指定する。
 * 既定は gid で特定しているので、ふつうは触らなくてよい。
 * スプレッドシートを複製した・シートを作り直した ときのための逃げ道。
 */
function setSheetTargets() {
  var props = PropertiesService.getScriptProperties();
  var names = SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) {
    return '  ' + s.getName() + '（gid ' + s.getSheetId() + '）';
  }).join('\n');

  var res = ui_().prompt(
    '使うシートを指定する',
    'このスプレッドシートのシート:\n' + names + '\n\n'
    + '現在の指定:\n'
    + '  登録シート … ' + (prop_('REGISTER_SHEET') || '（既定: gid ' + GID.REGISTER + '）') + '\n'
    + '  DBシート … ' + (prop_('DB_SHEET') || '（既定: gid ' + GID.DB + '）') + '\n\n'
    + '「register=シート名」または「db=シート名」の形式で入力してください。\n'
    + 'gid の数字でも指定できます。空にすると既定に戻します（例: register=）。',
    ui_().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui_().Button.OK) return;

  var m = res.getResponseText().trim().match(/^(register|db)\s*=\s*(.*)$/i);
  if (!m) {
    ui_().alert('形式が違います。 register=シート名 または db=シート名 のように入力してください。');
    return;
  }
  var key = m[1].toLowerCase() === 'register' ? 'REGISTER_SHEET' : 'DB_SHEET';
  var val = m[2].trim();
  if (val) props.setProperty(key, val);
  else props.deleteProperty(key);

  // 指定した先が本当に使えるかを、その場で確かめて伝える
  var msg;
  try {
    var sh = key === 'REGISTER_SHEET' ? registerSheet_() : dbSheet_();
    msg = (val ? key + ' を「' + val + '」にしました。' : key + ' を既定に戻しました。')
      + '\n\n実際に使うシート: ' + sh.getName() + '（gid ' + sh.getSheetId() + '）';
  } catch (e) {
    msg = '設定しましたが、そのシートは使えません:\n\n' + errText_(e);
  }
  ui_().alert(msg);
}

function setPasscode() {
  var cur = prop_('PASSCODE');
  var res = ui_().prompt(
    'パスコードの設定',
    'このパスコードを知っている人だけが登録・閲覧できます。\n'
    + '担当者に URL と一緒に伝えてください。\n'
    + (cur ? '\n現在: 設定済み（先頭2文字 ' + cur.slice(0, 2) + '**）' : '\n現在: 未設定'),
    ui_().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui_().Button.OK) return;

  var v = res.getResponseText().trim();
  if (v.length < 6) {
    ui_().alert('6文字以上にしてください。');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('PASSCODE', v);
  ui_().alert('設定しました。\n\nGitHub の Secrets にも同じ値を GAS_PASSCODE として登録してください。');
}

function setNotifyDays() {
  var cur = notifyDays_();
  var res = ui_().prompt(
    '通知する日',
    'Slack に通知する日を、カンマ区切りで入れてください。\n'
    + '賞味期限まで「ちょうどその日数」の商品だけが通知されます。\n'
    + '（「以内」ではないので、同じ商品が毎日通知されることはありません）\n\n'
    + '現在: ' + describeDays_(cur) + '　（' + cur.join(',') + '）\n\n'
    + '例) 7,3,1 … 7日前・3日前・前日\n'
    + '例) 3,1,0 … 3日前・前日・当日\n\n'
    + '※ 期限切れの商品は、この設定にかかわらず毎回通知されます。',
    ui_().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui_().Button.OK) return;

  var days = parseDays_(res.getResponseText());
  if (!days.length) {
    ui_().alert('数字が読み取れませんでした。7,3,1 のように入れてください。');
    return;
  }
  if (days.some(function (d) { return d > 365; })) {
    ui_().alert('365 以下の数字にしてください。');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('NOTIFY_DAYS', days.join(','));
  ui_().alert(describeDays_(days) + ' に通知するようにしました。\n\n'
    + '※ 通知の時刻を変えるには GitHub 側（.github/workflows/expiry-notify.yml）を直します。');
}

function setSoonDays() {
  var res = ui_().prompt(
    '画面で色が変わる日数',
    '一覧画面で、賞味期限まであと何日から色を付けますか？\n'
    + 'これは見た目だけの設定で、Slack 通知には影響しません。\n\n'
    + '現在: ' + soonDays_() + '日',
    ui_().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui_().Button.OK) return;

  var n = Number(res.getResponseText().trim());
  if (!n || isNaN(n) || n < 0 || n > 365) {
    ui_().alert('0〜365 の数字を入れてください。');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('SOON_DAYS', String(Math.floor(n)));
  ui_().alert('あと ' + Math.floor(n) + ' 日から色を付けるようにしました。');
}

/** [1,3,7] を「7日前・3日前・前日」と読める形にする。 */
function describeDays_(days) {
  return days.slice().sort(function (a, b) { return b - a; }).map(function (d) {
    return d === 0 ? '当日' : d === 1 ? '前日' : d + '日前';
  }).join('・');
}

function setJanKeys() {
  var props = PropertiesService.getScriptProperties();
  var st = janSourceStatus_();

  var res = ui_().prompt(
    'JANコードDBのAPIキー',
    '未知のJANコードを読んだとき、商品名の候補を自動で取ってきます。\n'
    + '設定しなくても手入力で登録できます（その分だけ縮退します）。\n\n'
    + '現在:\n'
    + '  Yahoo!ショッピング … ' + (st.yahoo ? '設定済み' : '未設定') + '\n'
    + '  楽天市場 … ' + (st.rakuten ? '設定済み' : '未設定') + '\n'
    + '  Open Food Facts … 常に利用可（キー不要）\n\n'
    + '「yahoo=アプリID」または「rakuten=アプリID」の形式で入力してください。\n'
    + '空にして OK を押すと、その項目を削除します（例: yahoo=）。',
    ui_().ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui_().Button.OK) return;

  var m = res.getResponseText().trim().match(/^(yahoo|rakuten)\s*=\s*(.*)$/i);
  if (!m) {
    ui_().alert('形式が違います。 yahoo=xxxx または rakuten=xxxx のように入力してください。');
    return;
  }
  var key = m[1].toLowerCase() === 'yahoo' ? 'YAHOO_APP_ID' : 'RAKUTEN_APP_ID';
  var val = m[2].trim();
  if (val) {
    props.setProperty(key, val);
    ui_().alert(key + ' を設定しました。');
  } else {
    props.deleteProperty(key);
    ui_().alert(key + ' を削除しました。');
  }
}

function showConnectionInfo() {
  var url = '';
  try {
    url = ScriptApp.getService().getUrl();
  } catch (e) {
    url = '';
  }
  var pass = prop_('PASSCODE');

  ui_().alert(
    '接続情報',
    (url
      ? '接続URL:\n' + url + '\n\n'
      : '接続URL: まだデプロイされていません。\n'
        + '［デプロイ］→［新しいデプロイ］→ 種類「ウェブアプリ」\n'
        + '  次のユーザーとして実行: 自分\n'
        + '  アクセスできるユーザー: 全員\n'
        + 'で公開してから、もう一度ここを開いてください。\n\n')
    + 'パスコード: ' + (pass ? '設定済み（先頭2文字 ' + pass.slice(0, 2) + '**）' : '未設定')
    + '\n登録シート: ' + sheetLabel_('REGISTER')
    + '\nDBシート: ' + sheetLabel_('DB')
    + '\n通知する日: ' + describeDays_(notifyDays_())
    + '\n画面で色が変わる日数: あと' + soonDays_() + '日'
    + '\n\n担当者にはこの2つを伝えてください。'
    + '\nGitHub Secrets には GAS_URL / GAS_PASSCODE として登録してください。',
    ui_().ButtonSet.OK);
}

/** 接続情報の表示用。掴めないときは理由をそのまま出す。 */
function sheetLabel_(kind) {
  try {
    var sh = kind === 'REGISTER' ? registerSheet_() : dbSheet_();
    return sh.getName() + '（gid ' + sh.getSheetId() + '）';
  } catch (e) {
    return '× ' + errText_(e);
  }
}

function ui_() {
  return SpreadsheetApp.getUi();
}
