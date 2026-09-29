#!/usr/bin/env python3
"""
网页的真实点击测试：起一个接力台（假家目录、只有假工具），用浏览器真的去点。
  python3 scripts/e2e.py            用这个目录下的 dist（先 npm run build）
  python3 scripts/e2e.py 某个目录   用那个目录下的 dist
要装 playwright（pip install playwright，再 playwright install chromium）。没装就跳过，不算失败。
不进 npm test：CI 里没有浏览器。
"""
import json
import os
import socket
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
    }
    subprocess.run(['node', CLI, 'init', '加一个导出'], cwd=repo, env=env, check=True, capture_output=True)
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

            # 群聊：之前发的长话先收起，点「展开」看全文；粘进来很长的一段字存成文件带上，输入框里只有一个小条，点开在页签里看
            page.get_by_role('tab', name='群聊').click()
            page.locator('.me .note').first.wait_for()
            folded = page.locator('.me .note.fold').count() == 1
            page.locator('.me').get_by_role('button', name='展开').click()
            page.wait_for_timeout(350)
            check(folded and page.locator('.me .note.fold').count() == 0, '群聊：长话先收起，点「展开」看全文')
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
            chip = page.locator('.composer .attach .chip').filter(has_text='粘贴的文字（60 行）.txt')
            chip.wait_for(timeout=5000)
            check(taken and js('() => document.querySelector(".composer textarea").value') == '' and js('() => S.files[0]').startswith('.relay/uploads/'), '粘一大段字：存成文件带上，输入框里是空的')
            chip.locator('.ell').click()
            page.wait_for_function('() => document.body.innerText.includes("日志第 60 行")', timeout=5000)
            check(True, '点那个小条：在页签里看到粘进来的全文')
            page.locator('#center').get_by_role('tab', name='群聊').click()
            page.get_by_label('页面').get_by_role('tab', name='接力').click()

            # 窗口窄于 1180px：右栏自己收起；宽回来自己打开（没改你记下的）
            no_right = '() => document.querySelector(".app").classList.contains("no-right")'
            page.set_viewport_size({'width': 1100, 'height': 800})
            page.wait_for_timeout(700)
            narrow_hidden = js(no_right)
            page.set_viewport_size({'width': 1280, 'height': 800})
            page.wait_for_timeout(700)
            check(narrow_hidden and not js(no_right) and js('() => localStorage.getItem("relay.noRight")') is None, '窗口变窄右栏自己收起，宽回来自己打开')

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
