/* ============================================================================
 * 空洞骑士复刻 · 客户端存档伪造 PoC
 * ----------------------------------------------------------------------------
 * 目标 : https://a53d60dc08e38084e.app.workbuddy.host/?sharecode=5YAX54MVUC
 * 性质 : 纯客户端单机游戏,存档为 localStorage["hk_save_v2"] 明文 JSON
 *        无 HMAC / 签名 / 校验和,loadGame() 客户端全信任
 *
 * 用法 : 打开目标页面 → F12 打开 DevTools → Console 粘贴本文件全部内容 → 回车
 *        然后刷新页面(F5)即可看到伪造生效。
 *
 * 覆盖 :
 *   F1 资源伪造   (geo/soul/hp/nailLevel 无钳制或钳到上限)
 *   F2 flags 伪造 (无白名单,任意键合入 Game.flags)
 *   F3 护符伪造   (ch 载入时只过滤非法 id,不校验所有权/槽位)
 *
 * 附带 : 自动备份原存档,提供 restore() 一键还原。
 * ========================================================================== */
(function () {
  "use strict";

  const SAVE_KEY   = "hk_save_v2";
  const BACKUP_KEY = "hk_save_v2.poc_backup";

  /* ---------- 工具 ---------- */
  function readSave() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || "{}"); } catch (e) { s = {}; }
    return (s && typeof s === "object") ? s : {};
  }
  function backup() {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) localStorage.setItem(BACKUP_KEY, raw);
    return raw ? "已备份原存档 → " + BACKUP_KEY : "无现存档,跳过备份";
  }
  function restore() {
    const bak = localStorage.getItem(BACKUP_KEY);
    if (bak) { localStorage.setItem(SAVE_KEY, bak); localStorage.removeItem(BACKUP_KEY); return true; }
    localStorage.removeItem(SAVE_KEY);
    return false;
  }

  /* ---------- 构造伪造存档 ---------- */
  function forge() {
    const s = readSave();

    /* F1 — 资源伪造
       geo/soul 仅 `|0` 强转,无上下界;hp/mhp 钳到 [5,20];nl 钳到 NAIL_MAX(=4) */
    s.g   = 999999;          // 吉欧
    s.s   = 999;             // 灵魂(载入后 recomputeCharms 会钳到 maxSoul)
    s.hp  = 20;              // 血量
    s.mhp = 20;              // 血量上限(最大值)
    s.nl  = 99;              // 骨钉等级(载入时钳到 4 = 满级,伤害 5)

    /* F2 — 进度 flags 伪造(loadGame 无白名单,任意键值直接合入 Game.flags) */
    const F = s.f || {};
    Object.assign(F, {
      // —— 能力 ——
      canDash: true, canWallJump: true, canDoubleJump: true,
      hasDive: true, hasWraiths: true, wraithUp: true, hasSpirit: true,
      canSuperDash: true, superDash2: true, hasIsmasTear: true, cyclone: true,
      dreamNail: true, dnailLevel: 3,
      // —— 深层进度 ——
      bossDead: true, bossDead2: true, bossDead3: true,
      kingsBrand: true, hasVoidHeart: true, shadeCloak: true,
      dreamersDefeated: 3, herrahDead: true, kingsoul_pieces: 3,
      // —— 结局 / 全收集 ——
      ending_achieved: true, ending_type: 5, colosseumCleared: true,
      allGrubsSaved: true, grubsMask: true, grubSongGot: true, hunterMask: true,
      // —— 商店 / 槽位(影响 maxNotches)——
      bought_notch4: true, bought_notch5: true, bought_notch6: true,
      bought_notch7: true, bought_notch8: true,
      notch_basin: true, notch_deep: true, notch_hornet: true,
    });
    s.f = F;

    /* F3 — 护符伪造(载入时只 filter 合法 id,不校验拥有/槽位 → 全护符数值生效) */
    s.ch = [
      "strength", "fragile_power", "soul_eater", "quick_focus", "quick_soak",
      "dashmaster", "jonny", "stalwart_shell", "palacecharm", "longbrand",
      "nailmasters_glory", "honeycharm", "collectorcharm", "grubsong", "kingsoul",
    ];

    return s;
  }

  /* ---------- 执行 ---------- */
  const backupMsg = backup();
  const s = forge();
  localStorage.setItem(SAVE_KEY, JSON.stringify(s));

  /* ---------- 校验输出 ---------- */
  console.log("%c[PoC] 存档伪造完成,刷新页面(F5)后生效", "color:#2e7d5b;font-weight:bold;font-size:13px");
  console.log(backupMsg);
  console.log("已写入字段:");
  console.table({
    吉欧_geo:          s.g,
    灵魂_soul:         s.s,
    血量_hp:           s.hp,
    血量上限_mhp:      s.mhp,
    骨钉等级_nl:       s.nl + "(载入后钳到 4 满级)",
    flags_数量:        Object.keys(s.f || {}).length,
    装备护符_ch:       (s.ch || []).length + " 枚: " + (s.ch || []).join(", "),
  });
  console.log("伪造的 flags:", s.f);
  console.log("%c还原方法: 在 Console 执行 restore() 或刷新前未执行备份时手动清档",
              "color:#b8860b");
})();

/* 一键还原(独立函数,可在任意时刻单独调用) */
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
