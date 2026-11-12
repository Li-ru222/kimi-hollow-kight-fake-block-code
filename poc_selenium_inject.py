#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
空洞骑士复刻 · 客户端存档伪造 PoC —— Selenium 自动注入版
============================================================
目标  : https://a53d60dc08e38084e.app.workbuddy.host/?sharecode=5YAX54MVUC
        (亦可用本地 target_index.html,同一单文件游戏,零外部资源)
授权  : 资产方授权(自有/客户资产),范围限于客户端存档逻辑
载体  : localStorage["hk_save_v2"] 明文 JSON,无签名 / 校验和

依赖  : pip install selenium   (已装 4.51.0,自带 Selenium Manager 自动下载驱动)
浏览器: 默认 Edge(已安装);Chrome 亦可(--browser chrome)

用法示例:
  # 全部默认(全能力 + 全护符 + 高额资源),headless 跑本地文件
  python poc_selenium_inject.py

  # 自定义数值 + 指向线上目标
  python poc_selenium_inject.py --url "https://a53d60dc08e38084e.app.workbuddy.host/?sharecode=5YAX54MVUC" \
      --geo 999999 --soul 999 --nail 4 --ending-type 5

  # 仅注入指定护符,关闭 flags / 资源
  python poc_selenium_inject.py --charm strength,fragile_power,fragile_strength --no-flags --no-resources

  # F4 演示:geo int32 回绕为负 + respawnRoom 软锁
  python poc_selenium_inject.py --overflow --bad-room void_room_not_exist

  # F2 演示:字符串 "false" 仍按真值 / __proto__ 原型污染
  python poc_selenium_inject.py --string-truthy --proto

  # 还原备份
  python poc_selenium_inject.py --restore
"""

import argparse
import json
import os
import sys
import tempfile
import time

# 尽力让 Windows 控制台以 UTF-8 输出中文
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

SAVE_KEY   = "hk_save_v2"
BACKUP_KEY = "hk_save_v2.poc_backup"

# ---------------------------------------------------------------------------
# 数据表(与 target_index.html 源码逐条核对)
# ---------------------------------------------------------------------------
# 全部合法护符 id(loadGame 只按此白名单 filter,不校验拥有/槽位)
ALL_CHARMS = [
    "strength", "fragile_power", "fragile_strength", "soul_eater", "soul_catcher",
    "quick_focus", "quick_soak", "nailmasters_glory", "swift_nail", "frenzycharm",
    "hunter_mark", "longbrand", "dashmaster", "jonny", "stalwart_shell",
    "palacecharm", "lifeheart", "honeycharm", "defenders_crest", "sporesac",
    "traitorspike", "grubsong", "kingsoul", "abyss_heart", "dreamcatcher",
    "collectorcharm", "lumen_cloak", "greedySeal", "toughShell",
    "fragile_heart", "fragile_greed",
]

# 进度 flags(loadGame 用 Object.assign 无白名单直接合入 Game.flags)
DEFAULT_FLAGS = {
    # —— 能力 ——
    "canDash": True, "canWallJump": True, "canDoubleJump": True,
    "hasDive": True, "hasWraiths": True, "wraithUp": True, "hasSpirit": True,
    "canSuperDash": True, "superDash2": True, "hasIsmasTear": True, "cyclone": True,
    "dreamNail": True, "dnailLevel": 3, "shadeCloak": True,
    # —— 深层进度 ——
    "bossDead": True, "bossDead2": True, "bossDead3": True,
    "kingsBrand": True, "hasVoidHeart": True,
    "dreamersDefeated": 3, "herrahDead": True, "kingsoul_pieces": 3,
    # —— 结局 / 全收集 ——
    "ending_achieved": True, "ending_type": 5, "colosseumCleared": True,
    "allGrubsSaved": True, "grubsMask": True, "grubSongGot": True, "hunterMask": True,
    # —— 商店 / 槽位(影响 maxNotches)——
    "bought_notch4": True, "bought_notch5": True, "bought_notch6": True,
    "bought_notch7": True, "bought_notch8": True,
    "notch_basin": True, "notch_deep": True, "notch_hornet": True,
}


def parse_args():
    p = argparse.ArgumentParser(
        description="Selenium 自动注入伪造存档(空洞骑士复刻)",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--url", default=None,
                   help="目标 URL;缺省用脚本同目录 target_index.html(file://)")
    p.add_argument("--browser", choices=["edge", "chrome"], default="edge")
    p.add_argument("--headless", action="store_true", help="无头模式")
    p.add_argument("--no-headless", action="store_true", help="显式禁用无头(带窗口)")
    p.add_argument("--timeout", type=int, default=30, help="页面/游戏就绪等待秒数")
    p.add_argument("--user-data-dir", default=None,
                   help="浏览器 profile 目录;缺省用临时目录(隔离,不碰真实浏览器)")

    # —— F1 资源(可自定义数值)——
    p.add_argument("--no-resources", action="store_true", help="跳过 F1 资源注入")
    p.add_argument("--geo", type=int, default=999999)
    p.add_argument("--soul", type=int, default=999)
    p.add_argument("--hp", type=int, default=20)
    p.add_argument("--nail", type=int, default=99, help="骨钉等级(载入钳到 NAIL_MAX=4)")
    p.add_argument("--bank", type=int, default=2500, help="存款(载入钳到 2500)")

    # —— F2 flags ——
    p.add_argument("--no-flags", action="store_true", help="跳过 F2 flags 注入")
    p.add_argument("--extra-flag", action="append", default=[], metavar="K=V",
                   help="追加/覆盖任意 flag,可重复,如 --extra-flag bossDead2=true")
    p.add_argument("--string-truthy", action="store_true",
                   help="F2 演示:bossDead2='false'(字符串)仍按真值")
    p.add_argument("--proto", action="store_true",
                   help="F2 演示:d.f 携带 __proto__ 键 → 局部原型污染")

    # —— F3 护符 ——
    p.add_argument("--no-charms", action="store_true", help="跳过 F3 护符注入")
    p.add_argument("--charm", default=None, metavar="LIST",
                   help="逗号分隔护符 id;缺省 = 全部护符")

    # —— F4 钳制绕过 ——
    p.add_argument("--overflow", action="store_true", help="F4:geo/soul 回绕为负")
    p.add_argument("--overflow-geo", type=int, default=2147483648,
                   help="回绕值(经 |0 变负)")
    p.add_argument("--neg-soul", type=int, default=-500)
    p.add_argument("--bad-room", default="void_room_not_exist",
                   help="F4:respawnRoom 指向不存在房间(软锁)")

    # —— F5 版本 ——
    p.add_argument("--no-version", action="store_true", help="跳过 F5 版本注入")
    p.add_argument("--ver", type=int, default=999, help="写入的版本号(从不被检查)")

    # —— 行为 ——
    p.add_argument("--restore", action="store_true", help="仅还原备份存档后退出")
    p.add_argument("--no-reload", action="store_true", help="注入后不刷新(不触发 loadGame)")
    return p.parse_args()


def build_save(args):
    save = {}
    if not args.no_resources:
        save.update(g=args.geo, s=args.soul, hp=args.hp, mhp=args.hp,
                    nl=args.nail, bank=args.bank)

    if not args.no_flags:
        f = dict(DEFAULT_FLAGS)
        for kv in args.extra_flag:
            if "=" not in kv:
                continue
            k, v = kv.split("=", 1)
            # 尽量还原类型:true/false/数字
            if v.lower() in ("true", "1"):
                f[k] = True
            elif v.lower() in ("false", "0"):
                f[k] = False
            else:
                try:
                    f[k] = int(v)
                except ValueError:
                    f[k] = v
        if args.string_truthy:
            f["bossDead2"] = "false"        # 字符串 "false",仍按真值 → hasDive=true
            f["stringTruthyDemo"] = "false"
        if args.proto:
            # Python 直接写 "__proto__" 键即可;json.dumps 原样输出,游戏 JSON.parse
            # 会把它保留为自有属性,Object.assign 经 setter 污染 Game.flags 原型。
            f["__proto__"] = {"pollutedViaProto": True, "ending_type": 5}
        save["f"] = f

    if not args.no_charms:
        charms = [c.strip() for c in args.charm.split(",")] if args.charm else list(ALL_CHARMS)
        charms = [c for c in charms if c]          # 去掉空串
        save["ch"] = charms
        save["oc"] = charms
        # 易碎护符「已拥有且未破碎」→ charmActive("fragile_strength") 生效,
        # 伤害叠乘 strength(1.5) × fragile_power(1.5) × fragile_strength(1.5) = ×3.375
        save["fr"] = {
            "strength": {"o": 1, "b": 0},
            "heart":    {"o": 1, "b": 0},
            "greed":    {"o": 1, "b": 0},
        }

    if args.overflow:
        save["g"] = args.overflow_geo     # |0 回绕为负
        save["s"] = args.neg_soul         # 仅上限 Math.min,负值不回升
        save["r"] = args.bad_room         # 不校验 ROOMS[d.r]

    if not args.no_version:
        save["ver"] = args.ver

    return save


# ---------------------------------------------------------------------------
# Selenium 逻辑
# ---------------------------------------------------------------------------
def make_driver(args):
    from selenium import webdriver

    opts = None
    if args.browser == "chrome":
        opts = webdriver.ChromeOptions()
    else:
        opts = webdriver.EdgeOptions()
        # 显式指定已安装的 Edge 路径(Selenium Manager 通常也能自行定位)
        edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
        if os.path.exists(edge_path):
            opts.binary_location = edge_path

    headless = args.headless and not args.no_headless
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--window-size=1280,800")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-first-run")
    # 独立临时 profile:不干扰用户真实浏览器,localStorage 从零开始
    opts.add_argument("--user-data-dir=" + (args.user_data_dir or tempfile.mkdtemp(prefix="hk_poc_")))

    cls = webdriver.Chrome if args.browser == "chrome" else webdriver.Edge
    return cls(options=opts)


def local_target_url():
    here = os.path.dirname(os.path.abspath(__file__))
    html = os.path.join(here, "target_index.html")
    if os.path.exists(html):
        import pathlib
        return pathlib.Path(html).as_uri()
    return None


INJECT_JS = r"""
const k = 'hk_save_v2', bk = k + '.poc_backup';
const raw = localStorage.getItem(k);
localStorage.setItem(bk, raw || '');
localStorage.setItem(k, arguments[0]);
return raw ? 'backed-up' : 'no-prior-save';
"""

RESTORE_JS = r"""
const k = 'hk_save_v2', bk = k + '.poc_backup';
const bak = localStorage.getItem(bk);
if (bak) { localStorage.setItem(k, bak); localStorage.removeItem(bk); return 'restored'; }
localStorage.removeItem(k); return 'cleared';
"""

VERIFY_JS = r"""
try {
  const g = (typeof Game !== 'undefined') ? Game : null; const p = g && g.player;
  return JSON.stringify({
    geo:        p && p.geo,
    soul:       p && p.soul,
    hp:         p && p.hp,
    maxHp:      p && p.maxHp,
    maxSoul:    p && p.maxSoul,
    nailLevel:  g.save && g.save.nailLevel,
    dmgMul:     p && p.dmgMul,
    invulnBonus:p && p.invulnBonus,
    airDashes:  p && p.airDashes,
    respawnRoom:p && p.respawnRoom,
    charmsEquipped: g.charmsEquipped || [],
    flagsCount: Object.keys(g.flags || {}).length,
    bossDead2:  g.flags && g.flags.bossDead2,
    hasDive:    g.flags && g.flags.hasDive,
    ending_type:g.flags && g.flags.ending_type,
    ver:        (function(){ try { return JSON.parse(localStorage.getItem('hk_save_v2')||'{}').ver; } catch(e){ return null; } })(),
  });
} catch (e) { return JSON.stringify({ error: String(e) }); }
"""


def wait_for_game(driver, timeout):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if driver.execute_script("return !!(typeof Game !== 'undefined' && Game.player && Game.flags);"):
                return True
        except Exception:
            pass
        time.sleep(0.3)
    return False


def main():
    args = parse_args()

    if args.restore:
        driver = make_driver(args)
        try:
            url = args.url or local_target_url()
            if not url:
                sys.exit("未提供 --url 且本地 target_index.html 不存在")
            driver.get(url)
            time.sleep(1)
            result = driver.execute_script(RESTORE_JS)
            print("[restore] 结果:", result)
        finally:
            driver.quit()
        return

    url = args.url or local_target_url()
    if not url:
        sys.exit("未提供 --url 且本地 target_index.html 不存在")

    save = build_save(args)
    print("目标        :", url)
    print("浏览器      :", args.browser, "(headless)" if (args.headless and not args.no_headless) else "")
    print("注入存档字段:")
    print(json.dumps(save, ensure_ascii=False, indent=2))

    driver = make_driver(args)
    try:
        # 1) 先导航到目标 origin,使 localStorage 可用
        driver.get(url)
        time.sleep(1)

        # 2) 备份 + 注入
        injected = driver.execute_script(INJECT_JS, json.dumps(save, ensure_ascii=False))
        print("[inject] 原存档:", injected)

        # 3) 刷新,触发 loadGame() 读取伪造存档
        if not args.no_reload:
            driver.refresh()
            if wait_for_game(driver, args.timeout):
                # loadGame() 不在启动时调用,而是挂在「继续游戏」按钮(19047 行)。
                # 直接调用它模拟点击,证明伪造存档被读取并合入运行态。
                load_ret = driver.execute_script(
                    "return (typeof loadGame === 'function') ? loadGame() : 'loadGame-not-found';")
                print("[loadGame] 返回:", load_ret, "(true = 伪造存档已被读取并合入)")
                print("[verify] 读取运行态:")
                state = json.loads(driver.execute_script(VERIFY_JS))
                print(json.dumps(state, ensure_ascii=False, indent=2))
                # 关键断言提示
                if isinstance(state, dict):
                    if state.get("dmgMul") == 3.375:
                        print("[verify] OK: 伤害叠乘达到 ×3.375 (strength×fragile_power×fragile_strength)")
                    if state.get("geo") is not None and state.get("geo") < 0:
                        print("[verify] OK: geo 为负 → int32 回绕生效")
                    if state.get("bossDead2") and state.get("hasDive"):
                        print("[verify] OK: bossDead2 → hasDive 已授予")
                    if state.get("respawnRoom") == args.bad_room and args.overflow:
                        print("[verify] OK: respawnRoom 指向不存在的房间(软锁)")
            else:
                print("[verify] 超时:未检测到 Game.player(可能 JS 未加载完)")
        else:
            print("[inject] 已写入 localStorage(未刷新,loadGame 未触发)")

        print("还原方法: 再次运行 --restore,或浏览器 DevTools 执行 localStorage.removeItem('hk_save_v2')")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
