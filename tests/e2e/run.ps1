# 画面の操作テストを Edge のヘッドレスで走らせる。
#
# 仮想時間（--virtual-time-budget）は使わない。時計を飛ばすと getUserMedia が間に合わず、
# dialog の close など非同期の配送順も揺れて、同じテストが通ったり落ちたりする。
# 代わりに、テストが終わるまで画面側が load イベントを止めておく（/wait）。
# その分そのまま実時間がかかる（30秒ほど）。
#
# JavaScript の構文エラーは「画面の一部が描画されないだけ」で静かに起きるので、
# サーバーが 200 を返していても気づけない。ここで実際に操作して結果を確かめる。
#
#   powershell -ExecutionPolicy Bypass -File tests\e2e\run.ps1

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8   # 日本語が cp932 で化けないように

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tmp = Join-Path $env:TEMP 'syoumikigenkanri-e2e'
if (-not (Test-Path $tmp)) { New-Item -ItemType Directory -Path $tmp | Out-Null }
$domFile = Join-Path $tmp 'dom.html'

# --- Edge を探す ---------------------------------------------------------
$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
)
$edge = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
  Write-Output 'Microsoft Edge が見つかりません。手動テスト: node tests/e2e/server.mjs を起動して http://127.0.0.1:5058/e2e を開いてください。'
  exit 1
}

# --- ポートが空いているか ------------------------------------------------
if (Get-NetTCPConnection -LocalPort 5058 -State Listen -ErrorAction SilentlyContinue) {
  Write-Output 'ポート 5058 が使用中です。先に使っているプロセスを止めてください。'
  exit 1
}

# --- テスト用サーバーを起動 ----------------------------------------------
$server = Start-Process -FilePath 'node' -ArgumentList (Join-Path $here 'server.mjs') `
  -PassThru -WindowStyle Hidden
try {
  $ready = $false
  foreach ($i in 1..40) {
    if (Get-NetTCPConnection -LocalPort 5058 -State Listen -ErrorAction SilentlyContinue) { $ready = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $ready) { throw 'テスト用サーバーが起動しませんでした。' }

  # --- ヘッドレスで開いて、操作後の DOM を取り出す -----------------------
  # PowerShell 5.1 では native exe の stderr を "2>$null" で捨てると
  # NativeCommandError になって落ちる。Start-Process でファイルに逃がす。
  $edgeLog = Join-Path $tmp 'edge.log'

  # カメラに映すバーコードを作る。リポジトリには置かない（1フレーム約1.4MBあるため）。
  $y4m = Join-Path $tmp 'barcode.y4m'
  & node (Join-Path $here 'make-barcode-y4m.mjs') $y4m '4901234567894' | Out-Null
  if (-not (Test-Path $y4m)) { throw 'テスト用のバーコード映像を作れませんでした。' }

  # 2回に分けて走らせる。カメラ映像にバーコードが映っていると、カメラを開いた瞬間に
  # 読めてパネルが閉じ、本体側の「開いて・映って・止められる」テストが成立しないため。
  $runs = @(
    @{ 名前 = '画面の操作'; url = 'http://127.0.0.1:5058/e2e';     dom = (Join-Path $tmp 'dom.html');     film = $null },
    @{ 名前 = 'カメラの読み取り'; url = 'http://127.0.0.1:5058/e2e-cam'; dom = (Join-Path $tmp 'dom-cam.html'); film = $y4m }
  )

  $failed = 0
  foreach ($run in $runs) {
    $args = @(
      '--headless=new', '--disable-gpu', '--no-sandbox',
      # 偽のカメラを許可なしで掴ませる（本物のカメラを使わない・許可も聞かれない）
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'
    )
    if ($run.film) { $args += "--use-file-for-fake-video-capture=$($run.film)" }
    $args += @("--user-data-dir=$tmp\profile", '--dump-dom', $run.url)

    Start-Process -FilePath $edge -Wait -NoNewWindow -ArgumentList $args `
      -RedirectStandardOutput $run.dom -RedirectStandardError $edgeLog | Out-Null

    Write-Output ('--- ' + $run.名前 + ' ---')
    $dom = Get-Content $run.dom -Raw -Encoding UTF8
    if ($dom -match '(?s)<pre id="out">(.*?)</pre>') {
      $result = [System.Net.WebUtility]::HtmlDecode($matches[1])
      Write-Output $result
      if ($result -match '(\d+) 件失敗' -and [int]$matches[1] -gt 0) { $failed = 1 }
      if ($result -match 'running') { Write-Output 'テストが完走していません。'; $failed = 1 }
    } else {
      Write-Output '結果を取り出せませんでした。画面のJSが読み込み時点で落ちている可能性があります。'
      Write-Output ('取得したDOM: ' + $run.dom)
      $failed = 1
    }
  }
  if ($failed -ne 0) { exit 1 }
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
