/** 纯格式化函数（无 DOM、无全局状态）。 */

/** HTML 转义（所有插入 innerHTML 的动态文本必须经过它）。属性值同样安全：引号一并转义。 */
export function esc(value: unknown): string {
  return (value === null || value === undefined ? "" : String(value))
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/** 时间戳 → 本地短格式（MM-DD HH:MM）；非法/空输入原样降级。 */
export function fmtTime(t: string | null | undefined): string {
  if (!t) return "—";
  if (t.includes("T")) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }
  return t.slice(5, 16);
}

/** 文件大小 → 人话（0 显示空串）。 */
export function fmtBytes(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (!v) return "";
  if (v < 1024) return `${v} B`;
  if (v < 1_048_576) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1_048_576).toFixed(1)} MB`;
}

/** 千分位数字（统计页）。 */
export function fmtNum(n: number | null | undefined): string {
  return n === null || n === undefined ? "0" : Number(n).toLocaleString("zh-CN");
}

/** 有附件时去掉扫描器留下的 [file] / [image] 占位行。 */
export function stripAttPlaceholders(text: string | null | undefined, atts: unknown[]): string {
  const t = String(text ?? "");
  if (!atts || atts.length === 0) return t;
  return t
    .split("\n")
    .filter((line) => !/^\[(file|image)\b/u.test(line.trim()))
    .join("\n")
    .replace(/^\s*\n+/u, "")
    .trim();
}

/** 相对时间（秒级 → "刚刚 / N 分钟前"）。 */
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const diff = Math.max(0, Date.now() - d.getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/** 截断（按字符，不破坏代理对）。 */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

export const INTERVALS: readonly number[] = [5, 10, 15, 30, 60, 180];
