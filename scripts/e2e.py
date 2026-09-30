#!/usr/bin/env python3
"""
网页的真实点击测试：起一个接力台（假家目录、只有假工具），用浏览器真的去点。
  python3 scripts/e2e.py            用这个目录下的 dist（先 npm run build）
  python3 scripts/e2e.py 某个目录   用那个目录下的 dist
要装 playwright（pip install playwright，再 playwright install chromium）。没装就跳过，不算失败。
不进 npm test：CI 里没有浏览器。
"""
import json
import re
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import subprocess
import sys
import tempfile
import time
import urllib.request

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print('跳过：没装 playwright')
    sys.exit(0)

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
CLI = os.path.join(ROOT, 'dist', 'src', 'cli.js')
fails = []


def check(ok, what):
    print(('通过  ' if ok else '没过  ') + what)
    if not ok:
        fails.append(what)


class Models(BaseHTTPRequestHandler):
    """本机的假模型接口：只回模型列表（添加模型时读它）。"""

    def do_GET(self):
        body = json.dumps({'data': [{'id': 'demo-pro'}, {'id': 'demo-flash'}, {'id': 'demo-tts'}]}).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def main():
    tmp = tempfile.mkdtemp(prefix='relay-e2e-')
    home = os.path.join(tmp, 'home')
    repo = os.path.join(tmp, '记账本')
    os.makedirs(home)
    os.makedirs(repo)
    with open(os.path.join(repo, 'README.md'), 'w') as f:
        f.write('# 记账本\n')
    env = {
        'HOME': home,
        'RELAY_HOME': os.path.join(home, '.relay'),
        'PATH': '/usr/bin:/bin:/usr/sbin:/sbin:' + os.path.dirname(sys.executable) + ':' + os.path.dirname(subprocess.check_output(['which', 'node'], text=True).strip()),
        'LANG': 'zh_CN.UTF-8',
        'RELAY_LOGIN_PATH': 'off',
        'RELAY_SCAN_APPS': 'off',
        'RELAY_AUTODETECT': 'off',
        'RELAY_NO_BROWSER': '1',
        'RELAY_CLIPBOARD': 'off',
        'RELAY_TERMINAL': 'off',
        'RELAY_APPS_DIRS': os.path.join(tmp, 'Apps'),
    }
    # 这台电脑上的程序：Trae 读得出标识；Kiro 只有空壳（不算装着）
    for app, bid in [('Trae', 'com.trae.app'), ('Kiro', None), ('Notes', 'com.apple.Notes')]:
        os.makedirs(os.path.join(tmp, 'Apps', f'{app}.app', 'Contents'))
        if bid:
            with open(os.path.join(tmp, 'Apps', f'{app}.app', 'Contents', 'Info.plist'), 'w') as f:
                f.write(f'<plist><dict><key>CFBundleIdentifier</key><string>{bid}</string></dict></plist>')
    subprocess.run(['node', CLI, 'init', '加一个导出'], cwd=repo, env=env, check=True, capture_output=True)
    subprocess.run(['node', CLI, 'task', '再加一个导入'], cwd=repo, env=env, check=True, capture_output=True)
    # 群聊里一句很长的话（之前发的）：网页上先收起
    with open(os.path.join(repo, '.relay', 'talk.jsonl'), 'a') as f:
        f.write(json.dumps({'ts': '2026-09-29T08:00:00.000Z', 'kind': 'human', 'who': '我', 'text': '\n'.join(f'第 {i} 行需求说明' for i in range(1, 31))}, ensure_ascii=False) + '\n')
    port = free_port()
    ui = subprocess.Popen(['node', CLI, 'ui', repo, '--port', str(port), '--no-open'], cwd=repo, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}/'
    try:
        for _ in range(60):
            try:
                if json.load(urllib.request.urlopen(url + 'api/ping', timeout=1)).get('app') == 'relay':
                    break
            except Exception:
                time.sleep(0.2)
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page(viewport={'width': 1280, 'height': 800}, locale='zh-CN')
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: m.type == 'error' and errors.append(m.text))
            page.goto(url)
            page.wait_for_function('() => typeof PAPER !== "undefined" && PAPER.w > 0')
            js = page.evaluate

            # 切页：点「派活」「群聊」「接力」，滑块跟着按下，纸扫一道换成那一页的
            for name, kind in [('派活', 'dispatch'), ('群聊', 'chat'), ('接力', 'relay')]:
                page.get_by_role('tab', name=name).click()
                page.wait_for_timeout(60)
                swept = js('() => !!PAPER.sweep')
                page.wait_for_function('() => !PAPER.sweep', timeout=3000)
                check(js('() => PAPER.kind') == kind and swept, f'点「{name}」：纸换成 {kind}，切的时候扫了一道')
                check(js('() => S.view') == kind, f'点「{name}」：停在这一页')

            # 指针在纸上划过：留下划痕，停下后褪掉、不再逐帧画
            box = page.locator('#center').bounding_box()
            page.mouse.move(box['x'] + 40, box['y'] + box['height'] - 60)
            for i in range(12):
                page.mouse.move(box['x'] + 40 + i * 20, box['y'] + box['height'] - 60 - i * 3)
            check(js('() => PAPER.trail.length') > 0, '指针划过纸面：有划痕')
            page.wait_for_timeout(600)
            check(js('() => PAPER.trail.length === 0 && !PAPER.raf'), '指针停下：划痕褪掉，不再逐帧画')

            # 收起（点「收起」）、打开（按 ⌘B）左栏：一道点扫过这一栏，扫完就拿掉
            for want in (True, False):
                if want:
                    page.locator('.brand').get_by_role('button', name='收起').click()
                else:
                    page.keyboard.press('Meta+b')
                page.wait_for_timeout(40)
                has = js('() => !!document.querySelector("#left > .specks.side")')
                check(js('() => document.querySelector(".app").classList.contains("no-left")') == want and has, f'{"收起" if want else "打开"}左栏：内沿扫一道点（点在左栏里面，不落到对话上）')
                page.wait_for_timeout(700)
                check(not js('() => !!document.querySelector(".specks.side")'), f'{"收起" if want else "打开"}左栏：扫完点拿掉了')

            # 设置：点开、切到成员、按 Esc 关掉
            page.get_by_role('button', name='设置').click()
            page.locator('.settings').wait_for()
            page.locator('.settings').get_by_role('tab', name='成员').click()
            page.wait_for_timeout(300)
            check(page.locator('.settings .members').count() == 1, '设置：点开、切到成员')
            y0 = js('() => getComputedStyle(document.querySelector(".settings nav")).getPropertyValue("--hy")')
            page.locator('.settings').get_by_role('tab', name='运行').click()
            page.wait_for_timeout(500)
            y1 = js('() => getComputedStyle(document.querySelector(".settings nav")).getPropertyValue("--hy")')
            check(y0 != y1 and page.locator('.settings .pane-in').get_by_text('每一棒最长').count() == 1, '设置：切到「运行」，页签底下那一块滑过去，每一项有说明')
            page.keyboard.press('Escape')
            page.wait_for_timeout(500)
            check(page.locator('.settings').count() == 0, '设置：按 Esc 关掉')

            # 换模型：点名字弹出来，平时只露现在用的和同一家的几个（语音模型不列）；「+」再加一位；打字搜、没有的直接用写的
            mock = ThreadingHTTPServer(('127.0.0.1', 0), Models)
            threading.Thread(target=mock.serve_forever, daemon=True).start()
            with open(os.path.join(home, '.relay', 'agents.json'), 'w') as f:
                json.dump({'agents': [{'name': 'demo', 'label': 'Demo 接口', 'kind': 'api', 'tier': 'strong', 'tierSet': True, 'api': {'baseUrl': f'http://127.0.0.1:{mock.server_port}/v1', 'model': 'demo-pro', 'apiKeyEnv': ''}}]}, f)
            js('() => refresh(true)')
            page.get_by_role('button', name='设置').click()
            page.locator('.settings').get_by_role('tab', name='成员').click()
            page.locator('.settings .members .member').first.wait_for()
            page.locator('.settings .member .mname').first.click()
            menu = page.locator('.model-menu:not(.leave)')
            menu.locator('.mrow').first.wait_for(timeout=5000)
            rows = menu.locator('.mrow')
            check(rows.count() == 2 and menu.locator('[aria-checked=true]').filter(has_text='Demo Pro').count() == 1, '换模型：点名字弹出来，现在用的打着勾，语音模型不列')
            page.screenshot(path=os.path.join(tmp, 'model-menu.png'))
            rows.filter(has_text='Demo Flash').hover()
            rows.filter(has_text='Demo Flash').get_by_role('button', name='再加一位 Demo Flash').click()
            page.wait_for_function('() => document.querySelectorAll(".settings .members .member").length === 2', timeout=5000)
            with open(os.path.join(home, '.relay', 'agents.json')) as f:
                added = [a for a in json.load(f)['agents'] if a['name'] != 'demo']
            check([(a['api']['model'], a['tier']) for a in added] == [('demo-flash', 'weak')] and page.locator('.settings .members').get_by_text('Demo Flash').count() == 1, '换模型：点「+」再加一位（照抄接口，只换模型，强弱按模型猜）')
            page.locator('.settings .member .mname').filter(has_text='Demo Flash').click()
            menu.locator('.msearch').fill('demo-mini')
            menu.get_by_role('menuitemradio', name='demo-mini').click()
            page.wait_for_function('() => [...document.querySelectorAll(".settings .members .mname")].some((b) => b.textContent.includes("Demo Mini"))', timeout=5000)
            with open(os.path.join(home, '.relay', 'agents.json')) as f:
                models = sorted(a['api']['model'] for a in json.load(f)['agents'])
            check(models == ['demo-mini', 'demo-pro'], '换模型：打字搜，列表里没有的直接用写的名字，这一位换成它')
            # 添加桌面程序：认得的、核实过的排成一排，点一下填好；写一个这台电脑上没有的，「添加」按不了
            page.locator('.settings').get_by_role('button', name='添加', exact=True).click()
            page.locator('.menu .mi').filter(has_text='桌面程序').click()
            dlg = page.get_by_role('dialog', name='添加桌面程序')
            pick = dlg.locator('.app-picks .pick')
            pick.first.wait_for(timeout=5000)
            names = pick.all_inner_texts()
            pick.filter(has_text='Trae').click()
            inputs = dlg.locator('input.input')
            filled = [inputs.nth(0).input_value(), inputs.nth(1).input_value()]
            add = dlg.get_by_role('button', name='添加', exact=True)
            page.wait_for_timeout(450)
            found = dlg.locator('.app-check').first.inner_text()
            check(names == ['Trae'] and filled == ['Trae', 'trae'] and found.startswith('这台电脑上有：') and add.is_enabled(), f'添加桌面程序：识别到的（核实过标识，空壳不算）点一下填好（{names} {filled} {found}）')
            inputs.nth(0).fill('Nope')
            page.wait_for_timeout(450)
            check(add.is_disabled() and '没有叫「Nope」' in dlg.locator('.app-check.bad').inner_text(), '添加桌面程序：写一个这台电脑上没有的，标红、「添加」按不了')
            page.screenshot(path=os.path.join(tmp, 'add-app.png'))
            inputs.nth(0).fill('Trae')
            add.click()
            page.wait_for_function('() => document.querySelectorAll(".settings .members .member").length === 3', timeout=5000)
            with open(os.path.join(home, '.relay', 'agents.json')) as f:
                trae = [a for a in json.load(f)['agents'] if a['name'] == 'trae']
            check([(a['kind'], a['label'], a['tier']) for a in trae] == [('app', 'Trae', 'weak')], '添加桌面程序：点「添加」加进名单')
            page.keyboard.press('Escape')
            page.wait_for_timeout(400)
            mock.shutdown()

            # 工具里的对话：这个项目文件夹里自己在 Claude Code 里开的一段，左边收成一行，点开能看全文
            real = os.path.realpath(repo)
            cdir = os.path.join(home, '.claude', 'projects', re.sub(r'[^A-Za-z0-9]', '-', real))
            os.makedirs(cdir, exist_ok=True)
            with open(os.path.join(cdir, 'desk-000001.jsonl'), 'w') as f:
                for row in [
                    {'type': 'user', 'cwd': real, 'entrypoint': 'claude-desktop', 'message': {'role': 'user', 'content': '导出做成 CSV 吗' + '，顺带看一下 `python3 -m unittest discover` 为什么很慢' * 3}},
                    {'type': 'assistant', 'cwd': real, 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': '做成 CSV'}, {'type': 'tool_use', 'name': 'Read', 'input': {'file_path': 'README.md'}}]}},
                ]:
                    f.write(json.dumps(row, ensure_ascii=False) + '\n')
            page.get_by_role('tab', name='接力').click()
            js('() => { S.sessions.at = 0; return loadSessions(); }')
            page.locator('.thread.sess-head').wait_for(timeout=5000)
            page.locator('.thread.sess-head').click()
            row = page.locator('.thread.sess').filter(has_text='导出做成 CSV 吗')
            row.wait_for(timeout=3000)
            page.wait_for_timeout(400)
            box = js('''() => { const r = document.querySelector('.thread.sess'), t = r.querySelector('.t'); const a = r.getBoundingClientRect(), b = t.getBoundingClientRect();
              return { h: Math.round(a.height), dir: getComputedStyle(r).flexDirection, inside: b.left >= a.left - 1 && b.right <= a.right + 1, ell: t.scrollWidth > t.clientWidth }; }''')
            check(box['h'] <= 40 and box['dir'] == 'row' and box['inside'] and box['ell'], f'工具里的对话：标题太长时一行、末尾省略，不跑出左边（{box}）')
            row.click()
            page.locator('.sess-log .sm.ai').wait_for(timeout=5000)
            check(page.locator('.sess-log .sm.user').inner_text().startswith('导出做成 CSV 吗') and page.locator('.sess-log .sm.tool').inner_text() == 'Read：README.md', '工具里的对话：左边收成一行，点开看全文（人说的、AI 答的、用了什么工具）')
            page.locator('.thread.sess-head').click()
            page.wait_for_function('() => !document.querySelector(".thread.sess")', timeout=3000)
            check(page.locator('.thread.sess-head').get_attribute('aria-expanded') == 'false', '工具里的对话：再点一下收起（原地淡出，不整列重画）')
            page.locator('.tab.chat-tab').click()

            # 打 / 挑技能：写任务的输入框也能挑，选了在字里写成「/技能名 」
            sk = os.path.join(home, '.agents', 'skills', 'demo-skill')
            os.makedirs(sk, exist_ok=True)
            with open(os.path.join(sk, 'SKILL.md'), 'w') as f:
                f.write('---\nname: demo-skill\ndescription: 演示用的技能\n---\n\n先写测试。\n')
            js('() => { SKILLS.dir = ""; }')
            page.locator('#left-in').get_by_role('button', name='新任务').first.click()
            ta = page.locator('.composer textarea')
            ta.wait_for(timeout=5000)
            ta.click()
            ta.fill('')
            ta.type('按 /demo')
            page.locator('.menu .mi').filter(has_text='demo-skill').wait_for(timeout=5000)
            page.keyboard.press('Enter')
            check(ta.input_value() == '按 /demo-skill ', '打 / 挑技能：写任务时也能挑，选了写成「/技能名」')
            ta.fill('')
            # 接力页写任务：行首打 / 出命令和技能；打 @ 出成员（做第一棒）和文件，选了成员是一个小条
            ta.type('/')
            page.locator('.menu .mi').first.wait_for(timeout=5000)
            heads = page.locator('.menu .mh').all_inner_texts()
            has_cmd = page.locator('.menu .mi').filter(has_text='对账').count() == 1 and page.locator('.menu .mi').filter(has_text='demo-skill').count() == 1
            check(has_cmd and heads[:2] == ['命令', '技能'], f'接力页写任务：行首打 / 出命令和技能（{heads}）')
            ta.fill('')
            page.keyboard.press('Escape')
            ta.click()
            ta.type('先看 @')
            page.locator('.menu .mi').first.wait_for(timeout=5000)
            first = page.locator('.menu .mi').filter(has_text='做第一棒').first
            who = first.locator('.grow > span').first.inner_text() if first.count() else ''
            check(bool(who) and page.locator('.menu .mh').filter(has_text='文件').count() == 1, f'接力页写任务：打 @ 出成员（做第一棒）和文件（{who}）')
            first.click()
            chip = page.locator('.composer .attach .chip.who')
            chip.wait_for(timeout=3000)
            check(f'{who} 做第一棒' in chip.inner_text() and ta.input_value() == '先看 ' and page.locator('.composer .switch').filter(has_text='全自动').is_hidden(), '接力页写任务：@ 一位成员变成「X 做第一棒」小条（全自动开关收起）')
            page.screenshot(path=os.path.join(tmp, 'who-chip.png'))
            chip.get_by_role('button', name='去掉').click()
            page.wait_for_timeout(200)
            check(page.locator('.composer .attach .chip.who').count() == 0, '接力页写任务：小条点 × 去掉')
            ta.fill('')
            page.keyboard.press('Escape')
            # 派活页写任务：@ 只列文件（谁指挥、谁干活在下面选）
            page.get_by_label('页面').get_by_role('tab', name='派活').click()
            page.wait_for_timeout(500)
            if page.locator('#left-in').get_by_role('button', name='新任务').count():
                page.locator('#left-in').get_by_role('button', name='新任务').first.click()
            ta.wait_for(timeout=5000)
            ta.click()
            ta.type('@')
            page.locator('.menu .mi').first.wait_for(timeout=5000)
            check(page.locator('.menu .mi').filter(has_text='做第一棒').count() == 0 and page.locator('.menu .mh').all_inner_texts() == ['文件'], '派活页写任务：@ 只列文件')
            ta.fill('')
            page.keyboard.press('Escape')
            page.get_by_label('页面').get_by_role('tab', name='接力').click()
            page.wait_for_timeout(500)
            if page.locator('#left-in').get_by_role('button', name='新任务').count():
                page.locator('#left-in').get_by_role('button', name='新任务').first.click()
            ta.wait_for(timeout=5000)
            # 设置里的技能：每个三档，点「不用」原地滑过去、存进 auto.json；之后打 / 不再列出它
            page.get_by_role('button', name='设置').click()
            page.locator('.settings').get_by_role('tab', name='技能').click()
            srow = page.locator('.settings .skill-list .row').filter(has_text='demo-skill')
            srow.wait_for(timeout=5000)
            srow.get_by_role('button', name='不用').click()
            saved = None
            for _ in range(50):
                try:
                    with open(os.path.join(home, '.relay', 'auto.json')) as f:
                        saved = json.load(f).get('skills')
                except Exception:
                    saved = None
                if saved == {'demo-skill': 'off'}:
                    break
                page.wait_for_timeout(100)
            check(saved == {'demo-skill': 'off'} and srow.get_by_role('button', name='不用').get_attribute('aria-pressed') == 'true', '设置里的技能：三档，点「不用」原地换过去、存好')
            page.keyboard.press('Escape')
            page.wait_for_timeout(400)
            ta.click()
            ta.type('按 /demo')
            page.wait_for_timeout(600)
            check(page.locator('.menu .mi').filter(has_text='demo-skill').count() == 0, '设成「不用」的技能：打 / 不列出')
            ta.fill('')
            page.keyboard.press('Escape')
            page.locator('#left-in .thread').filter(has_text='再加一个导入').click()
            page.wait_for_timeout(300)
            # 派活边做边复核：顶上除了正在干活的，再多一个「复核第 N 棒」（和干活同时在跑）
            side = js('''() => {
              const t = pageThreads().find((x) => x.current);
              if (!t) return 'no-thread';
              const keep = S.st.project.go;
              const now = new Date().toISOString();
              S.st.project.go = { id: 'x', status: 'running', mode: 'auto', dispatch: true, phase: '', stints: [], current: { stint: 9, member: 'demo', label: 'Demo · demo-flash', kind: 'work', since: now, log: '' }, side: { member: 'demo', label: 'Demo · demo-pro', targets: [7, 8], since: now, log: '' } };
              barSig = '';
              renderBar(t);
              const el = document.querySelector('.status[data-k=side]');
              const text = el ? el.innerText.replace(/\\s+/g, ' ') : '';
              S.st.project.go = keep;
              barSig = '';
              renderBar(t);
              return text;
            }''')
            check('复核第 7、8 棒' in side, f'派活边做边复核：顶上多一个「复核第 N 棒」（{side}）')

            # 群聊：之前发的长话先收起，点「展开」看全文；粘进来很长的一段字存成文件带上，输入框里只有一个小条，点开在页签里看
            page.get_by_role('tab', name='群聊').click()
            page.locator('.me .note').first.wait_for()
            folded = page.locator('.me .note.fold').count() == 1
            page.locator('.me').get_by_role('button', name='展开').click()
            page.wait_for_timeout(350)
            check(folded and page.locator('.me .note.fold').count() == 0, '群聊：长话先收起，点「展开」看全文')
            tip = js('() => { S.ask = new Set(talkers().map((m) => m.name)); updateComposer(); return `${S.ask.size}|${C.pick.dataset.tip}`; }')
            check(tip.split('|')[1] == f"{tip.split('|')[0]} 位回答", f'群聊：成员一叠停上去只写几位（{tip}），名字点开看')
            long = '\n'.join(f'日志第 {i} 行：导出失败' for i in range(1, 61))
            paste = '''(text) => {
              const ta = document.querySelector('.composer textarea');
              ta.focus();
              const dt = new DataTransfer();
              dt.setData('text/plain', text);
              const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
              ta.dispatchEvent(e);
              return e.defaultPrevented;
            }'''
            check(not js(paste, '短短一句'), '粘一句短的：照常粘成字')
            taken = js(paste, long)
            chip = page.locator('.composer .attach .chip:not(.busy)').filter(has_text='粘贴的文字（60 行）.txt')
            chip.wait_for(timeout=5000)
            check(taken and js('() => document.querySelector(".composer textarea").value') == '' and js('() => S.files[0]').startswith('.relay/uploads/'), '粘一大段字：存成文件带上，输入框里是空的')
            chip.locator('.ell').click()
            page.wait_for_function('() => document.body.innerText.includes("日志第 60 行")', timeout=5000)
            check(True, '点那个小条：在页签里看到粘进来的全文')
            page.locator('#center').get_by_role('tab', name='群聊').click()

            # 右键：左边这段群聊「删除群聊」→ 不见了，点提示里的「撤销」→ 回来（成了一段存档的群聊）
            menu = page.locator('.menu:not(.leave)')
            page.locator('.thread[data-id="chat:"]').click(button='right')
            menu.get_by_role('menuitem', name='删除群聊').click()
            page.wait_for_function('() => !document.querySelector(".thread[data-id^=\\"chat:talk-\\"]") && S.talk.rows.length === 0', timeout=5000)
            page.locator('.toast').get_by_role('button', name='撤销').click()
            page.locator('.thread[data-id^="chat:talk-"]').wait_for(timeout=5000)
            check(True, '右键删除群聊：左边不见了，撤销后回来')

            page.get_by_label('页面').get_by_role('tab', name='接力').click()
            page.wait_for_timeout(400)
            # 右键：正在做的任务也能删（清单清空，回到写新任务），撤销 → 原样回来；旧的那段「删除对话」→ 不见了，撤销 → 回来；中间空白处有常用操作
            threads = page.locator('.left-body .thread:not(.draft)')
            cur_id = threads.first.get_attribute('data-id')
            threads.first.click(button='right')
            menu.get_by_role('menuitem', name='删除对话').click()
            page.wait_for_function('() => S.st.project.task.empty && document.querySelector(".left-body .thread.draft")', timeout=5000)
            page.locator('.toast').get_by_role('button', name='撤销').click()
            page.wait_for_function('() => S.st.project.task.title === "再加一个导入"', timeout=5000)
            page.locator(f'.thread[data-id="{cur_id}"]').wait_for(timeout=5000)
            check(True, '右键删除正在做的任务：清单清空、回到写新任务，撤销后原样回来')
            old = threads.nth(1)
            old_id = old.get_attribute('data-id')
            old.click(button='right')
            menu.get_by_role('menuitem', name='删除对话').click()
            page.wait_for_function(f'() => !document.querySelector(\'.thread[data-id="{old_id}"]\')', timeout=5000)
            page.locator('.toast').get_by_role('button', name='撤销').click()
            page.locator(f'.thread[data-id="{old_id}"]').wait_for(timeout=5000)
            check(True, '右键删除旧的对话：左边不见了，撤销后回来')
            page.locator('.stream').click(button='right', position={'x': 8, 'y': 8})
            check(menu.get_by_role('menuitem', name='新任务').count() == 1 and menu.get_by_role('menuitem', name='接力本').count() == 1, '中间空白处右键：新任务、接力本这些常用操作')
            page.keyboard.press('Escape')

            # 运行设置 auto.json 写坏了：顶上提示（不悄悄按默认的派活），点「恢复默认」修好，坏的那份留成 auto.json.broken
            auto = os.path.join(home, '.relay', 'auto.json')
            with open(auto, 'w') as f:
                f.write('{ "order": [], }')
            js('() => refresh(true)')
            bar = page.locator('.cfg-bad')
            bar.get_by_text('运行设置坏了').wait_for(timeout=5000)
            bar.get_by_role('button', name='恢复默认').click()
            page.wait_for_function('() => document.querySelector(".cfg-bad").hidden', timeout=5000)
            with open(auto) as f:
                fixed = json.load(f)
            check(os.path.exists(auto + '.broken') and fixed.get('order') == [], '运行设置写坏了：顶上提示，点「恢复默认」修好，坏的那份留着')

            # 成员名单 agents.json 写坏了：顶上提示（不当成没有成员），点「重新识别」修好，坏的那份存成 agents.json.broken
            agents = os.path.join(home, '.relay', 'agents.json')
            with open(agents, 'w') as f:
                f.write('{ "agents": [ 坏 ,,')
            js('() => refresh(true)')
            bar.get_by_text('成员名单坏了').wait_for(timeout=5000)
            bar.get_by_role('button', name='重新识别').click()
            page.wait_for_function('() => document.querySelector(".cfg-bad").hidden', timeout=15000)
            check(os.path.exists(agents + '.broken') and os.path.exists(agents), '成员名单写坏了：顶上提示，点「重新识别」修好，坏的那份留着')

            # 窗口窄于 1180px：右栏自己收起；宽回来自己打开（没改你记下的）
            no_right = '() => document.querySelector(".app").classList.contains("no-right")'
            page.set_viewport_size({'width': 1100, 'height': 800})
            page.wait_for_timeout(700)
            narrow_hidden = js(no_right)
            page.set_viewport_size({'width': 1280, 'height': 800})
            page.wait_for_timeout(700)
            check(narrow_hidden and not js(no_right) and js('() => localStorage.getItem("relay.noRight")') is None, '窗口变窄右栏自己收起，宽回来自己打开')

            # 刷新：栏的开合在画出来之前就定好。逐帧量右栏宽度——宽窗口时右栏启动就开着（以前记住的「收着」不算）、一直不动；
            # 窗口窄时从第一帧起就是收着的（以前先按三栏都开画出来，再滑走）
            page.add_init_script('''(() => {
              window.__rw = [];
              const tick = () => {
                const r = document.getElementById('right');
                if (r) window.__rw.push(Math.round(r.getBoundingClientRect().width));
                if (window.__rw.length < 45) requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            })()''')
            js('() => localStorage.setItem("relay.noRight", "1")')
            ready = '() => window.__rw && window.__rw.length >= 45 && typeof S !== "undefined" && S.st'
            page.reload()
            page.wait_for_function(ready, timeout=10000)
            wide = js('() => window.__rw')
            page.set_viewport_size({'width': 1100, 'height': 800})
            page.reload()
            page.wait_for_function(ready, timeout=10000)
            tight = js('() => window.__rw')
            page.set_viewport_size({'width': 1280, 'height': 800})
            page.wait_for_timeout(700)
            check(min(wide) > 200 and max(wide) - min(wide) <= 1 and max(tight) == 0 and not js(no_right), f'刷新时右栏不先露出来再滑走；启动时右栏开着（宽 {min(wide)}～{max(wide)}，窄窗口 {max(tight)}）')

            # 换语言：点左下角「EN」，整页淡出、重新载入成英文，接力台也记下（请 AI 用英文写）；再点「中」换回来
            page.locator('.lang-btn').click()
            page.wait_for_function('() => typeof LANG !== "undefined" && LANG.now === "en" && S.st && !document.documentElement.classList.contains("lang-in")', timeout=8000)
            lang = json.load(urllib.request.urlopen(url + 'api/state', timeout=3))['settings'].get('lang')
            check(page.get_by_role('button', name='New task').count() == 1 and js('() => T.missing.size') == 0 and lang == 'en', '换成英文：界面是英文、没有漏翻的，接力台记下了')
            page.locator('.lang-btn').click()
            page.wait_for_function('() => typeof LANG !== "undefined" && LANG.now === "zh" && S.st && !document.documentElement.classList.contains("lang-in")', timeout=8000)
            check(page.get_by_role('button', name='新任务').count() == 1, '再点「中」：换回中文')
            check(len(errors) == 0, '整个过程控制台没有报错' + (f'：{errors[:3]}' if errors else ''))
            browser.close()
    finally:
        try:
            urllib.request.urlopen(urllib.request.Request(url + 'api/quit', data=b'{}', method='POST'), timeout=2)
        except Exception:
            pass
        ui.terminate()
    print(f'\n{len(fails)} 项没过' if fails else '\n全部通过')
    sys.exit(1 if fails else 0)


main()
