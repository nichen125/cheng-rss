// 配置中心的「账户」分类（PLAN §15.15）。
//
// 原来这部分信息在侧栏底部（头像 + 邮箱 + 退出），占了侧栏最后一行。
// 搬进配置之后侧栏只留一个齿轮入口 —— 邮箱和头像属于"我是谁"，
// 不是日常导航，每天看不到 20 次。
import { IconLogout } from '../icons.tsx';
import type { User } from '../api.ts';

export function AccountSection(props: { user: User; onLogout: () => void }) {
  const initial = (props.user.name ?? props.user.email ?? '?').slice(0, 1).toUpperCase();
  return (
    <div className="settings-section">
      <header className="settings-sec-head">
        <h2>账户</h2>
        <p className="muted">单用户部署下这里只有一个账号；表结构已按多人预留。</p>
      </header>

      <div className="account-card">
        <div className="avatar lg">{initial}</div>
        <div className="account-main">
          <div className="account-name">{props.user.name ?? 'Owner'}</div>
          <div className="account-mail">{props.user.email ?? '（未设置邮箱）'}</div>
          <div className="account-role">角色：{props.user.role}</div>
        </div>
      </div>

      <div className="settings-actions">
        <button className="btn" onClick={props.onLogout}>
          <IconLogout size={15} />
          退出登录
        </button>
      </div>

      <p className="hint">
        多人使用需要给每个账号单独的登录态与数据隔离，属于后续里程碑（§12）。
        当前所有表都带 user_id，切换时不需要改表结构。
      </p>
    </div>
  );
}
