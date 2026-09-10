/**
 * 通知スクリプト (.github/scripts/notify.mjs) を、GAS と Slack の代わりの偽サーバー相手に
 * 実際に走らせて確かめる。Slack にも GAS にも本当には繋がない。
 *
 *   node tests/notify.test.mjs
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import assert from 'node:assert';

const SCRIPT = new URL('../.github/scripts/notify.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// 7日前・3日前・前日ちょうどのものが返ってくる想定（絞り込みは GAS 側でやっている）
const DUE = {
  today: '2026-08-27',
  notifyDays: [1, 3, 7],
  expired: [
    { row: 137, jan: '4901234567894', name: '明治おいしい牛乳 900ml', attr: '食品', expiry: '2026-08-24', daysLeft: -3, inDb: true },
    // Slack の mrkdwn で悪さをしうる文字が混ざった商品名（外部DB由来を想定）
    { row: 138, jan: '4902102072618', name: '<b>特売</b> & ハム', attr: '食品', expiry: '2026-08-26', daysLeft: -1, inDb: true }
  ],
  soon: [
    { row: 139, jan: '4901777018888', name: '絹ごし豆腐', attr: '食品', expiry: '2026-08-28', daysLeft: 1, inDb: true },
    { row: 140, jan: '4909411000000', name: '食パン', attr: '食品', expiry: '2026-08-28', daysLeft: 1, inDb: true },
    { row: 141, jan: '4902220000000', name: 'ヨーグルト', attr: '食品', expiry: '2026-08-30', daysLeft: 3, inDb: true },
    { row: 142, jan: '4901005202078', name: 'カップヌードル', attr: '駄菓子', expiry: '2026-09-03', daysLeft: 7, inDb: true }
  ]
};

const EMPTY = { today: '2026-08-27', notifyDays: [1, 3, 7], expired: [], soon: [] };

// 大量件数（Slack の 50 ブロック上限に当たるか）
const MANY = {
  today: '2026-08-27', notifyDays: [1, 3, 7], expired: [],
  soon: Array.from({ length: 400 }, (_, i) => ({
    row: 200 + i, jan: '49' + String(i).padStart(11, '0'),
    name: '商品' + i + 'あいうえおかきくけこさしすせそ', expiry: '2026-08-30',
    attr: '食品', daysLeft: 3, inDb: true
  }))
};

const slackPosts = [];
let lastGasPayload = null;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); return res; };

    if (req.url.startsWith('/gas')) {
      const parsed = JSON.parse(body);
      if (parsed.pass !== 'testpass') return json().end(JSON.stringify({ ok: false, error: 'パスコードが違います' }));
      if (parsed.action !== 'due') return json().end(JSON.stringify({ ok: false, error: '不明な操作です' }));
      lastGasPayload = parsed.payload;
      const set = req.url.includes('empty') ? EMPTY : req.url.includes('many') ? MANY : DUE;
      return json().end(JSON.stringify({ ok: true, data: set }));
    }
    if (req.url.startsWith('/slack')) {
      slackPosts.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    res.writeHead(404); res.end('nope');
  });
});

function run(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], {
      env: { ...process.env, ...env }, encoding: 'utf8'
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

let pass = 0, fail = 0;
async function test(label, fn) {
  slackPosts.length = 0;
  try { await fn(); console.log('  OK   ' + label); pass++; }
  catch (e) { console.log('  FAIL ' + label + '\n       ' + e.message); fail++; }
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const base = { GAS_PASSCODE: 'testpass', SLACK_WEBHOOK_URL: `http://127.0.0.1:${port}/slack` };
  const gas = (path = '') => `http://127.0.0.1:${port}/gas${path}`;

  console.log('\n--- 通知 ---');

  await test('対象があれば Slack に送る', async () => {
    const r = await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(slackPosts.length, 1);
    const b = slackPosts[0].blocks;
    assert.strictEqual(b[0].type, 'header');
    assert.ok(JSON.stringify(b).includes('期限切れ 2件'));
    assert.ok(slackPosts[0].text.includes('まもなく期限 4件'), slackPosts[0].text);
  });

  await test('残り日数ごとにまとまり、差し迫っている順に並ぶ', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false' });
    const heads = slackPosts[0].blocks
      .filter((x) => x.type === 'section' && x.text.text.startsWith(':alarm_clock:'))
      .map((x) => x.text.text);
    assert.deepStrictEqual(heads, [
      ':alarm_clock: *明日まで（2026-08-28）* 2件',
      ':alarm_clock: *あと3日（2026-08-30）* 1件',
      ':alarm_clock: *あと7日（2026-09-03）* 1件'
    ], JSON.stringify(heads, null, 2));
  });

  await test('属性が通知本文に出る（通知先を分けたくなったとき用）', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false' });
    const text = JSON.stringify(slackPosts[0].blocks);
    assert.ok(text.includes('絹ごし豆腐* ｜食品'), '属性が出ていない: ' + text.slice(0, 400));
    assert.ok(text.includes('カップヌードル* ｜駄菓子'), '属性が出ていない');
  });

  await test('通知する日の設定が本文に書かれる', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false' });
    const ctx = slackPosts[0].blocks.find((x) => x.type === 'context');
    assert.ok(ctx.elements[0].text.includes('7日前・3日前・前日に通知'), ctx.elements[0].text);
  });

  await test('GAS に渡す通知日は NOTIFY_DAYS から来る', async () => {
    const r = await run({ ...base, GAS_URL: gas(), DRY_RUN: 'true', NOTIFY_DAYS: '5,2' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.deepStrictEqual(lastGasPayload, { days: '5,2' }, JSON.stringify(lastGasPayload));
  });

  await test('DRY-RUN では送らない（外部への送信は既定でOFF）', async () => {
    const r = await run({ ...base, GAS_URL: gas(), DRY_RUN: 'true' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(slackPosts.length, 0, 'DRY-RUN なのに送信された');
    assert.ok(r.stdout.includes('DRY-RUN'));
  });

  await test('商品名の < > & がエスケープされる', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false' });
    const text = JSON.stringify(slackPosts[0].blocks);
    assert.ok(text.includes('&lt;b&gt;特売&lt;/b&gt; &amp; ハム'), 'エスケープされていない');
  });

  await test('0件なら既定では送らない', async () => {
    const r = await run({ ...base, GAS_URL: gas('?empty=1'), DRY_RUN: 'false' });
    assert.strictEqual(r.code, 0, r.stderr);
    assert.strictEqual(slackPosts.length, 0);
  });

  await test('0件でも NOTIFY_WHEN_EMPTY=true なら送る', async () => {
    await run({ ...base, GAS_URL: gas('?empty=1'), DRY_RUN: 'false', NOTIFY_WHEN_EMPTY: 'true' });
    assert.strictEqual(slackPosts.length, 1);
    assert.ok(slackPosts[0].text.includes('異常なし'));
  });

  await test('件数が多くても Slack の上限に収まり、黙って落とさない', async () => {
    await run({ ...base, GAS_URL: gas('?many=1'), DRY_RUN: 'false' });
    const b = slackPosts[0].blocks;
    const text = JSON.stringify(b);

    assert.ok(b.length <= 50, 'ブロック数が ' + b.length + ' 個で上限50を超えた');
    b.filter((x) => x.type === 'section').forEach((s) => {
      assert.ok(s.text.text.length <= 3000, 'section が 3000 文字を超えた（' + s.text.text.length + '）');
    });

    // 全件載っているか、載らなかったなら「省略した」と明記されているか。どちらでもないのは駄目。
    const missing = MANY.soon.filter((i) => !text.includes(i.name));
    if (missing.length) {
      assert.ok(text.includes('省略'), missing.length + '件が黙って落ちている');
    }
  });

  await test('APP_URL があれば一覧へのリンクが付く', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false', APP_URL: 'https://example.com/app/' });
    assert.ok(JSON.stringify(slackPosts[0].blocks).includes('https://example.com/app/'));
  });

  await test('SLACK_MENTION=channel ならチャンネル全員を呼ぶ', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false', SLACK_MENTION: 'channel' });
    assert.strictEqual(slackPosts.length, 1);
    const secs = slackPosts[0].blocks.filter((x) => x.type === 'section').map((x) => x.text.text);
    assert.ok(secs.includes('<!channel>'), 'メンションのブロックが無い: ' + JSON.stringify(secs.slice(0, 3)));
    // 通知プレビュー（blocks を展開しない画面）にも出さないと、誰が呼ばれたか分からない
    assert.ok(slackPosts[0].text.startsWith('<!channel> '), slackPosts[0].text);
  });

  await test('メンションは本文の先頭に出る（中身より先に目に入る）', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false', SLACK_MENTION: 'here' });
    const b = slackPosts[0].blocks;
    const mention = b.findIndex((x) => x.type === 'section' && x.text.text === '<!here>');
    const first = b.findIndex((x) => x.type === 'section' && x.text.text.includes('期限切れ'));
    assert.ok(mention >= 0, 'メンションが無い');
    assert.ok(mention < first, 'メンションが本文より後ろにある');
  });

  await test('対象0件のときはメンションしない（毎朝の異常なしで全員を呼ばない）', async () => {
    await run({ ...base, GAS_URL: gas('?empty=1'), DRY_RUN: 'false', NOTIFY_WHEN_EMPTY: 'true', SLACK_MENTION: 'channel' });
    assert.strictEqual(slackPosts.length, 1, '異常なしの通知そのものは送る');
    const all = JSON.stringify(slackPosts[0]);
    assert.ok(!all.includes('<!channel>'), '0件なのに全員を呼んでいる: ' + all.slice(0, 300));
  });

  await test('メンバーIDをカンマ区切りで複数指定できる', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false', SLACK_MENTION: 'U01ABCDEFG, U02XYZ1234' });
    const secs = slackPosts[0].blocks.filter((x) => x.type === 'section').map((x) => x.text.text);
    assert.ok(secs.includes('<@U01ABCDEFG> <@U02XYZ1234>'), JSON.stringify(secs.slice(0, 3)));
  });

  await test('使えない指定は当てずっぽうで送らず、理由を出す', async () => {
    const r = await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false', SLACK_MENTION: '@yamada, channel' });
    assert.strictEqual(r.code, 0, '1つ駄目でも通知そのものは止めない');
    const all = JSON.stringify(slackPosts[0]);
    assert.ok(all.includes('<!channel>'), '使える方は生きているべき');
    assert.ok(!all.includes('yamada'), '解決できない名前を本文に混ぜている');
    assert.ok(r.stdout.includes('使いませんでした'), '無視したことが実行ログに出ていない: ' + r.stdout.slice(-300));
  });

  await test('SLACK_MENTION が空ならメンションしない（今までどおり）', async () => {
    await run({ ...base, GAS_URL: gas(), DRY_RUN: 'false', SLACK_MENTION: '' });
    const all = JSON.stringify(slackPosts[0]);
    assert.ok(!all.includes('<!'), '勝手にメンションが付いている');
    assert.ok(!slackPosts[0].text.startsWith('<'), slackPosts[0].text);
  });

  console.log('\n--- 失敗のしかた ---');

  await test('パスコードが違えば異常終了する', async () => {
    const r = await run({ ...base, GAS_PASSCODE: 'wrong', GAS_URL: gas(), DRY_RUN: 'false' });
    assert.notStrictEqual(r.code, 0, '失敗したのに正常終了した');
    assert.ok(r.stderr.includes('パスコード'));
    assert.strictEqual(slackPosts.length, 0);
  });

  await test('Secrets が無ければ異常終了する', async () => {
    const r = await run({ GAS_URL: gas(), GAS_PASSCODE: '', SLACK_WEBHOOK_URL: '', DRY_RUN: 'false' });
    assert.notStrictEqual(r.code, 0);
    assert.ok(r.stderr.includes('環境変数'));
  });

  await test('GASに繋がらなければ異常終了する', async () => {
    const r = await run({ ...base, GAS_URL: 'http://127.0.0.1:1/gas', DRY_RUN: 'false' });
    assert.notStrictEqual(r.code, 0);
    assert.strictEqual(slackPosts.length, 0);
  });

  console.log(`\n=== ${pass} 件成功 / ${fail} 件失敗 ===`);
  server.close();
  process.exit(fail ? 1 : 0);
});
