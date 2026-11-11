import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { formatIssues } from '../src/server/http/validate.ts';

// formatIssues 的契约：用户看到的必须是能照着改的一句话，
// 而不是 zod 的 issue 列表。这里锁定三件容易回退的事：
// 单字段措辞、多字段截断、嵌套路径的可读性。

test('单字段：类型错说清字段名与期望类型', () => {
  const err = z.object({ starred: z.boolean() }).safeParse({ starred: 'yes' });
  assert.equal(err.success, false);
  const msg = formatIssues(err.error);
  assert.equal(msg, '字段 starred 需要 boolean');
});

test('单字段：缺字段与类型错要分开表达', () => {
  const err = z.object({ ids: z.array(z.string()) }).safeParse({});
  assert.equal(err.success, false);
  assert.equal(formatIssues(err.error), '缺少字段 ids');
});

test('多字段：超过 3 条只留前 3 条并报总数', () => {
  const schema = z.object({
    a: z.number(),
    b: z.number(),
    c: z.number(),
    d: z.number(),
    e: z.number(),
  });
  const err = schema.safeParse({ a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' });
  assert.equal(err.success, false);
  const msg = formatIssues(err.error);
  const parts = msg.split('；');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], '字段 a 需要 number');
  assert.match(msg, /（另有 2 处问题）/);
});

test('多字段：3 条以内全部列出，不加后缀', () => {
  const err = z.object({ a: z.number(), b: z.boolean() }).safeParse({ a: 'x', b: 1 });
  assert.equal(err.success, false);
  assert.equal(formatIssues(err.error), '字段 a 需要 number；字段 b 需要 boolean');
});

test('嵌套路径：数组下标写成 ids[0]，不是 ids.0', () => {
  const err = z.object({ ids: z.array(z.string()) }).safeParse({ ids: [1] });
  assert.equal(err.success, false);
  const msg = formatIssues(err.error);
  assert.equal(msg, '字段 ids[0] 需要 string');
  assert.doesNotMatch(msg, /ids\.0/);
});

test('嵌套路径：对象里的对象保留点号层级', () => {
  const err = z.object({ page: z.object({ title: z.string() }) }).safeParse({ page: { title: 1 } });
  assert.equal(err.success, false);
  assert.equal(formatIssues(err.error), '字段 page.title 需要 string');
});

test('空路径：请求体本身不是对象时用「请求体」作主语', () => {
  const err = z.object({ ids: z.array(z.string()) }).safeParse('nope');
  assert.equal(err.success, false);
  assert.equal(formatIssues(err.error), '请求体需要 object');
});

test('schema 手写的中文提示优先于通用措辞', () => {
  const err = z.array(z.string()).min(1, 'ids 不能为空').safeParse([]);
  assert.equal(err.success, false);
  assert.equal(formatIssues(err.error), 'ids 不能为空');
});

test('枚举值：列出允许的取值而不是 expected 字面量', () => {
  const err = z.enum(['active', 'paused']).safeParse('broken');
  assert.equal(err.success, false);
  assert.equal(formatIssues(err.error), '请求体只能是 active、paused');
});

test('同一处错误重复出现时只说一遍', () => {
  // 数组里两个元素错法相同，zod 会给两条文案一样的 issue（只是 path 不同）。
  // 原样拼接会变成「ids 里只能是订阅 id；ids 里只能是订阅 id」，看着像两个问题。
  const err = z.array(z.string({ invalid_type_error: 'ids 里只能是订阅 id' }), {
    invalid_type_error: '需要 ids 数组',
  }).safeParse([1, 2]);
  assert.equal(err.success, false);
  assert.equal(formatIssues(err.error), 'ids 里只能是订阅 id');
});
