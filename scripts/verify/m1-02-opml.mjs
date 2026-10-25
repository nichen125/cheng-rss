#!/usr/bin/env node
// OPML 往返 + 容错
import { parseOpml, buildOpml } from '../../src/server/feeds/opml.ts';

let pass = 0, fail = 0;
const check = (d, c, detail = '') => {
  if (c) { pass++; console.log(`  \u001b[32mPASS\u001b[0m  ${d}`); }
  else { fail++; console.log(`  \u001b[31mFAIL\u001b[0m  ${d}${detail ? `\n        ${detail}` : ''}`); }
};

console.log('\nOPML');

const IN = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>我的订阅</title></head>
  <body>
    <outline text="科技">
      <outline type="rss" text="少数派" title="少数派" xmlUrl="https://sspai.com/feed" htmlUrl="https://sspai.com"/>
      <outline type="rss" text="晚点" xmlUrl="https://example.com/latepost.xml"/>
    </outline>
    <outline type="rss" text="独立博客" xmlUrl="https://blog.example.net/rss"/>
    <outline text="空文件夹"/>
    <outline type="rss" text="重复" xmlUrl="https://sspai.com/feed"/>
    <outline type="rss" text="坏地址" xmlUrl="ftp://x.com/feed"/>
    <outline type="rss" text="缺地址"/>
  </body>
</opml>`;

const r = parseOpml(IN);
check('解析出 3 个可用源', r.feeds.length === 3, String(r.feeds.length));
check('文件夹名被正确继承', r.feeds.find((f) => f.url === 'https://sspai.com/feed')?.folder === '科技', JSON.stringify(r.feeds.map((f) => [f.url, f.folder])));
check('顶层源无文件夹', r.feeds.find((f) => f.url === 'https://blog.example.net/rss')?.folder === null, JSON.stringify(r.feeds.find((f) => f.url === 'https://blog.example.net/rss')));
check('htmlUrl 取到', r.feeds.find((f) => f.url === 'https://sspai.com/feed')?.siteUrl === 'https://sspai.com');
check('文件内重复被跳过', r.skipped.some((s) => s.reason === '文件内重复'), JSON.stringify(r.skipped));
check('非 http 地址被跳过', r.skipped.some((s) => /http\(s\)/.test(s.reason)), JSON.stringify(r.skipped));
check('缺 xmlUrl 的文件夹不产生源', !r.feeds.some((f) => f.title === '缺地址'));

// 往返
const out = buildOpml(r.feeds);
const back = parseOpml(out);
check('导出再导入源数一致', back.feeds.length === 3, String(back.feeds.length));
check('往返保留文件夹', back.feeds.find((f) => f.url === 'https://sspai.com/feed')?.folder === '科技', JSON.stringify(back.feeds.map((f) => [f.url, f.folder])));
check('往返保留标题', back.feeds.find((f) => f.url === 'https://sspai.com/feed')?.title === '少数派');
check('导出是合法 XML（可被再次解析）', out.includes('<opml') && out.includes('</opml>') && back.feeds.length > 0);

// 属性大小写容错
const UPPER = `<opml version="2.0"><body>
  <outline text="x" XMLURL="https://a.example/feed" HTMLURL="https://a.example"/>
</body></opml>`;
const u = parseOpml(UPPER);
check('XMLURL 大写也能识别', u.feeds.length === 1 && u.feeds[0].url === 'https://a.example/feed', JSON.stringify(u.feeds));

// 错误路径
let threw = false;
try { parseOpml('<html><body>hi</body></html>'); } catch { threw = true; }
check('HTML 当 OPML 导入会抛错（不是静默成功）', threw);

check('空输入返回空列表', parseOpml('').feeds.length === 0);

// XML 转义
const esc = buildOpml([{ url: 'https://x.com/f?a=1&b=2', title: 'A & B <c>', siteUrl: null, folder: null }]);
const escBack = parseOpml(esc);
check('URL 里的 & 被正确转义并还原', escBack.feeds[0].url === 'https://x.com/f?a=1&b=2', escBack.feeds[0].url);
check('标题里的 & < > 被正确转义并还原', escBack.feeds[0].title === 'A & B <c>', escBack.feeds[0].title);

console.log('');
if (fail === 0) console.log(`\u001b[32mopml: ${pass}/${pass} PASS\u001b[0m`);
else { console.log(`\u001b[31mopml: ${pass}/${pass + fail} PASS, ${fail} FAIL\u001b[0m`); process.exitCode = 1; }
