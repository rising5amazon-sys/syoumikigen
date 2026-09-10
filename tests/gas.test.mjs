/**
 * GAS のサーバー側ロジックを、Google のサービスを偽物に差し替えて node 上で動かす。
 * 目的は「シートに入れた値が、そのまま正しく読み戻せるか」を実際に確かめること。
 *
 * 扱うシートは利用者の実物と同じ形にしてある。
 *   登録シート（gid 0）        … A:JAN  B:商品名  C:属性  D:賞味期限
 *   DBシート（gid 391546061）  … A:JAN  B:商品名  C:属性
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

// 基準はこのファイルの位置から解決する（どのPCに置いても動くように）
const GAS_DIR = new URL('../gas/', import.meta.url);

// ---------------------------------------------------------------- 偽スプレッドシート

/**
 * 値と数式を別に持つ。
 * 数式列（B列が VLOOKUP になっているシート）でも試したいので、
 * getFormulas() が本物と同じように「数式のあるセルだけ文字列を返す」ようにしている。
 */
function makeSheet(name, gid) {
  const rows = [];        // rows[r-1][c-1] = 値
  const formulas = [];    // formulas[r-1][c-1] = '=...'（無いセルは undefined）
  const formats = [];

  const at = (grid, r, c) => (grid[r - 1] && grid[r - 1][c - 1] !== undefined ? grid[r - 1][c - 1] : '');
  const put = (grid, r, c, v) => {
    if (!grid[r - 1]) grid[r - 1] = [];
    grid[r - 1][c - 1] = v;
  };

  const api = {
    name, gid, rows, formulas, formats,
    getName: () => name,
    getSheetId: () => gid,
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    getMaxRows: () => Math.max(rows.length, 1000),
    appendRow: (r) => { rows.push(r.slice()); return api; },
    setFrozenRows: () => api,
    autoResizeColumns: () => api,

    /** テスト用: 数式が入っている列を作る（値は数式の結果として別に置く）。 */
    seedFormula: (r, c, formula, computed) => {
      put(formulas, r, c, formula);
      put(rows, r, c, computed);
    },

    getRange: (r, c, nr = 1, nc = 1) => ({
      getValue: () => at(rows, r, c),
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const line = [];
          for (let j = 0; j < nc; j++) line.push(at(rows, r + i, c + j));
          out.push(line);
        }
        return out;
      },
      getFormulas: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const line = [];
          for (let j = 0; j < nc; j++) line.push(at(formulas, r + i, c + j));
          out.push(line);
        }
        return out;
      },
      setValue: (v) => { put(rows, r, c, v); },
      setValues: (vals) => {
        vals.forEach((line, i) => line.forEach((v, j) => put(rows, r + i, c + j, v)));
      },
      setNumberFormat: (f) => {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) put(formats, r + i, c + j, f);
      },
      setFontWeight: () => {}
    })
  };
  return api;
}

const GID_REGISTER = 0;
const GID_DB = 391546061;

let sheetList = [];
const sheetByName = (n) => sheetList.filter((s) => s.getName() === n)[0] || null;

const SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getName: () => '賞味期限管理（テスト）',
    getSheets: () => sheetList.slice(),
    getSheetByName: (n) => sheetByName(n),
    insertSheet: (n) => {
      const s = makeSheet(n, 900000 + sheetList.length);
      sheetList.push(s);
      return s;
    }
  }),
  getUi: () => { throw new Error('UI は使わない'); }
};

/** 各テスト群の前に、利用者の実物と同じ形のシートを組み直す。 */
function resetSheets() {
  const reg = makeSheet('登録', GID_REGISTER);
  reg.appendRow(['JAN', '商品名', '属性', '賞味期限']);
  // 商品リストを貼っただけの行（賞味期限が空）。実物にも135行ある。
  reg.appendRow(['4902181097526', 'なとり JPお得なカルパス 28g', '食品', '']);
  reg.appendRow(['49480795', 'うまいぼうたこ焼き', '駄菓子', '']);

  const db = makeSheet('DB', GID_DB);
  db.appendRow(['JAN', '商品名', '属性']);
  db.appendRow(['4902181097526', 'なとり JPお得なカルパス 28g', '食品']);
  db.appendRow(['49480795', 'うまいぼうたこ焼き', '駄菓子']);
  db.appendRow([4902105948743, 'ぶっこみ飯　シーフードヌードル味', '食品']);   // 数値で持たれている場合

  sheetList = [reg, db];
  return { reg, db };
}

let SHEETS = resetSheets();

// ---------------------------------------------------------------- その他の偽サービス

const props = new Map([['PASSCODE', 'himitsu123'], ['SOON_DAYS', '7']]);

function pad(n) { return (n < 10 ? '0' : '') + n; }

// ---------------------------------------------------------------- 「今日」を固定する
//
// 実行した日によってテスト結果が変わらないようにする。todayYMD_() だけを差し替えると、
// ログの日時（Code.gs が直接 new Date() で書く値）が本物の今日のままになり、
// たまたま TODAY と同じ日に書いたテストが翌日から落ちる。
// なので「引数なしの new Date()（＝現在時刻）」だけを固定日時に差し替える。
// 引数付き（ymdToDate_ の new Date(y, m, d) など）と Date.UTC / Date.parse は本物のまま。

const TODAY = '2026-08-27';
const NOW = new Date(2026, 7, 27, 10, 0, 0);   // ローカル時刻。Utilities.formatDate の偽物と揃える

class FixedDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(NOW.getTime());
    else super(...args);
  }
  static now() { return NOW.getTime(); }
}

const ctx = {
  console,
  Map, Set, JSON, Math, Number, String, Object, Array, RegExp, Error, isNaN,
  Date: FixedDate,

  SpreadsheetApp,
  Session: { getScriptTimeZone: () => 'Asia/Tokyo' },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => props.set(k, v),
      deleteProperty: (k) => props.delete(k)
    })
  },
  CacheService: {
    getScriptCache: () => ({ get: () => null, put: () => {} })   // キャッシュ無効で毎回実照会
  },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    // スクリプトの TZ とローカル TZ が同じ場合の GAS と同じ挙動にする
    formatDate: (d, tz, fmt) => {
      const s = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      return fmt === 'yyyy-MM-dd' ? s
        : s + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
  },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: (t) => ({ setMimeType: () => ({ _text: t, getContent: () => t }) })
  },
  UrlFetchApp: {
    fetch: (url) => {
      // Open Food Facts だけ「見つかった」ことにする
      if (url.indexOf('openfoodfacts') >= 0 && url.indexOf('4901777018888') >= 0) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            status: 1, product: { product_name_ja: '絹ごし豆腐 300g', brands: 'テスト食品, 別名' }
          })
        };
      }
      if (url.indexOf('openfoodfacts') >= 0) {
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ status: 0 }) };
      }
      if (url.indexOf('rakuten') >= 0) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ Items: [{ Item: { itemName: '【送料無料】 テスト商品 まとめ買い' } }] })
        };
      }
      return { getResponseCode: () => 500, getContentText: () => 'error' };
    }
  }
};

vm.createContext(ctx);
for (const f of ['Code.gs', 'Jan.gs']) {
  vm.runInContext(readFileSync(new URL(f, GAS_DIR), 'utf8'), ctx, { filename: f });
}

// todayYMD_ は差し替えない。上の FixedDate が効いているので、GAS 側のコードが
// new Date() を使っている場所（ログの日時）も揃って TODAY になる。

// ---------------------------------------------------------------- テスト

let pass = 0, fail = 0;
function test(label, fn) {
  try { fn(); console.log('  OK   ' + label); pass++; }
  catch (e) { console.log('  FAIL ' + label + '\n       ' + e.message); fail++; }
}
function call(action, payload, passcode = 'himitsu123') {
  const out = vm.runInContext('handle_', ctx)({ action, pass: passcode, payload });
  return JSON.parse(out._text);
}
const reg = () => SHEETS.reg;
const db = () => SHEETS.db;

console.log('\n--- 認証 ---');
test('パスコードが違えば拒否される', () => {
  const r = call('list', {}, 'wrong');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'BAD_PASS');
});
test('ping はパスコード無しでも通る', () => {
  const r = call('ping', {}, '');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.passcodeSet, true);
});
test('未知の操作は拒否される', () => {
  assert.strictEqual(call('drop_everything', {}).ok, false);
});

console.log('\n--- どのシートを掴むか ---');
test('gid で登録シートとDBシートを見つける', () => {
  const d = call('ping', {}, '').data;
  assert.strictEqual(d.registerSheet, '登録');
  assert.strictEqual(d.dbSheet, 'DB');
  assert.strictEqual(d.dbCount, 3);
  assert.deepStrictEqual(Array.from(d.sheetErrors), []);
});
test('プロパティでシート名を指定できる', () => {
  props.set('DB_SHEET', 'DB');
  assert.strictEqual(call('ping', {}, '').data.dbSheet, 'DB');
  props.delete('DB_SHEET');
});
test('存在しないシートを指定したら、当てずっぽうで他のシートを使わない', () => {
  props.set('REGISTER_SHEET', 'そんなシートは無い');
  const r = call('list', {});
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('見つかりません') >= 0, r.error);
  props.delete('REGISTER_SHEET');
});
test('A1 が JAN でないシートを掴んだら書き込みを中止する', () => {
  const other = makeSheet('関係ないシート', 555);
  other.appendRow(['日付', 'メモ']);
  sheetList.push(other);
  props.set('REGISTER_SHEET', '関係ないシート');

  const r = call('addItem', { jan: '4900000000099', name: 'あぶない', attr: '食品', expiry: '2026-09-01' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf('A1') >= 0, r.error);
  assert.strictEqual(other.getLastRow(), 1, '関係ないシートに書き込んでしまった');

  props.delete('REGISTER_SHEET');
  sheetList = sheetList.filter((s) => s !== other);
});

console.log('\n--- 照会 ---');
test('DBシートにある JAN は商品名と属性を返す', () => {
  const d = call('lookup', { jan: '4902181097526' }).data;
  assert.strictEqual(d.found, true);
  assert.strictEqual(d.source, 'db');
  assert.strictEqual(d.name, 'なとり JPお得なカルパス 28g');
  assert.strictEqual(d.attr, '食品');
});
test('DBシートが数値で持っている13桁JANも引ける', () => {
  const d = call('lookup', { jan: '4902105948743' }).data;
  assert.strictEqual(d.found, true);
  assert.strictEqual(d.attr, '食品');
});
test('DBシートに無い JAN は商品名・属性を空で返す（画面が「入力」を出せるように）', () => {
  const d = call('lookup', { jan: '4901777018888' }).data;
  assert.strictEqual(d.found, false);
  assert.strictEqual(d.name, '', '外部の候補を欄に入れてしまっている');
  assert.strictEqual(d.attr, '');
});
test('外部DBの候補は suggest として別に返る（確定ではないため）', () => {
  const d = call('lookup', { jan: '4901777018888' }).data;
  assert.strictEqual(d.suggest.name, 'テスト食品 絹ごし豆腐 300g');
  assert.strictEqual(d.suggest.source, 'Open Food Facts');
});
test('外部DBにも無ければ候補も空で、理由が付く', () => {
  const d = call('lookup', { jan: '4900000000000' }).data;
  assert.strictEqual(d.suggest.name, '');
  assert.ok(d.skipped.join(' ').indexOf('未設定') >= 0, '未設定の理由が入っていない');
});
test('APIキーを入れると楽天も候補に入り、販促文が落ちる', () => {
  props.set('RAKUTEN_APP_ID', 'dummy');
  const d = call('lookup', { jan: '4900000000001' }).data;
  assert.strictEqual(d.suggest.name, 'テスト商品 まとめ買い');
  props.delete('RAKUTEN_APP_ID');
});
test('ハイフン入りの JAN も受け付ける', () => {
  assert.strictEqual(call('lookup', { jan: '4901-777-018888' }).data.jan, '4901777018888');
});

console.log('\n--- 登録（A列とD列に書く） ---');
test('DBにある商品は、登録シートに1行足すだけ（DBは増えない）', () => {
  const dbBefore = db().getLastRow();
  const r = call('addItem', {
    jan: '4902181097526', name: 'なとり JPお得なカルパス 28g', attr: '食品',
    expiry: '2026-08-30', user: '山田'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.newProduct, false);
  assert.strictEqual(r.data.daysLeft, 3);
  assert.strictEqual(db().getLastRow(), dbBefore, 'DBシートに重複追加された');

  const row = reg().rows[r.data.row - 1];
  assert.strictEqual(row[0], '4902181097526', 'A列にJANが入っていない');
  assert.strictEqual(ctx.toYMD_(row[3]), '2026-08-30', 'D列に賞味期限が入っていない');
});
test('既存の行は書き換えず、末尾に足す', () => {
  assert.strictEqual(ctx.toYMD_(reg().rows[1][3]), '', '期限が空だった既存行を書き換えた');
  assert.strictEqual(reg().rows[1][0], '4902181097526');
});
test('DBに無い商品は、DBシートにも JAN・商品名・属性が足される', () => {
  const r = call('addItem', {
    jan: '4901777018888', name: '絹ごし豆腐 300g', attr: '食品',
    expiry: '2026-09-03', user: '鈴木'
  });
  assert.strictEqual(r.data.newProduct, true);
  const last = db().rows[db().getLastRow() - 1];
  assert.deepStrictEqual(last.slice(0, 3), ['4901777018888', '絹ごし豆腐 300g', '食品']);
});
test('2回目はDBに重複追加しない', () => {
  const before = db().getLastRow();
  const r = call('addItem', {
    jan: '4901777018888', name: '絹ごし豆腐 300g', attr: '食品',
    expiry: '2026-09-30', user: '鈴木'
  });
  assert.strictEqual(r.data.newProduct, false);
  assert.strictEqual(db().getLastRow(), before);
});
test('属性は自由入力。DBに無い属性でもそのまま入る', () => {
  const r = call('addItem', {
    jan: '4900000000031', name: '洗剤', attr: '日用品', expiry: '2027-01-31', user: '佐藤'
  });
  assert.strictEqual(r.data.attr, '日用品');
  assert.strictEqual(db().rows[db().getLastRow() - 1][2], '日用品');
});
test('商品名が空なら登録を拒否する（シートも触らない）', () => {
  const before = reg().getLastRow();
  const r = call('addItem', { jan: '4902181097526', name: '  ', attr: '食品', expiry: '2026-09-01' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(reg().getLastRow(), before);
});
test('賞味期限が不正なら登録を拒否する', () => {
  assert.strictEqual(
    call('addItem', { jan: '49017', name: 'x', attr: '食品', expiry: 'あした' }).ok, false);
});
test('スラッシュ区切りの日付も受け付ける', () => {
  const r = call('addItem', {
    jan: '4900000000009', name: '牛乳', attr: '食品', expiry: '2026/9/1', user: '佐藤'
  });
  assert.strictEqual(r.data.expiry, '2026-09-01');
});
test('属性が空でも登録できる（画面側で新規のときだけ必須にしている）', () => {
  const r = call('addItem', {
    jan: '4900000000011', name: '卵', attr: '', expiry: '2026-08-20', user: '佐藤'
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(r.data.attr, '');
});
test('担当者が空でも落ちず、ログに (未設定) と残る', () => {
  call('addItem', { jan: '4900000000012', name: '納豆', attr: '食品', expiry: '2026-08-29' });
  const log = sheetByName('ログ').rows;
  assert.strictEqual(log[log.length - 1][4], '(未設定)');
});
test('操作がログシートに残る', () => {
  const log = sheetByName('ログ').rows;
  assert.ok(log.length > 5, 'ログが記録されていない');
  assert.ok(log.some((r) => r[1] === '登録'), '登録ログが無い');
  assert.ok(log.some((r) => String(r[3]).indexOf('DBシートに追加') >= 0), '新規追加のログが無い');
});

console.log('\n--- B列・C列の扱い（数式でも値でも壊さない） ---');
test('値だけのシートでは、商品名と属性も書いて人が読める形にする', () => {
  const r = call('addItem', {
    jan: '4900000000040', name: 'ポテトチップス', attr: '駄菓子', expiry: '2026-10-01', user: '山田'
  });
  const row = reg().rows[r.data.row - 1];
  assert.strictEqual(row[1], 'ポテトチップス');
  assert.strictEqual(row[2], '駄菓子');
});
test('B列が数式のシートでは、B列に触らない（#REF! を撒かない）', () => {
  SHEETS = resetSheets();
  // B列を VLOOKUP にしてあるシートを作る
  SHEETS.reg.seedFormula(2, 2, '=VLOOKUP($A2,DB!$A:$C,2,FALSE)', 'なとり JPお得なカルパス 28g');
  SHEETS.reg.seedFormula(3, 2, '=VLOOKUP($A3,DB!$A:$C,2,FALSE)', 'うまいぼうたこ焼き');

  const r = call('addItem', {
    jan: '4902181097526', name: 'なとり JPお得なカルパス 28g', attr: '食品',
    expiry: '2026-08-30', user: '山田'
  });
  const row = r.data.row;
  assert.strictEqual(SHEETS.reg.rows[row - 1][1], undefined, '数式列に値を書き込んでしまった');
  assert.strictEqual(SHEETS.reg.rows[row - 1][0], '4902181097526');
  assert.strictEqual(ctx.toYMD_(SHEETS.reg.rows[row - 1][3]), '2026-08-30');
});
test('数式で埋まる列でも、一覧の商品名はDBシートから引けている', () => {
  const items = call('list', {}).data.items;
  const added = items.filter((i) => i.expiry === '2026-08-30')[0];
  assert.strictEqual(added.name, 'なとり JPお得なカルパス 28g');
  assert.strictEqual(added.attr, '食品');
});

console.log('\n--- 読み戻し（ここがいちばん壊れやすい） ---');
SHEETS = resetSheets();
call('addItem', { jan: '4902181097526', name: 'カルパス', attr: '食品', expiry: '2026-08-30', user: '山田' });
call('addItem', { jan: '4900000000009', name: '牛乳', attr: '食品', expiry: '2026-09-01', user: '佐藤' });
call('addItem', { jan: '4900000000011', name: '卵', attr: '食品', expiry: '2026-08-20', user: '佐藤' });

test('Date として書いた賞味期限が yyyy-MM-dd で読み戻る', () => {
  const items = call('list', {}).data.items;
  assert.strictEqual(items.filter((i) => i.jan === '4902181097526')[0].expiry, '2026-08-30');
});
test('残り日数が正しい（未来・過去）', () => {
  const byJan = {};
  call('list', {}).data.items.forEach((i) => { byJan[i.jan] = i; });
  assert.strictEqual(byJan['4902181097526'].daysLeft, 3);    // 2026-08-30
  assert.strictEqual(byJan['4900000000009'].daysLeft, 5);    // 2026-09-01
  assert.strictEqual(byJan['4900000000011'].daysLeft, -7);   // 2026-08-20
});
test('商品名と属性は DBシート側を正とする', () => {
  // 登録では 'カルパス' と送ったが、DBシートには元の長い名前が入っている
  const it = call('list', {}).data.items.filter((i) => i.jan === '4902181097526')[0];
  assert.strictEqual(it.name, 'なとり JPお得なカルパス 28g');
  assert.strictEqual(it.inDb, true);
});
test('賞味期限が空の行は既定の一覧に出ない（件数だけ知らせる）', () => {
  const d = call('list', {}).data;
  assert.ok(d.items.every((i) => !!i.expiry), '期限が空の行が混ざった');
  assert.strictEqual(d.noExpiryCount, 2, '実際: ' + d.noExpiryCount);
});
test('all=1 なら賞味期限が空の行も返る', () => {
  const d = call('list', { all: '1' }).data;
  assert.strictEqual(d.items.length, 5);
  assert.strictEqual(d.items.filter((i) => !i.expiry).length, 2);
});
test('13桁の JAN が指数表記に化けない', () => {
  const items = call('list', { all: '1' }).data.items;
  assert.ok(items.every((i) => /^[0-9]+$/.test(i.jan)),
    '数字以外が混じった: ' + JSON.stringify(items.map((i) => i.jan)));
  // シートが数値として持っていた場合も想定して直接検証する
  assert.strictEqual(ctx.normJan_(4901777018888), '4901777018888');
});
test('同じ JAN の登録履歴が、後に登録したものから返る', () => {
  call('addItem', { jan: '4902181097526', name: 'カルパス', attr: '食品', expiry: '2026-12-01', user: '山田' });
  const h = call('lookup', { jan: '4902181097526' }).data.history;
  assert.strictEqual(h.length, 2);
  assert.strictEqual(h[0].expiry, '2026-12-01', '新しい登録が先に来ていない');
  assert.ok(h[0].row > h[1].row);
});

console.log('\n--- 通知用の抽出（7日前・3日前・前日）---');
SHEETS = resetSheets();
// 各しきい値ちょうどのものと、あえて外したもの（5日後）を用意する
call('addItem', { jan: '4900000000050', name: '絹ごし豆腐', attr: '食品', expiry: '2026-08-28', user: '山田' }); // 1日後
call('addItem', { jan: '4900000000051', name: 'ヨーグルト', attr: '食品', expiry: '2026-08-30', user: '山田' }); // 3日後
call('addItem', { jan: '4900000000052', name: '牛乳', attr: '食品', expiry: '2026-09-01', user: '山田' });       // 5日後
call('addItem', { jan: '4900000000053', name: '味噌', attr: '食品', expiry: '2026-09-03', user: '山田' });       // 7日後
call('addItem', { jan: '4900000000054', name: '卵', attr: '食品', expiry: '2026-08-20', user: '山田' });         // -7日

const names = (arr) => arr.map((i) => i.name).sort();

test('既定は 7日前・3日前・前日', () => {
  assert.deepStrictEqual(call('due', {}).data.notifyDays, [1, 3, 7]);
});
test('「ちょうどその日数」のものだけ通知する（以内では拾わない）', () => {
  const d = call('due', {}).data;
  assert.deepStrictEqual(names(d.soon), ['ヨーグルト', '味噌', '絹ごし豆腐'],
    '実際: ' + JSON.stringify(names(d.soon)));
  assert.ok(!names(d.soon).includes('牛乳'), '5日後の商品が通知に混ざった（以内で拾っている）');
});
test('期限切れは日数にかかわらず毎回通知される', () => {
  assert.deepStrictEqual(names(call('due', {}).data.expired), ['卵']);
});
test('賞味期限が空の行は通知に載らない', () => {
  const d = call('due', { days: '0,1,2,3,4,5,6,7' }).data;
  assert.ok(d.soon.concat(d.expired).every((i) => !!i.expiry));
});
test('days を渡すとその日だけになる', () => {
  const d = call('due', { days: '5' }).data;
  assert.deepStrictEqual(d.notifyDays, [5]);
  assert.deepStrictEqual(names(d.soon), ['牛乳'], '実際: ' + JSON.stringify(names(d.soon)));
});
test('スクリプトプロパティ NOTIFY_DAYS が効く', () => {
  props.set('NOTIFY_DAYS', '3, 5');
  const d = call('due', {}).data;
  assert.deepStrictEqual(d.notifyDays, [3, 5]);
  assert.deepStrictEqual(names(d.soon), ['ヨーグルト', '牛乳']);
  props.delete('NOTIFY_DAYS');
});
test('差し迫っている順に並ぶ', () => {
  const order = call('due', { days: '1,3,7' }).data.soon.map((i) => i.daysLeft);
  assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b), JSON.stringify(order));
});
test('当日(0)も指定できる', () => {
  call('addItem', { jan: '4900000000055', name: '刺身', attr: '食品', expiry: '2026-08-27', user: '山田' });
  assert.deepStrictEqual(names(call('due', { days: '0' }).data.soon), ['刺身']);
});
test('通知には属性も乗る（通知先を分けたくなったとき用）', () => {
  assert.ok(call('due', { days: '1' }).data.soon.every((i) => i.attr === '食品'));
});

console.log('\n--- 通知する日の指定の読み取り ---');
// vm の中で作られた配列はこちらの Array とは別物になるので、素の配列に写してから比べる
const days = (v) => Array.from(ctx.parseDays_(v));

test('カンマ・全角読点・空白のどれでも区切れる', () => {
  assert.deepStrictEqual(days('7,3,1'), [1, 3, 7]);
  assert.deepStrictEqual(days('7、3、1'), [1, 3, 7]);
  assert.deepStrictEqual(days(' 7 , 3 , 1 '), [1, 3, 7]);
  assert.deepStrictEqual(days([7, 3, 1]), [1, 3, 7]);
});
test('重複は取り除く', () => {
  assert.deepStrictEqual(days('3,3,1,3'), [1, 3]);
});
test('読めない値は捨てるが、他の日は生かす', () => {
  assert.deepStrictEqual(days('7,あした,3,-2'), [3, 7], '負の数や文字が通ってしまった');
});
test('空なら空配列を返し、既定値に落ちる', () => {
  assert.deepStrictEqual(days(''), []);
  assert.deepStrictEqual(days('あした'), []);
  assert.deepStrictEqual(Array.from(ctx.notifyDays_()), [1, 3, 7]);
});

console.log('\n--- 日付の正規化 ---');
test('いろいろな書き方を受け付ける', () => {
  assert.strictEqual(ctx.normYMD_('2026-09-01'), '2026-09-01');
  assert.strictEqual(ctx.normYMD_('2026/9/1'), '2026-09-01');
  assert.strictEqual(ctx.normYMD_('2026年9月1日'), '2026-09-01');
  assert.strictEqual(ctx.normYMD_('2026.9.1'), '2026-09-01');
});
test('不正な日付は空文字にする', () => {
  ['', 'あした', '2026-13-01', '2026-09-32', '26-9-1'].forEach((v) => {
    assert.strictEqual(ctx.normYMD_(v), '', v + ' が通ってしまった');
  });
});
test('月またぎ・年またぎの日数計算', () => {
  assert.strictEqual(ctx.daysUntil_('2026-09-03'), 7);
  assert.strictEqual(ctx.daysUntil_('2027-08-27'), 365);
  assert.strictEqual(ctx.daysUntil_('2026-08-27'), 0);
});

console.log(`\n=== ${pass} 件成功 / ${fail} 件失敗 ===`);
if (fail) process.exitCode = 1;
