/**
 * 期限が近い／切れている商品を GAS から取得して Slack に通知する。
 *
 * 依存パッケージなし（Node 20 の組み込み fetch のみ）。
 * GAS 側は読み取り（due）しか呼ばないので、この処理でデータが変わることはない。
 *
 * 必要な環境変数:
 *   GAS_URL            … GAS ウェブアプリの /exec URL
 *   GAS_PASSCODE       … GAS のスクリプト プロパティ PASSCODE と同じ値
 *   SLACK_WEBHOOK_URL  … Slack の Incoming Webhook URL
 * 任意:
 *   NOTIFY_DAYS        … 通知する日をカンマ区切りで（例 "7,3,1"）。未指定ならスプレッドシート側の設定。
 *                        「以内」ではなく「ちょうどその日数」の商品だけを通知する
 *   DRY_RUN            … "true" なら Slack に送らず内容を表示するだけ
 *   NOTIFY_WHEN_EMPTY  … "true" なら対象0件でも「異常なし」を送る（既定は送らない）
 *   APP_URL            … 一覧画面の URL。通知の末尾にリンクとして付ける
 *   SLACK_MENTION      … 通知の先頭に付けるメンション。"channel" / "here" / メンバーID（U…）を
 *                        カンマ区切りで指定する。空ならメンションしない。
 *                        対象0件のときは付けない（毎朝の「異常なし」で全員を呼ばないため）
 */

import { appendFileSync } from 'node:fs';

const env = process.env;
const DRY_RUN = String(env.DRY_RUN || '').toLowerCase() === 'true';
const NOTIFY_WHEN_EMPTY = String(env.NOTIFY_WHEN_EMPTY || '').toLowerCase() === 'true';

function required(name) {
  const v = env[name];
  if (!v) {
    console.error(`環境変数 ${name} が設定されていません。GitHub の Secrets を確認してください。`);
    process.exit(1);
  }
  return v;
}

/** GitHub Actions の実行結果ページに出す要約。ローカル実行では何もしない。 */
function summary(md) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, md + '\n');
  console.log(md);
}

async function fetchDue() {
  const url = required('GAS_URL');
  const payload = { days: env.NOTIFY_DAYS || '' };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'due', pass: required('GAS_PASSCODE'), payload }),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`GAS への接続に失敗しました (HTTP ${res.status})`);

  const json = await res.json();
  if (!json.ok) throw new Error(`GAS がエラーを返しました: ${json.error}`);
  return json.data;
}

/** 期限切れは1件ずつ超過日数が違うので、行ごとに日付を出す。 */
function expiredLine(item) {
  return `• *${escapeMrkdwn(item.name)}* — ${-item.daysLeft}日超過（${item.expiry}）${attrSuffix(item)}`;
}

/** まもなく期限のものは日ごとにまとめるので、行には商品名と属性だけ出す。 */
function soonLine(item) {
  return `• *${escapeMrkdwn(item.name)}*${attrSuffix(item)}`;
}

/** 属性は将来通知先を分ける手掛かりになるので、あれば添える。 */
function attrSuffix(item) {
  return item.attr ? ` ｜${escapeMrkdwn(item.attr)}` : '';
}

/** 7 → 「あと7日」、1 → 「明日まで」、0 → 「今日まで」 */
function dayLabel(d) {
  return d === 0 ? '今日まで' : d === 1 ? '明日まで' : `あと${d}日`;
}

/** [1,3,7] → 「7日前・3日前・前日」。設定内容を人が読める形で通知に添える。 */
function describeDays(days) {
  if (!days || !days.length) return '通知する日の設定なし';
  return days.slice().sort((a, b) => b - a)
    .map((d) => (d === 0 ? '当日' : d === 1 ? '前日' : `${d}日前`))
    .join('・');
}

/** Slack の mrkdwn で特別扱いされる文字を無害化する。商品名は外部由来なので必ず通す。 */
function escapeMrkdwn(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slack の section は 3000 文字上限。溢れないように分割する。 */
function sections(lines) {
  const out = [];
  let buf = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + 1 > 2800) {
      out.push({ type: 'section', text: { type: 'mrkdwn', text: buf.join('\n') } });
      buf = [];
      len = 0;
    }
    buf.push(l);
    len += l.length + 1;
  }
  if (buf.length) out.push({ type: 'section', text: { type: 'mrkdwn', text: buf.join('\n') } });
  return out;
}

/**
 * 通知の先頭に付けるメンションを組み立てる。
 *
 * 通知専用チャンネルに全件を流す運用なので、既定の想定は "channel"（そのチャンネルの全員）。
 * 誰に届くかは「チャンネルに誰を招待したか」で決まり、名簿をどこかに持つ必要がない。
 * 人が増減してもチャンネルに招待/退出するだけで済む。
 *
 * 値は GitHub の Variables（SLACK_MENTION）に置く。Secrets ではないので、
 * ブラウザから誰でも見て直せる。認証情報ではないため隠す理由がない。
 *
 *   空          … メンションしない
 *   channel     … <!channel>（チャンネル全員。オフラインの人にも通知が飛ぶ）
 *   here        … <!here>（いまオンラインの人だけ）
 *   U01ABCDEFG  … その人だけ。カンマ区切りで複数書ける
 *   S01ABCDEFG  … ユーザーグループ
 *
 * 形が違うものは当てずっぽうで <@…> にせず、使わずに理由を出す。
 * Slack は「@表示名」という文字列には反応しないので、黙って通すと
 * 「送ったのに誰も呼ばれていない」ことに気づけないため。
 */
function mentionParts() {
  const raw = String(env.SLACK_MENTION || '').trim();
  if (!raw) return { text: '', ignored: [] };

  const good = [];
  const ignored = [];
  for (const token of raw.split(/[,\s]+/).filter(Boolean)) {
    const v = token.replace(/^@/, '');
    if (/^channel$/i.test(v)) good.push('<!channel>');
    else if (/^here$/i.test(v)) good.push('<!here>');
    else if (/^[UW][A-Z0-9]{6,}$/.test(v)) good.push('<@' + v + '>');
    else if (/^S[A-Z0-9]{6,}$/.test(v)) good.push('<!subteam^' + v + '>');
    else ignored.push(token);
  }
  return { text: [...new Set(good)].join(' '), ignored };
}

function buildMessage(data) {
  const { expired = [], soon = [], today, notifyDays = [] } = data;
  const total = expired.length + soon.length;

  const blocks = [{
    type: 'header',
    text: { type: 'plain_text', text: total ? '賞味期限のお知らせ' : '賞味期限チェック：異常なし', emoji: true }
  }];

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `基準日 ${today} ／ ${describeDays(notifyDays)}に通知` }]
  });

  // メンションは対象があるときだけ付ける。
  // 「異常なし」で毎朝チャンネル全員を呼び出すと、すぐ誰も見なくなるため。
  const mention = mentionParts();
  if (total && mention.text) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: mention.text } });
  }

  if (expired.length) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:rotating_light: *期限切れ ${expired.length}件*` } });
    blocks.push(...sections(expired.map(expiredLine)));
  }

  // まもなく期限のものは残り日数ごとにまとめる。
  // 「あと1日が3件、あと3日が5件」のように、何をいつまでに片付ければよいかが一目で分かる。
  if (soon.length) {
    const groups = new Map();
    for (const item of soon) {
      if (!groups.has(item.daysLeft)) groups.set(item.daysLeft, []);
      groups.get(item.daysLeft).push(item);
    }
    for (const d of [...groups.keys()].sort((a, b) => a - b)) {
      const items = groups.get(d);
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `:alarm_clock: *${dayLabel(d)}（${items[0].expiry}）* ${items.length}件` }
      });
      blocks.push(...sections(items.map(soonLine)));
    }
  }

  if (!total) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '通知の対象はありません。' } });
  }

  if (env.APP_URL) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${env.APP_URL}|一覧を開く>` }] });
  }

  // Slack の blocks は50個まで。超える分は切り、切ったことを明記する（黙って削らない）。
  let trimmed = 0;
  if (blocks.length > 49) {
    trimmed = blocks.length - 49;
    blocks.length = 49;
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `※ 件数が多いため一部を省略しました（${trimmed}ブロック分）。一覧画面で確認してください。` }]
    });
  }

  const fallback = total
    ? `賞味期限: 期限切れ ${expired.length}件 / まもなく期限 ${soon.length}件`
    : '賞味期限チェック：異常なし';

  return {
    text: total && mention.text ? mention.text + ' ' + fallback : fallback,
    blocks,
    _total: total,
    _trimmed: trimmed,
    _mention: mention
  };
}

async function postToSlack(message) {
  const url = required('SLACK_WEBHOOK_URL');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message.text, blocks: message.blocks })
  });
  const body = await res.text();
  if (!res.ok || body.trim() !== 'ok') {
    throw new Error(`Slack への送信に失敗しました (HTTP ${res.status}): ${body}`);
  }
}

async function main() {
  const data = await fetchDue();
  const message = buildMessage(data);

  summary('## 賞味期限チェック');
  summary(`- 基準日: ${data.today}`);
  summary(`- 通知する日: ${describeDays(data.notifyDays)}（期限切れは日数にかかわらず毎回通知）`);
  summary(`- 期限切れ: ${data.expired.length}件 / まもなく期限: ${data.soon.length}件`);
  if (message._trimmed) summary(`- 注意: 件数が多く、通知の一部を省略しました`);
  if (message._mention.text) summary('- メンション: ' + message._mention.text + '（対象があるときだけ付きます）');
  if (message._mention.ignored.length) {
    summary('- **注意: SLACK_MENTION の「' + message._mention.ignored.join('」「')
      + '」は形が違うので使いませんでした。** channel / here / メンバーID（U で始まる英数字）'
      + 'で指定してください。@表示名では Slack は反応しません。');
  }

  for (const item of [...data.expired, ...data.soon]) {
    summary(`  - ${item.name} / ${item.attr || '属性なし'} / ${item.expiry} / ${item.daysLeft}日 / 登録シート ${item.row}行目`);
  }

  if (DRY_RUN) {
    summary('- **DRY-RUN のため Slack には送信していません。**');
    console.log(JSON.stringify(message.blocks, null, 2));
    return;
  }
  if (!message._total && !NOTIFY_WHEN_EMPTY) {
    summary('- 対象0件のため送信しませんでした（NOTIFY_WHEN_EMPTY=true で毎日送れます）。');
    return;
  }

  await postToSlack(message);
  summary('- Slack に送信しました。');
}

main().catch((err) => {
  console.error(err.message);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(err.message ? `\n:x: 失敗: ${err.message}\n` : '');
  }
  process.exit(1);
});

⚠️ 最後の3行だけ、上のコードブロックが壊れている。 貼ったあと、末尾を手で直して：

main().catch((err) => {
  console.error(err.message);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `\n:x: 失敗: ${err.message}\n`);
  }
  process.exit(1);
});
