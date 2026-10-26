// 阅读偏好（PLAN §15.11）。
//
// 三个值：字号 / 正文宽度 / 阅读区主题。
//
// 为什么存 localStorage 而不是存服务端：这是「这台设备上看着舒服」的
// 偏好，不是账号数据。存服务端会立刻出问题 —— 手机上把字号调到 18px
// 为了在通勤时看清，结果桌面端也变成 18px，72ch 的宽度全乱。
// 而 localStorage 天然是按浏览器分的，正好对上这个语义。
//
// 为什么不复用全局暗色主题：全局主题跟着系统走（§15.6），阅读区却
// 常常需要单独一盏灯 —— 白天用亮色、晚上躺着看用米色。两者生命周期
// 不同，硬合并会让用户调一个坏另一个。

export type ReaderTheme = 'system' | 'light' | 'dark' | 'sepia';

export interface ReaderPrefs {
  /** 正文字号 px */
  fontSize: number;
  /** 正文最大宽度 ch */
  width: number;
  theme: ReaderTheme;
}

/** 可选值集中在常量里：UI 的选择器与校验共用一份，避免两处各写一遍 */
export const FONT_SIZES = [15, 16.5, 18, 20] as const;
export const WIDTHS = [60, 72, 84] as const;
export const THEMES: { key: ReaderTheme; label: string }[] = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '亮' },
  { key: 'sepia', label: '米色' },
  { key: 'dark', label: '暗' },
];

export const DEFAULT_PREFS: ReaderPrefs = { fontSize: 16.5, width: 72, theme: 'system' };

const KEY = 'ai-rss.reader-prefs.v1';

/**
 * 读偏好。任何一项非法都回退到默认值 —— 而不是整份丢弃。
 *
 * 理由：用户在两个标签页里同时改字号，后写的会覆盖先写的，
 * 可能写出 {fontSize: 18, width: undefined} 这样的半份数据。
 * 整份丢弃等于"我在另一页调的字号丢了"，逐项回退则只丢那一项。
 */
export function loadPrefs(): ReaderPrefs {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_PREFS };
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // 隐私模式下 localStorage 读写都可能抛，不能因此让阅读页打不开
    return { ...DEFAULT_PREFS };
  }
  if (!raw) return { ...DEFAULT_PREFS };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_PREFS };
  }
  const o = (parsed ?? {}) as Partial<Record<keyof ReaderPrefs, unknown>>;

  const fontSize = FONT_SIZES.includes(o.fontSize as never)
    ? (o.fontSize as number)
    : DEFAULT_PREFS.fontSize;
  const width = WIDTHS.includes(o.width as never) ? (o.width as number) : DEFAULT_PREFS.width;
  const theme = THEMES.some((t) => t.key === o.theme)
    ? (o.theme as ReaderTheme)
    : DEFAULT_PREFS.theme;

  return { fontSize, width, theme };
}

export function savePrefs(p: ReaderPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // 存不进去只影响"下次打开还记不记得"，不影响本次使用 —— 静默即可
  }
}

/**
 * 把偏好写成 CSS 变量，挂在阅读区容器上。
 *
 * 为什么不直接改内联 style：正文的 72ch 是在 `.reader` 上用 ch 算的，
 * 而 ch 相对的是 `.reader` 自己的字号。把 `--reader-width` 交给 CSS 去
 * `max-width: calc(var(--reader-width) * 1ch)` 会绕开这个耦合 —— 变量
 * 的值是"多少个字符"，单位换算留在样式层。
 */
export function applyPrefs(el: HTMLElement | null, p: ReaderPrefs): void {
  if (!el) return;
  el.style.setProperty('--reader-font', `${p.fontSize}px`);
  el.style.setProperty('--reader-width', String(p.width));
  el.dataset.readerTheme = p.theme;
}
