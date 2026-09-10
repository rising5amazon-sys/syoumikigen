/**
 * 「カメラに映ったバーコード」をテストで再現するための映像を作る。
 *
 * Chrome / Edge は --use-file-for-fake-video-capture=<file.y4m> で
 * 偽のカメラ映像としてファイルを流せる。y4m は無圧縮なので、ここで直接書ける
 * （ffmpeg のような外部ツールを増やさずに済む）。
 *
 *   node tests/e2e/make-barcode-y4m.mjs <出力先.y4m> [JANコード]
 *
 * 生成物はリポジトリに置かない（1フレーム約1.4MBあるため）。テストのたびに作る。
 */
import { writeFileSync } from 'node:fs';

// EAN-13。左6桁は先頭の数字で L/G の並びが決まり、右6桁は R で固定。
const L = ['0001101', '0011001', '0010011', '0111101', '0100011',
           '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101',
           '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100',
           '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
                'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** JANコードを 95 モジュールの 0/1 列にする。 */
export function ean13Modules(jan) {
  if (!/^[0-9]{13}$/.test(jan)) throw new Error('13桁のJANコードを渡してください: ' + jan);

  const d = jan.split('').map(Number);
  // チェックデジットが合っていないと、読めなくて当たり前になる。先に弾く。
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  if (check !== d[12]) throw new Error('チェックデジットが違う: ' + jan + '（正しくは末尾 ' + check + '）');

  const parity = PARITY[d[0]];
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (parity[i] === 'L' ? L : G)[d[i + 1]];
  bits += '01010';
  for (let i = 0; i < 6; i++) bits += R[d[i + 7]];
  bits += '101';
  return bits;   // 95 モジュール
}

/**
 * バーコードを描いた輝度プレーン（Y）を作る。
 * 実際のカメラ映像に近づけるため、白地の中央に置き、上下左右に余白（クワイエットゾーン）を取る。
 */
function drawY(width, height, bits, moduleWidth, barHeight) {
  const y = Buffer.alloc(width * height, 235);          // 白（放送用の範囲に合わせる）
  const barsWidth = bits.length * moduleWidth;
  const x0 = Math.floor((width - barsWidth) / 2);
  const y0 = Math.floor((height - barHeight) / 2);

  for (let i = 0; i < bits.length; i++) {
    if (bits[i] !== '1') continue;
    for (let x = x0 + i * moduleWidth; x < x0 + (i + 1) * moduleWidth; x++) {
      for (let py = y0; py < y0 + barHeight; py++) y[py * width + x] = 16;   // 黒
    }
  }
  return y;
}

export function makeY4m(path, jan, opts = {}) {
  const width = opts.width || 1280;
  const height = opts.height || 720;
  const frames = opts.frames || 4;
  const moduleWidth = opts.moduleWidth || 6;            // 1モジュール6px = 570px幅
  const barHeight = opts.barHeight || Math.floor(height * 0.45);

  const bits = ean13Modules(jan);
  const yPlane = drawY(width, height, bits, moduleWidth, barHeight);
  const uv = Buffer.alloc((width / 2) * (height / 2), 128);   // 色は無し（グレー）

  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420mpeg2\n`, 'ascii')];
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from('FRAME\n', 'ascii'), yPlane, uv, uv);
  }
  writeFileSync(path, Buffer.concat(parts));
  return { path, width, height, frames, jan, barsWidth: bits.length * moduleWidth };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const out = process.argv[2];
  const jan = process.argv[3] || '4901234567894';
  if (!out) {
    console.error('使い方: node tests/e2e/make-barcode-y4m.mjs <出力先.y4m> [JANコード]');
    process.exit(1);
  }
  const info = makeY4m(out, jan);
  console.log(`${info.path}  ${info.width}x${info.height} ${info.frames}フレーム  JAN ${info.jan}（バー幅 ${info.barsWidth}px）`);
}
