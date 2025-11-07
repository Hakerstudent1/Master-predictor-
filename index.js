// index.js
// BDG server-only predictor with 30-minute rolling history (no local storage).
// - Polls BDG list API (pageSize=10) every minute
// - Stores entries in memory with IST timestamps
// - Prunes anything older than 30 minutes (so 31+ minutes are deleted)
// - Serves predictions + snapshot to the frontend

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ======== CONFIG ========
const BDG_LIST_URL   = process.env.BDG_LIST_URL || 'https://api.bdg88zf.com/api/webapi/GetNoaverageEmerdList';
const BDG_PAGE_SIZE  = Number(process.env.BDG_PAGE_SIZE || 10); // ✅ pageSize = 10
const BDG_PAGE_NO    = Number(process.env.BDG_PAGE_NO || 1);
const BDG_TYPE_ID    = Number(process.env.BDG_TYPE_ID || 1);
const BDG_LANGUAGE   = Number(process.env.BDG_LANGUAGE || 0);
const BDG_RANDOM     = process.env.BDG_RANDOM || 'c2505d9138da4e3780b2c2b34f2fb789';
const BDG_SIGNATURE  = process.env.BDG_SIGNATURE || '7D637E060DA35C0C6E28DC6D23D71BED';

const RESULT_RANGE_MAX = Number(process.env.RESULT_RANGE_MAX || 99); // 99 for 00..99, 9 for 0..9
const RETENTION_MINUTES = Number(process.env.RETENTION_MINUTES || 30); // ✅ keep 30 minutes
const PORT = Number(process.env.PORT || 3000);

// Optional extra headers (e.g., Authorization)
let EXTRA_HEADERS = {};
try { EXTRA_HEADERS = process.env.BDG_HEADERS_JSON ? JSON.parse(process.env.BDG_HEADERS_JSON) : {}; } catch { EXTRA_HEADERS = {}; }

// ======== STATE (server memory only) ========
// We'll store entries as: { period: "YYYYMMDDHHmm" | null, value: number, tISTms: number }
let entries = []; // newest-first by time; only within retention window
let lastMinuteKey = null;

// ======== TIME (IST helpers) ========
function istNow() { return new Date(Date.now() + 330 * 60 * 1000); } // UTC+5:30 offset
function currentPeriodIdIST() {
  const d = istNow();
  const y = d.getUTCFullYear();
  const M = String(d.getUTCMonth()+1).padStart(2,'0');
  const D = String(d.getUTCDate()).padStart(2,'0');
  const h = String(d.getUTCHours()).padStart(2,'0');
  const m = String(d.getUTCMinutes()).padStart(2,'0');
  return `${y}${M}${D}${h}${m}`; // YYYYMMDDHHmm (IST)
}
function secondsToNextMinute() {
  const now = Date.now();
  const next = Math.ceil(now/60000)*60000;
  return Math.max(0, Math.floor((next-now)/1000));
}
function minuteKeyIST() {
  const d = istNow();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}-${d.getUTCHours()}-${d.getUTCMinutes()}`;
}

// Parse period "YYYYMMDDHHmm" (IST) → IST epoch ms
function periodISTtoMs(period) {
  const s = String(period || '');
  if (!/^\d{12}$/.test(s)) return null;
  const y = Number(s.slice(0,4));
  const M = Number(s.slice(4,6));
  const D = Number(s.slice(6,8));
  const h = Number(s.slice(8,10));
  const m = Number(s.slice(10,12));
  // Build a Date in IST by building UTC and then subtracting the IST offset we added above? Easier:
  // We want the IST absolute time. Construct a Date as if values are IST and convert to ms:
  // Create a UTC date from components and then subtract 5h30m to get IST ms baseline.
  // But since we added 330 minutes when using istNow(), here we directly compute UTC time for IST clock:
  const utcMs = Date.UTC(y, M-1, D, h - 5, m - 30, 0, 0); // subtract 5:30 to obtain UTC ms
  return utcMs + 330*60*1000; // and then add back 5:30 to keep consistent IST epoch base (no-op, but clearer)
}

// ======== UTILS ========
const take = (a,n)=>a.slice(0,Math.min(n,a.length));
const sum  = a=>a.reduce((x,y)=>x+y,0);
const avg  = a=>a.length? sum(a)/a.length : 0;
const median = a=>{ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); const m=Math.floor(b.length/2); return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const mode = a=>{ const m=new Map(); for(const v of a)m.set(v,(m.get(v)||0)+1); let best=null,cnt=-1; for(const [k,c] of m) if(c>cnt){best=k;cnt=c} return best??0; };
const toDigit = v => RESULT_RANGE_MAX>9 ? (v%10) : v;

function pruneOld() {
  const nowIST = Date.now() + 330*60*1000;
  const cutoff = nowIST - RETENTION_MINUTES*60*1000;
  // Keep only entries >= cutoff
  entries = entries.filter(e => {
    const t = e.tISTms ?? 0;
    return t >= cutoff;
  });
  // Sort newest-first consistently
  entries.sort((a,b)=> (b.tISTms||0) - (a.tISTms||0));
}

function upsertEntries(newOnes) {
  // Insert new entries (dedupe by period if available, else by (value+time) best-effort)
  const byKey = new Map();
  for (const e of [...newOnes, ...entries]) {
    const key = e.period ? `p:${e.period}` : `t:${e.tISTms}:${e.value}`;
    const prev = byKey.get(key);
    if (!prev || (e.tISTms||0) > (prev.tISTms||0)) {
      byKey.set(key, e);
    }
  }
  entries = Array.from(byKey.values());
  // Sort newest-first
  entries.sort((a,b)=> (b.tISTms||0) - (a.tISTms||0));
  pruneOld();
}

function numericHistory() {
  // newest-first list of values within retention window
  return entries.map(e => e.value);
}

// ======== BDG FETCH ========
function bdgBody(pageSize=BDG_PAGE_SIZE, pageNo=BDG_PAGE_NO) {
  return {
    pageSize,
    pageNo,
    typeId: BDG_TYPE_ID,
    language: BDG_LANGUAGE,
    random: BDG_RANDOM,
    signature: BDG_SIGNATURE,
    timestamp: Math.floor(Date.now()/1000)
  };
}

async function fetchBdgList(pageSize=BDG_PAGE_SIZE, pageNo=BDG_PAGE_NO) {
  const res = await axios.post(BDG_LIST_URL, bdgBody(pageSize, pageNo), {
    headers: { 'Content-Type': 'application/json', ...EXTRA_HEADERS },
    timeout: 12000
  });
  return res.data;
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data?.list)) return data.data.list;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

// Map BDG row → {period,value,tISTms}
function mapRow(row) {
  const period = row.period ?? row.issue ?? row.issueNo ?? row.gameNo ?? row.no ?? null;
  const valueRaw = row.number ?? row.result ?? row.resultNo ?? row.openNum ?? row.value ?? row.num ?? null;
  const value = Number(valueRaw);
  if (!Number.isFinite(value)) return null;

  // prefer timestamp from period if present; else use "now IST" (minute)
  let tISTms = null;
  if (period) {
    const ms = periodISTtoMs(period);
    if (Number.isFinite(ms)) tISTms = ms;
  }
  if (!tISTms) {
    const nowIST = istNow();
    const floorMs = Date.UTC(
      nowIST.getUTCFullYear(),
      nowIST.getUTCMonth(),
      nowIST.getUTCDate(),
      nowIST.getUTCHours(),
      nowIST.getUTCMinutes(),
      0, 0
    ) + 330*60*1000; // align to IST minute start
    tISTms = floorMs;
  }
  return { period: period ? String(period) : null, value, tISTms };
}

async function refreshFromBDG() {
  const data = await fetchBdgList(BDG_PAGE_SIZE, BDG_PAGE_NO);
  const list = extractRows(data);
  if (!Array.isArray(list) || !list.length) return;

  const mapped = list.map(mapRow).filter(Boolean);

  // If rows have periods, ensure order newest-first by period numeric desc
  let ordered = mapped;
  if (mapped.every(r => r.period && /^\d{12}$/.test(r.period))) {
    ordered = [...mapped].sort((a,b)=> Number(b.period) - Number(a.period));
  } else {
    // otherwise, sort by time we computed
    ordered = [...mapped].sort((a,b)=> b.tISTms - a.tISTms);
  }

  upsertEntries(ordered);
}

// ======== PREDICTIONS (from numericHistory()) ========
function hist() { return numericHistory(); }

function p1(){ const h=hist(); if(h.length<10)return ['Waiting…','wait']; const a=avg(take(h,5).map(toDigit)), b=avg(h.slice(5,10).map(toDigit)); return [`Bias ${a>=b?'↗':'↘'} next≈${Math.round(a)%10}`, a>=b?'good':'bad']; }
function p2(){ const h=hist(); if(h.length<10)return ['Waiting…','wait']; const pick=[0,2,8].map(i=>toDigit(h[i]??0)); return [`Blend=${(pick[0]+pick[1]+pick[2])%10}`,'accent']; }
function p3(){ const h=hist(); if(h.length<6)return ['Waiting…','wait']; const last6=take(h,6).map(toDigit); const m=mode(last6), c=last6.filter(x=>x===m).length; return [c>=3?`Stick with ${m}`:`Shift to ${(m+1)%10}`, c>=3?'good':'warn']; }
function p4(){ const h=hist(); if(h.length<4)return ['Waiting…','wait']; const a=Math.round(avg(take(h,4).map(toDigit)))%10; return [`Momentum=${a}`,'accent']; }
function p5(){ const h=hist(); if(h.length<7)return ['Waiting…','wait']; const m=Math.round(median(take(h,7).map(toDigit)))%10; return [`Median=${m}`,'accent']; }
function p6(){ const h=hist(); if(h.length<8)return ['Waiting…','wait']; const arr=take(h,8).map(toDigit); const μ=avg(arr), dev=Math.sqrt(avg(arr.map(x=>(x-μ)*(x-μ)))); const choose=dev>2.5?Math.round((arr[0]+arr[1])/2)%10:Math.round(μ)%10; return [dev>2.5?`Swing=${choose}`:`Mean=${choose}`, dev>2.5?'warn':'good']; }
function p7(){ const h=hist(); if(h.length<9)return ['Waiting…','wait']; const a=take(h,9).map(toDigit); const odd=a.filter(x=>x%2===1).length; return [`${odd>=a.length-odd?'Odd':'Even'} → ${odd>=a.length-odd?1:0}`, odd>=a.length-odd?'good':'accent']; }
function p8(){ const h=hist(); if(h.length<12)return ['Waiting…','wait']; const a=take(h,12).map(toDigit); const low=a.filter(x=>x<=4).length, high=a.length-low; return [`Bias ${high>low?'High(5-9)':'Low(0-4)'} → ${high>low?7:2}`, high>low?'bad':'good']; }
function p9(){ const h=hist(); if(h.length<10)return ['Waiting…','wait']; const m=mode(take(h,10).map(toDigit)); return [`${m} or ${(m+9)%10}`,'accent']; }
function p10(){ const h=hist(); if(h.length<21)return ['Waiting (need 21)','wait']; const t=take(h,21).map(toDigit); const w=Array.from({length:21},(_,i)=>21-i); let num=0,den=0; for(let i=0;i<21;i++){num+=t[i]*w[i];den+=w[i]} const pred=Math.round(num/den)%10; const μ=avg(t), dev=Math.sqrt(avg(t.map(x=>(x-μ)*(x-μ)))); return [`W-Avg=${pred} • conf ${dev<2?'High':dev<3.5?'Mid':'Low'}`, dev<2?'good':dev<3.5?'warn':'bad']; }

function allPreds(){
  return { 1:p1(),2:p2(),3:p3(),4:p4(),5:p5(),6:p6(),7:p7(),8:p8(),9:p9(),10:p10() };
}

// ======== CRON: poll BDG each minute (5s after minute) ========
cron.schedule('5 * * * * *', async () => {
  const key = minuteKeyIST();
  if (key === lastMinuteKey) return;
  lastMinuteKey = key;
  try {
    await refreshFromBDG();
    console.log(`BDG polled. Kept ${entries.length} entries within last ${RETENTION_MINUTES} min.`);
  } catch (e) {
    console.warn('BDG poll failed:', e.message);
  }
});

// ======== API ========
app.get('/api/snapshot', (req, res) => {
  res.json({
    period: currentPeriodIdIST(),
    nextIn: secondsToNextMinute(),
    history: numericHistory(), // newest-first values within retention
    retentionMinutes: RETENTION_MINUTES,
    predictions: allPreds()
  });
});

app.get('/api/recent', (req, res) => {
  res.json({
    retentionMinutes: RETENTION_MINUTES,
    entries // full entries (period,value,tISTms) within retention window
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Static UI
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ======== START ========
(async () => {
  try { await refreshFromBDG(); } catch (e) { console.warn('Initial BDG fetch failed:', e.message); }
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
})();
