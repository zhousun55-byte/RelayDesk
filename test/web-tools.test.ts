import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage, htmlText, parseBing, parseDuck, privateHost, webSearch } from '../src/core/web';
import { planPrompt, stepPrompt } from '../src/core/prompts';

/** 假的网络：按网址给回应。 */
function fakeFetch(pages: Record<string, { status?: number; type?: string; body?: string; location?: string }>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    seen.push(url);
    const p = pages[url];
    if (!p) return new Response('没有', { status: 404 });
    const headers: Record<string, string> = { 'content-type': p.type ?? 'text/html; charset=utf-8' };
    if (p.location) headers.location = p.location;
    return new Response(p.body ?? '', { status: p.status ?? 200, headers });
  }) as typeof fetch;
}

test('上网工具不碰本机和局域网的地址（网页里的一句话不能让它去读路由器、本机服务），跳转过去也不行', async () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '[::1]', 'fd00::1', 'printer.local', '100.100.1.1']) assert.ok(privateHost(h), h);
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'cn.bing.com']) assert.ok(!privateHost(h), h);
  await assert.rejects(fetchPage('http://127.0.0.1:7388/api/state'), /本机或局域网/);
  await assert.rejects(fetchPage('file:///etc/passwd'), /只能读 http/);
  const seen: string[] = [];
  const f = fakeFetch({ 'https://a.example/': { status: 302, location: 'http://192.168.1.1/admin' } }, seen);
  await assert.rejects(fetchPage('https://a.example/', 1000, f), /本机或局域网/);
  assert.deepEqual(seen, ['https://a.example/'], '跳转到局域网的那一跳没有发出去');
});

test('读网页：去掉脚本和样式，留下标题、最终网址和正文；太长截断并说明', async () => {
  const html = '<html><head><title>药明康德 &amp; 半年报</title><style>.x{}</style></head><body><nav>菜单</nav><script>var a=1</script><h1>营收</h1><p>上半年营收约 &#20;<b>230</b> 亿元</p><table><tr><td>2025</td><td>2026</td></tr></table></body></html>';
  const t = htmlText(html);
  assert.equal(t.title, '药明康德 & 半年报');
  assert.doesNotMatch(t.text, /var a|菜单|\.x\{/);
  assert.match(t.text, /营收\n上半年营收约/);
  assert.match(t.text, /\| 2025 \| 2026/);
  const f = fakeFetch({ 'https://r.example/': { status: 301, location: '/new' }, 'https://r.example/new': { body: html }, 'https://bin.example/': { type: 'application/pdf', body: '%PDF' } });
  const page = await fetchPage('https://r.example/', 1000, f);
  assert.match(page, /^药明康德 & 半年报\nhttps:\/\/r\.example\/new\n/);
  assert.match(await fetchPage('https://r.example/new', 5, f), /只给了前 5 字/);
  assert.match(await fetchPage('https://bin.example/', 1000, f), /application\/pdf，不是网页文字/);
});

test('搜网页：先问 DuckDuckGo（解开跳转网址、去掉广告），没结果再问必应', async () => {
  const duck = '<a rel="nofollow" class="result__a" href="https://duckduckgo.com/y.js?ad=1">广告</a><a class="result__snippet">x</a>' + '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.cninfo.com.cn%2Fa&amp;rut=1">2026 年<b>半年度</b>报告</a><a class="result__snippet" href="#">体外筛选平台 &amp; 自动化</a>';
  assert.deepEqual(parseDuck(duck), [{ title: '2026 年半年度报告', url: 'https://www.cninfo.com.cn/a', snippet: '体外筛选平台 & 自动化' }]);
  const bing = '<li class="b_algo"><h2><a href="https://finance.sina.com.cn/x" h="ID=1">业绩点评</a></h2><div><p>全年指引上调</p></div></li>';
  assert.deepEqual(parseBing(bing), [{ title: '业绩点评', url: 'https://finance.sina.com.cn/x', snippet: '全年指引上调' }]);
  const q = encodeURIComponent('药明康德 半年报');
  const f = fakeFetch({ [`https://html.duckduckgo.com/html/?q=${q}`]: { body: '<p>没有结果</p>' }, [`https://cn.bing.com/search?q=${q}`]: { body: bing } });
  assert.equal(await webSearch('药明康德 半年报', 8, f), '1. 业绩点评\n   https://finance.sina.com.cn/x\n   全年指引上调');
  await assert.rejects(webSearch('什么都搜不到', 8, fakeFetch({})), /没搜到结果/);
});

test('拆解的提示：互不依赖的步骤标「可以同时做」；不许把自己工具做不到的事（不能联网）写成约定；同时做的那几步只改自己的文件', () => {
  const p = planPrompt({ id: 1, label: '智谱接口 · glm-5.3', handoff: '.relay/交接/x.md', gateCommand: '' });
  assert.match(p, /各加一行「可以同时做」/);
  assert.match(p, /不要把你自己这个工具做不到的事（比如你不能联网、不能跑命令）写成约定/);
  const s = stepPrompt({ id: 3, label: 'DeepSeek', handoff: '.relay/交接/y.md', gateCommand: '', step: { index: 2, text: '写行业' }, together: [3, 4] });
  assert.match(s, /第 3、4 步正由别人同时在做：只改这一步要改的文件/);
  assert.doesNotMatch(stepPrompt({ id: 3, label: 'DeepSeek', handoff: '.relay/交接/y.md', gateCommand: '', step: { index: 2, text: '写行业' } }), /同时在做/);
});
