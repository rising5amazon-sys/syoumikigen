/**
 * 画面テスト用のサーバー。
 *   - docs/ をそのまま配信する
 *   - 同じオリジンで GAS の代わりも返す（Google には一切繋がない）
 *   - /e2e で操作テストのページを返す
 *
 * 単体で起動すればブラウザから手で触ることもできる:
 *   node tests/e2e/server.mjs
 *   → http://127.0.0.1:5058/e2e   （自動テスト）
 *   → http://127.0.0.1:5058/e2e-cam （カメラの読み取りテスト。偽のカメラ映像が要る）
 *   → http://127.0.0.1:5058/      （手で触る。接続先は下の config.js で入っている）
 *   → http://127.0.0.1:5058/empty/index.html （config.js が空の場合。接続先の入力から）
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 基準はこのファイルの位置から解決する（どのPCに置いても動くように）
const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
const HARNESS = fileURLToPath(new URL('./harness.html', import.meta.url));
const HARNESS_CAM = fileURLToPath(new URL('./harness-cam.html', import.meta.url));

export const PORT = 5058;   // ブラウザが拒否する 5060/5061 を避けている
const PASS = 'himitsu123';
let lastAdd = null;   // 直前に addItem で受けた内容（テストから確認する）

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'
};

// 「今日」を 2026-08-27 と決め打ちした固定データ。
// 登録シート（A:JAN B:商品名 C:属性 D:賞味期限）を読んだ結果の形にしてある。
const ITEMS = [
  { row: 137, jan: '4901234567894', name: '明治おいしい牛乳 900ml', attr: '食品', expiry: '2026-08-24', daysLeft: -3, inDb: true },
  // 商品名に HTML を混ぜて、そのまま描画されないことを確かめる
  { row: 138, jan: '4902102072618', name: '<img src=x onerror=alert(1)>ハム', attr: '食品', expiry: '2026-08-29', daysLeft: 2, inDb: true },
  { row: 139, jan: '4901777018888', name: '絹ごし豆腐', attr: '食品', expiry: '2026-08-27', daysLeft: 0, inDb: true },
  { row: 140, jan: '4901005202078', name: 'カップヌードル', attr: '駄菓子', expiry: '2026-12-31', daysLeft: 126, inDb: true },
  // DBシートに無い JAN。一覧では「DB未登録」と出る。
  { row: 141, jan: '4900000000000', name: 'DBに無い商品', attr: '', expiry: '2026-09-03', daysLeft: 7, inDb: false }
];

// 賞味期限が空の行（商品リストを貼っただけの行）。all=1 のときだけ返す。
const NO_EXPIRY = [
  { row: 2, jan: '4902181097526', name: 'なとり JPお得なカルパス 28g', attr: '食品', expiry: '', daysLeft: null, inDb: true },
  { row: 3, jan: '49480795', name: 'うまいぼうたこ焼き', attr: '駄菓子', expiry: '', daysLeft: null, inDb: true }
];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const path = req.url.split('?')[0];
    const json = (o) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(o));
    };

    if (path === '/gas') {
      let p;
      try { p = JSON.parse(body); } catch (e) { return json({ ok: false, error: '不正なリクエスト' }); }

      if (p.action === 'ping') {
        return json({ ok: true, data: {
          name: 'テスト', sheet: 'テスト用スプレッドシート', timezone: 'Asia/Tokyo',
          registerSheet: '登録', dbSheet: 'DB', dbCount: 135, sheetErrors: [],
          today: '2026-08-27', soonDays: 7, notifyDays: [1, 3, 7], passcodeSet: true,
          janSources: { yahoo: false, rakuten: false, openFoodFacts: true }
        } });
      }
      if (p.pass !== PASS) return json({ ok: false, error: 'パスコードが違います', code: 'BAD_PASS' });

      if (p.action === 'list') {
        const all = String(p.payload.all || '') === '1';
        return json({ ok: true, data: {
          items: all ? ITEMS.concat(NO_EXPIRY) : ITEMS,
          noExpiryCount: NO_EXPIRY.length,
          today: '2026-08-27', soonDays: 7
        } });
      }
      // 4909999999999 だけ「DBシートに無い JAN」として扱う。
      // 画面が商品名・属性を空にして「入力」を促すかを確かめるため。
      if (p.action === 'lookup') {
        if (p.payload.jan === '4909999999999') {
          return json({ ok: true, data: {
            jan: p.payload.jan, found: false, name: '', attr: '',
            suggest: { name: '外部DBの候補 300g', source: 'Open Food Facts' },
            skipped: ['Yahoo!ショッピング: YAHOO_APP_ID 未設定のためスキップ'],
            history: []
          } });
        }
        return json({ ok: true, data: {
          jan: p.payload.jan, found: true, name: 'テスト商品 500ml', attr: '食品', source: 'db',
          history: [{ expiry: '2026-08-30', daysLeft: 3, row: 130 }]
        } });
      }
      if (p.action === 'addItem') {
        lastAdd = p.payload;
        return json({ ok: true, data: {
          row: 143, jan: p.payload.jan, name: p.payload.name, attr: p.payload.attr,
          expiry: p.payload.expiry, daysLeft: 3, newProduct: p.payload.jan === '4909999999999'
        } });
      }
      // 直前の登録内容をテストから覗くための口（テスト専用）
      if (p.action === '_lastAdd') return json({ ok: true, data: lastAdd || {} });
      return json({ ok: false, error: '不明な操作です: ' + p.action });
    }

    // 画面が読む config.js はテスト用の値を返す。
    // docs/config.js に本番の値が入っていてもテストが変わらないようにするため
    // （テストが Google に繋ぎに行かないようにする、という意味でもある）。
    if (path === '/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(`window.SMK_CONFIG = { url: '/gas', pass: '${PASS}' };\n`);
    }

    // /empty/ 以下は「config.js が空のまま配られた状態」を再現する。
    // 画面は config.js を相対パスで読むので、/empty/index.html からは /empty/config.js になる。
    if (path === '/empty/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end("window.SMK_CONFIG = { url: '', pass: '' };\n");
    }

    // テストが終わるまで load イベントを待たせるための口。
    // --dump-dom は load のあとに DOM を吐くので、これが無いと
    // テストの途中の（まだ 'running' の）DOM を掴んでしまう。
    // 応答しないまま置いておき、テスト側が img を消して打ち切る。
    if (path === '/wait') {
      const t = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('timeout');
      }, 90000);
      req.on('close', () => clearTimeout(t));
      return;
    }

    if (path === '/e2e') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(HARNESS));
    }

    // カメラの読み取りテスト。偽のカメラ映像にバーコードを流して走らせる。
    if (path === '/e2e-cam') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(HARNESS_CAM));
    }

    const rel = path.startsWith('/empty/') ? path.slice('/empty/'.length) : path.replace(/^\//, '');
    const file = DOCS + (rel === '' ? 'index.html' : rel);
    if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': (TYPES[ext] || 'text/plain') + '; charset=utf-8' });
    res.end(readFileSync(file));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ready on http://127.0.0.1:${PORT}/  (自動テストは /e2e、パスコードは ${PASS})`);
});
