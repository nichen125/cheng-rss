// 阅读偏好面板（§15.11）。
//
// 从 App.tsx 原样搬出来：七个选项完全由 reader-prefs.ts 的常量驱动，
// 组件本身只是把当前值画出来，没有别的地方依赖它。

import {
  BODY_FONTS, DEFAULT_PREFS, FONT_SIZES, LIST_STYLES, LIST_WIDTHS, THEMES, UI_FONTS, WIDTHS,
  type ReaderPrefs,
} from '../reader-prefs.ts';

/** 阅读偏好面板（§15.11）。所有值都是"本设备生效"，不落服务端。 */
export function PrefsPanel(props: {
  prefs: ReaderPrefs;
  onChange: (p: ReaderPrefs) => void;
  onClose: () => void;
}) {
  const { prefs } = props;
  return (
    <div className="prefs-panel">
      {/* ── 正文排版 ── */}
      <div className="prefs-row">
        <span className="prefs-label">字号</span>
        <div className="seg">
          {FONT_SIZES.map((s) => (
            <button
              key={s}
              className={`seg-btn ${prefs.fontSize === s ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, fontSize: s })}
              title={`${s}px`}
              aria-pressed={prefs.fontSize === s}
            >
              {s === 15 ? '小' : s === 16.5 ? '中' : s === 18 ? '大' : '特大'}
            </button>
          ))}
        </div>
      </div>
      <div className="prefs-row">
        <span className="prefs-label">宽度</span>
        <div className="seg">
          {WIDTHS.map((w) => (
            <button
              key={w}
              className={`seg-btn ${prefs.width === w ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, width: w })}
              title={`${w} 字符`}
              aria-pressed={prefs.width === w}
            >
              {w}ch
            </button>
          ))}
        </div>
      </div>
      <div className="prefs-row">
        <span className="prefs-label">底色</span>
        <div className="seg">
          {THEMES.map((t) => (
            <button
              key={t.key}
              className={`seg-btn ${prefs.theme === t.key ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, theme: t.key })}
              aria-pressed={prefs.theme === t.key}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {/* 字体两行单独分组：它们改的是"字"，上面三行改的是"版面" */}
      <div className="prefs-row">
        <span className="prefs-label">正文</span>
        <div className="seg">
          {BODY_FONTS.map((f) => (
            <button
              key={f.key}
              className={`seg-btn ${prefs.bodyFont === f.key ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, bodyFont: f.key })}
              title={f.hint}
              aria-pressed={prefs.bodyFont === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="prefs-row">
        <span className="prefs-label">界面</span>
        <div className="seg">
          {UI_FONTS.map((f) => (
            <button
              key={f.key}
              className={`seg-btn ${prefs.uiFont === f.key ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, uiFont: f.key })}
              title={f.hint}
              aria-pressed={prefs.uiFont === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 列表（v6.6）──
          分隔线把它们和上面的"正文"分开：上面改的是读文章的版面，
          下面改的是挑文章的列表。两者作用对象不同，混成一片会让人
          以为"字号"也管列表。 */}
      <div className="prefs-sep" role="presentation" />
      <div className="prefs-row">
        <span className="prefs-label">列表</span>
        <div className="seg">
          {LIST_STYLES.map((s) => (
            <button
              key={s.key}
              className={`seg-btn ${prefs.listStyle === s.key ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, listStyle: s.key })}
              title={s.hint}
              aria-pressed={prefs.listStyle === s.key}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="prefs-row">
        <span className="prefs-label">栏宽</span>
        <div className="seg">
          {LIST_WIDTHS.map((w) => (
            <button
              key={w.key}
              className={`seg-btn ${prefs.listWidth === w.key ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, listWidth: w.key })}
              title={`${w.key}px（窄屏会自动收窄）`}
              aria-pressed={prefs.listWidth === w.key}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <button className="btn block prefs-reset" onClick={() => props.onChange({ ...DEFAULT_PREFS })}>
        恢复默认
      </button>
    </div>
  );
}
