#!/usr/bin/env node
// HTML 白名单清洗 —— 安全边界
import { sanitizeHtml, textLength } from '../../src/server/feeds/sanitize.ts';

let pass = 0, fail = 0;
const check = (d, c, detail = '') => {
  if (c) { pass++; console.log(`  \u001b[32mPASS\u001b[0m  ${d}`); }
  else { fail++; console.log(`  \u001b[31mFAIL\u001b[0m  ${d}${detail ? `\n        ${detail}` : ''}`); }
};
const has = (h, s) => h.includes(s);

console.log('\nHTML 清洗');

// ── 危险的必须去掉 ──
{
  const r = sanitizeHtml('<p>安全</p><script>alert(1)</script>');
  check('script 连同内容一起删', !has(r.html, 'alert') && !has(r.html, '<script'), r.html);
  check('正常内容保留', has(r.html, '安全'), r.html);
}
{
  const r = sanitizeHtml('<img src="x" onerror="alert(1)">');
  check('onerror 事件属性被删', !has(r.html, 'onerror'), r.html);
}
{
  const r = sanitizeHtml('<a href="javascript:alert(1)">点我</a>');
  check('javascript: 伪协议被删', !has(r.html, 'javascript:'), r.html);
  check('但链接文字保留', has(r.html, '点我'), r.html);
}
{
  const r = sanitizeHtml('<a href="JaVaScRiPt&#58;alert(1)">x</a>');
  check('大小写混写 + 实体编码的伪协议也被拦', !/javascript/i.test(r.html), r.html);
}
{
  const r = sanitizeHtml('<div><iframe src="https://evil"></iframe>正文</div>');
  check('iframe 连同内容删除', !has(r.html, 'iframe'), r.html);
  check('iframe 外的正文保留', has(r.html, '正文'), r.html);
}
{
  const r = sanitizeHtml('<p onclick="evil()" style="color:red">文字</p>');
  check('onclick 与 style 都被删', !has(r.html, 'onclick') && !has(r.html, 'style='), r.html);
  check('文字保留', has(r.html, '文字'));
}
{
  const r = sanitizeHtml('<svg><script>alert(1)</script></svg>文本');
  check('svg 整块删除（svg 内的 script 是经典绕过）', !has(r.html, '<svg') && !has(r.html, 'alert'), r.html);
}
{
  const r = sanitizeHtml('<form action="/steal"><input name="p"><button>提交</button></form>内容');
  check('form/input/button 删除', !has(r.html, '<form') && !has(r.html, '<input') && !has(r.html, '<button'), r.html);
}
{
  const r = sanitizeHtml('<p>a</p><template><script>x</script></template><p>b</p>');
  check('template 删除', !has(r.html, 'template'), r.html);
}

// ── 排版必需的要保留 ──
{
  const r = sanitizeHtml(
    '<h2>标题</h2><p>段落 <strong>粗</strong> <em>斜</em></p>'
    + '<ul><li>一</li></ul><blockquote>引</blockquote><pre><code>x=1</code></pre>',
  );
  check('标题/段落/列表/引用/代码块全部保留',
    has(r.html, '<h2>') && has(r.html, '<strong>') && has(r.html, '<em>')
    && has(r.html, '<ul>') && has(r.html, '<blockquote>') && has(r.html, '<pre>')
    && has(r.html, '<code>'), r.html);
}
{
  const r = sanitizeHtml('<table><tr><td colspan="2">格</td></tr></table>');
  check('表格与 colspan 保留', has(r.html, '<table') && has(r.html, 'colspan'), r.html);
}
{
  const r = sanitizeHtml('<img src="https://x.com/a.jpg" alt="图">');
  check('img src/alt 保留', has(r.html, 'a.jpg') && has(r.html, 'alt="图"'), r.html);
  check('img 自动加 loading=lazy', has(r.html, 'loading="lazy"'), r.html);
}

// ── URL 处理 ──
{
  const r = sanitizeHtml('<a href="/rel">相对</a>', { baseUrl: 'https://example.com/post/1' });
  check('相对链接按 baseUrl 补全', has(r.html, 'https://example.com/rel'), r.html);
  check('外链自动加 noopener', has(r.html, 'noopener'), r.html);
  check('外链自动加 target=_blank（§15.11）', has(r.html, 'target="_blank"'), r.html);
}
{
  const r = sanitizeHtml('<a href="https://x.com">x</a>');
  check('绝对链接保持原样', has(r.html, 'href="https://x.com"'), r.html);
}

// §15.11：三类链接的出口各不相同。这三条直接决定"点一下会不会丢掉阅读器"，
// 所以放在清洗层验，而不是只在 UI 脚本里验 —— 数据脏了 UI 那边救不回来。
{
  const r = sanitizeHtml('<a href="#sec">锚点</a>', { baseUrl: 'https://example.com/post/1' });
  check('页内锚点不加 target', !has(r.html, 'target='), r.html);
  check('页内锚点仍补全成完整 URL', has(r.html, 'https://example.com/post/1#sec'), r.html);
}
{
  const r = sanitizeHtml('<a href="mailto:a@b.c">写信</a>', { baseUrl: 'https://example.com/p' });
  check('mailto 不加 target', !has(r.html, 'target='), r.html);
}
{
  const r = sanitizeHtml('<a href="tel:+8613800000000">电话</a>', { baseUrl: 'https://example.com/p' });
  check('tel 不加 target', !has(r.html, 'target='), r.html);
}

// 同一个 HTML 洗两遍，结果必须一样（幂等）。
//
// 为什么这条重要：entries 详情接口每次请求都会"读时再洗一次"（历史数据可能
// 来自旧版本）。第一次洗已经把 `#sec` 补成 `https://site/post#sec`，第二次
// 如果只判 `startsWith('#')`，就会把锚点误认成外链、给它加 target ——
// 第一版就是这么错的。幂等断言能在不碰浏览器的情况下抓住它。
{
  const once = sanitizeHtml('<a href="#sec">锚点</a><a href="/rel">相对</a>',
    { baseUrl: 'https://example.com/post/1' }).html;
  const twice = sanitizeHtml(once, { baseUrl: 'https://example.com/post/1' }).html;
  check('清洗是幂等的（洗两遍结果一致）', once === twice, `一次: ${once}\n        两次: ${twice}`);
  check('二次清洗后锚点仍无 target', !/href="[^"]*#sec"[^>]*target=/.test(twice)
    && !/target="[^"]*"[^>]*href="[^"]*#sec"/.test(twice), twice);
}
{
  const r = sanitizeHtml('<img src="data:image/png;base64,AAA">');
  check('data:image 允许（内联小图常见）', has(r.html, 'data:image'), r.html);
}
{
  const r = sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">');
  check('data:text/html 被拦', !has(r.html, 'data:text/html'), r.html);
}

// ── 未知标签：脱标签留文字 ──
{
  const r = sanitizeHtml('<custom-tag>里面的字</custom-tag>');
  check('未知标签脱掉但保留文字', !has(r.html, 'custom-tag') && has(r.html, '里面的字'), r.html);
}
{
  const r = sanitizeHtml('<div><span>a</span><unknown><b>b</b></unknown></div>');
  check('嵌套未知标签脱掉后子内容不丢', has(r.html, 'a') && has(r.html, 'b'), r.html);
}

// ── 边界 ──
{
  const r = sanitizeHtml('');
  check('空输入返回空串', r.html === '', JSON.stringify(r.html));
}
{
  const r = sanitizeHtml(null);
  check('null 输入返回空串', r.html === '');
}
{
  const r = sanitizeHtml('<p>未闭合');
  check('未闭合标签不抛错', typeof r.html === 'string' && has(r.html, '未闭合'), r.html);
}

// ── textLength ──
check('textLength 去标签计纯文字', textLength('<p>abc</p><div>de</div>') === 5, String(textLength('<p>abc</p><div>de</div>')));
check('textLength 不计 script 内容', textLength('<p>a</p><script>var x=1</script>') === 1, String(textLength('<p>a</p><script>var x=1</script>')));

// ── 统计 ──
{
  const r = sanitizeHtml('<script>x</script><p onclick="y">z</p><a href="javascript:1">l</a>');
  check('removed 统计非零（可观测攻击面）', r.removed.tags > 0 && r.removed.attrs > 0 && r.removed.urls > 0, JSON.stringify(r.removed));
}

console.log('');
if (fail === 0) console.log(`\u001b[32msanitize: ${pass}/${pass} PASS\u001b[0m`);
else { console.log(`\u001b[31msanitize: ${pass}/${pass + fail} PASS, ${fail} FAIL\u001b[0m`); process.exitCode = 1; }
