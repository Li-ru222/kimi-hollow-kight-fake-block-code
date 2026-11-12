/* ============================================================================
 * 空洞骑士复刻 · 客户端存档伪造 PoC 模板(参数化 / 可复用)
 * ============================================================================
 * 目标  : https://a53d60dc08e38084e.app.workbuddy.host/?sharecode=5YAX54MVUC
 * 资产  : 纯客户端单机游戏(Canvas + 内联 JS,无后端 / 无网络调用)
 * 授权  : 资产方授权(自有/客户资产),范围限于客户端存档逻辑
 * 载体  : localStorage["hk_save_v2"] —— 明文 JSON,无 HMAC / 校验和 / 加密
 *
 * 对应发现(见 pentest_report.pdf)：
 *   F1 存档零完整性保护      -> MODULE.F1_resources     资源伪造(geo/soul/hp/nail/bank)
 *   F2 flags 无白名单/类型   -> MODULE.F2_flags         flags 伪造 + 字符串真值 + __proto__
 *   F3 护符装配未校验        -> MODULE.F3_charms        全护符 / 未拥有 / 超槽位
 *   F4 字段未钳制            -> MODULE.F4_clampBypass   int32 回绕为负 / respawnRoom 软锁
 *   F5 版本号被忽略          -> MODULE.F5_version       d.ver 任意值不触发门控
 *
 * 用法 :
 *   1) 打开目标页面 -> F12 DevTools -> Console
 *   2) 粘贴本文件全部内容 -> 回车
 *   3) 刷新页面(F5)生效; 控制台会打印已注入字段与还原方法
 *
 * 模板化 : 顶部 CONFIG 是唯一需要改的地方。
 *   按需开关 MODULE.*、修改每个模块的取值,即可生成不同强度的伪造存档。
 *   附带 : 自动备份原存档,restore() 一键还原。
 * ========================================================================== */
(function () {
  "use strict";

  /* ==========================================================================
   * CONFIG —— 模板开关(唯一需要编辑的区域)
   * ======================================================================== */
  const CONFIG = {
    saveKey:   "hk_save_v2",
    backupKey: "hk_save_v2.poc_backup",

    MODULE: {
      F1_resources:    true,   // 资源伪造:吉欧/灵魂/血量/骨钉/存款
      F2_flags:        true,   // 进度 flags 伪造(无白名单)
      F2_stringTruthy: false,  // 演示:字符串 "false" 仍按真值判定(需 F2_flags)
      F2_protoPollute: false,  // 演示:__proto__ 局部原型污染(危害低,仅教学)
      F3_charms:       true,   // 全护符 / 未拥有 / 超槽位
      F3_fragileOn:    true,   // 额外启用「易碎力量」→ 伤害叠乘 ×3.375
      F4_clampBypass:  false,  // geo/soul 回绕为负 + respawnRoom 指向不存在房间
      F5_version:       true,   // 写入任意 d.ver 证明无版本门控
    },

    F1: { geo: 999999, soul: 999, hp: 20, nail: 99 /* 载入时钳到 NAIL_MAX=4 */, bank: 2500 },
    F4: { geoOverflow: 2147483648 /* |0 回绕为 -2147483648 */, soulNeg: -500, badRoom: "void_room_not_exist" },
    F5: { ver: 999 /* 任意版本号,loadGame 从不检查 d.ver */ },
  };

  /* ==========================================================================
   * 数据表 —— 来自 target_index.html 源码(已核对)
   * ======================================================================== */

  /* 全部合法护符 id(loadGame 仅按此白名单 filter ch,不校验拥有/槽位)。
   * 字段 cost 仅为说明槽位成本,实际载入时从不累加校验。 */
  const ALL_CHARMS = [
    // [id, cost, 备注]
    ["strength",        2, "力量 · 伤害×1.5"],
    ["fragile_power",   2, "脆弱力量 · 伤害×1.5(受伤+1)"],
    ["fragile_strength",2, "易碎力量 · 伤害×1.5(死亡碎裂,须 fr.strength.owned)"],
    ["soul_eater",      4, "噬魂者 · 灵魂上限+33 / 回复×2"],
    ["soul_catcher",    2, "灵魂捕手 · 命中+8 灵魂"],
    ["quick_focus",     2, "快速聚焦 · 回血时间×0.5"],
    ["quick_soak",      1, "快速凝聚 · 聚焦更快"],
    ["nailmasters_glory",1,"骨钉大师 · 前摇 2→1 / 骨钉更长"],
    ["swift_nail",      2, "迅捷骨钉 · 挥砍更快"],
    ["frenzycharm",     2, "愚人狂热 · 节奏×0.8"],
    ["hunter_mark",     1, "猎人印记 · 挥砍更快"],
    ["longbrand",       1, "拓刃纹章 · 攻击范围+14px"],
    ["dashmaster",      2, "冲刺大师 · 冲刺+40% / 空中二冲"],
    ["jonny",           1, "乔尼的祝福 · 面具+1 / 无敌+30"],
    ["stalwart_shell",  2, "稳定之体 · 无敌+60 / 减伤1"],
    ["palacecharm",     2, "苍白铠甲 · 无敌+70"],
    ["lifeheart",       2, "生命之核 · 缓慢回血"],
    ["honeycharm",      1, "蜂蜡鳞片 · 蜂蜜免疫"],
    ["defenders_crest", 1, "防御者纹章 · 毒云"],
    ["sporesac",        2, "孢子囊 · 受击释放毒孢"],
    ["traitorspike",    2, "背叛者之刺 · 冲刺伤害"],
    ["grubsong",        1, "幼虫之歌 · 受伤+8 灵魂"],
    ["kingsoul",        2, "王者之魂 · 灵魂回复×2.5"],
    ["abyss_heart",     2, "深渊之心 · 法术伤害×1.3"],
    ["dreamcatcher",    1, "捕梦网 · 梦钉命中+灵魂"],
    ["collectorcharm",  1, "收藏家的贪婪 · 额外吉欧"],
    ["lumen_cloak",     1, "荧光披风 · 暗处视野"],
    ["greedySeal",      1, "贪婪之印(商店)"],
    ["toughShell",      2, "坚韧之壳(商店)"],
    ["fragile_heart",   2, "易碎心 · 面具+2(须 fr.heart.owned)"],
    ["fragile_greed",   2, "易碎贪婪 · 吉欧+50%(须 fr.greed.owned)"],
  ];

  /* 进度 flags(loadGame 用 Object.assign 无白名单直接合入 Game.flags) */
  const FLAGS = {
    abilities: {
      canDash: true, canWallJump: true, canDoubleJump: true,
      hasDive: true, hasWraiths: true, wraithUp: true, hasSpirit: true,
      canSuperDash: true, superDash2: true, hasIsmasTear: true, cyclone: true,
      dreamNail: true, dnailLevel: 3, shadeCloak: true,
    },
    progression: {
      bossDead: true, bossDead2: true, bossDead3: true,
      kingsBrand: true, hasVoidHeart: true,
      dreamersDefeated: 3, herrahDead: true, kingsoul_pieces: 3,
    },
    completion: {
      ending_achieved: true, ending_type: 5, colosseumCleared: true,
      allGrubsSaved: true, grubsMask: true, grubSongGot: true, hunterMask: true,
    },
    notches: {   // 影响 maxNotches() = min(11, 3 + 商店买数 + 免费拾取)
      bought_notch4: true, bought_notch5: true, bought_notch6: true,
      bought_notch7: true, bought_notch8: true,
      notch_basin: true, notch_deep: true, notch_hornet: true,
    },
  };

  /* ==========================================================================
   * 工具
   * ======================================================================== */
  function readSave() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(CONFIG.saveKey) || "{}"); } catch (e) { s = {}; }
    return (s && typeof s === "object") ? s : {};
  }
  function backup() {
    const raw = localStorage.getItem(CONFIG.saveKey);
    if (raw) localStorage.setItem(CONFIG.backupKey, raw);
    return raw ? ("已备份原存档 → " + CONFIG.backupKey) : "无现存档,跳过备份";
  }

  /* ==========================================================================
   * 模块:F1 / F2 / F3 / F4 / F5 —— 每个模块返回对其负责字段的修改
   * ======================================================================== */
  function applyF1(s) {
    // loadGame: p.geo = d.g|0 (无钳制); p.soul = d.s|0 (仅上限 Math.min);
    //           maxHp 钳 [5,20]; hp 钳 [1,maxHp]; nailLevel 钳 [0,NAIL_MAX=4]; bank 钳 [0,2500]
    s.g    = CONFIG.F1.geo;
    s.s    = CONFIG.F1.soul;
    s.hp   = CONFIG.F1.hp;
    s.mhp  = CONFIG.F1.hp;
    s.nl   = CONFIG.F1.nail;
    s.bank = CONFIG.F1.bank;
    return s;
  }

  function applyF2(s) {
    const f = s.f || (s.f = {});
    for (const cat in FLAGS) Object.assign(f, FLAGS[cat]);

    if (CONFIG.MODULE.F2_stringTruthy) {
      // 演示:值不布尔化。loadGame 不强制 !!,全程 if(Game.flags.x) 按真值判断,
      // 字符串 "false"/"0" 亦为真值。bossDead2="false" 仍会触发 hasDive=true(16029 行)。
      f.stringTruthyDemo = "false";     // 一个字符串 "false" 的 flag,读取时仍为真
      f.bossDead2 = "false";            // 注意:字符串 "false" 仍被视作已击败灵魂大师
    }

    if (CONFIG.MODULE.F2_protoPollute) {
      // 演示:d.f 携带 __proto__ 键(JSON.parse 保留为自有属性) -> Object.assign 经
      // __proto__ setter 将 Game.flags 的原型改写(局部污染,非全局,危害低)。
      // 必须用 defineProperty 生成 own enumerable "__proto__" 键,否则 stringify 会被丢弃。
      Object.defineProperty(f, "__proto__", {
        value: { pollutedViaProto: true, ending_type: 5 },
        enumerable: true, writable: true, configurable: true,
      });
    }
    return s;
  }

  function applyF3(s) {
    // loadGame: Game.charmsEquipped = (d.ch||[]).filter(id => CHARMS.some(c=>c.id===id));
    // 仅过滤非法 id,不校验拥有(oc)、不校验槽位成本(maxNotches)。
    // 全护符装备:所有数值无条件生效(伤害/无敌/回血/二段冲等)。
    s.ch = ALL_CHARMS.map(c => c[0]);
    // 未拥有护符也一并写入 oc(本就不校验,但顺带演示 oc 只影响商店护符的 bought_ 标记)
    s.oc = ALL_CHARMS.map(c => c[0]);

    if (CONFIG.MODULE.F3_fragileOn) {
      // 让三个易碎护符「已拥有且未破碎」,使 charmActive("fragile_strength") 等生效,
      // 伤害叠乘达到 strength ×1.5 × fragile_power ×1.5 × fragile_strength ×1.5 = ×3.375。
      s.fr = {
        strength: { o: 1, b: 0 },
        heart:    { o: 1, b: 0 },
        greed:    { o: 1, b: 0 },
      };
    }
    return s;
  }

  function applyF4(s) {
    // loadGame: p.geo = d.g|0 仅 int32 强转,无上下界。
    //   2147483648 (2^31) 经 |0 回绕为 -2147483648,负值可行。
    //   p.soul = d.s|0 仅上限 Math.min,负值不回升。
    //   p.respawnRoom = d.r||"cross_01",不校验 ROOMS[d.r] -> 写入不存在房间即软锁。
    s.g = CONFIG.F4.geoOverflow;
    s.s = CONFIG.F4.soulNeg;
    s.r = CONFIG.F4.badRoom;
    return s;
  }

  function applyF5(s) {
    // SAVE_VER=3 随存档写入,但 loadGame 从不检查 d.ver(注释声明「版本不匹配不清空,
    // 走兼容读取」)。任意版本号(负值/超大步进)均不触发拒绝或迁移分支。
    s.ver = CONFIG.F5.ver;
    return s;
  }

  /* ==========================================================================
   * 组装:按 CONFIG.MODULE 顺序应用各模块
   * ======================================================================== */
  function forge() {
    let s = readSave();
    const M = CONFIG.MODULE;
    if (M.F1_resources)    applyF1(s);
    if (M.F2_flags)        applyF2(s);
    if (M.F3_charms)       applyF3(s);
    if (M.F4_clampBypass)  applyF4(s);
    if (M.F5_version)      applyF5(s);
    return s;
  }

  /* ==========================================================================
   * 执行 + 校验输出
   * ======================================================================== */
  function run() {
    const before = readSave();
    const backupMsg = backup();
    const s = forge();
    localStorage.setItem(CONFIG.saveKey, JSON.stringify(s));

    const M = CONFIG.MODULE;
    console.log("%c[PoC] 存档伪造完成,刷新页面(F5)后生效", "color:#2e7d5b;font-weight:bold;font-size:13px");
    console.log(backupMsg);
    console.log("启用模块:", M);

    const t = {
      "吉欧 g":          s.g, "灵魂 s": s.s, "血量 hp": s.hp, "血量上限 mhp": s.mhp,
      "骨钉 nl(载入钳4)": s.nl, "存款 bank(钳2500)": s.bank,
      "重生点 r":        s.r, "版本 ver": s.ver,
      "flags 数量":      Object.keys(s.f || {}).length,
      "装备护符 ch":     (s.ch || []).length + " 枚",
      "拥有护符 oc":     (s.oc || []).length + " 枚",
    };
    console.table(t);
    console.log("伪造的 flags:", s.f);
    console.log("装备的护符:", s.ch);

    if (M.F4_clampBypass) {
      console.log("%c[F4] geo 回绕:", "color:#c0392b", CONFIG.F4.geoOverflow, "->", (CONFIG.F4.geoOverflow | 0),
        "| soul:", CONFIG.F4.soulNeg, "| respawnRoom:", CONFIG.F4.badRoom);
    }
    if (M.F3_fragileOn) {
      console.log("%c[F3] 伤害叠乘:", "color:#c0392b", "strength(1.5) × fragile_power(1.5) × fragile_strength(1.5) = ×3.375");
    }

    // 变更摘要:相对载入前原档的差异键
    const changed = {};
    for (const k of new Set([...Object.keys(before), ...Object.keys(s)])) {
      if (JSON.stringify(before[k]) !== JSON.stringify(s[k])) changed[k] = { 原: before[k], 新: s[k] };
    }
    console.log("相对原档变更字段:", changed);

    console.log("%c还原方法: 在 Console 执行 restore()(见文件末尾)", "color:#b8860b");
    return s;
  }

  run();
})();

/* 一键还原(独立函数,任意时刻可单独调用) */
function restore() {
  const SAVE_KEY = "hk_save_v2", BACKUP_KEY = "hk_save_v2.poc_backup";
  const bak = localStorage.getItem(BACKUP_KEY);
  if (bak) {
    localStorage.setItem(SAVE_KEY, bak);
    localStorage.removeItem(BACKUP_KEY);
    console.log("%c[PoC] 已还原原存档,刷新后生效", "color:#2e7d5b;font-weight:bold");
    return true;
  }
  localStorage.removeItem(SAVE_KEY);
  console.log("%c[PoC] 无备份,已清空存档", "color:#b8860b;font-weight:bold");
  return false;
}
