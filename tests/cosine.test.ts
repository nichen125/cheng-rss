// hashEmbed / cosine / packVec / signatureText 的行为约束
// （src/server/dedupe/cosine.ts）。这些函数的用途是"判断两篇文章是不是同一篇"，
// 所以断言集中在判重需要的性质上：自比=1、同文高、异文低、对称、有界、确定性。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_DIM,
  LOCAL_MODEL,
  DUP_THRESHOLD,
  SAME_EVENT_THRESHOLD,
  hashEmbed,
  l2normalize,
  cosine,
  packVec,
  unpackVec,
  signatureText,
} from '../src/server/dedupe/cosine.ts';

const FILLER = '本测试只用性质断言：不写死具体小数，避免把哈希实现细节当契约锁死。';
test('常量：维度 256、模型名、阈值 0.95 与 0.88 且 SAME_EVENT < DUP', () => {
  assert.equal(LOCAL_DIM, 256);
  assert.equal(LOCAL_MODEL, 'local-hash-v1');
  assert.equal(DUP_THRESHOLD, 0.95);
  assert.equal(SAME_EVENT_THRESHOLD, 0.88);
  assert.ok(SAME_EVENT_THRESHOLD < DUP_THRESHOLD);
});

test('hashEmbed：长度等于 dim，默认 256，且已 L2 归一化（范数为 1）', () => {
  const v = hashEmbed('hello world');
  assert.equal(v.length, LOCAL_DIM);
  assert.ok(v instanceof Float32Array);
  let sum = 0;
  for (const x of v) sum += x * x;
  assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-5, `norm=${Math.sqrt(sum)}`);
});

test('hashEmbed：空串与纯空白得到全零向量（零向量不归一化，不产生 NaN）', () => {
  for (const t of ['', '   ', '\n\t']) {
    const v = hashEmbed(t);
    assert.equal(v.length, LOCAL_DIM);
    assert.ok(v.every((x) => x === 0), JSON.stringify(t));
    // 关键：不能有 NaN —— 零向量除以 0 会污染整条比较链
    assert.ok(v.every((x) => Number.isFinite(x)));
  }
});

test('hashEmbed：确定性 —— 同一文本两次结果逐元素相等', () => {
  const a = hashEmbed('确定性与中文混排 2024 election');
  const b = hashEmbed('确定性与中文混排 2024 election');
  assert.deepEqual(Array.from(a), Array.from(b));
});

test('hashEmbed：拉丁文本大小写不敏感（先 toLowerCase）', () => {
  assert.deepEqual(Array.from(hashEmbed('Hello World')), Array.from(hashEmbed('hello world')));
  assert.deepEqual(Array.from(hashEmbed('ABC')), Array.from(hashEmbed('abc')));
});

test('hashEmbed：全角字符不被当成 ASCII 拉丁词（与半角结果不同）', () => {
  // 正则只认 [a-z0-9_]；全角 ＡＢＣ 不匹配任何特征 → 空向量
  assert.ok(hashEmbed('ＡＢＣ').every((x) => x === 0));
  // 全角数字同理
  assert.ok(hashEmbed('１２３').every((x) => x === 0));
});

test('hashEmbed：中文（含扩展 A 区与兼容区）能产生非零特征', () => {
  for (const t of ['中', '人工智能', '\u3400\u3401', '\uf900']) {
    const v = hashEmbed(t);
    assert.ok(v.some((x) => x !== 0), JSON.stringify(t));
  }
});

test('hashEmbed：单个汉字也计入（run.length===1 走 add(run,1)）', () => {
  const one = hashEmbed('中');
  const two = hashEmbed('中文');
  assert.ok(one.some((x) => x !== 0));
  assert.notDeepEqual(Array.from(one), Array.from(two));
});

test('hashEmbed：自定义维度生效，结果仍是单位长度', () => {
  const v = hashEmbed('abc def ghi', 64);
  assert.equal(v.length, 64);
  let sum = 0;
  for (const x of v) sum += x * x;
  assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-5);
});

test('l2normalize：原地归一化并返回同一对象；零向量原样返回', () => {
  const v = new Float32Array([3, 4]);
  const out = l2normalize(v);
  assert.equal(out, v, '应原地修改并返回同一引用');
  assert.ok(Math.abs(v[0]! - 0.6) < 1e-6);
  assert.ok(Math.abs(v[1]! - 0.8) < 1e-6);

  const zero = new Float32Array([0, 0, 0]);
  assert.equal(l2normalize(zero), zero);
  assert.deepEqual(Array.from(zero), [0, 0, 0]);
});

test('cosine：自比=1，对称，值域 [-1,1]', () => {
  const v = hashEmbed('人工智能正在改变世界');
  assert.ok(Math.abs(cosine(v, v) - 1) < 1e-6);

  const a = hashEmbed('the quick brown fox jumps over the lazy dog');
  const b = hashEmbed('今天天气不错，适合出门散步');
  assert.ok(Math.abs(cosine(a, b) - cosine(b, a)) < 1e-6);
  const c = cosine(a, b);
  assert.ok(c >= -1.000001 && c <= 1.000001, `cosine=${c}`);
});

test('cosine：零向量 → 0（不是 NaN）；任一为空向量也 → 0', () => {
  const zero = new Float32Array(LOCAL_DIM);
  const v = hashEmbed('some text');
  assert.equal(cosine(zero, v), 0);
  assert.equal(cosine(v, zero), 0);
  assert.equal(cosine(zero, zero), 0);
  assert.ok(Number.isFinite(cosine(zero, v)));
});

test('cosine：维度不等时返回 0 而不抛错（换模型过渡期的 256 vs 1536）', () => {
  assert.equal(cosine(hashEmbed('a', 256), hashEmbed('a', 1536)), 0);
  assert.equal(cosine(new Float32Array(0), new Float32Array(0)), 0);
  assert.equal(cosine(hashEmbed('a', 256), new Float32Array(0)), 0);
});

test('cosine：未归一化的向量也能比（内部自己算模长）', () => {
  // 平行向量（比例 1:2）余弦应为 1
  const a = new Float32Array([1, 2, 3]);
  const b = new Float32Array([2, 4, 6]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  // 正交向量
  const c = new Float32Array([1, 0]);
  const d = new Float32Array([0, 1]);
  assert.equal(cosine(c, d), 0);
  // 反向
  assert.ok(Math.abs(cosine(c, new Float32Array([-1, 0])) + 1) < 1e-6);
});

test('判重性质：原文与转载差异的余弦高于异文，且带尾注的转载落在"同事件"档', () => {
  const text = `人工智能正在改变世界，这是一篇关于机器学习的文章的正文。${FILLER}`;
  const same = cosine(hashEmbed(text), hashEmbed(text));
  const repost = `${text}相关阅读：另见本站其他文章。`;
  const other = `今天天气不错，适合出门散步。${FILLER}另外这篇讲的是完全不同的主题，比如烹饪与园艺。`;

  // 完全相同的文本：余弦必须是 1
  assert.ok(Math.abs(same - 1) < 1e-6, `同文余弦 ${same}`);

  // 带尾注的转载：实测 ≈0.918 —— 高于"同事件"线、低于"同文"线。
  // 这正是阈值分层的意义：这种转载不应被直接合并（0.95），但值得聚类（0.88）
  const repostCos = cosine(hashEmbed(text), hashEmbed(repost));
  const diffCos = cosine(hashEmbed(text), hashEmbed(other));
  assert.ok(repostCos > SAME_EVENT_THRESHOLD, `转载余弦 ${repostCos} 应 > ${SAME_EVENT_THRESHOLD}`);
  assert.ok(repostCos < DUP_THRESHOLD, `转载余弦 ${repostCos} 不应误过 ${DUP_THRESHOLD}`);
  assert.ok(repostCos > diffCos, `转载 ${repostCos} 应高于异文 ${diffCos}`);
  assert.ok(diffCos < SAME_EVENT_THRESHOLD, `异文余弦 ${diffCos} 应 < ${SAME_EVENT_THRESHOLD}`);
});

test('判重性质：拉丁文长词共享 4-gram 前缀（election/elections），但不是"同一篇"', () => {
  const base = 'The election results were announced today after a long campaign season.';
  const variant = 'The elections results were announced today after a long campaign season.';
  const unrelated = 'A recipe for sourdough bread requires flour, water, salt and time.';

  const close = cosine(hashEmbed(base), hashEmbed(variant));
  const far = cosine(hashEmbed(base), hashEmbed(unrelated));
  // 实测 ≈0.90：共享的 elec 前缀把两段拉到"同事件"档，但词形不同不能算同一篇。
  // 这个性质正是阈值 0.88 / 0.95 分两档的依据
  assert.ok(close >= SAME_EVENT_THRESHOLD, `词形变化余弦 ${close} 应 ≥ ${SAME_EVENT_THRESHOLD}`);
  assert.ok(close < DUP_THRESHOLD, `词形变化余弦 ${close} 不应过 ${DUP_THRESHOLD}`);
  assert.ok(close > far, `词形变化 ${close} 应高于异文 ${far}`);
  assert.ok(far < 0.2, `异文余弦 ${far} 应很低`);
});

test('signatureText：标题去首尾空白 + 换行 + 正文压缩空白并截前 2000 字', () => {
  assert.equal(signatureText('  Title  ', 'a  b\n\tc'), 'Title\na b c');
  assert.equal(signatureText(null, null), '\n');
  assert.equal(signatureText(undefined, undefined), '\n');
  assert.equal(signatureText('', 'body'), '\nbody');
});

test('signatureText：超过 2000 字的正文被截断，标题不计入该上限', () => {
  const long = 'x'.repeat(2500);
  const s = signatureText('T', long);
  assert.equal(s, `T\n${'x'.repeat(2000)}`);

  const title = 'y'.repeat(2500);
  const s2 = signatureText(title, 'body');
  assert.equal(s2, `${title}\nbody`, '标题不截断');
});

test('signatureText：截断发生在压缩空白之后（先归一空白再 slice）', () => {
  const body = 'a '.repeat(3000); // 压缩后是 6000 字符
  const s = signatureText('T', body);
  const bodyPart = s.slice(2);
  assert.equal(bodyPart.length, 2000);
  assert.ok(!bodyPart.includes('  '), '压缩后不应有连续空格');
  assert.ok(!bodyPart.includes(' \n'), '尾随空格被 trim 掉');
});

test('packVec / unpackVec 往返：字节数 dim*4，值逐元素还原', () => {
  const v = hashEmbed('往返测试 roundtrip');
  const bytes = packVec(v);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.byteLength, v.length * 4);

  const back = unpackVec(bytes);
  assert.equal(back.length, v.length);
  assert.deepEqual(Array.from(back), Array.from(v));
});

test('packVec：带 byteOffset 的视图只打包自己那一段', () => {
  const big = new Float32Array([0, 1, 2, 3, 4, 5]);
  const view = big.subarray(2, 5); // [2,3,4]
  const bytes = packVec(view);
  assert.equal(bytes.byteLength, 12);
  assert.deepEqual(Array.from(unpackVec(bytes)), [2, 3, 4]);
  // 打包不应改动源数组
  assert.deepEqual(Array.from(big), [0, 1, 2, 3, 4, 5]);
});

test('unpackVec：坏数据返回空向量而不抛（null/空/长度非 4 的倍数）', () => {
  assert.equal(unpackVec(null).length, 0);
  assert.equal(unpackVec(undefined).length, 0);
  assert.equal(unpackVec(new Uint8Array(0)).length, 0);
  assert.equal(unpackVec(new Uint8Array([1, 2, 3])).length, 0);
  assert.equal(unpackVec(new Uint8Array([1, 2, 3, 4, 5])).length, 0);
});

test('unpackVec：返回的是副本，不共享外部 buffer（改源字节不影响结果）', () => {
  const src = new Uint8Array([0, 0, 0, 0, 0, 0, 0x80, 0x3f]); // [0, 1] (little-endian float32)
  const v = unpackVec(src);
  assert.deepEqual(Array.from(v), [0, 1]);

  const offsetView = new Uint8Array(12);
  offsetView.set([0, 0, 0x80, 0x3f], 4); // 只在中间一段写 1.0（小端）
  const fromOffset = unpackVec(offsetView.subarray(4, 8));
  assert.deepEqual(Array.from(fromOffset), [1]);
  offsetView[7] = 0; // 改源（指数位）不应影响已解出的向量
  assert.deepEqual(Array.from(fromOffset), [1]);
});
