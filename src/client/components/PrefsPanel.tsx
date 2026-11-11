// 阅读偏好面板（§15.11）。
//
// 从 App.tsx 原样搬出来：三个选项完全由 reader-prefs.ts 的常量驱动，
// 组件本身只是把当前值画出来，没有别的地方依赖它。

import { DEFAULT_PREFS, FONT_SIZES, THEMES, WIDTHS, type ReaderPrefs } from '../reader-prefs.ts';

/** 阅读偏好面板（§15.11）。三个值都是"本设备生效"，不落服务端。 */
export function PrefsPanel(props: {
  prefs: ReaderPrefs;
  onChange: (p: ReaderPrefs) => void;
  onClose: () => void;
}) {
  const { prefs } = props;
  return (
    <div className="prefs-panel">
      <div className="prefs-row">
        <span className="prefs-label">字号</span>
        <div className="seg">
          {FONT_SIZES.map((s) => (
            <button
              key={s}
              className={`seg-btn ${prefs.fontSize === s ? 'on' : ''}`}
              onClick={() => props.onChange({ ...prefs, fontSize: s })}
              title={`${s}px`}
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
            >
              {t.label}
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
