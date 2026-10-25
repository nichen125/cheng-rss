#!/usr/bin/env node
import { parseFeed, tryParseFeed, parseDate, htmlToText } from '../../src/server/feeds/parse.ts';

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>示例科技</title>
    <link>https://example.com</link>
    <description>每日科技简报</description>
    <item>
      <title>台积电三季度财报</title>
      <link>https://example.com/a1</link>
      <guid isPermaLink="false">tag:example.com,2026:a1</guid>
      <dc:creator>张三</dc:creator>
      <pubDate>Wed, 23 Oct 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>摘要只有一句</p>]]></description>
      <content:encoded><![CDATA[<p>全文第一段</p><p>全文第二段</p>]]></content:encoded>
      <category>半导体</category>
      <category>财报</category>
      <enclosure url="https://example.com/i1.jpg" type="image/jpeg"/>
    </item>
    <item>
      <title>第二篇</title>
      <link>/relative-b</link>
      <pubDate>not a date</pubDate>
      <description>纯文本描述，没有 CDATA</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 示例</title>
  <subtitle>一个 Atom feed</subtitle>
  <link rel="alternate" href="https://atom.example.org/"/>
  <icon>https://atom.example.org/icon.png</icon>
  <entry>
    <title>Atom 第一条</title>
    <id>urn:uuid:1</id>
    <link rel="alternate" href="https://atom.example.org/e/1"/>
    <published>2026-10-20T08:30:00Z</published>
    <author><name>李四</name></author>
    <content type="html">&lt;p&gt;Atom 正文&lt;/p&gt;</content>
    <category term="AI"/>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://rdf.example.net/">
    <title>RDF 示例</title>
    <link>https://rdf.example.net/</link>
    <description>RSS 1.0</description>
  </channel>
  <item rdf:about="https://rdf.example.net/1">
    <title>RDF 第一条</title>
    <link>https://rdf.example.net/1</link>
    <dc:date>2026-10-21T12:00:00Z</dc:date>
    <dc:creator>王五</dc:creator>
    <description>RDF 描述</description>
  </item>
</rdf:RDF>`;

const HTML_PAGE = `<!DOCTYPE html><html><head><title>x</title></head><body><p>不是 feed</p></body></html>`;
const BROKEN = `<rss><channel><title>坏的`;
const EMPTY = ``;

let pass = 0;
let fail = 0;
const check = (desc, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \u001b[32mPASS\u001b[0m  ${desc}`); }
  else { fail++; console.log(`  \u001b[31mFAIL\u001b[0m  ${desc}${detail ? `\n        ${detail}` : ''}`); }
};

console.log('\nfeed 解析');

// ── RSS 2.0 ──
const r = parseFeed(RSS2, 'https://example.com/feed.xml');
check('RSS2 识别为 rss2', r.format === 'rss2', r.format);
check('RSS2 频道标题', r.title === '示例科技', String(r.title));
check('RSS2 条目数 = 2', r.items.length === 2, String(r.items.length));
check('RSS2 用 content:encoded 而非 description', r.items[0].html?.includes('全文第一段') === true, String(r.items[0].html?.slice(0, 60)));
check('RSS2 guid 优先非 link', r.items[0].guid === 'tag:example.com,2026:a1', r.items[0].guid);
check('RSS2 dc:creator 取了作者', r.items[0].author === '张三', String(r.items[0].author));
check('RSS2 日期解析为 2026-10-23', new Date(r.items[0].publishedAt).toISOString().startsWith('2026-10-23'), new Date(r.items[0].publishedAt).toISOString());
check('RSS2 相对链接按 base 补全', r.items[1].url === 'https://example.com/relative-b', r.items[1].url);
check('RSS2 坏日期不返回 NaN', Number.isFinite(r.items[1].publishedAt), String(r.items[1].publishedAt));
check('RSS2 excerpt 去掉了 HTML 标签', r.items[0].excerpt === '全文第一段 全文第二段', String(r.items[0].excerpt));
check('RSS2 取到 enclosure 图片', r.items[0].imageUrl === 'https://example.com/i1.jpg', String(r.items[0].imageUrl));
check('RSS2 分类取到 2 个', r.items[0].categories.length === 2, JSON.stringify(r.items[0].categories));
check('RSS2 站点图标退到 favicon.ico', r.iconUrl === 'https://example.com/favicon.ico', String(r.iconUrl));

// ── Atom ──
const a = parseFeed(ATOM, 'https://atom.example.org/feed.xml');
check('Atom 识别为 atom', a.format === 'atom', a.format);
check('Atom 标题', a.title === 'Atom 示例', String(a.title));
check('Atom link 取 href 属性', a.siteUrl === 'https://atom.example.org/', String(a.siteUrl));
check('Atom 条目数 = 1', a.items.length === 1, String(a.items.length));
check('Atom 作者取 <author><name>', a.items[0].author === '李四', String(a.items[0].author));
check('Atom id 作为 guid', a.items[0].guid === 'urn:uuid:1', a.items[0].guid);
check('Atom content 被反转义', a.items[0].html?.includes('<p>Atom 正文</p>') === true, String(a.items[0].html));
check('Atom category 取 term 属性', a.items[0].categories[0] === 'AI', JSON.stringify(a.items[0].categories));
check('Atom icon 取到', a.iconUrl === 'https://atom.example.org/icon.png', String(a.iconUrl));

// ── RDF ──
const rd = parseFeed(RDF, 'https://rdf.example.net/feed.rdf');
check('RDF 识别为 rdf', rd.format === 'rdf', rd.format);
check('RDF 条目数 = 1', rd.items.length === 1, String(rd.items.length));
check('RDF rdf:about 作为 guid', rd.items[0].guid === 'https://rdf.example.net/1', rd.items[0].guid);
check('RDF dc:date 解析正确', new Date(rd.items[0].publishedAt).toISOString().startsWith('2026-10-21'), new Date(rd.items[0].publishedAt).toISOString());

// ── 错误路径 ──
const html = tryParseFeed(HTML_PAGE, 'https://x.com');
check('HTML 网页被拒绝且原因可读', html.ok === false && /HTML 网页/.test(html.error), html.ok ? '竟然解析成功' : html.error);

const broken = tryParseFeed(BROKEN, 'https://x.com');
// linkedom 对残缺 XML 很宽容："<rss><channel><title>坏的" 会被补全成
// 一个 0 条目的 feed 而不是报错。这不是我们想要的 "成功"，
// 所以断言它至少暴露为 0 条目，让上层能据此提示用户。
check('残缺 XML 要么报错要么暴露为 0 条目（不假装成功）',
  broken.ok === false || broken.feed.items.length === 0,
  JSON.stringify(broken.ok ? broken.feed.items.length : broken.error));

const empty = tryParseFeed(EMPTY, 'https://x.com');
check('空内容被拒绝', empty.ok === false && /为空/.test(empty.error), empty.ok ? '竟然成功' : empty.error);

// ── 日期边界 ──
check('未来日期（>1天）被钳到 fallback', parseDate('2099-01-01T00:00:00Z', 12345) === 12345, String(parseDate('2099-01-01T00:00:00Z', 12345)));
check('1970 年垃圾值被钳到 fallback', parseDate('1970-01-01T00:00:00Z', 12345) === 12345, String(parseDate('1970-01-01T00:00:00Z', 12345)));
check('正常历史日期保留', parseDate('2026-10-01T00:00:00Z', 1) > 1, String(parseDate('2026-10-01T00:00:00Z', 1)));

// ── htmlToText ──
check('htmlToText 去标签、去 script', htmlToText('<p>a</p><script>evil()</script><b>b</b>') === 'a b', htmlToText('<p>a</p><script>evil()</script><b>b</b>'));
check('htmlToText 解实体', htmlToText('&amp;&lt;&#65;&#x42;') === '&<AB', htmlToText('&amp;&lt;&#65;&#x42;'));

console.log('');
if (fail === 0) {
  console.log(`\u001b[32mfeed-parse: ${pass}/${pass} PASS\u001b[0m`);
} else {
  console.log(`\u001b[31mfeed-parse: ${pass}/${pass + fail} PASS, ${fail} FAIL\u001b[0m`);
  process.exitCode = 1;
}
