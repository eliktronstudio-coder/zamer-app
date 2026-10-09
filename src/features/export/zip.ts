import { UnzipInflate, zipSync } from "fflate";
import { assertPath, MAX_ARCHIVE, MAX_ENTRY, MAX_EXPANDED } from "./paths";
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const n of data) crc = crcTable[(crc ^ n) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function createZip(files: Map<string, Uint8Array>) {
  let size = 0;
  const names = new Set<string>(),
    entries: Record<string, [Uint8Array, { level: 0 }]> = Object.create(null);
  if (files.size > 10000)
    throw new Error("Слишком много файлов для одного ZIP");
  for (const [name, data] of files) {
    assertPath(name);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error("Повтор пути в ZIP");
    names.add(key);
    size += data.length;
    if (data.length > MAX_ENTRY || size > MAX_ARCHIVE - 4 * 1024 * 1024)
      throw new Error(
        "Проект превышает лимит ZIP 256 МБ; файлы не будут исключены молча",
      );
    entries[name] = [data, { level: 0 }];
  }
  const result = zipSync(entries);
  if (result.length > MAX_ARCHIVE) throw new Error("ZIP превышает 256 МБ");
  return result;
}
// Validate the central directory before allocating outputs; inflate input in 4 KiB pieces.
// Actual output/CRC are checked too, so forged size headers cannot bypass the budget.
export function readZip(data: Uint8Array) {
  if (data.length > MAX_ARCHIVE || data.length < 22)
    throw new Error("Некорректный размер ZIP (максимум 256 МБ)");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength),
    u16 = (p: number) => view.getUint16(p, true),
    u32 = (p: number) => view.getUint32(p, true);
  let e = data.length - 22;
  while (e >= Math.max(0, data.length - 65557) && u32(e) !== 0x06054b50) e--;
  if (
    e < 0 ||
    u32(e) !== 0x06054b50 ||
    e + 22 + u16(e + 20) !== data.length ||
    u16(e + 4) !== 0 ||
    u16(e + 6) !== 0 ||
    u16(e + 8) !== u16(e + 10)
  )
    throw new Error("Повреждённый ZIP или многотомный архив");
  const count = u16(e + 10),
    start = u32(e + 16),
    end = start + u32(e + 12);
  if (count > 10000 || count === 65535 || end !== e || start > end)
    throw new Error("ZIP64 или слишком большой список файлов");
  let p = start,
    total = 0;
  const rows: {
      name: string;
      offset: number;
      compressed: number;
      size: number;
      crc: number;
      method: number;
    }[] = [],
    names = new Set<string>(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || u32(p) !== 0x02014b50)
      throw new Error("Повреждённый каталог ZIP");
    const flags = u16(p + 8),
      method = u16(p + 10),
      compressed = u32(p + 20),
      size = u32(p + 24),
      length = u16(p + 28),
      next = p + 46 + length + u16(p + 30) + u16(p + 32),
      offset = u32(p + 42);
    if (
      next > end ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      ((u32(p + 38) >>> 16) & 0xf000) === 0xa000 ||
      size > MAX_ENTRY ||
      compressed > MAX_ARCHIVE ||
      offset + 30 > start ||
      size === 0xffffffff
    )
      throw new Error("Неподдерживаемый или чрезмерно большой файл ZIP");
    const name = decoder.decode(data.subarray(p + 46, p + 46 + length));
    assertPath(name);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error("Повторяющийся путь ZIP");
    names.add(key);
    total += size;
    if (total > MAX_EXPANDED)
      throw new Error("Распакованный архив превышает 512 МБ");
    if (
      u32(offset) !== 0x04034b50 ||
      u16(offset + 8) !== method ||
      u16(offset + 6) & 1 ||
      decoder.decode(
        data.subarray(offset + 30, offset + 30 + u16(offset + 26)),
      ) !== name
    )
      throw new Error("Заголовки ZIP не согласованы");
    const begin = offset + 30 + u16(offset + 26) + u16(offset + 28);
    if (begin + compressed > start || begin < offset)
      throw new Error("Некорректное смещение ZIP");
    rows.push({
      name,
      offset: begin,
      compressed,
      size,
      crc: u32(p + 16),
      method,
    });
    p = next;
  }
  if (p !== end) throw new Error("Лишние записи каталога ZIP");
  const files = new Map<string, Uint8Array>();
  for (const row of rows) {
    const input = data.subarray(row.offset, row.offset + row.compressed);
    let output: Uint8Array;
    if (row.method === 0) output = input.slice();
    else {
      const chunks: Uint8Array[] = [];
      let actual = 0;
      const decoder = new UnzipInflate();
      decoder.ondata = (error, chunk) => {
        if (error) throw error;
        actual += chunk.length;
        if (actual > row.size || actual > MAX_ENTRY)
          throw new Error("Фактический размер файла превышает заявленный");
        chunks.push(chunk);
      };
      for (let n = 0; n < input.length; n += 4096)
        decoder.push(input.subarray(n, n + 4096), n + 4096 >= input.length);
      output = new Uint8Array(actual);
      let cursor = 0;
      for (const chunk of chunks) {
        output.set(chunk, cursor);
        cursor += chunk.length;
      }
    }
    if (output.length !== row.size || crc32(output) !== row.crc)
      throw new Error("Неверный размер или CRC файла: " + row.name);
    files.set(row.name, output);
  }
  return files;
}
