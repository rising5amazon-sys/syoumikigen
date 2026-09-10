/**
 * JANコードから商品名を引く（外部サービス照会）。
 *
 * ここをサーバー側（GAS）に置いている理由:
 *   1. ブラウザから外部APIを直接叩くと CORS で失敗する
 *   2. APIキーを画面のソースに置きたくない（GitHub Pages は public リポジトリのため）
 *
 * 取得できた名前は「候補」であって確定ではない。画面側では必ず編集可能な欄に入れ、
 * 人が確認してから登録する。当てずっぽうで登録しない。
 *
 * キーが未設定のサービスは、理由を添えてスキップするだけで他をブロックしない。
 * （スクリプト プロパティ: YAHOO_APP_ID / RAKUTEN_APP_ID）
 */

var JAN_CACHE_SEC = 60 * 60 * 24 * 7;   // 一度引けた名前は1週間キャッシュ

function lookupExternal_(jan) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('jan:' + jan);
  if (cached) {
    var c = JSON.parse(cached);
    c.skipped = ['キャッシュから取得'];
    return c;
  }

  var skipped = [];
  var sources = [];

  var yahooId = prop_('YAHOO_APP_ID');
  if (yahooId) sources.push({ label: 'Yahoo!ショッピング', fn: function () { return fromYahoo_(jan, yahooId); } });
  else skipped.push('Yahoo!ショッピング: YAHOO_APP_ID 未設定のためスキップ');

  var rakutenId = prop_('RAKUTEN_APP_ID');
  if (rakutenId) sources.push({ label: '楽天市場', fn: function () { return fromRakuten_(jan, rakutenId); } });
  else skipped.push('楽天市場: RAKUTEN_APP_ID 未設定のためスキップ');

  // キー不要。食品中心なので賞味期限管理とは相性が良いが、日本の商品は網羅していない。
  sources.push({ label: 'Open Food Facts', fn: function () { return fromOpenFoodFacts_(jan); } });

  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    try {
      var name = cleanName_(s.fn());
      if (name) {
        var result = { name: name, source: s.label };
        cache.put('jan:' + jan, JSON.stringify(result), JAN_CACHE_SEC);
        result.skipped = skipped;
        return result;
      }
      skipped.push(s.label + ': 該当なし');
    } catch (e) {
      // 1つ落ちても他は続ける
      skipped.push(s.label + ': 照会失敗 (' + errText_(e) + ')');
    }
  }

  return { name: '', source: '', skipped: skipped };
}

/** ping で「どのサービスが使える状態か」を返すため。 */
function janSourceStatus_() {
  return {
    yahoo: !!prop_('YAHOO_APP_ID'),
    rakuten: !!prop_('RAKUTEN_APP_ID'),
    openFoodFacts: true
  };
}

// ---------------------------------------------------------------- 各サービス

function fromYahoo_(jan, appId) {
  var url = 'https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch'
    + '?appid=' + encodeURIComponent(appId)
    + '&jan_code=' + encodeURIComponent(jan)
    + '&results=1';
  var res = fetchJson_(url);
  var hits = res && res.hits;
  return (hits && hits.length) ? hits[0].name : '';
}

function fromRakuten_(jan, appId) {
  var url = 'https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601'
    + '?applicationId=' + encodeURIComponent(appId)
    + '&keyword=' + encodeURIComponent(jan)
    + '&hits=1&format=json';
  var res = fetchJson_(url);
  var items = res && res.Items;
  if (!items || !items.length) return '';
  // 版によって {Items:[{itemName}]} と {Items:[{Item:{itemName}}]} の両方がある
  var it = items[0].Item || items[0];
  return it.itemName || '';
}

function fromOpenFoodFacts_(jan) {
  var url = 'https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(jan) + '.json'
    + '?fields=product_name,product_name_ja,generic_name_ja,brands';
  var res = fetchJson_(url);
  if (!res || res.status !== 1 || !res.product) return '';
  var p = res.product;
  var name = p.product_name_ja || p.generic_name_ja || p.product_name || '';
  if (name && p.brands) name = String(p.brands).split(',')[0].trim() + ' ' + name;
  return name;
}

// ---------------------------------------------------------------- 共通

function fetchJson_(url) {
  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    validateHttpsCertificates: true,
    headers: { 'User-Agent': 'syoumikigenkanri/1.0 (Google Apps Script)' }
  });
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('HTTP ' + code);
  return JSON.parse(res.getContentText());
}

/**
 * 通販サイトの商品名には販促文が混ざる（【送料無料】〜 ×3セット など）。
 * 人が直す前提で、目に見えて邪魔な部分だけ落として短くする。
 */
function cleanName_(raw) {
  var s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/[【\[（(]\s*(送料無料|あす楽|ポイント\d*倍|まとめ買い|訳あり|クーポン[^】\])）]*)\s*[】\])）]/g, ' ');
  s = s.replace(/^[【\[]\s*[^】\]]{0,12}\s*[】\]]/, ' ');   // 先頭の店舗名タグ
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, 80);
}
