/**
 * 查询理解层专项验证（纯函数，不需要起服务、不需要网络）。
 * 用法: node _qa_query.js
 *
 * 为什么单独一个脚本
 *   这一层的输出是「发给上游的那串字」。它错了不会报错、不会崩，只会让
 *   结果静默变成 0 条 —— 线上看起来像"站里没这个资源"，实际是查询被改坏了。
 *   所以每条清洗规则都要有一组固定的输入/期望，改词表时立刻能看出打死谁了。
 *
 * 覆盖五组：
 *   A 繁简与全角      —— 上游标题基本是简体，繁体查询等于自断召回
 *   B 口语剥除        —— 实测「有没有庆余年的资源」上游 0 条、「庆余年」有货
 *   C 意图识别        —— 类型 / 年份 / 季集 / 画质
 *   D 退让变体        —— 结果不够时按什么顺序放宽
 *   E 相关性打分      —— 命中必须显著高于噪音
 */

const q = require('./lib/query');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } else {
    fails.push(name + (detail ? '  →  ' + detail : ''));
    console.log('  \x1b[31m✗\x1b[0m ' + name + (detail ? '  →  ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, '实际 ' + JSON.stringify(actual) + ' / 期望 ' + JSON.stringify(expected));
}

console.log('\nA. 繁简 / 全角 / 标点');

eq('繁体片名转简体', q.prepare('慶餘年').upstream, '庆余年');
eq('繁体口语整句', q.prepare('有沒有慶餘年的資源').upstream, '庆余年');
eq('繁体后缀也能剥掉', q.prepare('慶餘年 第二季 資源').upstream, '庆余年 第二季');
eq('全角字母数字转半角', q.prepare('Ｏｆｆｉｃｅ　２０２１').upstream, 'office 2021');
eq('中文标点当分隔符', q.prepare('三体，全集《4K》').upstream, '三体 全集 4k');

console.log('\nB. 口语剥除（这一组直接决定"搜不搜得到"）');

eq('开头「有没有」被剥掉', q.prepare('有没有庆余年的资源').upstream, '庆余年');
eq('结尾「谢谢大佬」被剥掉', q.prepare('求三体全集资源谢谢大佬').upstream, '三体全集');
eq('「谁有」前缀被剥掉', q.prepare('谁有周杰伦').upstream, '周杰伦');
eq('前缀「大佬们」被剥掉', q.prepare('大佬们求个PS').upstream, 'ps');
eq('后缀「下载 / 链接」被剥掉', q.prepare('奥本海默 下载 链接').upstream, '奥本海默');
eq('复合口语整句归一', q.prepare('请问一下哪里能下载 沙丘2 的高清资源').upstream, '沙丘2');
eq('★ 安全阀：剥空就退回原词', q.prepare('求资源').upstream, '求资源');
eq('★ 安全阀：单词「资源」不被吃', q.prepare('资源').upstream, '资源');
eq('两字词不因后缀被削成单字', q.prepare('考研资料').upstream, '考研资料');
eq('清洗不改动正常词', q.prepare('三体').upstream, '三体');

console.log('\nC. 意图识别');

eq('影视剧类型', q.prepare('庆余年第二季').intent.type, 'tv');
eq('电影类型', q.prepare('奥本海默 4K 蓝光').intent.type, 'movie');
eq('课程类型', q.prepare('2026考研数学全程班').intent.type, 'course');
eq('软件类型', q.prepare('Office 2021 破解版').intent.type, 'software');
eq('音乐类型', q.prepare('周杰伦 无损 专辑').intent.type, 'music');
eq('书籍类型', q.prepare('三体 epub 电子书').intent.type, 'book');
eq('年份抽取', q.prepare('2024考研数学一真题').intent.year, '2024');
eq('季集抽取（第二季）', q.prepare('庆余年第二季').intent.season, '第二季');
eq('季集抽取（S02）', q.prepare('The Last of Us S02').intent.season, 's02');
eq('画质抽取', q.prepare('沙丘2 2160p HDR').intent.quality.join(','), '2160p,hdr');

console.log('\nD. 退让变体');

const v1 = q.prepare('庆余年第二季').variants.map((v) => v.q);
ok('有季集时生成「去季集」变体', v1.includes('庆余年'), v1.join(' / '));

const v2 = q.prepare('考研2025年真题').variants.map((v) => v.q);
ok('有年份时生成「去年份」变体', v2.includes('考研 真题'), v2.join(' / '));

const v3 = q.prepare('沙丘2 4K 1080p').variants.map((v) => v.q);
ok('有画质时生成「去画质」变体', v3.includes('沙丘2'), v3.join(' / '));

const v4 = q.prepare('庆余年').variants;
eq('没有可退让空间时不给空变体', v4.length, 0);

const p5 = q.prepare('周杰伦 稻香 无损');
ok('变体一律不含原词本身', p5.variants.every((v) => v.q !== p5.upstream));

console.log('\nE. 相关性打分');

const aQy = q.analyze('庆余年');
const hit = q.relevance({ title: '庆余年 第二季 全集 4K 中字' }, aQy);
const part = q.relevance({ title: '2025年热门国产剧打包' }, aQy);
const noise = q.relevance({ title: '热门影视合集大全 持续更新 拿走不谢' }, aQy);

ok('整词命中得分很高（>=80）', hit >= 80, 'hit=' + hit);
ok('无关条目得分很低（<=10）', Math.abs(part) <= 10, 'part=' + part);
ok('命中断层领先无关', hit - part >= 60, hit + ' vs ' + part);
ok('大杂烩标题被倒扣分', noise < 0, 'noise=' + noise);

const aY = q.analyze('2024考研数学');
const yHit = q.relevance({ title: '2024考研数学一全程班' }, aY);
const yMiss = q.relevance({ title: '2019考研数学一真题' }, aY);
ok('同年份比错年份更相关', yHit > yMiss, yHit + ' vs ' + yMiss);

const aT = q.analyze('周杰伦 无损');
const tRel = q.relevance({ title: '周杰伦全部专辑 FLAC 无损' }, aT);
ok('多词全部命中得到高分（>=60）', tRel >= 60, 'tRel=' + tRel);

console.log('\nF. 容错匹配（打错字 / 少打字 / 打拼音）');

const aTypo = q.analyze('庆余午');
const typoHit = q.relevance({ title: '庆余年 第二季 全集 4K 中字' }, aTypo);
const typoMiss = q.relevance({ title: '热门影视合集大全 持续更新' }, aTypo);
ok('打错一个字仍能命中（>0）', typoHit > 0, 'typoHit=' + typoHit);
ok('打错字命中显著高于无关条目', typoHit - typoMiss >= 20, typoHit + ' vs ' + typoMiss);

const aShort = q.analyze('庆年');
const shortHit = q.relevance({ title: '庆余年 第二季 全集' }, aShort);
ok('少打中间的字能命中（子序列）', shortHit > 0, 'shortHit=' + shortHit);

const aPy = q.analyze('qyn');
ok('拼音首字母 qyn 命中 庆余年', q.relevance({ title: '庆余年 第二季 全集' }, aPy) >= 30);

const aFull = q.analyze('qingyunian');
ok('全拼 qingyunian 命中 庆余年', q.relevance({ title: '庆余年 第二季 全集' }, aFull) >= 40);

const typoVars = q.prepare('庆余午第二季').variants.map((v) => v.q);
ok('长中文词生成「前缀截断」变体（绕过词尾的错字）', typoVars.includes('庆余'), typoVars.join(' / '));

console.log('\nG. 相关词抽取');

const related = require('./lib/related');
const relItems = [
  '庆余年 第二季 全集 4K 中字', '庆余年 第一季 全集 1080P', '庆余年 原著小说 epub',
  '庆余年 第二季 更新至12集', '庆余年 特别篇 花絮', '庆余年 第二季 4K HDR 内封字幕',
  '庆余年 有声小说 全本', '庆余年 漫画 全彩',
].map((t) => ({ title: t }));
const terms = related.extract(relItems, q.analyze('庆余年'));
ok('相关词非空', terms.length > 0, terms.join('、'));
ok('相关词不含查询词本身', !terms.some((t) => '庆余年'.includes(t) || t.includes('庆余年')), terms.join('、'));
ok('相关词不含泛词（合集/全集/资源…）', !terms.some((t) => ['合集', '全集', '资源', '下载'].includes(t)), terms.join('、'));
ok('相关词长度 2~4 字', terms.every((t) => t.length >= 2 && t.length <= 4), terms.join('、'));

console.log('\n————————————————————————————');
if (fails.length) {
  console.log('\x1b[31m失败 ' + fails.length + ' 项：\x1b[0m');
  fails.forEach((f) => console.log('  · ' + f));
  console.log('\n通过 ' + pass + '/' + (pass + fails.length) + '\n');
  process.exit(1);
}
console.log('\x1b[32m全部通过 ' + pass + '/' + pass + '\x1b[0m\n');
