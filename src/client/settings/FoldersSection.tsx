// 配置中心的「分组」分类（PLAN §15.15）。
//
// 从订阅页顶部的「分组」展开面板迁入。为什么单独一页：
// 分组是"组织结构的定义"，订阅是"有哪些源"，两者都是配置但改的
// 是不同东西 —— 混在一个长页面里时，删分组的确认框会盖在源列表上，
// 用户容易点错行。
import { useState } from 'react';
import { api, ApiFailure, type FolderItem } from '../api.ts';
import { IconFolder } from '../icons.tsx';
import { useFeeds } from './store.tsx';

export function FoldersSection() {
  const { folders, feeds, busy, setBusy, setErr, setNotice, reload, fail } = useFeeds();
  const [name, setName] = useState('');

  const add = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    setErr('');
    try {
      await api.createFolder(n);
      setName('');
      setNotice(`已创建分组「${n}」`);
      await reload();
    } catch (e) {
      fail(e, '新建分组失败');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (f: FolderItem) => {
    const n = window.prompt('新的分组名', f.name);
    if (n === null || !n.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await api.renameFolder(f.id, n.trim());
      setNotice(`分组已改名为「${n.trim()}」`);
      await reload();
    } catch (e) {
      fail(e, '重命名失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f: FolderItem) => {
    const yes = window.confirm(
      `删除分组「${f.name}」？\n\n`
      + `里面的 ${f.feedCount} 个订阅不会被删，会退回「未分组」。`,
    );
    if (!yes) return;
    setBusy(true);
    setErr('');
    try {
      await api.deleteFolder(f.id);
      setNotice('分组已删除，里面的订阅退回未分组');
      await reload();
    } catch (e) {
      fail(e, '删除失败');
    } finally {
      setBusy(false);
    }
  };

  const unfiled = feeds.filter((f) => !f.folderId).length;

  return (
    <div className="settings-section">
      <header className="settings-sec-head">
        <h2>分组</h2>
        <p className="muted">把几十个源归拢。侧栏与收件箱都会按分组建入口。</p>
      </header>

      <div className="add-row">
        <div className="search-box grow">
          <IconFolder size={15} className="search-icon" />
          <input
            placeholder="新分组名，例如「科技」「财经」"
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          />
        </div>
        <button className="btn primary" onClick={() => void add()} disabled={busy || !name.trim()}>
          新建
        </button>
      </div>

      {folders.length === 0 ? (
        <p className="hint">
          还没有分组。建一个之后，可以在「订阅」里把源放进去，也可以添加订阅时直接选。
        </p>
      ) : (
        <ul className="folder-manage-list">
          {folders.map((f) => (
            <li key={f.id}>
              <IconFolder size={14} />
              <span className="folder-name">{f.name}</span>
              <span className="muted">{f.feedCount} 个源</span>
              <div className="grow" />
              <button className="btn tiny" onClick={() => void rename(f)} disabled={busy}>重命名</button>
              <button className="btn tiny danger" onClick={() => void remove(f)} disabled={busy}>删除</button>
            </li>
          ))}
        </ul>
      )}

      <p className="hint">
        未归组的源：{unfiled} 个。删分组不会删订阅，只把它们退回未分组。
      </p>
    </div>
  );
}
