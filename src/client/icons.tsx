// 内联 SVG 图标，不引图标库。
//
// 理由：整个前端就 20 来个图标，图标库动辄 50KB+ 且要按需引入配置。
// 这里统一 20×20 描边风格（1.6px），跟色板一起构成视觉语言。

type P = { size?: number; className?: string };

const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function IconInbox({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3 12h5l2 3h4l2-3h5" />
      <path d="M5.5 5h13l2.5 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
    </svg>
  );
}

export function IconCircle({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="8.5" />
    </svg>
  );
}

export function IconStar({ size, className, filled }: P & { filled?: boolean }) {
  return (
    <svg {...base(size)} className={className} fill={filled ? 'currentColor' : 'none'}>
      <path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z" />
    </svg>
  );
}

export function IconClock({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

export function IconSearch({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.4 15.4L20 20" />
    </svg>
  );
}

export function IconArrowLeft({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </svg>
  );
}

export function IconExternal({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M13 5h6v6" />
      <path d="M19 5l-8 8" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

export function IconRss({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M5 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2z" fill="currentColor" stroke="none" />
      <path d="M5 12a7 7 0 0 1 7 7" />
      <path d="M5 5a14 14 0 0 1 14 14" />
    </svg>
  );
}

export function IconLogout({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M15 5h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-3" />
      <path d="M10 8l-4 4 4 4" />
      <path d="M6 12h9" />
    </svg>
  );
}

export function IconSparkle({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 4l1.7 4.6L18 10.3l-4.3 1.7L12 16.6l-1.7-4.6L6 10.3l4.3-1.7z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}

export function IconChevronRight({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9.5 6l6 6-6 6" />
    </svg>
  );
}

export function IconMenu({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function IconBookmark({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z" />
    </svg>
  );
}

export function IconRefresh({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

export function IconPause({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9.5 5v14M14.5 5v14" />
    </svg>
  );
}

export function IconPlay({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M8 5.5l11 6.5-11 6.5z" />
    </svg>
  );
}

export function IconFolder({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h3.4l1.6 2h7.9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function IconEdit({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4 20h4l10-10a2.1 2.1 0 0 0-3-3L5 17z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

export function IconTrash({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M4.5 6.5h15" />
      <path d="M9 6.5V4.8a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.7" />
      <path d="M6.5 6.5l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12" />
    </svg>
  );
}

/** 关闭 / 清除筛选。用于标题旁的小「×」，与 IconTrash 区分开：
 *  前者是"取消视图过滤"，后者是"删除真的数据"，不能共用一个图标。 */
export function IconClose({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6.5 6.5l11 11" />
      <path d="M17.5 6.5l-11 11" />
    </svg>
  );
}

/** 勾选框：批量管理模式下每行左边那个。checked 时实心 + 对勾 */
export function IconCheck({ size, className, checked }: P & { checked?: boolean }) {
  return (
    <svg {...base(size)} className={className}>
      <rect
        x="3.5" y="3.5" width="17" height="17" rx="5"
        fill={checked ? 'currentColor' : 'none'}
      />
      {checked && (
        <path
          d="M8 12.3l2.6 2.6L16 9.5"
          stroke="var(--bg-elev)" strokeWidth="2"
          fill="none" strokeLinecap="round" strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** 设置 / 配置中心（§15.15）。齿轮：一个圆 + 内圆 + 八向齿线。
 *  不用「三个圆点」那种"更多"，因为它是"配置"不是"更多菜单" ——
 *  两者在同一个侧栏里出现时，圆点会被理解成"展开更多导航"。 */
export function IconSettings({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="3.1" />
      <circle cx="12" cy="12" r="7.6" opacity="0.45" />
      <path d="M12 2.9v1.9M12 19.2v1.9M3.4 12h1.9M18.7 12h1.9" />
      <path d="M5.9 5.9l1.35 1.35M16.75 16.75l1.35 1.35M18.1 5.9l-1.35 1.35M7.25 16.75L5.9 18.1" />
    </svg>
  );
}

/** 数据库 / 备份迁移（§15.15 的占位分类）。
 *  三个叠起来的数据层，比"软盘"更贴合"SQLite + 附件目录"这件事，
 *  也比"下载箭头"更中性 —— 那一页既含导出也含恢复。 */
export function IconDatabase({ size, className }: P) {
  return (
    <svg {...base(size)} className={className}>
      <ellipse cx="12" cy="6.2" rx="7.4" ry="2.9" />
      <path d="M4.6 6.2v11.6c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9V6.2" />
      <path d="M4.6 12c0 1.6 3.3 2.9 7.4 2.9s7.4-1.3 7.4-2.9" />
    </svg>
  );
}
