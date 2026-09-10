/* 賞味期限管理 — 画面side
 *
 * 接続先(URL)とパスコードは config.js に置く（全員共通・書き換えたら全員に効く）。
 * 画面が毎回聞くのは「作業する人の名前」だけ。名前は保存せず、候補として履歴だけ残す。
 * config.js が空のときだけ、接続先を入力する画面に落ちる（別のシートで使う場合の逃げ道）。
 */
(function () {
  'use strict';

  // smk.users は「最近使った名前」の候補リスト。誰が作業中かは保存しない（毎回聞く）。
  var LS = {
    url: 'smk.url', pass: 'smk.pass', users: 'smk.users', cache: 'smk.cache',
    cam: 'smk.cam'   // 選んだカメラ（端末ごとに違うので端末に持つ）
  };
  // 読み取りライブラリは同梱している（CDN だと社内プロキシで落ちる・テストが外部に繋がる）。
  // 差し替えるときは docs/vendor/ を入れ替えて、このパスも変える。
  var ZXING_SRC = 'vendor/zxing-0.21.3.min.js';

  // 端末の読み取り機能が動いていても、何も取れないことがある（PC の BarcodeDetector 等）。
  // 黙って読めないままにせず、この時間で ZXing に切り替える。
  var NATIVE_GIVE_UP_MS = 8000;

  // config.js を優先する。全員共通の設定を1か所で変えられるようにするため、
  // 端末に残った古い値（localStorage）に負けないようにしている。
  var baked = window.SMK_CONFIG || {};
  var cfg = {
    url: String(baked.url || localStorage.getItem(LS.url) || '').trim(),
    pass: String(baked.pass || localStorage.getItem(LS.pass) || '').trim(),
    user: ''
  };
  var fixedConn = !!(String(baked.url || '').trim() && String(baked.pass || '').trim());

  var state = {
    soonDays: 7,
    today: '',
    items: [],
    noExpiryCount: 0,   // 登録シートにある「賞味期限が空の行」の数（一覧には出さない）
    sortKey: 'daysLeft',
    sortAsc: true,
    current: null,      // 照会中の商品
    listLoaded: false
  };

  var $ = function (id) { return document.getElementById(id); };

  // ============================================================ 通信

  /**
   * GAS の Web アプリを呼ぶ。
   * Content-Type を text/plain にしているのは意図的で、こうすると CORS のプリフライトが
   * 発生しない。GAS は OPTIONS に応答できないため、application/json にすると必ず失敗する。
   */
  function api(action, payload) {
    if (!cfg.url) return Promise.reject(new Error('接続URLが未設定です'));
    return fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, pass: cfg.pass, payload: payload || {} }),
      redirect: 'follow'
    }).then(function (res) {
      if (!res.ok) throw new Error('サーバーの応答が異常です (HTTP ' + res.status + ')');
      return res.json();
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error || '不明なエラー');
      return j.data;
    }).catch(function (e) {
      if (e instanceof TypeError) {
        throw new Error('接続できません。URLが正しいか、ネットワークが繋がっているか確認してください。');
      }
      throw e;
    });
  }

  // ============================================================ 小道具

  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.add('hidden'); }, isError ? 5000 : 2500);
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function normJan(v) { return String(v || '').replace(/[^0-9]/g, ''); }

  function ymd(date) {
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
  }

  function todayPlus(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return ymd(d);
  }

  function daysUntil(s) {
    if (!s) return null;
    var a = s.split('-'), b = (state.today || ymd(new Date())).split('-');
    return Math.round((Date.UTC(+a[0], a[1] - 1, +a[2]) - Date.UTC(+b[0], b[1] - 1, +b[2])) / 86400000);
  }

  /** [1,3,7] を「7日前・3日前・前日」と読める形にする（設定表示用）。 */
  function describeDays(days) {
    if (!days || !days.length) return '設定なし';
    return days.slice().sort(function (a, b) { return b - a; }).map(function (d) {
      return d === 0 ? '当日' : d === 1 ? '前日' : d + '日前';
    }).join('・');
  }

  /** 残り日数の見せ方。1週間前（既定）から色が付く。 */
  function dueLabel(d) {
    if (d === null || d === undefined) return { text: '—', cls: 'gray' };
    if (d < 0) return { text: '期限切れ ' + (-d) + '日', cls: 'red' };
    if (d === 0) return { text: '今日まで', cls: 'red' };
    if (d <= state.soonDays) return { text: 'あと' + d + '日', cls: 'amber' };
    return { text: 'あと' + d + '日', cls: 'gray' };
  }

  function busy(btn, on, labelWhenBusy) {
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = labelWhenBusy || '…';
      btn.disabled = true;
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      btn.disabled = false;
    }
  }

  // ============================================================ 初回設定 / 設定

  function showScreen(id) {
    ['who', 'setup', 'main'].forEach(function (name) {
      $(name).classList.toggle('hidden', name !== id);
    });
  }

  function showSetup() {
    showScreen('setup');
    $('cfgUrl').value = cfg.url;
    $('cfgPass').value = cfg.pass;
  }

  function showMain() {
    showScreen('main');
    $('jan').focus();
  }

  // ------------------------------------------------ 作業する人（毎回聞く）

  /** 最近使った名前。壊れた値が入っていても画面を止めない。 */
  function recentUsers() {
    try {
      var a = JSON.parse(localStorage.getItem(LS.users) || '[]');
      if (!Array.isArray(a)) return [];
      return a.filter(function (n) { return typeof n === 'string' && n; });
    } catch (e) { return []; }
  }

  function rememberUser(name) {
    var list = recentUsers().filter(function (n) { return n !== name; });
    list.unshift(name);
    localStorage.setItem(LS.users, JSON.stringify(list.slice(0, 8)));
  }

  function forgetUser(name) {
    localStorage.setItem(LS.users, JSON.stringify(
      recentUsers().filter(function (n) { return n !== name; })));
  }

  function renderWhoRecent() {
    var box = $('whoRecent');
    box.textContent = '';
    var list = recentUsers();
    box.classList.toggle('hidden', list.length === 0);
    list.forEach(function (name) {
      box.appendChild(el('div', { class: 'who-chip' }, [
        el('button', {
          class: 'who-pick', type: 'button', text: name,
          onclick: function () { startAs(name, this); }
        }),
        el('button', {
          class: 'who-del', type: 'button', text: '✕',
          'aria-label': name + ' を候補から消す', title: name + ' を候補から消す',
          onclick: function () { forgetUser(name); renderWhoRecent(); }
        })
      ]));
    });
  }

  function showWho() {
    showScreen('who');
    cfg.user = '';
    $('whoName').value = '';
    $('whoMsg').className = 'msg';
    $('whoMsg').textContent = '';
    renderWhoRecent();
    if (!recentUsers().length) $('whoName').focus();

    // どのシートに繋がるのかを、名前を選ぶ前に見せる。ping はパスコード不要。
    $('whoTarget').textContent = '接続先を確認しています…';
    api('ping', {}).then(function (d) {
      $('whoTarget').textContent = '接続先: ' + d.sheet
        + '（' + (d.registerSheet || '登録シートが見つかりません') + '）';
    }).catch(function (e) {
      $('whoTarget').textContent = '接続先に繋がりません: ' + e.message;
    });
  }

  /**
   * 名前を決めて本体に入る。
   * ここで一度 list を呼ぶのは、パスコードが通るかを最初に確かめるため。
   * ping はパスコードを見ないので、通っても書き込めるとは限らない。
   */
  function startAs(name, btn) {
    name = String(name || '').trim();
    var msg = $('whoMsg');
    if (!name) {
      msg.className = 'msg error';
      msg.textContent = '名前を入れてください。';
      $('whoName').focus();
      return;
    }
    cfg.user = name;
    msg.className = 'msg';
    msg.textContent = '接続しています…';
    if (btn) busy(btn, true, '接続中…');

    api('list', { all: '0' })
      .then(function (d) {
        rememberUser(name);
        applyList(d);
        state.listLoaded = true;
        msg.textContent = '';
        showMain();
        toast(name + ' さんとして始めます');
      })
      .catch(function (e) {
        cfg.user = '';
        msg.className = 'msg error';
        msg.textContent = e.message;
      })
      .then(function () { if (btn) busy(btn, false); });
  }

  $('whoGo').addEventListener('click', function () { startAs($('whoName').value, this); });

  $('whoName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); startAs($('whoName').value, $('whoGo')); }
  });

  $('cfgSave').addEventListener('click', function () {
    var btn = this;
    var url = $('cfgUrl').value.trim();
    var pass = $('cfgPass').value.trim();
    var user = $('cfgUser').value.trim();
    var msg = $('cfgMsg');

    if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(url)) {
      msg.className = 'msg error';
      msg.textContent = '接続URLの形式が違います。末尾が /exec のURLを貼ってください。';
      return;
    }
    if (!pass) { msg.className = 'msg error'; msg.textContent = 'パスコードを入れてください。'; return; }
    if (!user) { msg.className = 'msg error'; msg.textContent = '担当者名を入れてください。'; return; }

    cfg = { url: url, pass: pass, user: user };
    busy(btn, true, '接続中…');
    msg.className = 'msg';
    msg.textContent = '接続を確認しています…';

    // ping はパスコード不要。まず疎通、そのあと list で実際にパスコードを検証する。
    api('ping', {})
      .then(function () { return api('list', { all: '0' }); })
      .then(function (d) {
        localStorage.setItem(LS.url, url);
        localStorage.setItem(LS.pass, pass);
        rememberUser(user);
        applyList(d);
        state.listLoaded = true;
        showMain();
        toast('接続しました');
      })
      .catch(function (e) {
        msg.className = 'msg error';
        msg.textContent = e.message;
      })
      .then(function () { busy(btn, false); });
  });

  $('openSettings').addEventListener('click', function () {
    // 接続先が config.js で決まっているときは、ここから変えられないようにする。
    // 端末ごとにバラバラの接続先が残ると、原因の分からない不一致になるため。
    $('setConn').classList.toggle('hidden', fixedConn);
    $('setConnNote').classList.toggle('hidden', !fixedConn);
    $('setUrl').value = cfg.url;
    $('setPass').value = cfg.pass;
    $('setUser').value = cfg.user;
    $('setInfo').textContent = '確認中…';
    $('settings').showModal();
    api('ping', {}).then(function (d) {
      var src = d.janSources || {};
      $('setInfo').textContent =
        'スプレッドシート: ' + d.sheet
        + ' ／ 登録シート: ' + (d.registerSheet || '×')
        + ' ／ DBシート: ' + (d.dbSheet || '×') + '（' + d.dbCount + '件）'
        + ((d.sheetErrors && d.sheetErrors.length) ? ' ／ ' + d.sheetErrors.join(' / ') : '')
        + ' ／ Slack通知: ' + describeDays(d.notifyDays)
        + ' ／ 色分け: あと' + d.soonDays + '日から'
        + ' ／ 商品名の自動取得: '
        + [src.yahoo ? 'Yahoo' : null, src.rakuten ? '楽天' : null, 'OpenFoodFacts']
          .filter(Boolean).join('・');
    }).catch(function (e) {
      $('setInfo').textContent = '接続できません: ' + e.message;
    });
  });

  // 「閉じる」と Esc は何もしない（＝取り消し）。変更が効くのは下の2つを押したときだけ。
  $('setSwitch').addEventListener('click', function () {
    $('settings').close();
    showWho();
  });

  $('setSave').addEventListener('click', function () {
    var user = $('setUser').value.trim();

    if (!fixedConn) {
      var url = $('setUrl').value.trim();
      if (url && !/^https:\/\/.+\/exec/.test(url)) {
        toast('接続URLの形式が違います。末尾が /exec のURLを入れてください。', true);
        return;
      }
      cfg.url = url;
      cfg.pass = $('setPass').value.trim();
      localStorage.setItem(LS.url, cfg.url);
      localStorage.setItem(LS.pass, cfg.pass);
    }
    if (user) { cfg.user = user; rememberUser(user); }

    $('settings').close();
    toast('設定を保存しました');
    loadList();
  });

  // ============================================================ タブ

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
        b.classList.toggle('active', b === btn);
      });
      $('tab-scan').classList.toggle('hidden', btn.dataset.tab !== 'scan');
      $('tab-list').classList.toggle('hidden', btn.dataset.tab !== 'list');
      if (btn.dataset.tab === 'list') loadList();
      else $('jan').focus();
    });
  });

  // ============================================================ 登録タブ

  $('btnLookup').addEventListener('click', doLookup);

  $('jan').addEventListener('keydown', function (e) {
    // USBバーコードリーダーは末尾に Enter を送ってくる。手入力の Enter も同じ扱いでよい。
    if (e.key === 'Enter') { e.preventDefault(); doLookup(); }
  });

  function doLookup() {
    var jan = normJan($('jan').value);
    if (!jan) { toast('JANコードを入力してください', true); return; }
    $('jan').value = jan;

    busy($('btnLookup'), true, '照会中');
    api('lookup', { jan: jan })
      .then(showEntry)
      .catch(function (e) { toast(e.message, true); })
      .then(function () { busy($('btnLookup'), false); });
  }

  /**
   * 照会結果を登録フォームに出す。
   *
   * DBシートに無い JAN のときは、商品名・属性を空にして
   * 「商品名を入力」「属性を入力」と出す。外部のJANコードDBから名前が取れた場合も、
   * それは確定ではないので欄には入れず、押したら入る候補として下に出す。
   */
  function showEntry(d) {
    state.current = d;

    var badge = $('entryBadge');
    badge.textContent = d.found ? 'DBに登録済みの商品' : 'DBに無い商品です';
    badge.className = 'badge ' + (d.found ? 'known' : 'new');

    var nameIn = $('name'), attrIn = $('attr');
    nameIn.value = d.name || '';
    attrIn.value = d.attr || '';
    nameIn.placeholder = d.found ? '商品名' : '商品名を入力';
    attrIn.placeholder = d.found ? '属性' : '属性を入力';

    var note = $('nameNote');
    note.className = 'msg small';
    note.textContent = '';
    var attrNote = $('attrNote');
    attrNote.className = 'msg small';
    attrNote.textContent = '';

    if (d.found) {
      note.textContent = 'JAN ' + d.jan;
    } else {
      note.textContent = 'JAN ' + d.jan + ' はDBシートにありません。'
        + '登録すると、この商品名と属性がDBシートに追加されます。';
      attrNote.textContent = attrHint();
      var sug = d.suggest || {};
      if (sug.name) note.appendChild(suggestChip(sug));
    }

    $('expiry').value = '';

    var hist = $('history'), list = $('historyList');
    list.textContent = '';
    if (d.history && d.history.length) {
      d.history.forEach(function (h) {
        list.appendChild(el('li', {
          text: h.expiry + ' まで（' + dueLabel(h.daysLeft).text + '） / 登録シート ' + h.row + '行目'
        }));
      });
      hist.classList.remove('hidden');
    } else {
      hist.classList.add('hidden');
    }

    $('entry').classList.remove('hidden');
    $('entry').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!d.found) setTimeout(function () { $('name').focus(); }, 300);
  }

  /**
   * 外部のJANコードDBから取れた商品名の候補。押すと商品名欄に入る。
   * 自動では入れない。通販サイトの名前は実物と違うことがあるため。
   */
  function suggestChip(sug) {
    return el('button', {
      class: 'chip',
      type: 'button',
      text: '候補: ' + sug.name + '（' + sug.source + '）を使う',
      onclick: function () { $('name').value = sug.name; $('name').focus(); }
    });
  }

  /**
   * 属性は自由入力。ただし表記がばらけると絞り込みが効かなくなるので、
   * すでに使われている属性を参考として出す（一覧を読んでいるときだけ）。
   */
  function attrHint() {
    var seen = [];
    state.items.forEach(function (r) {
      if (r.attr && seen.indexOf(r.attr) < 0) seen.push(r.attr);
    });
    if (!seen.length) return '';
    return 'すでに使われている属性: ' + seen.slice(0, 6).join(' / ');
  }

  Array.prototype.forEach.call($('expiryQuick').querySelectorAll('button'), function (b) {
    b.addEventListener('click', function () { $('expiry').value = todayPlus(+b.dataset.add); });
  });

  $('btnCancel').addEventListener('click', resetEntry);

  function resetEntry() {
    state.current = null;
    $('entry').classList.add('hidden');
    $('jan').value = '';
    $('jan').focus();
  }

  $('btnSave').addEventListener('click', function () {
    var btn = this;
    if (!state.current) return;

    var name = $('name').value.trim();
    var attr = $('attr').value.trim();
    var expiry = $('expiry').value;

    if (!name) { toast('商品名を入力してください', true); $('name').focus(); return; }
    if (!expiry) { toast('賞味期限を選んでください', true); $('expiry').focus(); return; }

    // 属性はDBシートに載る値なので、新規商品のときだけ入力を促す。
    // すでにDBにある商品では、空でも既存の値を消さない（送っても使われない）。
    if (!state.current.found && !attr) {
      toast('属性を入力してください', true); $('attr').focus(); return;
    }

    var left = daysUntil(expiry);
    if (left !== null && left < 0 &&
        !confirm('この賞味期限は ' + (-left) + '日前で、すでに過ぎています。\nこのまま登録しますか？')) {
      return;
    }

    busy(btn, true, '登録中…');
    api('addItem', {
      jan: state.current.jan,
      name: name,
      attr: attr,
      expiry: expiry,
      user: cfg.user
    }).then(function (d) {
      toast('登録しました: ' + d.name + '（' + dueLabel(d.daysLeft).text + '）'
        + (d.newProduct ? ' ／ DBシートにも追加' : ''));
      pushRecent(d);
      state.listLoaded = false;      // 一覧は次に開いたとき読み直す
      resetEntry();
    }).catch(function (e) {
      toast(e.message, true);
    }).then(function () { busy(btn, false); });
  });

  function pushRecent(d) {
    var ul = $('recentList');
    ul.insertBefore(
      el('li', {
        text: d.name + '（' + (d.attr || '属性なし') + '） / ' + d.expiry + ' まで'
          + (d.newProduct ? ' / DBに新規追加' : '')
      }),
      ul.firstChild);
    while (ul.children.length > 10) ul.removeChild(ul.lastChild);
    $('recent').classList.remove('hidden');
  }

  // ============================================================ カメラ

  var cam = {
    stream: null, timer: null, detector: null, zxing: null,
    last: '', lastAt: 0,
    devices: [],        // 端末のカメラ一覧
    deviceId: '',       // いま掴んでいるカメラ（'' は「facingMode に任せる」）
    engine: '',         // いま何で読んでいるか
    nativeSince: 0
  };

  $('btnCamera').addEventListener('click', function () { startCamera(); });
  $('btnCameraStop').addEventListener('click', stopCamera);

  // カメラを選び直したら掴み直す。選択は端末に覚える。
  $('camPick').addEventListener('change', function () {
    localStorage.setItem(LS.cam, this.value);
    stopStream();
    startCamera(this.value);
  });

  function camSay(msg, isError) {
    var m = $('camMsg');
    m.textContent = msg;
    m.className = 'msg' + (isError ? ' error' : '');
  }

  /**
   * いま何で・どのカメラで・どの解像度で読んでいるかを出す。
   * 読めないときに「映ってはいる」だけだと原因が分からないため、必ず見せる。
   */
  function camStatus(head) {
    var t = cam.stream ? cam.stream.getVideoTracks()[0] : null;
    var set = (t && t.getSettings) ? t.getSettings() : {};
    var bits = [cam.engine];
    if (set.width) bits.push(set.width + '×' + set.height);
    if (t && t.label) bits.push(t.label);
    camSay((head || 'バーコードを枠の線に合わせてください') + '（' + bits.join(' / ') + '）');
  }

  function startCamera(deviceId) {
    $('cameraPanel').classList.remove('hidden');
    camSay('カメラを起動しています…');

    Promise.resolve().then(function () {
      if (!window.isSecureContext) {
        throw new Error('HTTPS ではないためカメラを使えません。配布された https:// のURLから開いてください。');
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('このブラウザはカメラに対応していません。USBリーダーか手入力を使ってください。');
      }
      // まず1本掴む。ここで許可も取れるし、掴めればラベルも読めるようになる。
      return grabCamera(deviceId || localStorage.getItem(LS.cam) || '');
    }).then(function () {
      return refineCamera(deviceId);
    }).then(function () {
      renderCamPick();
      return startDecoder();
    }).catch(function (e) {
      camSay(camError(e), true);
    });
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /**
   * カメラを1本掴んで video に流す。id が '' なら facingMode に任せる
   * （スマホではこれで背面が選ばれる）。
   *
   * Windows では直前まで他が握っていると開けないことがある（NotReadableError）。
   * 一度だけ待って試し直す。
   */
  function grabCamera(id) {
    // 解像度が低いと EAN-13 の細い線が潰れて読めない。高めを希望して、無ければ端末に任せる。
    var video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (id) video.deviceId = { exact: id };
    else video.facingMode = { ideal: 'environment' };

    var ask = function (v) { return navigator.mediaDevices.getUserMedia({ video: v }); };

    return ask(video).catch(function (e) {
      var name = e && e.name;
      if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
        return wait(800).then(function () { return ask(video); });
      }
      // 覚えていたカメラが今は無い／使えない。指定を捨てて素直に掴み直す。
      if (id && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        localStorage.removeItem(LS.cam);
        return ask({ width: { ideal: 1920 }, height: { ideal: 1080 } });
      }
      throw e;
    }).then(function (s) {
      cam.stream = s;
      var t = s.getVideoTracks()[0];
      cam.deviceId = (t && t.getSettings ? t.getSettings().deviceId : '') || id || '';
      var v = $('video');
      v.srcObject = s;
      // 自動再生が止められても、読み取り自体は続けられるので落とさない。
      return v.play().catch(function () { /* noop */ });
    });
  }

  /**
   * 掴んだあとでラベルを見て、本当に使いたいカメラだったかを確かめる。
   * ラベルは許可を得るまで空なので、この順でないと判断できない。
   *
   * すでにそれを掴んでいれば**何もしない**。掴み直しは Windows で失敗しやすく、
   * 「1台しかないPCで、離した直後にもう一度開こうとして開けない」を招く。
   *
   * PCには Windows Hello の赤外線カメラが並ぶことがあり、これを掴むと
   * 映ってはいるのに一生読めないので、名前で避ける。
   */
  function refineCamera(explicit) {
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      cam.devices = devices.filter(function (d) { return d.kind === 'videoinput'; });
      if (explicit) return;   // 人が選んだものは尊重する

      var want = preferredDevice(cam.devices, localStorage.getItem(LS.cam) || '');
      if (!want || want === cam.deviceId) return;

      stopStream();
      return wait(400).then(function () { return grabCamera(want); });
    });
  }

  /** 使いたいカメラの deviceId。決められないときは '' を返して facingMode に任せる。 */
  function preferredDevice(devices, saved) {
    var known = devices.some(function (d) { return d.deviceId === saved; });
    if (saved && known) return saved;

    var back = devices.filter(function (d) {
      return /back|rear|environment|背面|外側/i.test(d.label);
    })[0];
    if (back) return back.deviceId;

    var infrared = /(^|[^a-z])(ir|infrared)([^a-z]|$)|赤外/i;
    var rgb = devices.filter(function (d) { return !infrared.test(d.label); });
    // 赤外線カメラを避けた結果、残ったものがあるときだけこちらから指定する。
    if (rgb.length && rgb.length < devices.length) return rgb[0].deviceId;
    return '';
  }

  /** カメラの失敗は英語のまま出しても何をすればいいか分からない。次の一手まで書く。 */
  function camError(e) {
    var name = e && e.name;
    var tail = '（手入力とUSBリーダーはそのまま使えます）';

    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'カメラの使用が許可されていません。'
        + 'アドレスバーのカメラのアイコンから許可して、もう一度押してください。' + tail;
    }
    if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
      return 'カメラを他のアプリかタブが使っています。'
        + 'Teams・Zoom・カメラアプリや、この画面を開いた別のタブを閉じてから、もう一度押してください。' + tail;
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'カメラが見つかりません。' + tail;
    }
    if (name === 'OverconstrainedError') {
      return 'このカメラは指定の設定に対応していません。下の一覧から別のカメラを選んでください。' + tail;
    }
    return (e && e.message ? e.message : 'カメラを起動できませんでした') + tail;
  }

  function renderCamPick() {
    var sel = $('camPick');
    var t = cam.stream ? cam.stream.getVideoTracks()[0] : null;
    var set = (t && t.getSettings) ? t.getSettings() : {};
    var active = set.deviceId || cam.deviceId;

    sel.textContent = '';
    cam.devices.forEach(function (d, i) {
      sel.appendChild(el('option', {
        value: d.deviceId,
        text: d.label || ('カメラ ' + (i + 1))
      }));
    });
    if (active) sel.value = active;
    sel.classList.toggle('hidden', cam.devices.length < 2);
  }

  function startDecoder() {
    if (!('BarcodeDetector' in window)) return startZXing();

    return window.BarcodeDetector.getSupportedFormats().then(function (formats) {
      var want = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'].filter(function (f) {
        return formats.indexOf(f) >= 0;
      });
      if (!want.length) return startZXing();

      cam.detector = new window.BarcodeDetector({ formats: want });
      cam.engine = '端末の読み取り';
      cam.nativeSince = Date.now();
      camStatus();
      tick();
    }).catch(function () {
      return startZXing();   // 端末の読み取りが用意できなければ ZXing に回す
    });
  }

  function tick() {
    if (!cam.detector) return;

    cam.detector.detect($('video')).then(function (codes) {
      if (codes && codes.length) { onScan(codes[0].rawValue); return; }
      if (Date.now() - cam.nativeSince > NATIVE_GIVE_UP_MS) {
        cam.detector = null;          // 次の tick は止まる
        clearTimeout(cam.timer);
        startZXing();
      }
    }).catch(function () { /* 1フレーム失敗しても続ける */ });

    cam.timer = setTimeout(tick, 120);
  }

  /**
   * ZXing で読む。
   *
   * ライブラリが用意している動画用のループ（decodeFromStream / decodeFromVideoDevice）は
   * **使わない**。あれはフレームの輝度を1枚おきに白黒反転させる仕組み（doAutoInvert）を
   * 強制していて、こちらの呼び方だと反転側に張り付き、一度も読めなかった。
   * 実測: 同じ1枚を autoInvert=false なら毎回読めるのに、true だと交互に落ちる。
   *
   * なので自前で回す。やることは「video を canvas に写して1枚読む」だけ。
   * 実測 1280×720 で1回 6.6ms なので、この間隔でも余裕がある。
   */
  function startZXing() {
    camSay('読み取りを準備しています…');
    return loadScript(ZXING_SRC).then(function () {
      var Z = window.ZXing;
      var hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
        Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
        Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E,
        Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.ITF
      ]);
      hints.set(Z.DecodeHintType.TRY_HARDER, true);

      var reader = new Z.MultiFormatReader();
      reader.setHints(hints);
      cam.zxing = { reader: reader, canvas: document.createElement('canvas') };
      cam.engine = 'ZXing';
      camStatus();
      zxTick();
    });
  }

  function zxTick() {
    if (!cam.zxing) return;
    var Z = window.ZXing;
    var v = $('video');

    if (v.videoWidth) {
      var c = cam.zxing.canvas;
      if (c.width !== v.videoWidth) { c.width = v.videoWidth; c.height = v.videoHeight; }
      c.getContext('2d').drawImage(v, 0, 0);
      try {
        // autoInvert は渡さない（渡すと1枚おきに反転して読めなくなる）
        var src = new Z.HTMLCanvasElementLuminanceSource(c);
        var bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
        var res = cam.zxing.reader.decode(bmp);
        if (res) { onScan(res.getText()); return; }
      } catch (e) {
        // 読めないフレームがあるのは普通のこと。次のフレームで読む。
      }
      cam.zxing.reader.reset();   // フレーム間で状態を持ち越さない
    }

    cam.timer = setTimeout(zxTick, 120);
  }

  function loadScript(src) {
    if (window.ZXing) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('読み取りライブラリを取得できませんでした（ネットワークを確認してください）'));
      };
      document.head.appendChild(s);
    });
  }

  function onScan(code) {
    var jan = normJan(code);
    if (!jan) return;
    var now = Date.now();
    if (jan === cam.last && now - cam.lastAt < 2500) return;   // 同じコードの連続検出を無視
    cam.last = jan;
    cam.lastAt = now;

    beep();
    if (navigator.vibrate) navigator.vibrate(60);
    $('jan').value = jan;
    stopCamera();
    doLookup();
  }

  /** 読み取りだけ止める（カメラは掴んだまま）。 */
  function stopDecoding() {
    clearTimeout(cam.timer);
    cam.detector = null;
    if (cam.zxing) {
      try { cam.zxing.reader.reset(); } catch (e) { /* noop */ }
      cam.zxing = null;
    }
  }

  /** カメラも離す。パネルは開けたまま（選び直しのときに使う）。 */
  function stopStream() {
    stopDecoding();
    if (cam.stream) { cam.stream.getTracks().forEach(function (t) { t.stop(); }); cam.stream = null; }
    var v = $('video');
    v.pause();
    v.srcObject = null;
  }

  function stopCamera() {
    stopStream();
    $('cameraPanel').classList.add('hidden');
  }

  // 画面を離れたらカメラを離す。掴んだままだと、他のアプリはもちろん
  // 「同じ画面を開いた別のタブ」でも開けなくなる（1台しかないPCで詰む）。
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && cam.stream) stopCamera();
  });

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      beep.ctx = beep.ctx || new Ctx();
      var o = beep.ctx.createOscillator(), g = beep.ctx.createGain();
      o.frequency.value = 1320;
      g.gain.value = 0.08;
      o.connect(g); g.connect(beep.ctx.destination);
      o.start();
      o.stop(beep.ctx.currentTime + 0.09);
    } catch (e) { /* 音が出せない環境でも読み取りは続ける */ }
  }

  // ============================================================ 一覧タブ

  $('btnReload').addEventListener('click', function () { state.listLoaded = false; loadList(); });
  $('expiryFilter').addEventListener('change', function () { state.listLoaded = false; loadList(); });
  $('search').addEventListener('input', renderList);

  Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
    th.addEventListener('click', function () {
      var key = th.dataset.key;
      if (state.sortKey === key) state.sortAsc = !state.sortAsc;
      else { state.sortKey = key; state.sortAsc = true; }
      renderList();
    });
  });

  function loadList() {
    if (state.listLoaded) { renderList(); return; }
    var btn = $('btnReload');
    busy(btn, true, '読込中');
    api('list', { all: $('expiryFilter').value === 'all' ? '1' : '0' })
      .then(function (d) {
        applyList(d);
        state.listLoaded = true;
      })
      .catch(function (e) {
        toast(e.message, true);
        var cached = localStorage.getItem(LS.cache);
        if (cached && !state.items.length) {
          applyList(JSON.parse(cached));
          $('listSummary').textContent = '※ 通信できないため、前回の内容を表示しています。';
        }
      })
      .then(function () { busy(btn, false); });
  }

  function applyList(d) {
    state.items = d.items || [];
    state.today = d.today || state.today;
    state.soonDays = d.soonDays || state.soonDays;
    state.noExpiryCount = d.noExpiryCount || 0;
    try {
      localStorage.setItem(LS.cache, JSON.stringify(d));
    } catch (e) { /* 容量超過などは無視してよい */ }
    renderList();
  }

  function renderList() {
    var q = $('search').value.trim().toLowerCase();
    var rows = state.items.filter(function (r) {
      return !q
        || r.name.toLowerCase().indexOf(q) >= 0
        || (r.attr || '').toLowerCase().indexOf(q) >= 0
        || r.jan.indexOf(q) >= 0;
    });

    // 値の無いもの（賞味期限が空など）は、昇順・降順どちらでも常に末尾に置く
    var key = state.sortKey;
    var isEmpty = function (v) { return v === null || v === undefined || v === ''; };
    var filled = rows.filter(function (r) { return !isEmpty(r[key]); });
    var empties = rows.filter(function (r) { return isEmpty(r[key]); });

    filled.sort(function (a, b) {
      var x = a[key], y = b[key], c;
      if (typeof x === 'number' && typeof y === 'number') c = x - y;
      else c = String(x).localeCompare(String(y), 'ja');
      return state.sortAsc ? c : -c;
    });
    rows = filled.concat(empties);

    Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.key === key) th.classList.add(state.sortAsc ? 'sorted-asc' : 'sorted-desc');
    });

    var tbody = $('tbody');
    tbody.textContent = '';
    rows.forEach(function (r) { tbody.appendChild(rowEl(r)); });

    $('listEmpty').classList.toggle('hidden', rows.length > 0);

    // daysLeft が null（賞味期限が空）のものを数えないよう明示する。
    // JavaScript では null >= 0 が true になるため、書かないと期限切れ間近に混ざる。
    var expired = state.items.filter(function (r) {
      return r.daysLeft !== null && r.daysLeft < 0;
    }).length;
    var soon = state.items.filter(function (r) {
      return r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= state.soonDays;
    }).length;
    $('listSummary').textContent =
      '表示 ' + rows.length + '件 / 全 ' + state.items.length + '件'
      + '　期限切れ ' + expired + '件、あと' + state.soonDays + '日以内 ' + soon + '件'
      + '（基準日 ' + state.today + '）'
      + (state.noExpiryCount
        ? '　※ 賞味期限が空の ' + state.noExpiryCount + '行は表示していません'
        : '');
  }

  /**
   * 一覧は読み取り専用。
   * 登録シートは A:JAN B:商品名 C:属性 D:賞味期限 の4列で、行を一意に指せるIDが無いため、
   * 画面から特定の行を書き換える操作は用意していない。直すときはシートを直接開く。
   */
  function rowEl(r) {
    var lab = dueLabel(r.daysLeft);
    var cls = (r.daysLeft !== null && r.daysLeft < 0) ? 'expired'
      : (r.daysLeft !== null && r.daysLeft <= state.soonDays) ? 'soon' : '';

    return el('tr', { class: cls }, [
      el('td', {}, [el('span', { class: 'pill ' + lab.cls, text: lab.text })]),
      el('td', {}, [
        el('span', { class: 'name', text: r.name || '（商品名なし）' }),
        el('span', { class: 'jan', text: 'JAN ' + r.jan + (r.inDb ? '' : ' / DB未登録') })
      ]),
      el('td', { text: r.attr || '—' }),
      el('td', { text: r.expiry || '—' }),
      el('td', { class: 'num', text: String(r.row) })
    ]);
  }

  // ============================================================ 起動

  // 接続先が分かっていれば、聞くのは名前だけ。
  if (cfg.url && cfg.pass) showWho();
  else showSetup();
})();
