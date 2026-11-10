// 配置中心的「分组」分类（PLAN §15.15、§15.28）。
//
// 从订阅页顶部的「分组」展开面板迁入。为什么单独一页：
// 分组是"组织结构的定义"，订阅是"有哪些源"，两者都是配置但改的
// 是不同东西 —— 混在一个长页面里时，删分组的确认框会盖在源列表上，
// 用户容易点错行。
//
// §15.28 起这里还是**唯一**的手动排序入口（手机上没有侧栏，
// 长按拖拽在那里不存在）。所以箭头是常显的，不需要先进入任何模式 ——
// 配置页是批量整理的场合，一次要动十几项，"点一次走一格"比拖更可控，
// 而且天然可键盘操作、可被断言精确验证。
import { useMemo, useState } from 'react';
import { api, ApiFailure, type FolderItem } from '../api.ts';
import { IconChevronRight, IconFolder } from '../icons.tsx';
import { useConfirm } from '../components/ConfirmDialog.tsx';
import { compareFeedInGroup, feedsOfFolder } from '../arrange.ts';
import { useFeeds } from './store.tsx';

export function FoldersSection() {
  const { folders, feeds, busy, setBusy, setErr, setNotice, reload, fail, toast } = useFeeds();
  const confirm = useConfirm();
  const [name, setName] = useState('');
  /** 展开着看组内源的组。可以同时展开多个 —— 这里是整理，不是浏览 */
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  /**
   * 组 id → 组内源（已排好序），一次算完。
   *
   * 之前是在 `folders.map` 里逐个调 `feedsOfFolder(feeds, f.id)` ——
   * 那个函数会 filter 一遍全部源。几十个组 × 几百个源 = 上万次比较，
   * 而且每次切换展开状态都要重算一遍。这里改成一次 O(n) 归拢：
   * 遍历源一遍，把它推进所属组的桶里，桶内再排序。
   *
   * 与 App.tsx 的 `feedsByFolder` 用的是同一套比较器（`feedsOfFolder`），
   * 所以侧栏与配置页永远不会给出不同顺序。
   */
  const kidsByFolder = useMemo(() => {
    const buckets = new Map<string, typeof feeds>();
    for (const f of feeds) {
      if (!f.folderId) continue;
      const b = buckets.get(f.folderId);
      if (b) b.push(f); else buckets.set(f.folderId, [f]);
    }
    // 桶内排序。传的是**桶本身**而不是全量 feeds —— 传全量等于又 filter
    // 了一遍，白省。比较器仍是同一个，两处顺序不会分叉。
    for (const [id, b] of buckets) buckets.set(id, b.slice().sort(compareFeedInGroup));
    return buckets;
  }, [feeds]);

  const toggleOpen = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

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
    const yes = await confirm({
      title: `删除分组「${f.name}」？`,
      message: `里面的 ${f.feedCount} 个订阅不会被删，会退回「未分组」。`,
      confirmText: '删除分组',
      danger: true,
    });
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

  /** 分组走一格。首行 ↑ 与末行 ↓ 在按钮上已经禁用，这里再挡一次 */
  const moveFolder = async (id: string, delta: number) => {
    const ids = folders.map((f) => f.id);
    const i = ids.indexOf(id);
    const dst = i + delta;
    if (i < 0 || dst < 0 || dst >= ids.length) return;
    const next = ids.slice();
    const [x] = next.splice(i, 1);
    next.splice(dst, 0, x as string);
    setBusy(true);
    setErr('');
    try {
      await api.reorderFolders(next);
      await reload();
    } catch (e) {
      fail(e, '调整顺序失败');
    } finally {
      setBusy(false);
    }
  };

  /** 组内源走一格 */
  const moveFeed = async (folderId: string, feedId: string, delta: number) => {
    const ids = feedsOfFolder(feeds, folderId).map((f) => f.id);
    const i = ids.indexOf(feedId);
    const dst = i + delta;
    if (i < 0 || dst < 0 || dst >= ids.length) return;
    const next = ids.slice();
    const [x] = next.splice(i, 1);
    next.splice(dst, 0, x as string);
    setBusy(true);
    setErr('');
    try {
      await api.arrangeFeeds(folderId, next);
      await reload();
    } catch (e) {
      fail(e, '调整顺序失败');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 把源移到另一个分组（或未分组）。
   *
   * 落在目标组末尾 —— 与侧栏拖到分组行上是同一个语义，
   * 两处给不出不同的结果。
   *
   * 走应用级 toast 而不是内联 notice（§15.28）：手机上侧栏不存在，
   * 这个下拉是唯一能把源在组间搬动的入口，必须和侧栏一样给撤销。
   */
  const moveFeedTo = async (feedId: string, toFolderId: string | null) => {
    const cur = feeds.find((f) => f.id === feedId);
    const fromFolderId = cur?.folderId ?? null;
    // 目标组当前的顺序。未分组不是真实文件夹，得单独从 feeds 里挑
    // —— 不能给 feedsOfFolder 传空串，那会得到空数组，
    // 结果是把所有未分组源都挤到这一批后面、顺序被打乱。
    const destNow = toFolderId === null
      ? feeds.filter((f) => !f.folderId).map((f) => f.id)
      : feedsOfFolder(feeds, toFolderId).map((f) => f.id);

    setBusy(true);
    setErr('');
    try {
      await api.arrangeFeeds(toFolderId, [...destNow.filter((x) => x !== feedId), feedId]);
      const destName = toFolderId
        ? (folders.find((f) => f.id === toFolderId)?.name ?? '分组')
        : '未分组';
      const fromName = fromFolderId
        ? (folders.find((f) => f.id === fromFolderId)?.name ?? '分组')
        : '未分组';
      // 撤销要把归属和位置一起还原：只改 folderId 会让它落在原组末尾，
      // 而不是它原来在的位置
      const backIds = fromFolderId === null
        ? feeds.filter((f) => !f.folderId).map((f) => f.id)
        : feedsOfFolder(feeds, fromFolderId).map((f) => f.id);
      toast({
        text: `「${cur?.title ?? feedId}」已移入「${destName}」`,
        onUndo: async () => {
          try {
            await api.arrangeFeeds(fromFolderId, [...backIds.filter((x) => x !== feedId), feedId]);
            setNotice(`已撤销，回到「${fromName}」`);
          } catch (e) {
            setErr(e instanceof ApiFailure ? e.message : '撤销失败，请手动移回');
          }
          await reload();
        },
      });
      await reload();
    } catch (e) {
      fail(e, '移动失败');
    } finally {
      setBusy(false);
    }
  };

  const unfiled = feeds.filter((f) => !f.folderId).length;

  return (
    <div className="settings-section">
      <header className="settings-sec-head">
        <h2>分组</h2>
        <p className="muted">
          把几十个源归拢。侧栏与收件箱都会按分组建入口。
          用 ↑ ↓ 调整顺序，展开分组后排组内的源。
        </p>
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
        <ul className="folder-manage-list arrange-list">
          {folders.map((f, fi) => {
            const kids = kidsByFolder.get(f.id) ?? [];
            const open = openIds.has(f.id);
            return (
              <li key={f.id} className="folder-manage-group" data-folder-id={f.id}>
                <div className="folder-manage-row">
                  <button
                    className={`folder-twist ${open ? 'open' : ''}`}
                    onClick={() => toggleOpen(f.id)}
                    aria-expanded={open}
                    aria-label={`${open ? '收起' : '展开'}「${f.name}」的源`}
                    title={open ? '收起组内的源' : `展开 ${kids.length} 个源`}
                  >
                    <IconChevronRight size={13} />
                  </button>
                  <IconFolder size={14} />
                  <span className="folder-name">{f.name}</span>
                  <span className="muted">{f.feedCount} 个源</span>
                  <div className="grow" />
                  {/* 首行不给 ↑、末行不给 ↓：禁用的按钮比"点了没反应"清楚，
                      也比把箭头藏起来稳定（藏起来会让行内其它元素左右跳） */}
                  <button
                    className="btn tiny icon-arrow"
                    onClick={() => void moveFolder(f.id, -1)}
                    disabled={busy || fi === 0}
                    aria-label={`「${f.name}」上移`}
                    title="上移一位"
                  >↑</button>
                  <button
                    className="btn tiny icon-arrow"
                    onClick={() => void moveFolder(f.id, 1)}
                    disabled={busy || fi === folders.length - 1}
                    aria-label={`「${f.name}」下移`}
                    title="下移一位"
                  >↓</button>
                  <button className="btn tiny" onClick={() => void rename(f)} disabled={busy}>重命名</button>
                  <button className="btn tiny danger" onClick={() => void remove(f)} disabled={busy}>删除</button>
                </div>

                {open && (
                  kids.length === 0 ? (
                    <p className="hint inset-hint">这一组里还没有源。</p>
                  ) : (
                    <ul className="folder-feed-list">
                      {kids.map((fd, ki) => (
                        <li key={fd.id}>
                          <span className="folder-feed-name">{fd.title ?? fd.url}</span>
                          <div className="grow" />
                          <button
                            className="btn tiny icon-arrow"
                            onClick={() => void moveFeed(f.id, fd.id, -1)}
                            disabled={busy || ki === 0}
                            aria-label={`「${fd.title ?? fd.url}」上移`}
                            title="上移一位"
                          >↑</button>
                          <button
                            className="btn tiny icon-arrow"
                            onClick={() => void moveFeed(f.id, fd.id, 1)}
                            disabled={busy || ki === kids.length - 1}
                            aria-label={`「${fd.title ?? fd.url}」下移`}
                            title="下移一位"
                          >↓</button>
                          {/* 移到别的组用下拉而不是拖：配置页要能一条一条明确地搬，
                              而拖拽在这里要重做一套落点计算，收益为零 */}
                          <select
                            className="folder-move-select"
                            value={f.id}
                            disabled={busy}
                            onChange={(e) => void moveFeedTo(fd.id, e.target.value || null)}
                            aria-label={`把「${fd.title ?? fd.url}」移到`}
                            title="移到别的分组"
                          >
                            {folders.map((g) => (
                              <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                            <option value="">未分组</option>
                          </select>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="hint">
        未归组的源：{unfiled} 个。删分组不会删订阅，只把它们退回未分组。
      </p>
    </div>
  );
}
