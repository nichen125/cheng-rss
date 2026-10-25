#!/usr/bin/env node
// 往指定数据目录灌一批演示条目，用来在不接 RSS 抓取的情况下看 UI。
//
// 用法：
//   node scripts/seed-demo.mjs --data ./data
//   node scripts/seed-demo.mjs --data ./data --user you@example.com
//
// 只写 entries / entry_contents / entry_analysis 和 FTS 索引，
// 不动 users —— 账号仍由你第一次打开 UI 时初始化。找不到用户就
// 报错退出，不偷偷建账号。
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};

const dataDir = resolve(arg('--data', './data'));
const dbPath = join(dataDir, 'app.db');
if (!existsSync(dbPath)) {
  console.error(`找不到 ${dbPath}\n先启动一次服务（会自动建库）再灌数据`);
  process.exit(1);
}

// 直接用生产的索引函数，不在这里重写一份 bigram 逻辑
const { indexEntry } = await import(
  pathToFileURL(join(root, 'src/server/search/index.ts')).href
);

const db = new DatabaseSync(dbPath);

const resolveUser = () => {
  const wanted = arg('--user');
  if (wanted) {
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(wanted);
    if (!u) { console.error(`没有用户 ${wanted}`); process.exit(1); }
    return u.id;
  }
  const first = db.prepare('SELECT id FROM users ORDER BY created_at LIMIT 1').get();
  if (!first) {
    console.error('库里还没有用户。先打开 UI 完成初始化，或加 --user <email>');
    process.exit(1);
  }
  return first.id;
};
const userId = resolveUser();

const now = Date.now();
const H = 3600_000;

const SEED = [
  {
    tier: 'must_read', importance: 82,
    site: '晚点 LatePost', title: '台积电三季度财报：先进制程产能持续吃紧，交期延长至 20 周',
    summary: '台积电三季度营收同比增长 12%，毛利率 53.2%。受先进制程产能紧张影响，英伟达、AMD 等主要客户订单交付周期已延长至 20 周，下季度预计维持满产。',
    points: ['先进制程（3nm/5nm）满载，交期从 12 周拉长到 20 周', '毛利率 53.2%，环比持平，未受海外扩产成本拖累', '主要客户订单已排至下季度末，短期难缓解'],
    topics: ['半导体', '财报', '供应链'], ago: 2 * H,
    body: '台积电今日公布第三季度财报。营收同比增长百分之十二，毛利率维持百分之五十三点二，与上季度基本持平。\n\n公司管理层在电话会上表示，受先进制程产能持续紧张影响，英伟达、AMD 等主要客户的订单交付周期已从十二周延长至二十周。这一状况预计在下季度仍将维持。\n\n资本开支方面，公司维持全年指引不变，海外新厂建设按计划推进。管理层强调，海外扩产带来的成本压力已被产品组合优化抵消。\n\n分析师普遍认为，先进制程的供需缺口将至少持续到明年上半年。对下游而言，交期拉长意味着新品上市节奏可能被迫调整。',
  },
  {
    tier: 'worth', importance: 64,
    site: 'Reuters', title: '半导体出口管制新规落地，国内厂商加速国产替代',
    summary: '新规进一步限制先进制程设备与 EDA 工具出口。多家券商研报认为短期国内晶圆厂扩产承压，但中长期将加速设备与材料环节的国产替代。',
    points: ['限制范围扩大到部分成熟制程设备与设计工具', '短期扩产节奏放缓，设备交付周期存不确定性', '设备、材料、EDA 国产厂商订单可见度提升'],
    topics: ['出口管制', '国产替代'], ago: 7 * H,
    body: '新一轮半导体出口管制规则正式生效，限制范围从此前的极紫外光刻设备扩大到部分先进制程所需的刻蚀、薄膜沉积设备以及主流 EDA 工具。\n\n多家券商在研报中指出，短期内国内晶圆厂的扩产节奏会受到影响，部分产线的设备交付周期存在不确定性。\n\n但报告同时认为，管制的持续收紧会显著提升国产设备与材料的验证意愿。过去需要两到三年才能完成的产线验证，现在可能在一年内推进。\n\nEDA 环节的替代难度最大。业内普遍认为，成熟制程的全流程工具可在两到三年内形成可用方案，先进制程则仍需更长时间。',
  },
  {
    tier: 'normal', importance: 41,
    site: 'Hacker News', title: '开源大模型发布：多项基准接近闭源旗舰，推理成本下降一半',
    summary: '新模型在 MMLU、HumanEval 等基准上接近当前闭源旗舰，官方称同等硬件下推理吞吐提升一倍。权重以 Apache 2.0 发布。',
    points: ['基准成绩接近闭源第一梯队，但未超越', 'Apache 2.0 许可，允许商用', '同等硬件推理吞吐提升约一倍'],
    topics: ['大模型', '开源'], ago: 26 * H,
    body: '一个新的开源大模型权重昨日发布，采用 Apache 2.0 许可，允许商业使用。\n\n官方公布的评测显示，该模型在 MMLU、HumanEval、GSM8K 等常用基准上接近当前闭源第一梯队模型，但在长上下文与多模态任务上仍有明显差距。\n\n工程侧的主要改进在推理效率：通过调整注意力实现与 KV cache 策略，官方称在同等硬件上吞吐提升约一倍。\n\n社区复现结果尚未大规模出现。有开发者指出，官方基准使用的提示词格式对成绩影响较大，实际使用中的表现需要独立评测确认。',
  },
  {
    tier: 'noise', importance: 12,
    site: 'PR Newswire', title: '某厂商季度营销通稿：新品线全面升级，强调生态协同',
    summary: '公司宣布旗下产品线完成年度升级，覆盖多个价位段，重点强调设计语言统一与跨设备生态协同能力。通稿未披露具体销售数据。',
    points: ['产品线年度更新，覆盖多个价位段', '强调设计语言统一与跨设备协同', '未披露销量、营收等可验证数据'],
    topics: ['消费电子'], ago: 3 * H,
    body: '公司今日宣布旗下产品线完成年度升级。本次更新覆盖多个价位段，重点强调设计语言的统一与跨设备生态协同能力。\n\n官方表示，新产品在续航、影像与系统流畅度方面均有提升，并强化了与同品牌其他设备的互联体验。\n\n通稿未披露具体销售数据、市场份额或第三方评测结果。',
  },
];

const insEntry = db.prepare(`
  INSERT INTO entries (id, user_id, guid, url, url_norm, title, published_at, fetched_at,
                       excerpt, word_count, stage, site_name, source_type,
                       is_read, is_starred, first_read_at, last_read_at, read_count)
  VALUES (?,?,?,?,?,?,?,?,?,?,'done',?,'rss',?,?,?,?,?)
`);
const insContent = db.prepare('INSERT INTO entry_contents (entry_id, html, extracted_by) VALUES (?,?,?)');
const insAnalysis = db.prepare(`
  INSERT INTO entry_analysis (entry_id, summary, key_points, topics, entities, importance, tier,
                              reading_time, lang, model, prompt_version, created_at)
  VALUES (?,?,?,?,?,?,?,?,'zh','seed','seed-v1',?)
`);

let made = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const s of SEED) {
    const guid = `seed:${createHash('sha1').update(s.title).digest('hex').slice(0, 16)}`;
    const id = `seed_${guid.slice(5, 13)}`;
    const published = now - s.ago;
    const words = Math.round(s.body.length / 2);
    const read = s.tier !== 'must_read';

    // 重复执行覆盖同一条，不累积垃圾
    db.prepare('DELETE FROM entries WHERE id = ?').run(id);

    insEntry.run(
      id, userId, guid, `https://example.com/seed/${id}`, `example.com/seed/${id}`,
      s.title, published, published, s.summary.slice(0, 120), words,
      s.site, read ? 1 : 0, 0,
      read ? published + 600_000 : null,
      read ? published + 600_000 : null,
      read ? 1 : 0,
    );

    // 与生产一致的 gzip + 0x01 标记格式（见 db/text-blob.ts）
    const html = s.body.split('\n\n').map((p) => `<p>${p}</p>`).join('');
    const gz = gzipSync(Buffer.from(html, 'utf8'), { level: 6 });
    const packed = new Uint8Array(gz.length + 1);
    packed[0] = 0x01;
    packed.set(gz, 1);
    insContent.run(id, packed, 'seed');

    insAnalysis.run(
      id, s.summary, JSON.stringify(s.points), JSON.stringify(s.topics), '[]',
      s.importance, s.tier, Math.max(1, Math.round(words / 400)), now,
    );

    indexEntry(db, id, {
      title: s.title,
      summary: s.summary,
      topics: s.topics,
      excerpt: s.summary.slice(0, 120),
    });

    made++;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

db.close();
console.log(`已写入 ${made} 条演示条目 → ${dbPath}`);
console.log('刷新 UI 即可看到列表。重复执行会覆盖同一批，不会累积。');
