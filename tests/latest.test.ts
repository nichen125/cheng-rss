// 请求序号守卫的单测（P0 fix/entry-list-race）。
//
// 这里覆盖的错法只能靠时序复现：先发的请求后返回。浏览器里要稳定造出
// "100ms 的响应晚于 300ms 的响应到达"几乎只能靠改后端，所以把判定
// 抽成不依赖 DOM/React 的纯逻辑，直接在这里按顺序调 begin/isLatest。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatest, isAbortError } from '../src/client/lib/latest.ts';

test('旧响应后到必须被丢弃', () => {
  const latest = createLatest();
  const first = latest.begin();
  const second = latest.begin();

  // 第二发（新视图/新搜索词）先到：允许落地
  assert.equal(latest.isLatest(second), true);
  // 第一发后到：必须丢弃，否则旧数据会盖掉刚渲染的新视图
  assert.equal(latest.isLatest(first), false);
});

test('先发后至：乱序到达时只有最新那次能落地', async () => {
  // 上个用例是"按顺序调用"，这里把真实的到达顺序也演一遍：
  // 第一发（慢）后返回，第二发（快）先返回。
  const latest = createLatest();
  const first = latest.begin();
  const second = latest.begin();

  const slow = new Promise<string>((resolve) => setTimeout(() => resolve('旧视图数据'), 20));
  const fast = Promise.resolve('新视图数据');

  const applied: string[] = [];
  for (const [seq, payload] of [[second, fast], [first, slow]] as const) {
    const text = await payload;
    if (latest.isLatest(seq)) applied.push(text);
  }

  // 旧响应确实到了，但它不许写 state —— 否则列表会闪回旧视图
  assert.deepEqual(applied, ['新视图数据']);
});

test('只有最后发起的请求能落地', () => {
  const latest = createLatest();
  const seqs = [latest.begin(), latest.begin(), latest.begin()];

  assert.deepEqual(seqs.map((s) => latest.isLatest(s)), [false, false, true]);
});

test('invalidate 之后所有在途请求都作废', () => {
  const latest = createLatest();
  const seq = latest.begin();
  latest.invalidate();

  // 离开这组筛选条件（切视图/改搜索词/卸载）时不必等新请求发起
  assert.equal(latest.isLatest(seq), false);

  // 作废只针对在途请求，下一次请求照常可以落地
  const next = latest.begin();
  assert.equal(latest.isLatest(next), true);
});

test('isAbortError 只认 AbortError 这个名字', () => {
  assert.equal(isAbortError(new DOMException('aborted', 'AbortError')), true);
  // 跨 realm 的 DOMException 可能不是同一个构造函数，按 name 判断
  assert.equal(isAbortError({ name: 'AbortError' }), true);
  assert.equal(isAbortError(new Error('boom')), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError('AbortError'), false);
});
