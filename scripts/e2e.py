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
            page = browser.new_page(viewport={'width': 1280, 'height': 800})
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
                has = js('() => !!document.querySelector(".specks.side")')
                check(js('() => document.querySelector(".app").classList.contains("no-left")') == want and has, f'{"收起" if want else "打开"}左栏：扫一道点')
                page.wait_for_timeout(700)
                check(not js('() => !!document.querySelector(".specks.side")'), f'{"收起" if want else "打开"}左栏：扫完点拿掉了')

            # 设置：点开、切到成员、按 Esc 关掉
            page.get_by_role('button', name='设置').click()
            page.locator('.settings').wait_for()
            page.locator('.settings').get_by_role('tab', name='成员').click()
            page.wait_for_timeout(300)
            check(page.locator('.settings .members').count() == 1, '设置：点开、切到成员')
            page.keyboard.press('Escape')
            page.wait_for_timeout(500)
            check(page.locator('.settings').count() == 0, '设置：按 Esc 关掉')
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
