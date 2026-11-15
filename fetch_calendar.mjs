// 优酷「追剧日历」采集 —— 匿名 mtop，不需要 cookie、不需要浏览器、不需要 secret。
//
// 接口：mtop.youku.detail.innovation.query，scene=episodeCalendar，appKey 24679788。
// 签名是 mtop h5 那套两步握手（第一发故意签错，只为换一枚 _m_h5_tk），
// 和 fetch_billboard.mjs 用的是同一个套路，只是换了 appKey 和 data 形状。
//
// 为什么要它：这一份是优酷自己排的表，包含「临时调整」之后的结果。
// 面板原来那套日历是拿 playRule 那句规则原文推的，规则一改口推的就错。
// 所以官方这份当主源，推的降级成兜底，两者不一致时页面印对账行。
//
// 环境变量：
//   CAL_OUT     产出路径，默认 calendar.json
//   CAL_SHOW    剧名，只用于日志
//   CAL_SID     优酷 showId，默认本剧
//   CAL_VID     优酷 videoId（编码后的），默认本剧
//   CAL_PROBE   只探连通性、不写文件（用来验 Actions 的机房 IP 能不能取到数）
//
// 失败一律不写文件：日历是低频数据，拿不到就留着上一份，别让一次抖动把表擦成空。

import crypto from 'node:crypto';
import fs from 'node:fs';

const HOST = 'https://acs.youku.com';
const API = 'mtop.youku.detail.innovation.query';
const APPKEY = '24679788';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0';

const OUT = process.env.CAL_OUT || 'calendar.json';
const SHOW = process.env.CAL_SHOW || '十万狂花入梦来';
const SHOWID = process.env.CAL_SID || 'adcf514e1f7b412a91e3';
const VIDEOID = process.env.CAL_VID || 'XNjU5MDUwOTcyMA==';

function buildData() {
  const params = JSON.stringify({
    nextSession: '', videoId: VIDEOID, showId: SHOWID,
    scene: 'episodeCalendar', biz: 'new_detail_innovation',
    appPackageKey: 'pcweb', gray: '0', userId: 0,
    playlistId: '', scgId: '',
    os: 'pc', ver: '1.0.0', device: 'pc', platform: 'pc',
    cookies: 'null', ip: '127.0.0.1', pid: '',
  });
  const sysinfo = JSON.stringify({
    appPackageKey: 'pcweb', appPackageId: 'pcweb', appkey: APPKEY,
    device: 'pc', os: 'pc', ver: '1.0.0', pid: '', zx: 0, disableUserRec: '0',
  });
  return JSON.stringify({ ms_codes: '2019030100', params, system_info: sysinfo });
}

async function call(data, token, cookie) {
  const t = String(Date.now());
  const sign = crypto.createHash('md5').update(`${token}&${t}&${APPKEY}&${data}`).digest('hex');
  const q = new URLSearchParams({
    jsv: '2.6.1', appKey: APPKEY, t, sign, api: API, v: '1.0',
    dataType: 'json', type: 'originaljson', data,
  });
  const headers = { 'User-Agent': UA, Referer: 'https://v.youku.com/', Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${HOST}/h5/${API}/1.0/?${q}`, { headers });
  const raw = await res.text();
  let j = null;
  try { j = JSON.parse(raw); } catch { /* 被拦成页面 */ }
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie()
    : String(res.headers.get('set-cookie') || '').split(/,(?=\s*_m_h5_tk)/);
  return { j, raw, sc };
}

async function query() {
  const data = buildData();
  let token = '', cookie = '', last = null;
  for (let i = 0; i < 4; i++) {
    last = await call(data, token, cookie);
    const rets = last.j ? (Array.isArray(last.j.ret) ? last.j.ret : [String(last.j.ret)]) : [];
    if (rets.some(r => String(r).includes('SUCCESS'))) return last.j;
    for (const c of last.sc) {
      const kv = String(c).split(';')[0];
      if (!/_m_h5_tk(_enc)?=/.test(kv)) continue;
      cookie = cookie ? `${cookie}; ${kv}` : kv;
      const m = /^_m_h5_tk=([^_;]+)/.exec(kv);
      if (m) token = m[1].split('_')[0];
    }
    if (!token) throw new Error(`拿不到 _m_h5_tk，ret=${JSON.stringify(rets)}`);
  }
  throw new Error(`签名四轮没通过，ret=${JSON.stringify((last.j && last.j.ret) || (last.raw || '').slice(0, 80))}`);
}

/* "1-5集" / "5集" 都拆成 from/to；纯数字直接当同一个值 */
function range(s) {
  const s0 = String(s == null ? '' : s).trim();
  const m2 = s0.match(/^(\d+)\s*[-–~至]\s*(\d+)/);
  if (m2) return [Number(m2[1]), Number(m2[2])];
  const m1 = s0.match(/(\d+)/);
  return m1 ? [Number(m1[1]), Number(m1[1])] : [null, null];
}

/* 表里只有「11月15日」这种月日，年份得自己补：
   以放量日为基准，月份比它小就是跨年（1月接在12月后面）。 */
function isoFromMd(md, baseIso) {
  const m = String(md || '').match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (!m) return '';
  const mm = Number(m[1]), dd = Number(m[2]);
  let y = Number(String(baseIso || '').slice(0, 4)) || new Date().getFullYear();
  if (baseIso && mm < Number(String(baseIso).slice(5, 7)) - 6) y += 1;
  const p = n => String(n).padStart(2, '0');
  return `${y}-${p(mm)}-${p(dd)}`;
}

function parse(j) {
  const rows = [];
  let extra = null, note = '';
  (function walk(x) {
    if (Array.isArray(x)) return x.forEach(walk);
    if (!x || typeof x !== 'object') return;
    if (x.extra && x.extra.showId) extra = x.extra;
    if (typeof x.bottomSubtitle === 'string' && x.bottomSubtitle) note = x.bottomSubtitle;
    if (x.sheetType === 'item' && Array.isArray(x.sheet)) {
      const d = x.sheet.find(s => s.sheetItemType === 'date') || {};
      const sv = x.sheet.find(s => s.sheetHeadType === 'svip') || {};
      const vp = x.sheet.find(s => s.sheetHeadType === 'vip') || {};
      const day = d.subtitle || '';
      const [sf, st] = range((sv.title || [])[0]);
      const [vf, vt] = range((vp.title || [])[0]);
      rows.push({
        day,
        week: (d.title || [])[0] || '',
        svip: (sv.title || [])[0] || '',
        vip: (vp.title || [])[0] || '',
        svipFrom: sf, svipTo: st, vipFrom: vf, vipTo: vt,
        current: !!x.isCurrentDay,
      });
    }
    Object.values(x).forEach(walk);
  })(j);
  return { rows, extra, note };
}

const now = new Date();
const iso = d => new Date(d.getTime() + 8 * 3600e3).toISOString();

let body;
try {
  const j = await query();
  const { rows, extra, note } = parse(j);
  if (!rows.length) throw new Error('回包里没有日历行（组件改名或这剧没排期）');
  const rel = (extra && extra.showReleaseTime) || '';
  const base = String(rel).slice(0, 10) || iso(now).slice(0, 10);
  rows.forEach(r => { r.iso = isoFromMd(r.day, base); });
  body = {
    ok: true,
    show: SHOW,
    showId: (extra && extra.showId) || SHOWID,
    videoId: (extra && extra.videoId) || VIDEOID,
    subtitle: (extra && extra.showSubtitle) || '',
    episodeLast: extra && extra.episodeLast != null ? Number(extra.episodeLast) : null,
    episodeTotal: extra && extra.episodeTotal != null ? Number(extra.episodeTotal) : null,
    releaseTime: rel,
    packageType: (extra && extra.showPackageType) || [],
    completed: !!(extra && extra.completed),
    note,
    rows,
    lastRun: iso(now),
  };
} catch (e) {
  console.error(`::error::追剧日历没取到：${e.message}`);
  console.error('不写文件，页面上留的还是上一份表。');
  process.exit(1);
}

if (process.env.CAL_PROBE) {
  console.log(`PROBE OK · ${body.show} 日历 ${body.rows.length} 行 · VIP 已更 ${body.episodeLast}/${body.episodeTotal} · 放量 ${body.releaseTime}`);
  process.exit(0);
}

/* lastRun 只在成功时前进，闸门读它 —— 和 vv-hourly 那条同一个套路 */
fs.writeFileSync(OUT, JSON.stringify(body, null, 1));
const cur = body.rows.find(r => r.current) || body.rows[0];
console.log(`${body.show} · 官方日历 ${body.rows.length} 行 · VIP 已更 ${body.episodeLast}/${body.episodeTotal}`
  + ` · 今日 SVIP ${cur.svip}／VIP ${cur.vip} · ${body.releaseTime || '放量时刻未给'}`);
