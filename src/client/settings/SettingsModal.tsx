// 配置中心（PLAN §15.15）。
//
// 参考 Huntly 的 SettingModal：一个全高弹窗，左边固定分类栏，右边
// 条件渲染当前分类。为什么是弹窗而不是第四栏：
//
//   · 配置是低频动作，常驻一栏会永久吃掉 1/4 屏宽；
//   · 弹窗**遮蔽**了主界面，明确告诉你"现在在配置，不是在读"；
//   · 分类栏放在原侧栏的位置，肌肉记忆不用重学。
//
// 组件拆分（每个分类一个文件，都挂在 ./settings/ 下）：
//   FeedsSection   订阅列表 / 添加 / 编辑 / 批量 / OPML
//   FoldersSection 分组的增删改
//   AccountSection 账户信息与退出
//
// 「订阅」和「分组」共享 FeedsProvider 里的同一份数据 —— 在分组页删掉
// 一个组，切回订阅页必须立刻看到源退回未分组。这条共享关系是这个
// 模块里唯一不显然的设计，所以写在 store.tsx 的注释里。
import { useEffect, type ReactNode } from 'react';
import type { User } from '../api.ts';
import {
  IconClose, IconFolder, IconRss, IconSettings, IconSparkle, IconClock, IconDatabase,
} from '../icons.tsx';
import { FeedsProvider } from './store.tsx';
import { FeedsSection } from './FeedsSection.tsx';
import { FoldersSection } from './FoldersSection.tsx';
import { AccountSection } from './AccountSection.tsx';
import { AiSection } from './AiSection.tsx';
import { DigestSection } from './DigestSection.tsx';

/** 分类 id。'feeds' / 'folders' / 'account' 已实现，其余是占位 */
export type SettingsSection =
  | 'feeds' | 'folders' | 'account'
  | 'ai' | 'digest' | 'backup';

interface SecDef {
  key: SettingsSection;
  label: string;
  icon: ReactNode;
  /** 占位分类：能点开，但内容明确写着"待接入"与所属里程碑 */
  soon?: string;
}

const SECTIONS: SecDef[] = [
  { key: 'feeds', label: '订阅', icon: <IconRss size={16} /> },
  { key: 'folders', label: '分组', icon: <IconFolder size={16} /> },
  { key: 'account', label: '账户', icon: <IconSettings size={16} /> },
  { key: 'ai', label: 'AI 分析', icon: <IconSparkle size={16} /> },
  { key: 'digest', label: '每日简报', icon: <IconClock size={16} /> },
  { key: 'backup', label: '备份与迁移', icon: <IconDatabase size={16} />, soon: 'M6' },
];

export function SettingsModal(props: {
  user: User;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  onClose: () => void;
  onLogout: () => void;
  /** 配置里改了数据（分组/订阅）时通知外层刷新侧栏 */
  onChanged: () => void;
}) {
  // Esc 关闭。挂在 window 上而不是弹窗上：焦点可能在右侧输入框里，
  // 依赖事件冒泡也能工作，但显式监听更稳（输入框里有自己的 onKeyDown）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);

  return (
    <div
      className="settings-backdrop"
      onClick={props.onClose}
      role="dialog"
      aria-modal="true"
      aria-label="配置"
    >
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-nav">
          <div className="settings-nav-head">
            <span>配置</span>
            <button
              className="icon-btn tiny"
              onClick={props.onClose}
              title="关闭（Esc）"
              aria-label="关闭配置"
            >
              <IconClose size={14} />
            </button>
          </div>
          <nav>
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                className={`settings-nav-item ${props.section === s.key ? 'active' : ''}`}
                onClick={() => props.onSection(s.key)}
                aria-current={props.section === s.key ? 'page' : undefined}
              >
                <span className="settings-nav-icon">{s.icon}</span>
                <span className="settings-nav-label">{s.label}</span>
                {s.soon && <span className="soon-tag">{s.soon}</span>}
              </button>
            ))}
          </nav>
        </aside>

        <div className="settings-body">
          {/* 订阅与分组共享同一份数据源。Provider 放在这里而不是整个 App：
              弹窗关闭时它卸载，下次打开重新拉一次 —— 这正是"配置里的数据
              永远新鲜"需要的，也省掉一份全局缓存的一致性维护。 */}
          <FeedsProvider onChanged={props.onChanged}>
            {/* 六个分类**全部挂载**，只把非当前的用 hidden 藏起来（§15.15 ③）。
                为什么不按需条件渲染：那样每次切分类都会卸载再挂载，用户在
                「添加订阅」里填了一半的 URL 会凭空消失 —— 而这恰恰是
                分类切换最常见的用法（"我要先看看有哪些分组再决定放哪"）。
                display:none 的代价是六个面板都在 DOM 里，但它们都是轻量
                静态节点，占位分类甚至没有状态。 */}
            <SettingsPane active={props.section === 'feeds'}>
              <FeedsSection onClose={props.onClose} />
            </SettingsPane>
            <SettingsPane active={props.section === 'folders'}>
              <FoldersSection />
            </SettingsPane>
            <SettingsPane active={props.section === 'account'}>
              <AccountSection user={props.user} onLogout={props.onLogout} />
            </SettingsPane>
            <SettingsPane active={props.section === 'ai'}>
              <AiSection />
            </SettingsPane>
            <SettingsPane active={props.section === 'digest'}>
              <DigestSection />
            </SettingsPane>
            <SettingsPane active={props.section === 'backup'}>
              <SoonSection
                title="备份与迁移"
                milestone="M6"
                items={[
                  '数据目录位置与自动备份保留份数',
                  '一键导出（SQLite + 附件 + 配置）',
                  '从备份恢复到干净实例',
                  '迁移到另一台机器时的校验和比对',
                ]}
                note="单目录部署（data/）已经可以手工备份，这里补的是自动化与校验。"
              />
            </SettingsPane>
          </FeedsProvider>
        </div>
      </div>
    </div>
  );
}

/** 一个分类面板。active=false 时用 hidden（display:none）藏起来但不卸载 */
function SettingsPane(props: { active: boolean; children: ReactNode }) {
  return (
    <div className="settings-pane" hidden={!props.active}>
      {props.children}
    </div>
  );
}

/** 占位分类：明确列出"以后会配什么、属于哪个里程碑"，不说假话 */
function SoonSection(props: {
  title: string;
  milestone: string;
  items: string[];
  note: string;
}) {
  return (
    <div className="settings-section">
      <header className="settings-sec-head">
        <h2>
          {props.title}
          <span className="tag soon-tag-inline">待接入 · {props.milestone}</span>
        </h2>
        <p className="muted">{props.note}</p>
      </header>
      <ul className="soon-list">
        {props.items.map((t, i) => (
          <li key={i}>
            {/* 用圆点而不是 IconCheck：后者是个空方框，看起来像可勾选的
                复选框 —— 而这一页明确写着"现在改不了任何东西"。
                一个长得像开关却点不动的东西，比没有图标更糟。 */}
            <span className="soon-dot" aria-hidden="true" />
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <p className="hint">
        现在改不了任何东西 —— 这一页只是把"将来会有哪些选项"提前写清楚，
        免得实现时再猜需求。属于 §19 的 {props.milestone} 里程碑。
      </p>
    </div>
  );
}
