import { BadRequestException } from '@nestjs/common';
import { closeSync, openSync, readSync, unlinkSync } from 'fs';

/**
 * QA-2: проверка загруженного файла по СОДЕРЖИМОМУ, а не по имени и типу,
 * которые присылает браузер. Раньше текстовый файл, переименованный в .png,
 * принимался как чек и как фото студента, а PDF — в слот «Фото 3/4».
 *
 * Смотрим первые байты («сигнатуру») сохранённого файла. Не совпало с
 * разрешённым видом — файл удаляем с диска и отвечаем 400 понятным текстом.
 */
export type FileKind = 'image' | 'pdf' | 'office' | 'video';

type Sniffed = 'jpg' | 'png' | 'webp' | 'gif' | 'heic' | 'pdf' | 'zip' | 'ole' | 'video' | null;

function readHead(file: { path?: string; buffer?: Buffer }): Buffer {
  if (file.buffer) return file.buffer.subarray(0, 32);
  if (!file.path) return Buffer.alloc(0);
  const fd = openSync(file.path, 'r');
  try {
    const buf = Buffer.alloc(32);
    const n = readSync(fd, buf, 0, 32, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function sniffFile(file: { path?: string; buffer?: Buffer }): Sniffed {
  const b = readHead(file);
  if (b.length < 4) return null;
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'zip'; // docx/xlsx/pptx
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'ole'; // doc/xls
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).toLowerCase();
    if (/^(heic|heix|hevc|hevx|mif1|msf1|avif)/.test(brand)) return 'heic';
    return 'video'; // mp4 / mov / 3gp
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video'; // webm / mkv
  return null;
}

const KIND_OF: Record<Exclude<Sniffed, null>, FileKind> = {
  jpg: 'image', png: 'image', webp: 'image', gif: 'image', heic: 'image',
  pdf: 'pdf', zip: 'office', ole: 'office', video: 'video',
};

const LABEL: Record<FileKind, string> = {
  image: 'фото (JPG, PNG, WEBP, HEIC)',
  pdf: 'PDF',
  office: 'документ Word или Excel',
  video: 'видео',
};

/** 400 и удаление файла, если его содержимое — не один из разрешённых видов. */
export function assertFileContent(
  file: { path?: string; buffer?: Buffer } | undefined | null,
  allowed: FileKind[],
  what = 'Файл',
): void {
  if (!file) return;
  let kind: FileKind | null = null;
  try {
    const s = sniffFile(file);
    kind = s ? KIND_OF[s] : null;
  } catch {
    kind = null;
  }
  if (kind && allowed.includes(kind)) return;
  if (file.path) {
    try { unlinkSync(file.path); } catch { /* уже нет — не страшно */ }
  }
  const expect = allowed.map((k) => LABEL[k]).join(' или ');
  throw new BadRequestException(`${what}: внутри не ${expect}. Похоже, у файла просто сменили расширение — загрузите настоящий файл.`);
}
