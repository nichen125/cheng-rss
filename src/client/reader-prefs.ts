// 阅读偏好（PLAN §15.11）。
//
// 五个值：字号 / 正文宽度 / 阅读区主题 / 正文字体 / 界面字体。
//
// 为什么存 localStorage 而不是存服务端：这是「这台设备上看着舒服」的
// 偏好，不是账号数据。存服务端会立刻出问题 —— 手机上把字号调到 18px
// 为了在通勤时看清，结果桌面端也变成 18px，72ch 的宽度全乱。
// 而 localStorage 天然是按浏览器分的，正好对上这个语义。
//
// 为什么不复用全局暗色主题：全局主题跟着系统走（§15.6），阅读区却
// 常常需要单独一盏灯 —— 白天用亮色、晚上躺着看用米色。两者生命周期
// 不同，硬合并会让用户调一个坏另一个。
//
// 字体为什么也要开放：同一份 CSS 在不同机器上落到的字族并不相同
// （Windows 有思源、微软雅黑、等线；macOS 有苹方、宋体-简），
// 「哪个好看」只能在用户自己的屏上判断。给出的是**字族栈**而不是
// 单个字体名，装不到的会自动落到下一档，不会出现"选完变成系统默认宋体"。

export type ReaderTheme = 'system' | 'light' | 'dark' | 'sepia';
export type BodyFont = 'serif' | 'sans' | 'kai';
export type UiFont = 'system' | 'noto' | 'yahei';
/** 列表密度（v6.6）：一行显示多少信息 */
export type ListStyle = 'compact' | 'standard' | 'rich';
/** 列表栏宽度（v6.6）：px 值，同时也写进 --list-w-user */
export type ListWidth = 368 | 456 | 544;

export interface ReaderPrefs {
  /** 正文字号 px */
  fontSize: number;
  /** 正文最大宽度 ch */
  width: number;
  theme: ReaderTheme;
  /** 正文字族 */
  bodyFont: BodyFont;
  /** 界面字族（侧栏 / 列表 / 设置 / 按钮） */
  uiFont: UiFont;
  /** 列表密度（v6.6） */
  listStyle: ListStyle;
  /** 列表栏宽度 px（v6.6） */
  listWidth: ListWidth;
}

/** 可选值集中在常量里：UI 的选择器与校验共用一份，避免两处各写一遍。
 *
 * 宽度三档的中间值是**默认值**（80ch），左右两档分别留了"怕长行"和
 * "还要更宽"的出口。为什么不是 60/72/84 而整体右移：v1.14 之前默认
 * 72ch，实测 1440 屏下正文两侧各空 118px、1920 屏下各空 358px，
 * 空白比列表栏还宽。82ch 附近是长文可接受的边界，超过它阅读回扫
 * 成本明显上升 —— 所以 80 当默认，96 只给宽屏 + 大字号的人用。
 *
 * 老数据兼容：v1.13 存下的 72 已经不在集合里，会被 loadPrefs 判非法
 * 并回退到默认 80。这是**有意的**——留着 72 会让"默认改了"这件事
 * 对老用户不生效，而 72→80 只是同一篇文章宽了 72px，不会有人需要切回去。 */
export const FONT_SIZES = [15, 16.5, 18, 20] as const;
export const WIDTHS = [64, 80, 96] as const;
export const THEMES: { key: ReaderTheme; label: string }[] = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '亮' },
  { key: 'sepia', label: '米色' },
  { key: 'dark', label: '暗' },
];

/** 正文字族。三档都是"字族栈"，不是单个字体名 —— 选完一定有位可落。 */
export const BODY_FONTS: { key: BodyFont; label: string; hint: string }[] = [
  { key: 'serif', label: '宋体', hint: '思源宋体 / 宋体-简 / 宋体 —— 长文阅读的传统选择' },
  { key: 'sans', label: '黑体', hint: '与界面同族 —— 屏幕上更清晰，长文略"硬"' },
  { key: 'kai', label: '楷体', hint: '楷体 / 华文楷体 —— 最像纸，适合慢读' },
];

/** 界面字族。system 优先用操作系统自己的 UI 字体（最贴合系统观感）。 */
export const UI_FONTS: { key: UiFont; label: string; hint: string }[] = [
  { key: 'noto', label: '思源', hint: '思源黑体 / Noto Sans SC —— 字形更收敛（默认）' },
  { key: 'system', label: '系统', hint: '操作系统 UI 字体（macOS 苹方 / Windows 雅黑）' },
  { key: 'yahei', label: '雅黑', hint: '微软雅黑 —— Windows 上最熟悉的字形' },
];

/** 列表密度三档（v6.6）。
 *
 * 需求方提的第二条路：「将列表中不同问题区分明显，放大列表宽度，各部分添加
 * 部分间隔，可以显示更多摘要」。它与「只显示标题」不是替代关系，而是
 * **同一件事的两端**：信息量越少扫得越快，信息量越多越不用点开。
 * 两者都对，取决于你在浏览还是在挑选，所以都留，让人自己切。
 *
 * 为什么三档而不是滑块：滑块给出一堆中间值，每个都要求单独调间距，
 * 而密度是**排版组合**（字号 / 行高 / 内边距 / 分隔方式要一起变），
 * 连续可调只会得到大量哪里都不太对的中间态。 */
export const LIST_STYLES: { key: ListStyle; label: string; hint: string }[] = [
  { key: 'compact', label: '紧凑', hint: '只显示标题 —— 一屏 13 条，扫得最快' },
  { key: 'standard', label: '标准', hint: '标题 + 一行摘要 + 元信息 —— 默认' },
  { key: 'rich', label: '舒展', hint: '标题 + 两行摘要 + 元信息，行间留白更大' },
];

/** 列表栏宽度三档（v6.6）。
 *
 * 368 是 v1.19 收敛后的基准（§15.16）；456 放得下更长的标题和两行摘要；
 * 544 是「摘要当正文看」的宽度。三者与 styles.css 里的
 * `clamp(300px, var(--list-w-user), 视口 − 侧栏 − 656px)` 一起工作：
 * 视口够宽时按用户选的值，不够宽时收到"刚好还留 574 给正文"为止。
 * 所以 1240px 以下三档会收敛到同一个值 —— 那是物理约束，
 * 不是选择失效（§5.3 有说明）。 */
export const LIST_WIDTHS: { key: ListWidth; label: string }[] = [
  { key: 368, label: '窄' },
  { key: 456, label: '中' },
  { key: 544, label: '宽' },
];

export const DEFAULT_PREFS: ReaderPrefs = {
  fontSize: 16.5,
  width: 80,
  theme: 'system',
  bodyFont: 'serif',
  // 界面默认思源黑体而不是「系统」：Windows 上「系统」会落到微软雅黑，
  // 小字号下的字面偏窄、笔画粘连，是「看起来旧」的主要来源。
  // 思源那一档装不到时自动落到苹方 / 雅黑，不会变丑，只是回到系统默认。
  uiFont: 'noto',
  // 列表默认「标准」：只显示标题牺牲了「不用点开就能挑」的能力。
  // 标准档保留摘要与元信息，同时把一行的字号档数从三种压到两种
  // （元信息 12 + 标题 14，摘要与元信息同档，只有一行）。
  listStyle: 'standard',
  listWidth: 368,
};

const KEY = 'cheng-rss.reader-prefs.v1';

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
  // 字体是后加的字段：老数据里没有，会走到默认值（不报错、不重置其它项）
  const bodyFont = BODY_FONTS.some((f) => f.key === o.bodyFont)
    ? (o.bodyFont as BodyFont)
    : DEFAULT_PREFS.bodyFont;
  const uiFont = UI_FONTS.some((f) => f.key === o.uiFont)
    ? (o.uiFont as UiFont)
    : DEFAULT_PREFS.uiFont;
  const listStyle = LIST_STYLES.some((s) => s.key === o.listStyle)
    ? (o.listStyle as ListStyle)
    : DEFAULT_PREFS.listStyle;
  const listWidth = LIST_WIDTHS.some((w) => w.key === o.listWidth)
    ? (o.listWidth as ListWidth)
    : DEFAULT_PREFS.listWidth;

  return { fontSize, width, theme, bodyFont, uiFont, listStyle, listWidth };
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
 * 为什么不直接改内联 style：正文宽度是在 `.reader` 上用 ch 算的，
 * 而 ch 相对的是 `.reader` 自己的字号。把 `--reader-width` 交给 CSS 去
 * `max-width: calc(var(--reader-width) * 1ch)` 会绕开这个耦合 —— 变量
 * 的值是"多少个字符"，单位换算留在样式层。
 *
 * 界面字体挂在 <html> 的 data 属性上：它影响的是整个应用
 * （侧栏、列表、设置、按钮），不只是阅读区。挂在阅读区容器上
 * 会让弹窗与侧栏保持旧字体，看起来像两套主题拼在一起。
 *
 * 注意：`max-width` 只是**上限**，正文实际宽度还受阅读栏可用宽度约束
 * （窄屏时是 100%）。所以"默认 80ch"不等于"一定 80ch"，见 §15.3。
 */
export function applyPrefs(el: HTMLElement | null, p: ReaderPrefs): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.dataset.uiFont = p.uiFont;
    root.dataset.bodyFont = p.bodyFont;
    root.dataset.listStyle = p.listStyle;
    // 列表宽度写成 CSS 变量，而不是内联改 .app 的 grid-template-columns：
    // 那个模板在 mobile.css 的三个断点里各有一份（184/344、320、0/100%），
    // 内联覆盖会把移动端的规则一起压死。变量只提供「期望值」，
    // 断点规则仍然是主 —— 见 styles.css 里 --list-w 的定义处。
    root.style.setProperty('--list-w-user', `${p.listWidth}px`);
  }
  if (!el) return;
  el.style.setProperty('--reader-font', `${p.fontSize}px`);
  el.style.setProperty('--reader-width', String(p.width));
  el.dataset.readerTheme = p.theme;
}
