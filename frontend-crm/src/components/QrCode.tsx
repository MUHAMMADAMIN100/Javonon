/**
 * Self-contained QR-code generator (byte mode, error-correction level M,
 * versions 1..40 auto-selected).
 *
 * Ported/adapted from Project Nayuki's public-domain qrcodegen.ts algorithm.
 * We embed it inline so the CRM has ZERO extra runtime dependencies — the
 * partner-onboarding modal must work offline in the office, and adding a
 * third-party CDN URL like `api.qrserver.com` would break there.
 *
 * The output is a pure <svg> so it scales cleanly for screenshots that
 * partners will share on Telegram / WhatsApp.
 */

/* eslint-disable no-bitwise */

// ---------- Reed–Solomon over GF(256) ----------

/**
 * Умножение в GF(256) с примитивным полиномом 0x11D — стандарт QR.
 * Возвращает 8-битное значение (0..255).
 */
function gfMul(a: number, b: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((b >>> i) & 1) * a;
  }
  return z & 0xff;
}

/** Генератор Reed-Solomon полинома для degree ошибочных байт. */
function rsGenPoly(degree: number): number[] {
  const coef = new Array<number>(degree).fill(0);
  coef[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      coef[j] = gfMul(coef[j], root);
      if (j + 1 < degree) coef[j] ^= coef[j + 1];
    }
    root = gfMul(root, 2);
  }
  return coef;
}

/** Вычисление RS-байт коррекции для одного блока данных. */
function rsRemainder(data: number[], gen: number[]): number[] {
  const result = new Array<number>(gen.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < gen.length; i++) {
      result[i] ^= gfMul(gen[i], factor);
    }
  }
  return result;
}

// ---------- QR spec tables (ECL = M) ----------

/**
 * ec[version] = число байт коррекции на блок для ECL M.
 * Табличка взята из спецификации ISO/IEC 18004 (Table 9, ECL M).
 */
const EC_CODEWORDS_PER_BLOCK_M: number[] = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
  30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** num_ec_blocks[version] для ECL M. */
const NUM_EC_BLOCKS_M: number[] = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5,
  5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29,
  31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

// ---------- Полное число модулей и «сырые» данные ----------

/** Общее число модулей в QR-матрице после вычета всех служебных элементов. */
function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Число codewords, доступных под data + EC (без служебных бит). */
function getNumRawDataCodewords(ver: number): number {
  return Math.floor(getNumRawDataModules(ver) / 8);
}

function getNumDataCodewords(ver: number): number {
  const totalCw = getNumRawDataCodewords(ver);
  const ecCw = EC_CODEWORDS_PER_BLOCK_M[ver] * NUM_EC_BLOCKS_M[ver];
  return totalCw - ecCw;
}

// ---------- BitBuffer ----------

class BitBuffer {
  private bits: number[] = [];
  get length() {
    return this.bits.length;
  }
  append(val: number, len: number) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
  }
  bytes(): number[] {
    const out: number[] = new Array(Math.ceil(this.bits.length / 8)).fill(0);
    for (let i = 0; i < this.bits.length; i++) {
      out[i >>> 3] |= this.bits[i] << (7 - (i & 7));
    }
    return out;
  }
}

// ---------- Кодирование данных ----------

function encodeByteSegment(data: number[], ver: number): BitBuffer {
  const bb = new BitBuffer();
  bb.append(0b0100, 4); // mode: byte
  const ccBits = ver < 10 ? 8 : 16; // char-count indicator length
  bb.append(data.length, ccBits);
  for (const b of data) bb.append(b, 8);
  return bb;
}

/**
 * Выбираем минимальную версию (1..40), в которую влезает URL при ECL=M.
 * Возвращает {version, dataCodewords}.
 */
function chooseVersion(bytes: number[]): { ver: number; dataCw: number[] } {
  for (let ver = 1; ver <= 40; ver++) {
    const dataCapacityBits = getNumDataCodewords(ver) * 8;
    const bb = encodeByteSegment(bytes, ver);
    if (bb.length > dataCapacityBits) continue;
    // add terminator (0..4 zero bits — spec §8.4.9)
    const terminatorBits = Math.min(4, dataCapacityBits - bb.length);
    bb.append(0, terminatorBits);
    // pad to byte boundary
    bb.append(0, (8 - (bb.length & 7)) & 7);
    const cw = bb.bytes();
    // pad bytes 0xEC / 0x11 alternating
    const totalCw = getNumDataCodewords(ver);
    for (let i = 0, pad = 0xec; cw.length < totalCw; i++) {
      cw.push(pad);
      pad = pad === 0xec ? 0x11 : 0xec;
    }
    return { ver, dataCw: cw };
  }
  throw new Error('QR data too long for version 40');
}

// ---------- Interleave data + EC ----------

/**
 * Split data codewords into blocks per spec, append RS EC to each, then
 * interleave data-first-then-EC per §8.6. Short blocks are padded with a
 * 0 byte at the data/EC boundary so both short/long blocks have equal length
 * `shortBlockLen + 1`; that padding position is skipped when writing the
 * interleaved stream. Matches Nayuki's qrcodegen reference implementation.
 */
function interleaveCodewords(ver: number, dataCw: number[]): number[] {
  const numBlocks = NUM_EC_BLOCKS_M[ver];
  const blockEcLen = EC_CODEWORDS_PER_BLOCK_M[ver];
  const rawCw = getNumRawDataCodewords(ver);
  const numShortBlocks = numBlocks - (rawCw % numBlocks);
  const shortBlockLen = Math.floor(rawCw / numBlocks);

  const blocks: number[][] = [];
  const rsGen = rsGenPoly(blockEcLen);
  let k = 0;
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - blockEcLen + (i < numShortBlocks ? 0 : 1);
    const dat = dataCw.slice(k, k + dataLen);
    k += dataLen;
    const ec = rsRemainder(dat, rsGen);
    // Pad short blocks with a 0 byte so all block arrays have length
    // shortBlockLen+1 (aligns data/EC boundaries during interleave).
    if (i < numShortBlocks) dat.push(0);
    blocks.push([...dat, ...ec]);
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      // Skip the padding column for short blocks.
      if (i !== shortBlockLen - blockEcLen || j >= numShortBlocks) {
        result.push(blocks[j][i]);
      }
    }
  }
  return result;
}

// ---------- Alignment patterns ----------

function getAlignmentPatternPositions(ver: number): number[] {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step =
    ver === 32
      ? 26
      : Math.ceil((size - 13) / (numAlign * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < numAlign; pos -= step) {
    positions.splice(1, 0, pos);
  }
  return positions;
}

// ---------- Матрица ----------

type Matrix = number[][]; // 0/1 module; separate isFunction[][]

function buildMatrix(ver: number, allCw: number[]): number[][] {
  const size = ver * 4 + 17;
  const modules: Matrix = Array.from({ length: size }, () => new Array(size).fill(0));
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    new Array(size).fill(false),
  );

  // Timing patterns
  for (let i = 0; i < size; i++) {
    modules[6][i] = (~i & 1);
    modules[i][6] = (~i & 1);
    isFunction[6][i] = true;
    isFunction[i][6] = true;
  }

  // Three finder patterns
  const placeFinder = (r: number, c: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const yy = r + dy;
        const xx = c + dx;
        if (yy < 0 || yy >= size || xx < 0 || xx >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        modules[yy][xx] = dist !== 2 && dist !== 4 ? 1 : 0;
        isFunction[yy][xx] = true;
      }
    }
  };
  placeFinder(3, 3);
  placeFinder(3, size - 4);
  placeFinder(size - 4, 3);

  // Alignment patterns (skip overlap with finders)
  const alignPos = getAlignmentPatternPositions(ver);
  for (let i = 0; i < alignPos.length; i++) {
    for (let j = 0; j < alignPos.length; j++) {
      const isCorner =
        (i === 0 && j === 0) ||
        (i === 0 && j === alignPos.length - 1) ||
        (i === alignPos.length - 1 && j === 0);
      if (isCorner) continue;
      const cy = alignPos[i];
      const cx = alignPos[j];
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          modules[cy + dy][cx + dx] = dist !== 1 ? 1 : 0;
          isFunction[cy + dy][cx + dx] = true;
        }
      }
    }
  }

  // Reserve format info (18 modules)
  for (let i = 0; i < 8; i++) {
    isFunction[8][i] = true;
    isFunction[i][8] = true;
    isFunction[8][size - 1 - i] = true;
    isFunction[size - 1 - i][8] = true;
  }
  isFunction[8][8] = true;
  isFunction[size - 8][8] = true; // dark module

  // Reserve version info (only versions 7+)
  if (ver >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        isFunction[size - 11 + j][i] = true;
        isFunction[i][size - 11 + j] = true;
      }
    }
  }

  // Fill data bits in zig-zag pattern
  const bits: number[] = [];
  for (const cw of allCw) {
    for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  }
  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip vertical timing
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIdx < bits.length) {
          modules[y][x] = bits[bitIdx];
          bitIdx++;
        }
      }
    }
  }

  return applyBestMask(modules, isFunction, ver);
}

// ---------- Data masking ----------

function maskFn(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return ((x + y) & 1) === 0;
    case 1: return (y & 1) === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return ((Math.floor(y / 2) + Math.floor(x / 3)) & 1) === 0;
    case 5: return ((x * y) & 1) + ((x * y) % 3) === 0;
    case 6: return ((((x * y) & 1) + ((x * y) % 3)) & 1) === 0;
    case 7: return ((((x + y) & 1) + ((x * y) % 3)) & 1) === 0;
    default: return false;
  }
}

function applyBestMask(
  modules: Matrix,
  isFunction: boolean[][],
  ver: number,
): number[][] {
  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestCopy: Matrix = modules;

  for (let m = 0; m < 8; m++) {
    const copy: Matrix = modules.map((row) => row.slice());
    // apply mask
    for (let y = 0; y < copy.length; y++) {
      for (let x = 0; x < copy.length; x++) {
        if (!isFunction[y][x] && maskFn(m, x, y)) copy[y][x] ^= 1;
      }
    }
    drawFormatBits(copy, m);
    if (ver >= 7) drawVersion(copy, ver);
    const penalty = maskPenalty(copy);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = m;
      bestCopy = copy;
    }
  }
  void bestMask;
  return bestCopy;
}

/**
 * Порядок битов формат-информации взят из ISO/IEC 18004 Figure 25 и матчит
 * порядок Project Nayuki qrcodegen.ts. В Nayuki setFunctionModule(x, y, ...)
 * записывает в modules[y][x] — то есть первый аргумент это столбец, второй
 * это строка. Мы используем ту же семантику: `modules[y][x]`.
 */
function drawFormatBits(modules: Matrix, mask: number): void {
  // ECL M = 0b00
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const size = modules.length;

  // Первая копия — L-образно вокруг верхнего левого finder-а.
  //   бит 0..5 : (x=8, y=0..5)
  //   бит 6    : (x=8, y=7)
  //   бит 7    : (x=8, y=8)
  //   бит 8    : (x=7, y=8)
  //   бит 9..14: (x=5..0, y=8)
  for (let i = 0; i <= 5; i++) modules[i][8] = (bits >>> i) & 1;
  modules[7][8] = (bits >>> 6) & 1;
  modules[8][8] = (bits >>> 7) & 1;
  modules[8][7] = (bits >>> 8) & 1;
  for (let i = 9; i < 15; i++) modules[8][14 - i] = (bits >>> i) & 1;

  // Вторая копия — горизонталь справа сверху + вертикаль слева снизу.
  //   бит 0..7 : (x=size-1..size-8, y=8)
  //   бит 8..14: (x=8, y=size-7..size-1)
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = (bits >>> i) & 1;
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = (bits >>> i) & 1;
  modules[size - 8][8] = 1; // always dark
}

function drawVersion(modules: Matrix, ver: number): void {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  const size = modules.length;
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[a][b] = bit;
    modules[b][a] = bit;
  }
}

function maskPenalty(modules: Matrix): number {
  const size = modules.length;
  let penalty = 0;

  // Rule 1: runs of 5+ same-colour modules
  const runScore = (color: number, run: number) =>
    run >= 5 ? run - 2 : 0;
  for (let y = 0; y < size; y++) {
    let runColor = -1;
    let runLen = 0;
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === runColor) runLen++;
      else {
        penalty += runScore(runColor, runLen);
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    penalty += runScore(runColor, runLen);
  }
  for (let x = 0; x < size; x++) {
    let runColor = -1;
    let runLen = 0;
    for (let y = 0; y < size; y++) {
      if (modules[y][x] === runColor) runLen++;
      else {
        penalty += runScore(runColor, runLen);
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    penalty += runScore(runColor, runLen);
  }

  // Rule 2: 2x2 blocks of same colour
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (
        c === modules[y][x + 1] &&
        c === modules[y + 1][x] &&
        c === modules[y + 1][x + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 3: finder-like pattern in row/col
  const finder = [1, 0, 1, 1, 1, 0, 1];
  const finderExt = [0, 0, 0, 0, ...finder];
  const finderExt2 = [...finder, 0, 0, 0, 0];
  const rowHas = (row: number[], pat: number[]) => {
    for (let i = 0; i <= row.length - pat.length; i++) {
      let ok = true;
      for (let j = 0; j < pat.length; j++) {
        if (row[i + j] !== pat[j]) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  };
  for (let y = 0; y < size; y++) {
    if (rowHas(modules[y], finderExt) || rowHas(modules[y], finderExt2)) penalty += 40;
  }
  for (let x = 0; x < size; x++) {
    const col = modules.map((r) => r[x]);
    if (rowHas(col, finderExt) || rowHas(col, finderExt2)) penalty += 40;
  }

  // Rule 4: proportion of dark modules
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) dark += modules[y][x];
  const total = size * size;
  const percent = (dark * 100) / total;
  const deviation = Math.floor(Math.abs(percent - 50) / 5) * 10;
  penalty += deviation;

  return penalty;
}

// ---------- Public API ----------

/** Кодирует строку в QR-матрицу (byte mode, ECL M). */
export function encodeQr(text: string): number[][] {
  // UTF-8 encode
  const bytes: number[] = [];
  for (const b of new TextEncoder().encode(text)) bytes.push(b);
  const { ver, dataCw } = chooseVersion(bytes);
  const interleaved = interleaveCodewords(ver, dataCw);
  return buildMatrix(ver, interleaved);
}

// ---------- React component ----------

type Props = {
  value: string;
  /** Total pixel size of the SVG (square). Default 240. */
  size?: number;
  /** Quiet-zone modules on each side (spec = 4). */
  margin?: number;
  className?: string;
};

/**
 * Renders a QR code as a scalable, dependency-free <svg>. The rendered image
 * scales sharply for screenshots (partners often share these via messengers).
 */
export default function QrCode({ value, size = 240, margin = 4, className }: Props) {
  let matrix: number[][];
  try {
    matrix = encodeQr(value);
  } catch {
    return (
      <div
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed #dc2626',
          color: '#dc2626',
          fontSize: 12,
          padding: 8,
          textAlign: 'center',
        }}
      >
        QR: слишком длинная строка
      </div>
    );
  }
  const n = matrix.length;
  const total = n + margin * 2;

  // Combine dark modules into a single <path> — keeps SVG tiny and crisp.
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (matrix[y][x]) d += `M${x + margin},${y + margin}h1v1h-1z`;
    }
  }

  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${total} ${total}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code"
    >
      <rect width={total} height={total} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
