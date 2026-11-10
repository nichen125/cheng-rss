// canonicalUrl / sameUrl 的行为约束（src/server/dedupe/url.ts）。
//
// 断言分两类，第二类更要紧：
//   · 该吃掉的：fragment、追踪参数、host 大小写、默认端口、末尾斜杠
//   · 该保住的：path 大小写、http/https、www、参数顺序、看似追踪的参数
// 把 `?p=3` 当追踪参数丢掉，两篇不同文章就会被判成同一条。
import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalUrl, sameUrl } from '../src/server/dedupe/url.ts';

test('空串、纯空白与解析不了的输入原样返回（trim 后），不抛', () => {
  assert.equal(canonicalUrl(''), '');
  assert.equal(canonicalUrl('   '), '');
  assert.equal(canonicalUrl('  not a url  '), 'not a url');
  assert.equal(canonicalUrl('/relative/path'), '/relative/path');
});

test('fragment 被丢弃', () => {
  assert.equal(canonicalUrl('https://example.com/a#section-2'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com/a/#x'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com/a?p=1#top'), 'https://example.com/a?p=1');
});

test('host 转小写，但 path 的大小写保留', () => {
  assert.equal(canonicalUrl('https://Example.COM/Path'), 'https://example.com/Path');
  assert.notEqual(canonicalUrl('https://example.com/A'), canonicalUrl('https://example.com/a'));
});

test('utm_* 系列连同大小写变体都被吃掉；参数清空后连 `?` 一起去掉', () => {
  assert.equal(
    canonicalUrl('https://example.com/a?utm_source=weixin&utm_medium=social&utm_campaign=x'),
    'https://example.com/a',
  );
  assert.equal(canonicalUrl('https://example.com/a?UTM_Source=x'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com/a?'), 'https://example.com/a');
});

test('各家点击/分享 id 被吃掉', () => {
  for (const p of [
    'fbclid=1',
    'gclid=1',
    'dclid=1',
    'msclkid=1',
    'yclid=1',
    'twclid=1',
    'mc_cid=1',
    'mc_eid=1',
    '_hsenc=1',
    '_hsmi=1',
    'igshid=1',
    'ref=1',
    'ref_src=1',
    'ref_url=1',
    'referrer=1',
    'spm=1',
    'share_id=1',
    'from=timeline',
    'source=rss',
    'hmsr=1',
    'vero_id=1',
    'oly_enc_id=1',
    'wickedid=1',
  ]) {
    assert.equal(canonicalUrl(`https://example.com/a?${p}`), 'https://example.com/a', p);
  }
});

test('真正选文章的参数必须留下：p / id / page / q / s / t', () => {
  assert.equal(
    canonicalUrl('https://example.com/a?p=3&utm_source=x&fbclid=y'),
    'https://example.com/a?p=3',
  );
  assert.equal(
    canonicalUrl('https://example.com/post?article_id=88'),
    'https://example.com/post?article_id=88',
  );
  assert.equal(canonicalUrl('https://example.com/list?page=2'), 'https://example.com/list?page=2');
  assert.equal(canonicalUrl('https://example.com/s?q=ai&s=2&t=9'), 'https://example.com/s?q=ai&s=2&t=9');
});

test('前缀匹配有边界：ref 被吃掉，但 ref_id 不是', () => {
  assert.equal(canonicalUrl('https://example.com/a?ref=x'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com/a?ref_id=7'), 'https://example.com/a?ref_id=7');
  // `_hs` 是前缀规则，因此 _hsabc 也会被吃掉（锁住当前取舍）
  assert.equal(canonicalUrl('https://example.com/a?_hsabc=1'), 'https://example.com/a');
});

test('保留的参数维持原顺序与重复项', () => {
  assert.equal(canonicalUrl('https://example.com/a?z=1&a=2&m=3'), 'https://example.com/a?z=1&a=2&m=3');
  assert.equal(canonicalUrl('https://example.com/a?a=1&a=2'), 'https://example.com/a?a=1&a=2');
});

test('末尾斜杠去掉（含多个），但根路径 `/` 保留', () => {
  assert.equal(canonicalUrl('https://example.com/a/'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com/a///'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com/a/?utm_source=x'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://example.com/'), 'https://example.com/');
  assert.equal(canonicalUrl('https://example.com'), 'https://example.com/');
});

test('非默认端口保留，默认端口写法与省略等价', () => {
  assert.equal(canonicalUrl('http://example.com:8080/a'), 'http://example.com:8080/a');
  assert.equal(canonicalUrl('https://example.com:8443/a'), 'https://example.com:8443/a');
  assert.equal(canonicalUrl('https://example.com:443/a'), 'https://example.com/a');
  assert.equal(canonicalUrl('http://example.com:80/a'), 'http://example.com/a');
});

test('刻意不做的三件事：http→https、去 www、参数排序', () => {
  assert.equal(canonicalUrl('http://example.com/a'), 'http://example.com/a');
  assert.notEqual(canonicalUrl('http://example.com/a'), canonicalUrl('https://example.com/a'));
  assert.notEqual(canonicalUrl('https://www.example.com/a'), canonicalUrl('https://example.com/a'));
  assert.notEqual(
    canonicalUrl('https://example.com/a?x=1&y=2'),
    canonicalUrl('https://example.com/a?y=2&x=1'),
  );
});

test('全角形式不是等价物：全角斜杠不构成末尾斜杠，全角 utm 前缀不被吃掉', () => {
  // U+FF0F 会被百分号编码，故不等于去掉斜杠后的形式
  assert.notEqual(canonicalUrl('https://example.com/a／'), canonicalUrl('https://example.com/a'));
  // 全角 ｕｔｍ 不是 ASCII 的 utm，规则匹配不到，参数保留
  assert.notEqual(canonicalUrl('https://example.com/a?ｕｔｍ_source=x'), 'https://example.com/a');
});

test('sameUrl：同一篇文章的不同写法判同', () => {
  assert.equal(sameUrl('https://Example.com/a/', 'https://example.com/a'), true);
  assert.equal(sameUrl('https://example.com', 'https://example.com/'), true);
  assert.equal(sameUrl('https://example.com/a?utm_source=tw&fbclid=1', 'https://example.com/a'), true);
  assert.equal(sameUrl('https://example.com/a#x', 'https://example.com/a'), true);
  assert.equal(sameUrl('https://example.com:443/a', 'https://example.com/a'), true);
});

test('sameUrl：不同文章的不同写法判异', () => {
  assert.equal(sameUrl('https://example.com/a', 'https://example.com/b'), false);
  assert.equal(sameUrl('https://example.com/a?p=1', 'https://example.com/a?p=2'), false);
  assert.equal(sameUrl('http://example.com/a', 'https://example.com/a'), false);
  assert.equal(sameUrl('https://www.example.com/a', 'https://example.com/a'), false);
  assert.equal(sameUrl('https://example.com/A', 'https://example.com/a'), false);
});
