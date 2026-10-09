export const MAX_ARCHIVE = 256 * 1024 * 1024;
export const MAX_EXPANDED = 512 * 1024 * 1024;
export const MAX_ENTRY = 52 * 1024 * 1024;
export function segment(input: string) {
  let name = [...input.normalize("NFC")]
    .map((c) => (c.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(c) ? "_" : c))
    .join("")
    .replace(/^[. ]+/, "")
    .slice(0, 80)
    .replace(/[. ]+$/, "");
  if (!name) name = "Без_названия";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = "_" + name;
  return name;
}
export function assertPath(path: string) {
  if (
    path.length > 512 ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (s) =>
          !s ||
          s === "." ||
          s === ".." ||
          s.length > 120 ||
          /[<>:"|?*]/.test(s) ||
          [...s].some((c) => c.charCodeAt(0) < 32) ||
          /[. ]$/.test(s) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
      )
  )
    throw new Error("Небезопасный путь в архиве: " + path.slice(0, 100));
}
