// 侧栏排列的纯函数（src/client/arrange.ts）。
//
// 这一组里最容易错、也最难靠肉眼确认的是"松手之后顺序到底变成什么样"，
// 所以 orderAfterDrop 的每个落点都单独断言；findDropTarget 需要 DOM，
// 这里用最小的桩（elementsFromPoint + closest + dataset + rect），
// 并且用完立刻还原全局，避免污染同进程里的其它测试文件。
import test from 'node:test';
import assert from 'node:assert/strict';

import type { FeedItem, FolderItem } from '../src/client/api.ts';
import {
  LONG_PRESS_MS,
  MOVE_TOLERANCE,
  rowKey,
  moveItem,
  compareFeedInGroup,
  feedsOfFolder,
  looseFeedsOf,
  findDropTarget,
  orderAfterDrop,
  foldersAfterDrop,
} from '../src/client/arrange.ts';
import type { ArrangeRow, ArrangeKind } from '../src/client/arrange.ts';

function feed(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: 'f1',
    url: 'https://example.com/feed.xml',
    title: '示例源',
    siteUrl: null,
    iconUrl: null,
    status: 'active',
    fetchInterval: 3600,
    lastFetchedAt: null,
    nextFetchAt: null,
    errorCount: 0,
    unread: 0,
    total: 0,
    folderId: null,
    folderName: null,
    sort: 0,
    ...over,
  };
}

function folder(over: Partial<FolderItem> = {}): FolderItem {
  return { id: 'd1', name: '分组', sort: 0, feedCount: 0, unread: 0, ...over };
}

function row(kind: ArrangeKind, id: string, folderId: string | null = null): ArrangeRow {
  return { key: rowKey(kind, id), kind, id, folderId, label: id };
}

// ---- DOM 桩 --------------------------------------------------------------

class FakeHTMLElement {
  dataset: Record<string, string>;
  private _rect: { top: number; height: number };

  constructor(dataset: Record<string, string>, top = 0, height = 40) {
    this.dataset = dataset;
    this._rect = { top, height };
  }

  closest(_selector: string): FakeHTMLElement | null {
    return this.dataset.arrangeKind ? this : null;
  }

  getBoundingClientRect() {
    return {
      top: this._rect.top,
      height: this._rect.height,
      bottom: this._rect.top + this._rect.height,
      left: 0,
      right: 400,
      width: 400,
      x: 0,
      y: this._rect.top,
      toJSON: () => ({}),
    };
  }
}

function el(kind: ArrangeKind | null, id?: string, opts: { folder?: string; top?: number; height?: number } = {}) {
  const dataset: Record<string, string> = {};
  if (kind) {
    dataset.arrangeKind = kind;
    dataset.arrangeId = id ?? '';
    if (opts.folder !== undefined) dataset.arrangeFolder = opts.folder;
  }
  return new FakeHTMLElement(dataset, opts.top ?? 0, opts.height ?? 40);
}

function plainEl() {
  return new FakeHTMLElement({});
}

const g = globalThis as unknown as Record<string, unknown>;
const savedDoc = g.document;
const savedHTMLElement = g.HTMLElement;

function withDom<T>(elements: unknown[], fn: () => T): T {
  g.document = { elementsFromPoint: () => elements };
  g.HTMLElement = FakeHTMLElement;
  try {
    return fn();
  } finally {
    if (savedDoc === undefined) delete g.document;
    else g.document = savedDoc;
    if (savedHTMLElement === undefined) delete g.HTMLElement;
    else g.HTMLElement = savedHTMLElement;
  }
}

// ---- 常量与 rowKey --------------------------------------------------------

test('常量：长按 500ms、抖动容差 8px（两者都是与"单击选中"抢手势的边界）', () => {
  assert.equal(LONG_PRESS_MS, 500);
  assert.equal(MOVE_TOLERANCE, 8);
  assert.ok(MOVE_TOLERANCE < 50, '容差必须远小于手指移动，否则滚动会误判成长按');
});

test('rowKey：kind:id，三种 kind 互不冲突', () => {
  assert.equal(rowKey('folder', 'd1'), 'folder:d1');
  assert.equal(rowKey('feed', 'f1'), 'feed:f1');
  assert.equal(rowKey('loose', 'f1'), 'loose:f1');
  // 同一个 id 在不同 kind 下不是同一个 key —— 分组与源可以有相同的 id
  assert.notEqual(rowKey('folder', 'x'), rowKey('feed', 'x'));
});

// ---- moveItem ------------------------------------------------------------

test('moveItem：前移、后移、相邻与自身的精确结果', () => {
  const arr = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(arr, 0, 3), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveItem(arr, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(arr, 0, 1), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveItem(arr, 1, 0), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveItem(arr, 1, 2), ['a', 'c', 'b', 'd']);
  assert.deepEqual(moveItem(arr, 2, 1), ['a', 'c', 'b', 'd']);
  // from === to：内容不变，但返回的是新数组
  assert.deepEqual(moveItem(arr, 2, 2), arr);
});

test('moveItem：越界夹取而不抛，源下标越界时返回原样的副本', () => {
  const arr = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(arr, 0, 99), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(arr, 0, -99), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(arr, 2, 99), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(arr, -1, 1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(arr, 3, 0), ['a', 'b', 'c']);
});

test('moveItem：不修改输入数组（含空数组与单元素）', () => {
  const arr = ['a', 'b', 'c'];
  const snapshot = arr.slice();
  const out = moveItem(arr, 0, 2);
  assert.deepEqual(arr, snapshot);
  assert.notEqual(out, arr);

  const empty: string[] = [];
  assert.deepEqual(moveItem(empty, 0, 0), []);
  const one = ['x'];
  assert.deepEqual(moveItem(one, 0, 0), ['x']);
});

test('moveItem：保持元素身份（引用相同），目标下标在原数组坐标系里夹取', () => {
  const a = { v: 1 };
  const b = { v: 2 };
  const c = { v: 3 };
  const out = moveItem([a, b, c], 0, 2);
  assert.equal(out[2], a);
  assert.equal(out[0], b);
  assert.equal(out[1], c);
});

// ---- compareFeedInGroup --------------------------------------------------

test('compareFeedInGroup：失效源排最后，优先于 sort 与标题', () => {
  const broken = feed({ id: 'b', status: 'broken', sort: 0, title: '安' });
  const active = feed({ id: 'a', status: 'active', sort: 99, title: '词' });
  assert.ok(compareFeedInGroup(broken, active) > 0, 'broken 应排在 active 之后');
  assert.ok(compareFeedInGroup(active, broken) < 0);
  assert.equal(compareFeedInGroup(broken, broken), 0);
  // paused 不是 broken，不享受"排最后"
  const paused = feed({ id: 'p', status: 'paused', sort: 1, title: '波' });
  assert.ok(compareFeedInGroup(paused, broken) < 0);
});

test('compareFeedInGroup：先在组内按 sort 升序，sort 并列才看标题', () => {
  const s2 = feed({ id: 'a', sort: 2, title: '安' });
  const s1 = feed({ id: 'b', sort: 1, title: '词' });
  assert.ok(compareFeedInGroup(s1, s2) < 0, 'sort 1 在 sort 2 之前，标题无关');
  assert.ok(compareFeedInGroup(s2, s1) > 0);
  assert.equal(compareFeedInGroup(feed({ sort: 1 }), feed({ sort: 1 })), 0);
  // 负数 sort 也按数值比
  assert.ok(compareFeedInGroup(feed({ sort: -1 }), feed({ sort: 0 })) < 0);
});

test('compareFeedInGroup：空标题（null 与 ""）排最后，非空标题按拼音', () => {
  const nullTitle = feed({ id: 'n', title: null, sort: 0 });
  const emptyTitle = feed({ id: 'e', title: '', sort: 0 });
  const cjk = feed({ id: 'c', title: '安', sort: 0 });

  assert.ok(compareFeedInGroup(cjk, nullTitle) < 0, '有标题的在空标题之前');
  assert.ok(compareFeedInGroup(cjk, emptyTitle) < 0);
  // null 与 "" 属于同一档，可比出 0
  assert.equal(compareFeedInGroup(nullTitle, emptyTitle), 0);

  const an = feed({ id: '1', title: '安' });
  const bo = feed({ id: '2', title: '波' });
  assert.ok(compareFeedInGroup(an, bo) <= 0, '拼音序：安(an) 不晚于 波(bo)');
  assert.equal(compareFeedInGroup(an, an), 0);
});

test('compareFeedInGroup：可作 sort 比较器，完整顺序为 失效 → sort → 非空标题拼音 → 空标题', () => {
  const items = [
    feed({ id: 'null-title', title: null, sort: 0 }),
    feed({ id: 'broken', title: '安', sort: 0, status: 'broken' }),
    feed({ id: 'ci', title: '词', sort: 0 }),
    feed({ id: 'bo', title: '波', sort: 0 }),
    feed({ id: 'sort-last', title: '阿', sort: 5 }),
  ];
  const sorted = items.slice().sort(compareFeedInGroup).map((f) => f.id);
  // 顺序：sort 0 档内先比拼音（波 bo → 词 ci），空标题在 sort 0 档的最后，
  // 然后是 sort 5，最后才是失效源
  assert.deepEqual(sorted, ['bo', 'ci', 'null-title', 'sort-last', 'broken']);
});

// ---- feedsOfFolder / looseFeedsOf ----------------------------------------

test('feedsOfFolder：只取该组的源，按组内顺序，且不修改输入数组', () => {
  const feeds = [
    feed({ id: 'other', folderId: 'd2', title: '甲' }),
    feed({ id: 'b', folderId: 'd1', title: '词' }),
    feed({ id: 'a', folderId: 'd1', title: '波' }),
    feed({ id: 'loose', folderId: null, title: '安' }),
  ];
  const snapshot = feeds.slice();
  const out = feedsOfFolder(feeds, 'd1');
  assert.deepEqual(out.map((f) => f.id), ['a', 'b']);
  assert.deepEqual(feeds, snapshot, '输入顺序不能被就地改动');
  assert.notEqual(out, feeds);
  assert.deepEqual(feedsOfFolder(feeds, 'nope'), []);
});

test('looseFeedsOf：与组内同一套比较器（失效/空标题规则一致）', () => {
  const feeds = [
    feed({ id: 'broken', folderId: null, title: '安', status: 'broken' }),
    feed({ id: 'in-folder', folderId: 'd1', title: '阿' }),
    feed({ id: 'no-title', folderId: null, title: null }),
    feed({ id: 'bo', folderId: null, title: '波' }),
  ];
  const out = looseFeedsOf(feeds);
  assert.deepEqual(out.map((f) => f.id), ['bo', 'no-title', 'broken']);
  // 同一个列表里规则不一致是上一版真 bug：组内判定必须能复用到未分组
  const inGroup = feedsOfFolder(feeds, 'd1');
  assert.deepEqual(inGroup.map((f) => f.id), ['in-folder']);
});

test('looseFeedsOf：sort 字段在未分组里同样生效，空数组返回空数组', () => {
  const feeds = [
    feed({ id: 'late', folderId: null, sort: 3, title: '安' }),
    feed({ id: 'early', folderId: null, sort: 0, title: '词' }),
  ];
  assert.deepEqual(looseFeedsOf(feeds).map((f) => f.id), ['early', 'late']);
  assert.deepEqual(looseFeedsOf([]), []);
});

// ---- orderAfterDrop ------------------------------------------------------

test('orderAfterDrop：null 落点与 into 落点都不改顺序（返回 null，调用方跳过请求）', () => {
  const sib = ['a', 'b', 'c'];
  assert.equal(orderAfterDrop(sib, 'a', null), null);
  assert.equal(orderAfterDrop(sib, 'a', { kind: 'into', folderId: 'd1' }), null);
  assert.equal(orderAfterDrop(sib, 'a', { kind: 'into', folderId: null }), null);
});

test('orderAfterDrop：插到目标之前/之后，跨过多个元素', () => {
  const sib = ['a', 'b', 'c', 'd'];
  // a 插到 c 之前
  assert.deepEqual(orderAfterDrop(sib, 'a', { kind: 'line', key: 'feed:c', pos: 'before' }), [
    'b',
    'a',
    'c',
    'd',
  ]);
  // a 插到 c 之后
  assert.deepEqual(orderAfterDrop(sib, 'a', { kind: 'line', key: 'feed:c', pos: 'after' }), [
    'b',
    'c',
    'a',
    'd',
  ]);
  // d 插到 a 之前
  assert.deepEqual(orderAfterDrop(sib, 'd', { kind: 'line', key: 'feed:a', pos: 'before' }), [
    'd',
    'a',
    'b',
    'c',
  ]);
  // b 插到 d 之后（末尾）
  assert.deepEqual(orderAfterDrop(sib, 'b', { kind: 'line', key: 'feed:d', pos: 'after' }), [
    'a',
    'c',
    'd',
    'b',
  ]);
});

test('orderAfterDrop：已在原位时返回 null（松手不该发一次空请求）', () => {
  const sib = ['a', 'b', 'c'];
  // b 放到 a 之后 = 不动
  assert.equal(orderAfterDrop(sib, 'b', { kind: 'line', key: 'feed:a', pos: 'after' }), null);
  // b 放到 c 之前 = 不动
  assert.equal(orderAfterDrop(sib, 'b', { kind: 'line', key: 'feed:c', pos: 'before' }), null);
  // 落在自己身上 = 不动
  assert.equal(orderAfterDrop(sib, 'b', { kind: 'line', key: 'feed:b', pos: 'before' }), null);
  assert.equal(orderAfterDrop(sib, 'b', { kind: 'line', key: 'feed:b', pos: 'after' }), null);
  // 首元素放到最前、末元素放到最后
  assert.equal(orderAfterDrop(sib, 'a', { kind: 'line', key: 'feed:a', pos: 'after' }), null);
  assert.equal(orderAfterDrop(sib, 'c', { kind: 'line', key: 'feed:c', pos: 'after' }), null);
});

test('orderAfterDrop：未知的拖动 id 或目标 id 返回 null，而不是造出一个顺序', () => {
  const sib = ['a', 'b', 'c'];
  assert.equal(orderAfterDrop(sib, 'zzz', { kind: 'line', key: 'feed:a', pos: 'before' }), null);
  assert.equal(orderAfterDrop(sib, 'a', { kind: 'line', key: 'feed:zzz', pos: 'before' }), null);
  assert.equal(orderAfterDrop([], 'a', { kind: 'line', key: 'feed:a', pos: 'before' }), null);
  // key 里带冒号的 id 会被 split(':') 截断，从而变成"找不到目标"
  assert.equal(orderAfterDrop(['a:b', 'c'], 'a:b', { kind: 'line', key: 'feed:a:b', pos: 'before' }), null);
});

test('orderAfterDrop：返回新数组，输入不被修改', () => {
  const sib = ['a', 'b', 'c'];
  const snapshot = sib.slice();
  const out = orderAfterDrop(sib, 'a', { kind: 'line', key: 'feed:c', pos: 'before' });
  assert.deepEqual(sib, snapshot);
  assert.notEqual(out, sib);
});

test('orderAfterDrop：单元素与两元素列表', () => {
  assert.equal(orderAfterDrop(['a'], 'a', { kind: 'line', key: 'feed:a', pos: 'after' }), null);
  assert.deepEqual(orderAfterDrop(['a', 'b'], 'a', { kind: 'line', key: 'feed:b', pos: 'after' }), ['b', 'a']);
  assert.deepEqual(orderAfterDrop(['a', 'b'], 'b', { kind: 'line', key: 'feed:a', pos: 'before' }), ['b', 'a']);
});

// ---- foldersAfterDrop ----------------------------------------------------

test('foldersAfterDrop：取分组 id 后委托给 orderAfterDrop；into 落点返回 null', () => {
  const folders = [folder({ id: 'd1' }), folder({ id: 'd2' }), folder({ id: 'd3' })];
  const snapshot = folders.slice();

  assert.deepEqual(
    foldersAfterDrop(folders, 'd1', { kind: 'line', key: 'folder:d3', pos: 'before' }),
    ['d2', 'd1', 'd3'],
  );
  assert.deepEqual(
    foldersAfterDrop(folders, 'd1', { kind: 'line', key: 'folder:d3', pos: 'after' }),
    ['d2', 'd3', 'd1'],
  );
  assert.equal(foldersAfterDrop(folders, 'd1', null), null);
  assert.equal(foldersAfterDrop(folders, 'd1', { kind: 'into', folderId: null }), null);
  assert.equal(foldersAfterDrop([], 'd1', { kind: 'line', key: 'folder:d1', pos: 'before' }), null);
  assert.deepEqual(folders, snapshot);
});

// ---- findDropTarget ------------------------------------------------------

test('findDropTarget：指针下没有任何行 → null', () => {
  withDom([plainEl()], () => {
    assert.equal(findDropTarget(10, 10, row('feed', 'f1')), null);
  });
  withDom([], () => {
    assert.equal(findDropTarget(10, 10, row('feed', 'f1')), null);
  });
});

test('findDropTarget：落在自己那一行 → null（否则浮起瞬间就画出落点线）', () => {
  withDom([el('feed', 'f1', { top: 0 })], () => {
    assert.equal(findDropTarget(10, 10, row('feed', 'f1')), null);
  });
  withDom([el('folder', 'd1', { top: 0 })], () => {
    assert.equal(findDropTarget(10, 10, row('folder', 'd1')), null);
  });
  // kind 不同、id 相同不算自己
  withDom([el('folder', 'x', { top: 0 })], () => {
    assert.deepEqual(findDropTarget(10, 30, row('feed', 'x')), { kind: 'into', folderId: 'x' });
  });
});

test('findDropTarget：分组只和分组排；以中线为界分 before/after', () => {
  withDom([el('folder', 'd2', { top: 100, height: 40 })], () => {
    // 中线上方
    assert.deepEqual(findDropTarget(10, 110, row('folder', 'd1')), {
      kind: 'line',
      key: 'folder:d2',
      pos: 'before',
    });
    // 中线上方一格
    assert.deepEqual(findDropTarget(10, 119, row('folder', 'd1')), {
      kind: 'line',
      key: 'folder:d2',
      pos: 'before',
    });
    // 恰好在中线：不满足 `< mid`，判 after
    assert.deepEqual(findDropTarget(10, 120, row('folder', 'd1')), {
      kind: 'line',
      key: 'folder:d2',
      pos: 'after',
    });
    // 中线下方
    assert.deepEqual(findDropTarget(10, 130, row('folder', 'd1')), {
      kind: 'line',
      key: 'folder:d2',
      pos: 'after',
    });
  });
});

test('findDropTarget：分组拖到源行上 → null（分组不能放进分组）', () => {
  withDom([el('feed', 'f1', { top: 0 })], () => {
    assert.equal(findDropTarget(10, 10, row('folder', 'd1')), null);
  });
  withDom([el('loose', 'f1', { top: 0 })], () => {
    assert.equal(findDropTarget(10, 10, row('folder', 'd1')), null);
  });
});

test('findDropTarget：源拖到分组行上 → into 该分组（与中线无关）', () => {
  withDom([el('folder', 'd3', { top: 100, height: 40 })], () => {
    assert.deepEqual(findDropTarget(10, 105, row('feed', 'f1', 'd1')), { kind: 'into', folderId: 'd3' });
    assert.deepEqual(findDropTarget(10, 135, row('feed', 'f1', 'd1')), { kind: 'into', folderId: 'd3' });
    // 未分组的源也一样能放进分组
    assert.deepEqual(findDropTarget(10, 135, row('loose', 'f2')), { kind: 'into', folderId: 'd3' });
  });
});

test('findDropTarget：同组内源对源 → 画线；跨组 → 放进对方所在组', () => {
  // 同组（都在 d1）
  withDom([el('feed', 'f2', { folder: 'd1', top: 0 })], () => {
    assert.deepEqual(findDropTarget(10, 10, row('feed', 'f1', 'd1')), {
      kind: 'line',
      key: 'feed:f2',
      pos: 'before',
    });
    assert.deepEqual(findDropTarget(10, 30, row('feed', 'f1', 'd1')), {
      kind: 'line',
      key: 'feed:f2',
      pos: 'after',
    });
  });

  // 跨组（拖动在 d1，目标行属于 d2）
  withDom([el('feed', 'f2', { folder: 'd2', top: 0 })], () => {
    assert.deepEqual(findDropTarget(10, 10, row('feed', 'f1', 'd1')), { kind: 'into', folderId: 'd2' });
  });

  // 己方未分组，目标在 d2
  withDom([el('feed', 'f2', { folder: 'd2', top: 0 })], () => {
    assert.deepEqual(findDropTarget(10, 10, row('loose', 'f1')), { kind: 'into', folderId: 'd2' });
  });
});

test('findDropTarget：未分组对未分组 → 画线（两边都是 null 视为同组）', () => {
  withDom([el('loose', 'f2', { top: 0, height: 40 })], () => {
    assert.deepEqual(findDropTarget(10, 10, row('loose', 'f1')), {
      kind: 'line',
      key: 'loose:f2',
      pos: 'before',
    });
    assert.deepEqual(findDropTarget(10, 35, row('loose', 'f1')), {
      kind: 'line',
      key: 'loose:f2',
      pos: 'after',
    });
  });
});

test('findDropTarget：己方在组内、目标行未分组 → into null（移出分组）', () => {
  withDom([el('loose', 'f2', { top: 0 })], () => {
    assert.deepEqual(findDropTarget(10, 10, row('feed', 'f1', 'd1')), { kind: 'into', folderId: null });
  });
});

test('findDropTarget：用最上层的行（先跳过非行元素），遮挡物不算落点', () => {
  // elementsFromPoint 的顺序就是视觉层序：第一个非行元素应被跳过
  withDom([plainEl(), plainEl(), el('feed', 'f2', { folder: 'd1', top: 0 })], () => {
    assert.deepEqual(findDropTarget(10, 10, row('feed', 'f1', 'd1')), {
      kind: 'line',
      key: 'feed:f2',
      pos: 'before',
    });
  });
});

test('findDropTarget：最上层是自己的行时不落到更下面那行', () => {
  withDom([el('feed', 'f1', { folder: 'd1', top: 0 }), el('feed', 'f2', { folder: 'd1', top: 40 })], () => {
    assert.equal(findDropTarget(10, 10, row('feed', 'f1', 'd1')), null);
  });
});

test('findDropTarget：只用 elementsFromPoint 的 y 与 rect 判定，不做距离计算', () => {
  // 指针离矩形很远也被判定为该行：几何完全来自 rect，行本身由 DOM 命中决定
  withDom([el('folder', 'd9', { top: 1000, height: 40 })], () => {
    assert.deepEqual(findDropTarget(-100, 1010, row('folder', 'd1')), {
      kind: 'line',
      key: 'folder:d9',
      pos: 'before',
    });
  });
});
