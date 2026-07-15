/* ════════════════════════════════════════════
   CONSTANTS & STATE
════════════════════════════════════════════ */
const GAS='https://script.google.com/macros/s/AKfycbwO6qV5jgQT79dPd16qDhfFnoiuQkdi2ICKO6wTqu1bQRe4sZLVGOdOYuCGGKBk5x_f8A/exec';

const histMonthly=[
  ['2024-04-28',823747],['2024-06-28',943360],['2024-07-28',1076636],
  ['2024-08-28',942533],['2024-09-28',1009259],['2024-10-28',1107657],
  ['2024-11-28',1179667],['2024-12-28',1345052],['2025-01-28',2543462],
  ['2025-02-28',2528914],['2025-03-28',2498696],['2025-04-28',2152973],
  ['2025-05-28',2343811],['2025-06-28',2491070],['2025-07-28',1519690],
  ['2025-08-28',1594496],['2025-09-28',1719704],['2025-10-28',1808932],
  ['2025-11-28',1604040],['2025-12-28',1825092],['2026-01-28',2535658],
  ['2026-02-28',2608956],['2026-03-28',2770043],['2026-04-10',3094038],
];

const PIE_COLORS=[
  '#007AFF','#34C759','#FF9500','#FF3B30','#5856D6',
  '#AF52DE','#FF2D55','#00C7BE','#A2845E','#30B0C7',
  '#32ADE6','#4CD964','#FFCC00','#FF6B35','#8E8E93',
];
const FEE_RATE=0.001425*0.6;
const DCA_CODES=new Set(['0050','0056','2330']);
const ETF_LIST=new Set(['0050','0056']);

let stockData=[],usStockData=[],usPortfolio=[];
let tradeFees={},prevPrices={},prevPricesUS={},week52Data={};
let ibCashUSD=0,ibNavUSD=0,fxRate=32.5;
let twHistoryData=[];
let latestTWMV=0,latestTWUnrealized=0;   // from prices_tw TOTAL_MV / UNREALIZED
let usBenchmarkHistory={};               // {QQQ:[{d,price}], SPY:[...]}
let currentPortfolio='TW';
let sortMode='today';
let holdingsView='card';
let currentRange=3;
let showBenchmark=false, showHsBench=false;
let usBenchQQQ=false, usBenchSPY=false, usBenchNASDAQ=false;
let lineChartInst=null,usNavChartInst=null,hsSummaryChartInst=null;
let hsPeriodMode='YTD';
let divYearFilter='2026';
let divOnlyReceived=localStorage.getItem('divOnlyRcv')==='1';  // 股利合計是否排除尚未除息的 upcoming
let tradeFilter='all';
let allTrades=[],usTradesData=[];
let dividendsTW=[];
let hidden=false;
let holdingsSortCol='mv',holdingsSortDir='desc';
let holdingsTabMode='today';
let stockIndivHistory={};   // code → [{d,price}]
let stockIntradayPrices={};  // code → [close, close, ...]  (5-min intraday)
let stockIntradayRange={};   // code → {h, l}  (today's intraday high/low)
let stockIntradayCandles={}; // code → [{t,o,h,l,c}, ...]  (raw candles, for time-based axis)
let stockIntradayPrevClose={}; // code → 昨收（Yahoo chart meta，跟盤中K同交易日對齊）
let stockOHLCCache={};       // code → {d:[ohlc], w:[ohlc]}
let expandedStock=null;
let _intradayFetchDone=false;
let chartsPeriod='daily';
let trendPeriod='intraday';  // 走勢 tab 專用：intraday / daily / weekly（預設即時走勢）
const HLD_TABS={
  today:{cols:[{key:'price',label:'最後價'},{key:'amplitude',label:'振幅'},{key:'dayPct',label:'變化%'},{key:'dayAmt',label:'盈虧$'}],defaultSort:'dayAmt'},
  pnl:  {cols:[{key:'unrealPct',label:'未實現%'},{key:'unreal',label:'未實現$'},{key:'avg',label:'均價'}],defaultSort:'unrealPct'},
  alloc:{cols:[{key:'costPct',label:'成本佔比'},{key:'mv',label:'市場價值'},{key:'navPct',label:'淨清算%'}],defaultSort:'costPct'},
  trend:{cols:[],defaultSort:'mv'},
};

/* ════════════════════════════════════════════
   CACHE
════════════════════════════════════════════ */
const _CK='inv_v3',_CTL=12*60*60*1000;
function _sc(k,v){try{const a=JSON.parse(localStorage.getItem(_CK)||'{}');a[k]={v,t:Date.now()};localStorage.setItem(_CK,JSON.stringify(a));}catch(_){}}
function _rc(k){try{const a=JSON.parse(localStorage.getItem(_CK)||'{}');const e=a[k];if(e&&Date.now()-e.t<_CTL)return e.v;}catch(_){}return null;}

function restoreCache(){
  const sd=_rc('sd'),usd=_rc('usd'),up=_rc('up'),
        nav=_rc('nav'),fx=_rc('fx'),prev=_rc('prev'),prevUS=_rc('prevUS'),
        twhd=_rc('twhd'),twmv=_rc('twmv'),usbnch=_rc('usbnch');
  if(sd)stockData=sd;
  if(usd)usStockData=usd;
  if(up)usPortfolio=up;
  if(nav){ibNavUSD=nav.n||0;ibCashUSD=nav.c||0;}
  if(fx){fxRate=fx;document.getElementById('fx-rate-val').textContent=fx.toFixed(2);}
  if(prev)prevPrices=prev;
  if(prevUS)prevPricesUS=prevUS;
  if(twhd&&twhd.length)twHistoryData=twhd;
  if(twmv){latestTWMV=twmv.mv||0;latestTWUnrealized=twmv.ur||0;}
  if(usbnch)usBenchmarkHistory=usbnch;
  _restoreIntradayCache(); // 當日盤中快取先上，走勢/小圖立即有線可畫
  if(sd||usd){renderOverview();const st=document.getElementById('st1');st.textContent='快取載入';st.className='ok';}
}

/* ════════════════════════════════════════════
   INIT
════════════════════════════════════════════ */
async function checkFugleStatus(){
  const el=document.getElementById('fugle-st');
  if(!el)return;
  try{
    const res=await gas({action:'fugle_intraday',symbol:'2330'});
    if(res.ok&&res.data?.length>0){
      el.textContent='富果 ✅ ('+res.data.length+'筆)';
      el.style.color='#30D158';
    } else {
      el.textContent='富果 ❌ '+(res.error||'no data');
      el.style.color='#FF453A';
    }
  }catch(e){
    el.textContent='富果 ❌ '+e.message;
    el.style.color='#FF453A';
  }
}

window.addEventListener('load',()=>{
  restoreCache();
  refresh();
  loadFxRate();
  loadUSStockData();
  loadUSNav();
  loadUSTrades();
  loadUSBenchmark();
  loadTWHistory();
  fetchPrevCloseUS().then(m=>{if(Object.keys(m).length){prevPricesUS=m;_sc('prevUS',m);renderHoldingsTable();renderHsSummaryMetrics();}}).catch(_=>{});
  setTimeout(checkFugleStatus,6000); // 延後檢測，別跟首屏資料搶 GAS 連線
  loadKCache(); // 預載每日日K/周K快取
  startIntradayAutoRefresh(); // 盤中每 60 秒自動刷新即時走勢
});

/* ════════════════════════════════════════════
   NORMALIZER & HELPERS
════════════════════════════════════════════ */
function normMkt(v){
  const s=String(v||'').trim().toUpperCase();
  if(['US','美股','USD'].includes(s))return 'US';
  if(['TW','台股','TWD'].includes(s))return 'TW';
  return s;
}
function fmtN(v,cur='NT$'){return hidden?'****':cur+Math.round(v).toLocaleString();}
function fmtPct(v){return (v>=0?'+':'')+v.toFixed(2)+'%';}
function sign(v){return v>=0?'+':'−';}
function clsPN(v){return v>=0?'pos':'neg';}
function clsPNmkt(v,mkt){return mkt==='TW'?(v>=0?'pos-tw':'neg-tw'):clsPN(v);}

/* ════════════════════════════════════════════
   GAS
════════════════════════════════════════════ */
async function gas(payload){
  const p=new URLSearchParams(payload);
  p.set('t',Date.now());
  const r=await fetch(GAS+'?'+p.toString());
  if(!r.ok)throw new Error('HTTP '+r.status);
  return JSON.parse(await r.text());
}

/* ════════════════════════════════════════════
   DATA LOADING
════════════════════════════════════════════ */
async function loadFxRate(){
  try{
    const res=await gas({action:'get_fx_rate'});
    if(res.ok&&res.rate){
      fxRate=res.rate;
      document.getElementById('fx-rate-val').textContent=res.rate.toFixed(2);
      _sc('fx',res.rate);
    }
  }catch(_){}
}

async function refresh(){
  const st=document.getElementById('st1');
  st.textContent='讀取中...';st.className='';
  try{
    const res=await gas({action:'read',sheet:'holdings_tw'});
    if(!res.ok)throw new Error(res.error||'讀取失敗');
    const hdr=res.data[0].map(h=>String(h).trim().toLowerCase());
    const ci=(pat,fb)=>{const i=hdr.findIndex(h=>pat.test(h));return i>=0?i:fb;};
    const tiI=ci(/^(ticker|code|symbol)/,0),mkI=ci(/^(market|mkt)/,1),
          shI=ci(/^(shares|qty)/,2),avI=ci(/^(avg|avg_cost|average|cost)/,3),
          prI=ci(/^(price|current|close|last)/,4),nmI=ci(/^(name|stock_name)/,5),
          mvI2=ci(/^(mv|market_value|市值)/,-1),
          costI=ci(/^(total_cost|cost_basis|總成本)/,-1),
          urI2=ci(/^(unrealized|未實現損益)/,-1);
    stockData=res.data.slice(1).filter(r=>r[0]).map(r=>({
      code:String(r[tiI]).trim(),mkt:normMkt(r[mkI]),
      sh:+r[shI]||0,avg:+r[avI]||0,price:+r[prI]||0,
      name:String(r[nmI]||r[tiI]).trim(),
      sheetMV:mvI2>=0?(+String(r[mvI2]||'').replace(/[^\d.\-]/g,'')||0):0,
      sheetCost:costI>=0?(+String(r[costI]||'').replace(/[^\d.\-]/g,'')||0):0,
      sheetUnreal:urI2>=0?(v=>isNaN(v)?null:v)(+String(r[urI2]||'').replace(/[^\d.\-]/g,'')):null,
    })).filter(r=>r.sh>0);
    _sc('sd',stockData);
    await calcTradeFees();
    renderOverview();
    st.textContent='更新：'+new Date().toLocaleTimeString('zh-TW');
    st.className='ok';
  }catch(e){st.textContent=e.message;st.className='err';}
  // Parallel: prev close + US data + TW history + FX
  fetchPrevClose().then(m=>{if(Object.keys(m).length){prevPrices=m;_sc('prev',m);renderHoldingsTable();renderHsSummaryMetrics();}}).catch(_=>{});
  fetchPrevCloseUS().then(m=>{if(Object.keys(m).length){prevPricesUS=m;_sc('prevUS',m);renderHoldingsTable();renderHsSummaryMetrics();}}).catch(_=>{});
  loadUSStockData();
  loadUSNav();
  loadUSTrades();
  loadUSBenchmark();
  loadTWHistory();
  loadFxRate();
  loadTWDividends();
}

async function fetchPrevClose(){
  const map={};
  try{
    const res=await gas({action:'read',sheet:'prices_tw'});
    if(!res.ok||!res.data?.length)return map;
    const hdr=res.data[0].map(h=>{const s=String(h).trim();return /^\d{1,3}$/.test(s)?s.padStart(4,'0'):s;});
    const rows=res.data.slice(1).filter(r=>r[0]);
    if(rows.length<1)return map;
    // Data is DESCENDING: rows[0] = newest (today)
    const todayDate=String(rows[0][0]).slice(0,10);
    // Extract TOTAL_MV and UNREALIZED from today's row
    const mvI=hdr.findIndex(h=>/^total_mv$/i.test(h));
    const urI=hdr.findIndex(h=>/^unrealized$/i.test(h));
    if(mvI>=0){const v=+String(rows[0][mvI]||'').replace(/[^\d.\-]/g,'');if(v>0)latestTWMV=v;}
    if(urI>=0){const v=+String(rows[0][urI]||'').replace(/[^\d.\-]/g,'');if(!isNaN(v))latestTWUnrealized=v;}
    // Find prev close: first row with a different date
    // （此 map 只是「沒有盤中K可對日」時的退回值；有盤中K時
    //   livePrevClose 會依 K 線交易日從 stockIndivHistory 取正確昨收）
    let prevRow=null;
    for(let i=1;i<rows.length;i++){if(String(rows[i][0]).slice(0,10)!==todayDate){prevRow=rows[i];break;}}
    const useRow=prevRow||rows[0];
    hdr.forEach((c,i)=>{if(!/^\d{4}$/.test(c))return;const v=+String(useRow[i]||'').replace(/[^\d.\-]/g,'');if(!isNaN(v)&&v>0)map[c]=v;});
    if(res.prices)Object.entries(res.prices).forEach(([c,p])=>{const code=String(c).padStart(4,'0');if(+p>0)map[code]=+p;});
    // Build per-stock closing price history for sparklines
    hdr.forEach((c,i)=>{
      if(!/^\d{4}$/.test(c))return;
      const hist=rows.map(r=>{
        const d=String(r[0]).slice(0,10);
        const p=+String(r[i]||'').replace(/[^\d.\-]/g,'');
        return {d,price:p};
      }).filter(r=>r.d&&r.price>0).sort((a,b)=>a.d.localeCompare(b.d));
      if(hist.length)stockIndivHistory[c]=hist;
    });
  }catch(_){}
  return map;
}

async function fetchPrevCloseUS(){
  const map={};
  try{
    const res=await gas({action:'read',sheet:'us_prices'});
    if(!res.ok||!res.data?.length)return map;
    const hdr=res.data[0].map(h=>String(h).trim().toUpperCase());
    const rows=res.data.slice(1).filter(r=>r[0]);
    if(rows.length<2)return map;
    // Determine sort order from first two dates
    const toD=r=>String(r[0] instanceof Date?r[0].toISOString():r[0]).slice(0,10);
    const isDesc=toD(rows[0])>toD(rows[1]);
    const todayRow=isDesc?rows[0]:rows[rows.length-1];
    const todayDate=toD(todayRow);
    let prevRow=null;
    if(isDesc){
      for(let i=1;i<rows.length;i++){if(toD(rows[i])!==todayDate){prevRow=rows[i];break;}}
    } else {
      for(let i=rows.length-2;i>=0;i--){if(toD(rows[i])!==todayDate){prevRow=rows[i];break;}}
    }
    if(!prevRow)return map;
    hdr.forEach((col,i)=>{
      if(!col||col==='DATE')return;
      const v=+String(prevRow[i]||'').replace(/[^\d.\-]/g,'');
      if(!isNaN(v)&&v>0)map[col]=v;
    });
    // Build per-US-stock closing price history for sparklines
    const _benchPat=/^(QQQ|SPY|S&P500|NASDAQ|NDX|IXIC|GSPC|SPX|DATE)$/i;
    hdr.forEach((col,i)=>{
      if(!col||_benchPat.test(col))return;
      const hist=rows.map(r=>{
        const raw=r[0];
        const d=(raw instanceof Date?raw.toISOString():String(raw)).slice(0,10);
        const p=+String(r[i]||'').replace(/[^\d.\-]/g,'');
        return {d,price:p};
      }).filter(r=>r.d&&r.price>0).sort((a,b)=>a.d.localeCompare(b.d));
      if(hist.length)stockIndivHistory[col]=hist;
    });
  }catch(_){}
  return map;
}

async function calcTradeFees(){
  try{
    const res=await gas({action:'read',sheet:'trades_tw'});
    if(!res.ok||res.data.length<2)return;
    const hdr=res.data[0].map(h=>String(h).trim());
    const cdI=hdr.indexOf('code'),sdI=hdr.indexOf('side'),qtI=hdr.indexOf('qty'),
          prI=hdr.indexOf('price'),ttI=hdr.indexOf('trade_type'),
          feI=hdr.indexOf('fee'),txI=hdr.indexOf('tax');
    const fees={};
    res.data.slice(1).forEach(r=>{
      if(!r[cdI])return;
      const code=String(r[cdI]).padStart(4,'0');
      if(String(r[sdI]||'').trim()!=='賣')return;
      if(!fees[code])fees[code]=0;
      if(feI>=0&&r[feI]!==''){fees[code]+=(+r[feI]||0)+(+r[txI]||0);}
      else{
        const qty=+r[qtI]||0,price=+r[prI]||0;if(!qty||!price)return;
        const amt=qty*price,tt=String(r[ttI]||'').trim();
        const isDCA=tt==='定期定額'||(tt===''&&DCA_CODES.has(code));
        fees[code]+=(isDCA?1:Math.max(1,Math.round(amt*FEE_RATE)))+(isDCA?0:Math.floor(amt*0.003));
      }
    });
    tradeFees=fees;
    // Also load allTrades for trade panel
    allTrades=res.data.slice(1).filter(r=>r[0]).map(r=>{
      const dtI2=hdr.indexOf('date');
      return {
        date:String(r[dtI2>=0?dtI2:0]).slice(0,10),
        ticker:String(r[cdI]).padStart(4,'0'),
        side:(()=>{const s=String(r[sdI]||'').trim();return s==='買'||s==='B'||s==='BUY'?'BUY':'SELL';})(),
        qty:+r[qtI]||0,price:+r[prI]||0,fee:feI>=0?(+r[feI]||0):0,mkt:'TW'
      };
    }).sort((a,b)=>b.date.localeCompare(a.date));
    renderXirrMetric();
  }catch(_){}
}

async function loadUSStockData(){
  try{
    const res=await gas({action:'read',sheet:'holdings_us'});
    if(!res.ok)return;
    const hdr=res.data[0].map(h=>String(h).trim().toLowerCase());
    const ci=(pat,fb)=>{const i=hdr.findIndex(h=>pat.test(h));return i>=0?i:fb;};
    const tiI=ci(/^(ticker|code|symbol)/,0),mkI=ci(/^(market|mkt)/,1),
          shI=ci(/^(shares|qty)/,2),avI=ci(/^(avg|avg_cost)/,3),
          prI=ci(/^(price|current|close|last)/,4),nmI=ci(/^(name)/,5),
          ibI=ci(/^(ib_pnl|ibpnl|unrealized_pnl)/,-1);
    usStockData=res.data.slice(1)
      .filter(r=>r[0]&&normMkt(r[mkI])==='US')
      .map(r=>({
        code:String(r[tiI]).trim(),mkt:'US',
        sh:+r[shI]||0,avg:+r[avI]||0,price:+r[prI]||0,
        name:String(r[nmI>=0?nmI:tiI]||r[tiI]).trim(),
        ibPnl:ibI>=0?(+r[ibI]||null):null
      })).filter(s=>s.sh>0);
    _sc('usd',usStockData);
    if(currentPortfolio==='US')renderOverview();
  }catch(e){console.error('loadUSStockData',e);}
}

async function loadUSNav(){
  try{
    const res=await gas({action:'read',sheet:'us_nav'});
    if(!res.ok||!res.data?.length)return;
    const hdr=res.data[0].map(h=>String(h).trim().toLowerCase());
    const dtI=hdr.indexOf('date'),ibI=hdr.indexOf('ib_nav_usd'),
          eqI=hdr.indexOf('equity_usd'),mgI=hdr.indexOf('margin_usd');
    const rows=res.data.slice(1).filter(r=>r[dtI]!==''&&r[dtI]!==undefined);
    if(!rows.length)return;
    ibNavUSD=+(rows[0][ibI])||+(rows[0][eqI])||0;
    ibCashUSD=+(rows[0][mgI])||0;
    const asc=[...rows].reverse();
    const baseNav=+(asc[0]?.[ibI])||+(asc[0]?.[eqI])||1;
    usPortfolio=asc.map(r=>{
      const d=r[dtI] instanceof Date?r[dtI].toISOString().slice(0,10):String(r[dtI]).slice(0,10);
      const nav=+(r[ibI])||+(r[eqI])||0;
      return {d,pct:+((nav-baseNav)/baseNav*100).toFixed(4),navUSD:nav};
    }).filter(r=>r.d&&r.navUSD>0);
    _sc('nav',{n:ibNavUSD,c:ibCashUSD});
    _sc('up',usPortfolio);
    if(currentPortfolio==='US')renderOverview();
  }catch(e){console.error('loadUSNav',e);}
}

async function loadUSTrades(){
  try{
    const res=await gas({action:'read',sheet:'us_trades'});
    if(!res.ok||!res.data?.length)return;
    const hdr=res.data[0].map(h=>String(h).trim());
    const dtI=hdr.indexOf('date'),tkI=hdr.indexOf('ticker'),sdI=hdr.indexOf('side'),
          qtI=hdr.indexOf('qty'),prI=hdr.indexOf('price'),feI=hdr.indexOf('fee');
    usTradesData=res.data.slice(1).filter(r=>r[0]).map(r=>({
      date:String(r[dtI]).slice(0,10),ticker:String(r[tkI]).trim(),
      side:String(r[sdI]).trim(),qty:+r[qtI],price:+r[prI],
      fee:+r[feI]||0,mkt:'US'
    })).sort((a,b)=>b.date.localeCompare(a.date));
  }catch(_){}
}

async function loadUSBenchmark(){
  try{
    const res=await gas({action:'read',sheet:'us_prices'});
    if(!res.ok||!res.data?.length)return;
    const hdr=res.data[0].map(h=>String(h).trim().toUpperCase());
    const rows=res.data.slice(1).filter(r=>r[0]);
    usBenchmarkHistory={};
    const benchAliases={
      QQQ:[/^QQQ$/i],
      SPY:[/^SPY$/i,/^s&p500$/i,/s.?p.?500/i,/^GSPC/i,/^SPX/i],
      NASDAQ:[/^NASDAQ$/i,/^NDX$/i,/^IXIC$/i],
    };
    Object.entries(benchAliases).forEach(([sym,patterns])=>{
      const ci=hdr.findIndex(h=>patterns.some(re=>re.test(h)));
      if(ci<0)return;
      const pts=rows.map(r=>{
        const raw=r[0];
        const d=(raw instanceof Date?raw.toISOString():String(raw)).slice(0,10);
        const p=+String(r[ci]||'').replace(/[^\d.\-]/g,'');
        return {d,price:p};
      }).filter(r=>r.d&&r.price>0).sort((a,b)=>a.d.localeCompare(b.d));
      if(pts.length)usBenchmarkHistory[sym]=pts;
    });
    _sc('usbnch',usBenchmarkHistory);
    renderHsSummaryChart();
  }catch(e){console.error('loadUSBenchmark',e);}
}

async function loadTWHistory(){
  try{
    const res=await gas({action:'read',sheet:'prices_tw'});
    if(!res.ok||!res.data?.length)return;
    const hdr=res.data[0].map(h=>String(h).trim());
    const twiiI=hdr.findIndex(h=>/^(\^?twii|taiex|大盤)$/i.test(h));
    const mvI=hdr.findIndex(h=>/^total_mv$/i.test(h));
    const urI=hdr.findIndex(h=>/^unrealized$/i.test(h));
    const rows=res.data.slice(1).filter(r=>r[0]);
    // Data is DESCENDING: set globals from newest row
    if(rows.length>0){
      if(mvI>=0){const v=+String(rows[0][mvI]||'').replace(/[^\d.\-]/g,'');if(v>0)latestTWMV=v;}
      if(urI>=0){const v=+String(rows[0][urI]||'').replace(/[^\d.\-]/g,'');if(!isNaN(v))latestTWUnrealized=v;}
    }
    twHistoryData=rows.map(r=>{
      const date=String(r[0]).slice(0,10);
      const pv=mvI>=0?(+String(r[mvI]||'').replace(/[^\d.\-]/g,'')||0):0;
      return {date,pv,twii:twiiI>=0?(+r[twiiI]||null):null};
    }).filter(r=>r.date&&r.pv>0).sort((a,b)=>a.date.localeCompare(b.date));
    _sc('twhd',twHistoryData);
    _sc('twmv',{mv:latestTWMV,ur:latestTWUnrealized});
    renderHsSummaryChart();
    renderHsSummaryMetrics();
    renderXirrMetric();
  }catch(e){console.error('loadTWHistory',e);}
}

/* ════════════════════════════════════════════
   XIRR（年化報酬率，含已實現股利）
════════════════════════════════════════════ */
function xirr(cashflows){
  // cashflows: [{date:'YYYY-MM-DD', amount:Number}], 至少需要一筆負值與一筆正值
  if(cashflows.length<2)return null;
  const sorted=[...cashflows].sort((a,b)=>a.date.localeCompare(b.date));
  const hasNeg=sorted.some(c=>c.amount<0), hasPos=sorted.some(c=>c.amount>0);
  if(!hasNeg||!hasPos)return null;
  const d0=new Date(sorted[0].date);
  const yrs=d=>(new Date(d)-d0)/(365*86400000);
  let rate=0.1;
  for(let i=0;i<100;i++){
    let f=0,df=0;
    sorted.forEach(cf=>{
      const t=yrs(cf.date);
      const denom=Math.pow(1+rate,t);
      f+=cf.amount/denom;
      df+=-t*cf.amount/Math.pow(1+rate,t+1);
    });
    if(Math.abs(df)<1e-10)break;
    const newRate=rate-f/df;
    if(!isFinite(newRate)||newRate<=-0.999)break;
    if(Math.abs(newRate-rate)<1e-7){rate=newRate;break;}
    rate=newRate;
  }
  return isFinite(rate)?rate:null;
}

function buildXirrCashflows(sinceDate){
  // sinceDate: 'YYYY-MM-DD'，限定區間起點；null 表示自最早持倉以來
  const flows=[];
  if(sinceDate){
    const before=twHistoryData.filter(h=>h.date<=sinceDate);
    const startPV=before.length?before[before.length-1].pv:null;
    if(!startPV)return null; // 該期間無起始市值資料，無法計算
    flows.push({date:sinceDate,amount:-startPV});
  }
  allTrades.filter(t=>t.mkt==='TW'&&(!sinceDate||t.date>=sinceDate)).forEach(t=>{
    const amt=t.qty*t.price+(t.fee||0);
    if(amt)flows.push({date:t.date,amount:t.side==='BUY'?-amt:amt});
  });
  dividendsTW.filter(d=>d.status==='received'&&(!sinceDate||d.date>=sinceDate)).forEach(d=>{
    if(d.amount)flows.push({date:d.date,amount:d.amount});
  });
  const endPV=latestTWMV>0?latestTWMV:stockData.filter(s=>s.mkt==='TW').reduce((a,s)=>a+s.sh*s.price,0);
  if(!endPV)return null;
  flows.push({date:new Date().toISOString().slice(0,10),amount:endPV});
  return flows;
}

function renderXirrMetric(){
  const elYtd=document.getElementById('hs-xirr-ytd');
  const elAll=document.getElementById('hs-xirr-all');
  if(!elYtd||!elAll)return;
  if(!twHistoryData.length||!stockData.length){elYtd.textContent='--';elAll.textContent='';return;}

  const thisYear=new Date().getFullYear()+'-01-01';
  const ytdFlows=buildXirrCashflows(thisYear);
  const ytdRate=ytdFlows?xirr(ytdFlows):null;

  const earliestDate=twHistoryData[0]?.date||null;
  const allFlows=earliestDate?buildXirrCashflows(null):null;
  const allRate=allFlows?xirr(allFlows):null;

  if(ytdRate!==null){
    elYtd.textContent=(ytdRate>=0?'+':'')+(ytdRate*100).toFixed(1)+'%';
    elYtd.className='hs-mval '+clsPNmkt(ytdRate,'TW');
  } else {
    elYtd.textContent='--';
  }
  if(allRate!==null){
    elAll.textContent='全期間: '+(allRate>=0?'+':'')+(allRate*100).toFixed(1)+'%';
  } else {
    elAll.textContent='';
  }
}

/* ════════════════════════════════════════════
   UI: NAVIGATION
════════════════════════════════════════════ */
const PANEL_NAMES={overview:'總覽',dividends:'股利',lending:'借券',trade:'交易',charts:'多股圖'};
const PANEL_ORDER=['overview','dividends','lending','trade','charts'];
function sw(id){
  PANEL_ORDER.forEach(p=>{
    const btn=document.getElementById('bn-'+p);
    if(btn)btn.classList.toggle('on',p===id);
  });
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('on'));
  document.getElementById('panel-'+id).classList.add('on');
  // breadcrumb — overview = root only, others show section
  const bcSep=document.getElementById('bc-sep'),bcCur=document.getElementById('bc-cur');
  if(id==='overview'){bcSep.style.display='none';bcCur.style.display='none';}
  else{bcSep.style.display='';bcCur.style.display='';bcCur.textContent=PANEL_NAMES[id];}
  if(id==='dividends')renderDividends();
  if(id==='lending')renderLending();
  if(id==='trade')renderTrades();
  if(id==='charts')renderChartsPage();
}

function setPortfolio(p){
  currentPortfolio=p;
  _intradayFetchDone=false; // refetch intraday for new market
  ['TW','US'].forEach(m=>document.getElementById('pt-'+m).classList.toggle('on',m===p));
  const bcSep=document.getElementById('bc-sep');
  const bcCur=document.getElementById('bc-cur');
  bcSep.style.display='';bcCur.style.display='';
  bcCur.textContent=p==='TW'?'🇹🇼 台股':'🇺🇸 美股';
  renderOverview();
  if(document.getElementById('panel-dividends').classList.contains('on'))renderDividends();
  if(document.getElementById('panel-charts').classList.contains('on'))renderChartsPage();
}

function toggleHide(){
  hidden=!hidden;
  document.querySelector('.hdr-icon[title="隱藏數字"]').textContent=hidden?'🙈':'👁';
  renderOverview();
}

/* ════════════════════════════════════════════
   OVERVIEW: HOLDINGS SUMMARY METRICS
════════════════════════════════════════════ */
function renderOverview(){
  renderHsSummaryMetrics();
  renderHoldingsTable();
  renderHsSummaryChart();
}

function renderHsSummaryMetrics(){
  const mkt=currentPortfolio;
  let mv=0,cost=0,dayChg=0,unrealized=0,cash=0,nav=0;

  // TW — use TOTAL_MV/UNREALIZED from sheet when available
  if(mkt==='TW'||mkt==='ALL'){
    const twMv=latestTWMV>0
      ? latestTWMV
      : stockData.filter(s=>s.mkt==='TW').reduce((a,s)=>a+s.sh*s.price,0);
    const twUnreal=latestTWMV>0
      ? latestTWUnrealized
      : (()=>{const c=stockData.filter(s=>s.mkt==='TW').reduce((a,s)=>a+s.sh*s.avg,0);
              const f=Object.values(tradeFees).reduce((a,v)=>a+v,0);return twMv-c-f;})();
    const twCost=twMv-twUnreal;
    mv+=twMv; cost+=twCost; unrealized+=twUnreal;
    stockData.filter(s=>s.mkt==='TW').forEach(s=>{
      const prev=livePrevClose(s.code,false);
      if(prev&&prev>0)dayChg+=(liveLastPrice(s.code,s.price)-prev)*s.sh;
    });
  }

  // US
  if(mkt==='US'||mkt==='ALL'){
    const usMv=usStockData.reduce((s,x)=>s+x.sh*x.price,0);
    const usCost=usStockData.reduce((s,x)=>s+x.sh*x.avg,0);
    if(mkt==='US'){
      mv=usMv;cost=usCost;
      usStockData.forEach(s=>{const p=livePrevClose(s.code,true);if(p&&p>0)dayChg+=(liveLastPrice(s.code,s.price)-p)*s.sh;});
      unrealized=usStockData.reduce((s,x)=>s+(x.ibPnl!==null?x.ibPnl:x.sh*(x.price-x.avg)),0);
      cash=ibCashUSD;
      nav=ibNavUSD>0?ibNavUSD:(usMv+ibCashUSD);
    } else {
      mv+=usMv*fxRate;cost+=usCost*fxRate;
      usStockData.forEach(s=>{
        const p=livePrevClose(s.code,true);
        if(p&&p>0)dayChg+=(liveLastPrice(s.code,s.price)-p)*s.sh*fxRate;
        unrealized+=(s.ibPnl!==null?s.ibPnl:s.sh*(s.price-s.avg))*fxRate;
      });
    }
  }

  const isUS=mkt==='US';
  if(!isUS){nav=mv;cash=0;}
  const curr=isUS?'USD ':'NT$';
  const hasPrev=Object.keys(isUS?prevPricesUS:prevPrices).length>0;

  // NAV
  document.getElementById('hs-nav').textContent=fmtN(nav,curr);
  const navNtdEl=document.getElementById('hs-nav-ntd');
  if(isUS){ navNtdEl.textContent='≈ NT$'+Math.round(nav*fxRate).toLocaleString(); }
  else { navNtdEl.textContent=''; }

  // Bar
  const mvBar=isUS&&ibCashUSD<0?mv/(mv+Math.abs(ibCashUSD))*100:70;
  document.getElementById('hs-bar').style.width=Math.min(100,Math.max(10,mvBar)).toFixed(1)+'%';

  // Market Value / Cash
  document.getElementById('hs-mv').textContent=fmtN(mv,curr);
  document.getElementById('hs-cash').textContent=isUS?(cash>=0?'+':'')+fmtN(cash,curr):'— (無槓桿)';

  // Day Change
  const pc=v=>clsPNmkt(v,mkt);
  const dc=document.getElementById('hs-day-chg');
  const dp=document.getElementById('hs-day-pct');
  if(hasPrev&&mv>0){
    dc.textContent=(dayChg>=0?'+':'-')+curr+Math.abs(Math.round(dayChg)).toLocaleString();
    dc.className='hs-mval '+pc(dayChg);
    const pctDc=dayChg/(mv-dayChg)*100;
    dp.textContent=' ('+fmtPct(pctDc)+')';
    dp.className='hs-mpct '+pc(dayChg);
  } else {
    dc.textContent='--';dc.className='hs-mval neu';dp.textContent='';
  }
  const dcNtd=document.getElementById('hs-day-chg-ntd');
  if(isUS&&hasPrev&&mv>0){
    dcNtd.textContent='≈ '+(dayChg>=0?'+':'-')+'NT$'+Math.abs(Math.round(dayChg*fxRate)).toLocaleString();
  } else { dcNtd.textContent=''; }

  // Unrealized G/L
  const ur=document.getElementById('hs-unreal');
  const up=document.getElementById('hs-unreal-pct');
  ur.textContent=(unrealized>=0?'+':'-')+curr+Math.abs(Math.round(unrealized)).toLocaleString();
  ur.className='hs-mval '+pc(unrealized);
  const retPct=cost>0?unrealized/cost*100:0;
  up.textContent=' ('+fmtPct(retPct)+')';
  up.className='hs-mpct '+pc(unrealized);
  const urNtd=document.getElementById('hs-unreal-ntd');
  if(isUS){
    urNtd.textContent='≈ '+(unrealized>=0?'+':'-')+'NT$'+Math.abs(Math.round(unrealized*fxRate)).toLocaleString();
  } else { urNtd.textContent=''; }


  renderBenchmarkButtons();
}

/* ════════════════════════════════════════════
   OVERVIEW: HOLDINGS TAB + SORTABLE TABLE
════════════════════════════════════════════ */
function switchHoldingsTab(tab){
  holdingsTabMode=tab;
  document.querySelectorAll('.hld-tab').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  holdingsSortCol=HLD_TABS[tab].defaultSort;
  holdingsSortDir='desc';
  renderHoldingsTable();
}

function sortHoldings(col){
  if(holdingsSortCol===col){holdingsSortDir=holdingsSortDir==='desc'?'asc':'desc';}
  else{holdingsSortCol=col;holdingsSortDir='desc';}
  renderHoldingsTable();
}

/* ════════════════════════════════════════════
   SPARKLINE & K-CHART
════════════════════════════════════════════ */
// data 在 isIntraday=true 時是完整 candle 物件陣列（含 t，用來對齊真實時間到收盤）；
// isIntraday=false 時是單純價格陣列（5日日線 fallback，沒有分鐘時間軸概念）
function buildSparkSVG(data,prevClose,isUS,isIntraday){
  const H=26,pad=2,lblW=24,W=72+lblW; // 右側留空間標上下限
  const plotW=W-pad*2-lblW;
  const prices=isIntraday?data.map(c=>c.c):data;
  const allP=prevClose>0?[...prices,prevClose]:prices;
  const mn=Math.min(...allP),mx=Math.max(...allP),rng=mx-mn||1;
  let xFrac;
  if(isIntraday){
    const {start,end,tz}=_sessionRange(isUS);
    const span=end-start;
    const mins=data.map(c=>_candleMinuteOfDay(c.t,tz));
    const validTimes=mins.every(v=>v!=null);
    xFrac=i=>validTimes?Math.min(1,Math.max(0,(mins[i]-start)/span)):(i/(prices.length-1||1));
  }else{
    xFrac=i=>i/(prices.length-1||1);
  }
  const x=i=>pad+xFrac(i)*plotW;
  const y=p=>H-pad-((p-mn)/rng)*(H-pad*2);
  const d=prices.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+','+y(p).toFixed(1)).join(' ');
  // 漲跌色以「昨收」為基準，跟同一列的變化%顏色一致；沒有昨收才退回比對區間內第一筆
  const trend=prevClose>0?(prices[prices.length-1]-prevClose):(prices[prices.length-1]-prices[0]);
  const col=isUS?(trend>=0?'#34C759':'#FF3B30'):(trend>=0?'#FF3B30':'#34C759');
  const prevLine=prevClose>0
    ?`<line x1="${pad}" y1="${y(prevClose).toFixed(1)}" x2="${(pad+plotW).toFixed(1)}" y2="${y(prevClose).toFixed(1)}" stroke="#8E8E93" stroke-width="0.8" stroke-dasharray="2,2"/>`
    :'';
  // 上下限：當日最高（上）/ 最低（下）
  const pMax=Math.max(...prices),pMin=Math.min(...prices);
  const bounds=
    `<text x="${W-1}" y="7" text-anchor="end" font-size="6" fill="#8E8E93" font-family="-apple-system,sans-serif">${fmtAxis(pMax)}</text>`+
    `<text x="${W-1}" y="${H-2}" text-anchor="end" font-size="6" fill="#8E8E93" font-family="-apple-system,sans-serif">${fmtAxis(pMin)}</text>`;
  // 退回 5 日日線時標 "5D"
  const tag=isIntraday?'':
    `<text x="${(pad+plotW).toFixed(1)}" y="${H-1}" text-anchor="end" font-size="6" fill="#C7C7CC" font-family="-apple-system,sans-serif">5D</text>`;
  return `<div class="hld-spark"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${prevLine}<path d="${d}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>${bounds}${tag}</svg></div>`;
}

function sparklineSVG(code,isUS){
  const prev=livePrevClose(code,isUS);
  const candles=stockIntradayCandles[code];
  if(candles&&candles.length>=3)return buildSparkSVG(candles,prev,isUS,true);
  const hist=stockIndivHistory[code];
  if(!hist||hist.length<3)return '';
  // Fallback: last 4 closes + 今天最新價（含今日大漲）
  const stock=(isUS?usStockData:stockData).find(s=>s.code===code);
  const pts=hist.slice(-4).map(p=>p.price);
  if(stock?.price>0)pts.push(stock.price);
  return buildSparkSVG(pts,prev,isUS,false);
}

// 回傳完整 K 棒（含高低），供小圖收盤價序列與今日振幅共用
async function fetchFugleIntraday(symbol){
  const res=await gas({action:'fugle_intraday',symbol});
  if(!res.ok||!res.data?.length)throw new Error('no data');
  return res.data.filter(d=>d.c!=null);
}

// code 有給時，把 Yahoo meta 的昨收記到 stockIntradayPrevClose（跟盤中K同交易日對齊）
async function fetchYahooIntraday(sym,code){
  const res=await gas({action:'yahoo_chart',symbol:sym,interval:'5m',range:'1d'});
  if(!res.ok||!res.data?.length)throw new Error('no data');
  if(code&&res.prev>0)stockIntradayPrevClose[code]=res.prev;
  return res.data.filter(d=>d.c!=null);
}

// 台股盤中小圖：富果即時 → 假日退回 Yahoo「最近交易日」盤中5分K（如週五當天走勢）
async function fetchTWIntraday(code){
  try{const p=await fetchFugleIntraday(code);if(p.length>=3)return p;}catch(_){}
  for(const sfx of ['.TW','.TWO']){
    try{const p=await fetchYahooIntraday(code+sfx,code);if(p.length>=3)return p;}catch(_){}
  }
  throw new Error('no intraday');
}

// 昨收統一入口，依優先序：
// 1. Yahoo chart meta 的昨收（跟盤中K同來源、同交易日，最可靠）
// 2. 從個股收盤歷史找「盤中K交易日之前」的最後一筆收盤
//    ——關鍵是相對『K線的交易日』而非日曆今天：凌晨看的是昨天的盤、
//    假日看的是週五的盤，用日曆今天推昨收都會錯一天
// 3. Sheet 同步的昨收 map（沒有盤中K可對日時的退回值）
function livePrevClose(code,isUS){
  const p=stockIntradayPrevClose[code];
  if(p>0)return p;
  const cd=stockIntradayCandles[code];
  const hist=stockIndivHistory[code];
  if(cd&&cd.length&&hist&&hist.length){
    const t=cd[cd.length-1].t;
    const dt=typeof t==='number'?new Date(t*1000):new Date(t);
    if(!isNaN(dt.getTime())){
      const sess=new Intl.DateTimeFormat('en-CA',{timeZone:isUS?'America/New_York':'Asia/Taipei'}).format(dt);
      for(let i=hist.length-1;i>=0;i--){
        if(hist[i].d<sess&&hist[i].price>0)return hist[i].price;
      }
    }
  }
  return isUS?prevPricesUS[code]:prevPrices[code];
}
// 最新價統一入口：有盤中K就用最新一根收盤，否則退回 Sheet 同步價
function liveLastPrice(code,fallback){
  const cd=stockIntradayCandles[code];
  return cd&&cd.length?cd[cd.length-1].c:fallback;
}

function updateSparklineDOM(code,isUS){
  const td=document.querySelector(`#hld-body tr[data-code="${code}"] td.hld-name-td`);
  if(!td)return;
  const svg=sparklineSVG(code,isUS);
  const old=td.querySelector('.hld-spark');
  if(old)old.outerHTML=svg||'';
  else if(svg)td.insertAdjacentHTML('beforeend',svg);
}

function _applyIntradayCandles(code,candles){
  stockIntradayCandles[code]=candles;
  stockIntradayPrices[code]=candles.map(d=>d.c);
  const hs=candles.map(d=>d.h).filter(v=>v!=null),ls=candles.map(d=>d.l).filter(v=>v!=null);
  if(hs.length&&ls.length)stockIntradayRange[code]={h:Math.max(...hs),l:Math.min(...ls)};
}

let _sparklinesInflight=null;
async function fetchAllSparklines(){
  // 併發去重：同時多處呼叫（今日tab+走勢tab）只打一次
  if(_sparklinesInflight)return _sparklinesInflight;
  _sparklinesInflight=_fetchAllSparklinesInner().finally(()=>{_sparklinesInflight=null;});
  return _sparklinesInflight;
}
async function _fetchAllSparklinesInner(){
  const mkt=currentPortfolio;
  const stocks=[];
  if(mkt==='TW'||mkt==='ALL')stocks.push(...stockData.filter(s=>s.mkt==='TW').map(s=>({code:s.code,mkt:'TW'})));
  if(mkt==='US'||mkt==='ALL')stocks.push(...usStockData.map(s=>({code:s.code,mkt:'US'})));
  const need=stocks.filter(({code})=>!stockIntradayPrices[code]);
  if(!need.length)return;
  let gotAny=false;
  // 首選：單一 round-trip 批次抓全部（GAS 端用 fetchAll 平行打富果/Yahoo）
  try{
    const res=await gas({action:'intraday_batch',symbols:need.map(s=>s.code+':'+s.mkt).join(',')});
    if(res.ok&&res.data){
      for(const {code,mkt:m} of need){
        const candles=res.data[code];
        if(res.prev&&res.prev[code]>0)stockIntradayPrevClose[code]=res.prev[code];
        if(candles&&candles.length>=3){_applyIntradayCandles(code,candles);updateSparklineDOM(code,m==='US');gotAny=true;}
      }
    }
  }catch(e){console.warn('intraday_batch',e.message);}
  // 舊版 GAS 未部署 intraday_batch 或批次漏抓時：退回逐檔，但改成最多 4 路並行
  const missing=need.filter(({code})=>!stockIntradayPrices[code]);
  if(missing.length){
    let idx=0;
    await Promise.all(Array.from({length:Math.min(4,missing.length)},async()=>{
      while(idx<missing.length){
        const {code,mkt:m}=missing[idx++];
        try{
          const candles=m==='TW'?await fetchTWIntraday(code):await fetchYahooIntraday(code,code);
          if(candles.length>=3){_applyIntradayCandles(code,candles);updateSparklineDOM(code,m==='US');gotAny=true;}
        }catch(e){console.warn('sparkline',code,e.message);}
      }
    }));
  }
  // 振幅欄位、走勢tab的即時卡片都要等所有資料到齊才重繪，避免逐檔重繪整張表
  if(gotAny){
    _saveIntradayCache();
    if(holdingsTabMode==='today'||(holdingsTabMode==='trend'&&trendPeriod==='intraday'))renderHoldingsTable();
  }
}

/* 盤中資料本地快取：重新整理頁面時即時走勢「秒開」，背景再刷新成最新 */
const _ICK='inv_intraday_v1';
function _saveIntradayCache(){
  try{localStorage.setItem(_ICK,JSON.stringify({d:new Date().toDateString(),candles:stockIntradayCandles,prev:stockIntradayPrevClose}));}catch(_){}
}
function _restoreIntradayCache(){
  try{
    const c=JSON.parse(localStorage.getItem(_ICK)||'null');
    if(c&&c.d===new Date().toDateString()&&c.candles){
      Object.keys(c.candles).forEach(code=>{
        if(c.candles[code]&&c.candles[code].length>=3)_applyIntradayCandles(code,c.candles[code]);
      });
      if(c.prev)Object.keys(c.prev).forEach(code=>{if(c.prev[code]>0)stockIntradayPrevClose[code]=c.prev[code];});
    }
  }catch(_){}
}

// 盤中每 60 秒自動刷新一次即時走勢（今日小圖、振幅、走勢tab即時卡片都會一起更新）
// 分頁切到背景時暫停，避免浪費 API 額度
let _intradayRefreshing=false;
async function refreshIntradayData(){
  if(_intradayRefreshing)return;
  _intradayRefreshing=true;
  try{
    // 只清 prices 標記強制重抓；candles 保留舊值，抓失敗時畫面不會變空白
    stockIntradayPrices={};
    _intradayFetchDone=false;
    await fetchAllSparklines();
  }finally{
    _intradayRefreshing=false;
  }
}
function startIntradayAutoRefresh(){
  setInterval(()=>{
    if(document.visibilityState!=='visible')return;
    const day=new Date().getDay();
    if(day===0||day===6)return; // 週末不刷新
    refreshIntradayData();
  },60000);
}

/* ════════════════════════════════════════════
   MULTI-CHART: TREND TAB + CHARTS PAGE
════════════════════════════════════════════ */
let kcacheLoaded=false;
// 一次讀回每日盤後預抓的日K/周K，填入 stockOHLCCache（大幅加速、避開 Yahoo 限流）
async function loadKCache(){
  if(kcacheLoaded)return;
  try{
    const res=await gas({action:'read_kcache'});
    if(res.ok&&res.data){
      Object.keys(res.data).forEach(code=>{
        const o=res.data[code];
        if(!stockOHLCCache[code])stockOHLCCache[code]={};
        if(o.d&&o.d.length>3)stockOHLCCache[code].d=o.d;
        if(o.w&&o.w.length>3)stockOHLCCache[code].w=o.w;
      });
      kcacheLoaded=true;
    }
  }catch(_){}
}

async function ensureStockOHLC(code,mkt,period){
  if(!stockOHLCCache[code])stockOHLCCache[code]={};
  const key=period==='weekly'?'w':'d';
  if(stockOHLCCache[code][key]&&stockOHLCCache[code][key].length>3)return stockOHLCCache[code][key];
  const interval=period==='weekly'?'1wk':'1d';
  const range=period==='weekly'?'1y':'6mo';
  const data=await fetchOHLCsmart(code,mkt,interval,range)||[];
  stockOHLCCache[code][key]=data;
  return data;
}

// TW 股先試 .TW（上市），失敗再試 .TWO（上櫃）
async function fetchOHLCsmart(code,mkt,interval,range){
  if(mkt!=='TW')return fetchYahooOHLC(code,interval,range).catch(()=>null);
  let d=await fetchYahooOHLC(code+'.TW',interval,range).catch(()=>null);
  if(!d||d.length<=3)d=await fetchYahooOHLC(code+'.TWO',interval,range).catch(()=>null);
  return d;
}

function avgCostOf(code,isUS){
  const s=(isUS?usStockData:stockData).find(x=>x.code===code);
  return s&&s.avg>0?s.avg:null;
}
function lastPriceOf(code,isUS){
  const s=(isUS?usStockData:stockData).find(x=>x.code===code);
  return s&&s.price>0?s.price:null;
}
// 單檔未實現損益（與持倉表算法一致）
function calcUnreal(s,isUS){
  const fees=isUS?0:(tradeFees[s.code]||0);
  const costBasis=s.sheetCost&&s.sheetCost>0?s.sheetCost:(s.avg*s.sh+fees);
  const mv=s.sh*s.price;
  let unrealized;
  if(isUS)unrealized=s.ibPnl!=null?s.ibPnl:mv-s.avg*s.sh;
  else unrealized=s.sheetUnreal!=null?s.sheetUnreal:mv-costBasis;
  const unrealPct=costBasis>0?unrealized/costBasis*100:0;
  return {unrealized,unrealPct};
}

async function drawChartCard(code,mkt,containerId,period,isUS){
  const wrap=document.getElementById(containerId);
  if(!wrap)return;
  try{
    const ohlc=await ensureStockOHLC(code,mkt,period);
    const fallback=stockIndivHistory[code]||[];
    renderKPanel(containerId,ohlc.length>3?ohlc:null,fallback,period,isUS,avgCostOf(code,isUS),lastPriceOf(code,isUS));
  }catch(e){
    if(wrap){wrap.className='k-error';wrap.innerHTML='<span>無法載入</span>';}
  }
}

function setTrendPeriod(p){
  trendPeriod=p;
  if(holdingsTabMode==='trend')renderHoldingsTable();
}

function renderTrendGrid(rows,container,period){
  container.className='trend-grid';
  const cur=isUS=>isUS?'$':'';
  const isIntraday=period==='intraday';
  container.innerHTML=rows.map(r=>{
    // 即時卡片右上角顯示「當日漲跌幅＋當日盈虧」；日K/周K 維持未實現損益
    // 漲跌用「最新盤中K收盤 vs 昨收」計算——Sheet 同步的 s.price 盤中會過期，跟走勢線對不上
    let chgCls,chgPct,chgVal;
    if(isIntraday){
      const live=liveLastPrice(r.s.code,r.s.price>0?r.s.price:0);
      const prev=livePrevClose(r.s.code,r.isUS);
      if(live>0&&prev>0){
        const pct=(live-prev)/prev*100;
        const amt=(live-prev)*r.s.sh;
        chgCls=clsPNmkt(pct,r.isUS?'US':'TW');
        chgPct=fmtPct(pct);
        chgVal=(amt>=0?'+':'−')+cur(r.isUS)+Math.abs(Math.round(amt)).toLocaleString();
      }else{
        chgCls='neu';chgPct='--';chgVal='';
      }
    }else{
      chgCls=r.isUS?clsPN(r.unrealPct||0):clsPNmkt(r.unrealPct||0,'TW');
      chgPct=fmtPct(r.unrealPct||0);
      chgVal=(r.unrealized>=0?'+':'−')+cur(r.isUS)+Math.abs(Math.round(r.unrealized)).toLocaleString();
    }
    return `<div class="trend-card">
      <div class="trend-card-hdr">
        <span class="trend-card-ticker">${r.s.code}</span>
        <span class="trend-card-name">${r.s.name}</span>
        <span class="trend-card-chg ${chgCls}">${chgPct} <span class="trend-card-urval">${chgVal}</span></span>
      </div>
      <div id="trd-${r.s.code}" class="trend-chart-wrap k-loading">載入中...</div>
    </div>`;
  }).join('');
  if(isIntraday){
    drawIntradayCardsSeq(rows.map(r=>({code:r.s.code,mkt:r.s.mkt,id:'trd-'+r.s.code,isUS:r.isUS})));
  }else{
    drawChartCardsSeq(rows.map(r=>({code:r.s.code,mkt:r.s.mkt,id:'trd-'+r.s.code,isUS:r.isUS})),period);
  }
}

// 依序載入 K 圖，避免 Yahoo 並行限流導致部分退回折線（圖面不一致）
async function drawChartCardsSeq(cards,period){
  for(const c of cards){
    await drawChartCard(c.code,c.mkt,c.id,period||chartsPeriod,c.isUS);
  }
}

// 走勢 tab「即時」模式：大版 sparkline，沿用與小圖相同的富果/Yahoo 盤中資料
// 先畫已有快取的卡片（秒開），缺的用一次批次抓齊後再補畫
async function drawIntradayCardsSeq(cards){
  const pending=[];
  for(const c of cards){
    if(stockIntradayCandles[c.code]&&stockIntradayCandles[c.code].length>=3)await drawIntradayCard(c.code,c.mkt,c.id,c.isUS);
    else pending.push(c);
  }
  if(!pending.length)return;
  await fetchAllSparklines();
  for(const c of pending){
    await drawIntradayCard(c.code,c.mkt,c.id,c.isUS);
  }
}

async function drawIntradayCard(code,mkt,containerId,isUS){
  const wrap=document.getElementById(containerId);
  if(!wrap)return;
  try{
    if(!stockIntradayCandles[code]||stockIntradayCandles[code].length<3){
      const candles=mkt==='TW'?await fetchTWIntraday(code):await fetchYahooIntraday(code,code);
      if(candles.length<3)throw new Error('no data');
      _applyIntradayCandles(code,candles);
    }
    const candles=stockIntradayCandles[code];
    const prev=livePrevClose(code,isUS);
    wrap.className='trend-chart-wrap';
    wrap.innerHTML=buildBigSparkSVG(candles,prev,isUS);
  }catch(e){
    wrap.className='k-error';
    wrap.innerHTML='<span>無法載入</span>';
  }
}

// 交易時段（本地時區）：台股 09:00–13:30，美股 09:30–16:00（美東）
function _sessionRange(isUS){
  return isUS?{start:9*60+30,end:16*60,tz:'America/New_York'}:{start:9*60,end:13*60+30,tz:'Asia/Taipei'};
}
// candle 的 t 可能是 unix 秒數（Yahoo）或 ISO 字串（富果），統一換算成該時區的「當日第幾分鐘」
function _candleMinuteOfDay(t,tz){
  if(t==null)return null;
  const dt=typeof t==='number'?new Date(t*1000):new Date(t);
  if(isNaN(dt.getTime()))return null;
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(dt);
  const h=parseInt(parts.find(p=>p.type==='hour').value,10);
  const m=parseInt(parts.find(p=>p.type==='minute').value,10);
  return h*60+m;
}
function _fmtHHMM(min){
  return String(Math.floor(min/60)).padStart(2,'0')+':'+String(Math.round(min%60)).padStart(2,'0');
}

// X 軸固定為整個交易時段（開盤→收盤），資料只畫到目前時間，右側留白到收盤
// Y 軸為股價，含格線與昨收虛線
// 色塊標籤（背景+白字），永遠畫在圖表右側留白區，不會被走勢線蓋住
function _svgPill(x,y,label,bg){
  const w=label.length*5.3+8,h=13;
  return `<rect x="${x.toFixed(1)}" y="${(y-h/2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="3" fill="${bg}"/>`+
    `<text x="${(x+4).toFixed(1)}" y="${(y+3).toFixed(1)}" font-size="9" fill="#fff" font-family="-apple-system,sans-serif">${label}</text>`;
}

// Y 軸（股價）放右側、X 軸（時間）固定到收盤，與日K/周K圖版面一致
function buildBigSparkSVG(candles,prevClose,isUS){
  const W=300,H=110,padL=4,padR=44,padT=14,padB=18;
  const plotW=W-padL-padR,plotH=H-padT-padB;
  const {start,end,tz}=_sessionRange(isUS);
  const span=end-start;

  const mins=candles.map(c=>_candleMinuteOfDay(c.t,tz));
  const validTimes=mins.every(v=>v!=null);
  const xFrac=i=>validTimes?Math.min(1,Math.max(0,(mins[i]-start)/span)):(i/(candles.length-1||1));

  const closes=candles.map(c=>c.c);
  const allP=prevClose>0?[...closes,prevClose]:closes;
  const mn=Math.min(...allP),mx=Math.max(...allP),rng=mx-mn||1;
  const x=i=>padL+xFrac(i)*plotW;
  const y=p=>padT+plotH-((p-mn)/rng)*plotH;

  const d=closes.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+','+y(p).toFixed(1)).join(' ');
  // 漲跌色以「昨收」為基準，跟小圖、變化%欄位一致
  const trend=prevClose>0?(closes[closes.length-1]-prevClose):(closes[closes.length-1]-closes[0]);
  const col=isUS?(trend>=0?'#34C759':'#FF3B30'):(trend>=0?'#FF3B30':'#34C759');

  // Y 軸格線 + 價格標籤（右側，跟 K 線圖同一側）
  const yTicks=[mx,(mx+mn)/2,mn];
  const yGrid=yTicks.map(v=>
    `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${padL+plotW}" y2="${y(v).toFixed(1)}" stroke="#F2F2F7" stroke-width="1"/>`+
    `<text x="${(padL+plotW+4).toFixed(1)}" y="${(y(v)+3).toFixed(1)}" font-size="9" fill="#8E8E93" font-family="-apple-system,sans-serif">${fmtAxis(v)}</text>`
  ).join('');

  // 昨收虛線；標籤畫在右側留白區域，絕不會被走勢線壓到
  let prevLine='',prevPill='';
  if(prevClose>0){
    const py=y(prevClose);
    prevLine=`<line x1="${padL}" y1="${py.toFixed(1)}" x2="${padL+plotW}" y2="${py.toFixed(1)}" stroke="#8E8E93" stroke-width="1" stroke-dasharray="4,3"/>`;
    prevPill=_svgPill(padL+plotW+4,py,'昨 '+fmtAxis(prevClose),'#8E8E93');
  }

  // X 軸：開盤／盤中／收盤時間，固定畫到收盤
  const xTicks=[start,(start+end)/2,end];
  const xAxis=xTicks.map((min,i)=>{
    const anchor=i===0?'start':i===xTicks.length-1?'end':'middle';
    return `<text x="${(padL+((min-start)/span)*plotW).toFixed(1)}" y="${H-4}" text-anchor="${anchor}" font-size="9" fill="#8E8E93" font-family="-apple-system,sans-serif">${_fmtHHMM(min)}</text>`;
  }).join('');

  const lastX=x(closes.length-1),lastY=y(closes[closes.length-1]);
  const dot=`<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.8" fill="${col}"/>`;
  const lastPill=_svgPill(padL+plotW+4,lastY,fmtAxis(closes[closes.length-1]),col);

  return `<svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${yGrid}${prevLine}<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dot}${prevPill}${lastPill}${xAxis}</svg>`;
}

function renderChartsPage(){
  const mkt=currentPortfolio;
  const stocks=[];
  if(mkt==='TW'||mkt==='ALL')stocks.push(...stockData.filter(s=>s.mkt==='TW'));
  if(mkt==='US'||mkt==='ALL')stocks.push(...usStockData);
  const rows=stocks.map(s=>{
    const isUS=s.mkt==='US';
    const {unrealized,unrealPct}=calcUnreal(s,isUS);
    return {s,isUS,unrealized,unrealPct};
  });
  const area=document.getElementById('charts-grid-area');
  if(!area)return;
  const cur=isUS=>isUS?'$':'';
  area.innerHTML=rows.map(r=>{
    const urCls=r.isUS?clsPN(r.unrealPct||0):clsPNmkt(r.unrealPct||0,'TW');
    const urVal=(r.unrealized>=0?'+':'−')+cur(r.isUS)+Math.abs(Math.round(r.unrealized)).toLocaleString();
    return `<div class="charts-card">
      <div class="charts-card-hdr">
        <span class="charts-card-ticker">${r.s.code}</span>
        <span class="charts-card-name">${r.s.name}</span>
      </div>
      <div class="charts-card-chg ${urCls}">${fmtPct(r.unrealPct||0)} <span class="trend-card-urval">${urVal}</span></div>
      <div id="chp-${r.s.code}" class="charts-chart-wrap k-loading">載入中...</div>
    </div>`;
  }).join('');
  drawChartCardsSeq(rows.map(r=>({code:r.s.code,mkt:r.s.mkt,id:'chp-'+r.s.code,isUS:r.isUS})));
}

function setChartsPeriod(p){
  chartsPeriod=p;
  document.querySelectorAll('.charts-pg-hdr .cpt-btn').forEach(b=>b.classList.toggle('on',b.dataset.p===p));
  if(document.getElementById('panel-charts').classList.contains('on'))renderChartsPage();
}

function toggleStockExpand(code,mkt){
  const wasExpanded=expandedStock===code;
  // Remove any existing expand rows and highlights
  document.querySelectorAll('.k-expand-row').forEach(r=>r.remove());
  document.querySelectorAll('.k-row-expanded').forEach(r=>r.classList.remove('k-row-expanded'));
  expandedStock=null;
  if(wasExpanded)return;

  expandedStock=code;
  const triggerRow=document.querySelector(`#hld-body tr[data-code="${code}"]`);
  if(!triggerRow)return;
  triggerRow.classList.add('k-row-expanded');

  const colCount=triggerRow.children.length;
  const isUS=mkt==='US';
  // 未實現損益摘要列
  const stk=(isUS?usStockData:stockData).find(s=>s.code===code);
  let summaryHTML='';
  if(stk){
    const {unrealized,unrealPct}=calcUnreal(stk,isUS);
    const cCur=isUS?'$':'';
    const urCls=isUS?clsPN(unrealPct):clsPNmkt(unrealPct,'TW');
    const urVal=(unrealized>=0?'+':'−')+cCur+Math.abs(Math.round(unrealized)).toLocaleString();
    summaryHTML=`<div class="k-expand-summary">`+
      `<span class="kes-label">未實現損益</span>`+
      `<span class="kes-pl ${urCls}">${fmtPct(unrealPct)} <span class="kes-val">${urVal}</span></span>`+
      `<span class="kes-meta">均價 ${cCur}${fmtAxis(stk.avg)} · 現價 ${cCur}${fmtAxis(stk.price)}</span>`+
      `</div>`;
  }
  const expandRow=document.createElement('tr');
  expandRow.id='k-xrow-'+code;
  expandRow.className='k-expand-row';
  expandRow.innerHTML=`<td colspan="${colCount}"><div class="k-expand-inner">${summaryHTML}<div class="k-charts-grid">`+
    `<div class="k-chart-block"><div class="k-chart-label">即時走勢 <span class="k-chart-range">今日</span></div><div id="ki-${code}" class="trend-chart-wrap k-loading">載入中...</div></div>`+
    `<div class="k-chart-block"><div class="k-chart-label">日K <span class="k-chart-range">近6個月</span></div><div id="kd-${code}" class="k-loading">載入中...</div></div>`+
    `<div class="k-chart-block"><div class="k-chart-label">周K <span class="k-chart-range">近1年</span></div><div id="kw-${code}" class="k-loading">載入中...</div></div>`+
    `</div></div></td>`;
  triggerRow.after(expandRow);

  drawIntradayCard(code,mkt,'ki-'+code,isUS); // 即時走勢優先畫（快取命中時秒開）
  Promise.all([
    ensureStockOHLC(code,mkt,'daily'),
    ensureStockOHLC(code,mkt,'weekly'),
  ]).then(([daily,weekly])=>{
    const hist=stockIndivHistory[code]||[];
    const avg=avgCostOf(code,isUS),last=lastPriceOf(code,isUS);
    renderKPanel('kd-'+code,daily&&daily.length>3?daily:null,hist,'daily',isUS,avg,last);
    renderKPanel('kw-'+code,weekly&&weekly.length>3?weekly:null,hist,'weekly',isUS,avg,last);
  });
}

async function fetchYahooOHLC(sym,interval,range){
  const res=await gas({action:'yahoo_chart',symbol:sym,interval,range});
  if(!res.ok||!res.data?.length)throw new Error('no data');
  return res.data;
}

function renderKPanel(containerId,ohlc,fallbackPts,period,isUS,avg,last){
  const wrap=document.getElementById(containerId);
  if(!wrap)return;
  // Determine canvas height from parent or fallback
  const h=wrap.offsetHeight>20?wrap.offsetHeight:160;
  const cvStyle=`width:100%;height:${h}px;display:block;cursor:default`;
  if(ohlc&&ohlc.length>3){
    wrap.className='';
    wrap.innerHTML=`<canvas style="${cvStyle}"></canvas>`;
    drawCandlestick(wrap.querySelector('canvas'),ohlc,isUS,period,avg,last);
  } else if(fallbackPts&&fallbackPts.length>3){
    wrap.className='';
    wrap.innerHTML=`<canvas style="${cvStyle}"></canvas>`;
    const canvas=wrap.querySelector('canvas');
    let pts=fallbackPts;
    if(period==='weekly'){
      const wkMap={};
      pts.forEach(({d,price})=>{
        const dt=new Date(d);dt.setDate(dt.getDate()-dt.getDay());
        const k=dt.toISOString().slice(0,10);wkMap[k]=price;
      });
      pts=Object.entries(wkMap).sort((a,b)=>a[0].localeCompare(b[0])).map(([d,price])=>({d,price}));
    }
    const cutDate=new Date(Date.now()-(period==='weekly'?365:180)*86400000).toISOString().slice(0,10);
    drawLineK(canvas,pts.filter(p=>p.d>=cutDate),isUS,period,avg,last);
  } else {
    wrap.className='k-error';
    wrap.innerHTML='<span>無法載入行情</span><span>請確認網路連線</span>';
  }
}

// 價格軸標籤格式化（依數量級決定小數位）
function fmtAxis(v){
  const a=Math.abs(v);
  if(a>=1000)return Math.round(v).toLocaleString();
  if(a>=100)return v.toFixed(1);
  if(a>=10)return v.toFixed(2);
  return v.toFixed(2);
}

function drawCandlestick(canvas,data,isUS,period='daily',avg,last){
  // 濾掉異常資料點（0 或缺值，避免出現拉到 0 的怪線）
  data=data.filter(d=>d.o>0&&d.h>0&&d.l>0&&d.c>0);
  if(data.length<2)return;
  const dpr=window.devicePixelRatio||1;
  const W=canvas.offsetWidth||canvas.parentElement?.offsetWidth||300;
  const H=160;
  canvas.width=W*dpr;canvas.height=H*dpr;
  const ctx=canvas.getContext('2d');
  ctx.scale(dpr,dpr);
  const upC=isUS?'#34C759':'#FF3B30', dnC=isUS?'#FF3B30':'#34C759';
  const ml=4,mr=50,mt=13,mb=22,cW=W-ml-mr,cH=H-mt-mb;
  const highs=data.map(d=>d.h),lows=data.map(d=>d.l);
  let maxP=Math.max(...highs),minP=Math.min(...lows);
  if(avg>0){maxP=Math.max(maxP,avg);minP=Math.min(minP,avg);} // 讓均價線一定落在圖內
  if(last>0){maxP=Math.max(maxP,last);minP=Math.min(minP,last);}
  const pRng=maxP-minP||1;
  const toX=i=>ml+(i+0.5)/data.length*cW;
  const toY=p=>mt+(1-(p-minP)/pRng)*cH;
  const cw=Math.max(1,cW/data.length*0.65);
  // Grid lines + Y 軸價格標籤
  ctx.strokeStyle='#E5E5EA';ctx.lineWidth=0.5;
  ctx.fillStyle='#8E8E93';ctx.font='10px -apple-system,sans-serif';ctx.textBaseline='middle';ctx.textAlign='left';
  for(let i=0;i<=3;i++){
    const y=mt+i/3*cH;
    ctx.beginPath();ctx.moveTo(ml,y);ctx.lineTo(ml+cW,y);ctx.stroke();
    ctx.fillText(fmtAxis(maxP-i/3*pRng),ml+cW+5,y);
  }
  // Candles
  data.forEach((d,i)=>{
    const x=toX(i),isUp=d.c>=d.o,col=isUp?upC:dnC;
    ctx.strokeStyle=col;ctx.fillStyle=col;ctx.lineWidth=Math.max(1,cw>4?1.2:0.8);
    // Wick
    ctx.beginPath();ctx.moveTo(x,toY(d.h));ctx.lineTo(x,toY(d.l));ctx.stroke();
    // Body
    const bt=Math.min(toY(d.o),toY(d.c)),bh=Math.max(1,Math.abs(toY(d.o)-toY(d.c)));
    if(isUp){ctx.strokeRect(x-cw/2,bt,cw,bh);}else{ctx.fillRect(x-cw/2,bt,cw,bh);}
  });
  // X 軸日期標籤 — 每月一格（週K圖為每季）；太窄就跳過避免重疊
  ctx.fillStyle='#8E8E93';ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.font='10px -apple-system,sans-serif';
  const isWeeklyChart=period==='weekly';
  const Q=[1,4,7,10]; // quarters
  let prevMo='',lastLX=-99;
  data.forEach((d,i)=>{
    const mo=parseInt(d.d.slice(5,7));
    if(isWeeklyChart&&!Q.includes(mo))return;
    const lbl=mo+'月';
    if(lbl!==prevMo){
      prevMo=lbl;const lx=toX(i);
      if(lx-lastLX>=20){lastLX=lx;ctx.fillText(lbl,lx,H-6);}
    }
  });
  drawHLine(ctx,avg,toY,ml,ml+cW,'#FF9500','均 '+fmtAxis(avg));
  drawHLine(ctx,last,toY,ml,ml+cW,'#007AFF','收 '+fmtAxis(last));
}

// 通用橫虛線 + 右側彩色標籤（pill）：均價=橘、收盤=藍
// 標籤畫在繪圖區右側空白處，不蓋到 K 棒；有底色可覆蓋後面格線數字
function drawHLine(ctx,val,toY,x0,x1,color,label){
  if(!val||val<=0)return;
  const y=toY(val);
  ctx.save();
  ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([4,3]);
  ctx.beginPath();ctx.moveTo(x0,y);ctx.lineTo(x1,y);ctx.stroke();
  ctx.restore();
  ctx.font='8px -apple-system,sans-serif';
  const tw=ctx.measureText(label).width,pad=2,th=11,px=x1+2;
  ctx.fillStyle=color;
  ctx.fillRect(px,y-th/2,tw+pad*2,th);
  ctx.fillStyle='#fff';ctx.textAlign='left';ctx.textBaseline='middle';
  ctx.fillText(label,px+pad,y+0.5);
}

function drawLineK(canvas,pts,isUS,period,avg,last){
  if(!pts||!pts.length)return;
  const dpr=window.devicePixelRatio||1;
  const W=canvas.offsetWidth||canvas.parentElement?.offsetWidth||300;
  const H=160;
  canvas.width=W*dpr;canvas.height=H*dpr;
  const ctx=canvas.getContext('2d');
  ctx.scale(dpr,dpr);
  const ml=4,mr=50,mt=13,mb=22,cW=W-ml-mr,cH=H-mt-mb;
  const prices=pts.map(p=>p.price);
  let mn=Math.min(...prices),mx=Math.max(...prices);
  if(avg>0){mn=Math.min(mn,avg);mx=Math.max(mx,avg);}
  if(last>0){mn=Math.min(mn,last);mx=Math.max(mx,last);}
  const pRng=mx-mn||1;
  const toX=i=>ml+(i/(pts.length-1||1))*cW;
  const toY=p=>mt+(1-(p-mn)/pRng)*cH;
  const trend=prices[prices.length-1]-prices[0];
  const col=isUS?(trend>=0?'#34C759':'#FF3B30'):(trend>=0?'#FF3B30':'#34C759');
  // Grid lines + Y 軸價格標籤
  ctx.strokeStyle='#E5E5EA';ctx.lineWidth=0.5;
  ctx.fillStyle='#8E8E93';ctx.font='10px -apple-system,sans-serif';ctx.textBaseline='middle';ctx.textAlign='left';
  for(let i=0;i<=3;i++){
    const y=mt+i/3*cH;
    ctx.beginPath();ctx.moveTo(ml,y);ctx.lineTo(ml+cW,y);ctx.stroke();
    ctx.fillText(fmtAxis(mx-i/3*pRng),ml+cW+5,y);
  }
  ctx.beginPath();
  pts.forEach(({price},i)=>{i?ctx.lineTo(toX(i),toY(price)):ctx.moveTo(toX(i),toY(price));});
  ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.stroke();
  // X 軸日期標籤
  ctx.fillStyle='#8E8E93';ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.font='10px -apple-system,sans-serif';
  const isWeeklyLine=period==='weekly';
  const Qw=[1,4,7,10];
  let prevMoL='',lastLXl=-99;
  pts.forEach(({d},i)=>{
    const mo=parseInt(d.slice(5,7));
    if(isWeeklyLine&&!Qw.includes(mo))return;
    const lbl=mo+'月';
    if(lbl!==prevMoL){
      prevMoL=lbl;const lx=toX(i);
      if(lx-lastLXl>=20){lastLXl=lx;ctx.fillText(lbl,lx,H-6);}
    }
  });
  drawHLine(ctx,avg,toY,ml,ml+cW,'#FF9500','均 '+fmtAxis(avg));
  drawHLine(ctx,last,toY,ml,ml+cW,'#007AFF','收 '+fmtAxis(last));
}

function renderHoldingsTable(){
  const mkt=currentPortfolio;
  let stocks=[];
  if(mkt==='TW'||mkt==='ALL')stocks.push(...stockData.filter(s=>s.mkt==='TW'));
  if(mkt==='US'||mkt==='ALL')stocks.push(...usStockData);

  const tabCfg=HLD_TABS[holdingsTabMode]||HLD_TABS.today;
  const cols=tabCfg.cols;

  // Render dynamic thead
  const theadRow=document.getElementById('hld-thead-row');
  if(theadRow){
    const arr=c=>c===holdingsSortCol?(holdingsSortDir==='desc'?' ▼':' ▲'):' ⇅';
    theadRow.innerHTML=
      `<th class="l${holdingsSortCol==='name'?' sort-active':''}" data-col="name" onclick="sortHoldings('name')">投資產品<span class="hld-sort-arr">${arr('name')}</span></th>`+
      cols.map(c=>`<th class="r${holdingsSortCol===c.key?' sort-active':''}" data-col="${c.key}" onclick="sortHoldings('${c.key}')">${c.label}<span class="hld-sort-arr">${arr(c.key)}</span></th>`).join('');
  }

  const tbody=document.getElementById('hld-body');
  if(!stocks.length){tbody.innerHTML=`<tr><td colspan="5" class="empty">暫無資料</td></tr>`;return;}

  // Total NAV for 淨清算%
  let totalNAV=0;
  if(mkt==='TW'){totalNAV=latestTWMV>0?latestTWMV:stocks.reduce((s,x)=>s+x.sh*x.price,0);}
  else if(mkt==='US'){totalNAV=(ibNavUSD>0?ibNavUSD:stocks.reduce((s,x)=>s+x.sh*x.price,0))*fxRate;}
  else{totalNAV=stocks.reduce((s,x)=>s+x.sh*x.price*(x.mkt==='US'?fxRate:1),0);}

  // Build row data
  const rows=stocks.map(s=>{
    const isUS=s.mkt==='US';
    // 當日變化用「盤中即時價 vs 同交易日昨收」；Sheet 同步價僅作退回
    const prev=livePrevClose(s.code,isUS);
    const livePrice=liveLastPrice(s.code,s.price);
    const hasPrev=prev&&prev>0;
    const dayChgPct=hasPrev?(livePrice-prev)/prev*100:null;
    const dayChgAmt=hasPrev?(livePrice-prev)*s.sh:null;
    const fees=isUS?0:(tradeFees[s.code]||0);
    const costBasis=s.sheetCost&&s.sheetCost>0?s.sheetCost:(s.avg*s.sh+fees);
    const mv=s.sh*s.price;
    let unrealized;
    if(isUS)unrealized=s.ibPnl!==null?s.ibPnl:mv-s.avg*s.sh;
    else unrealized=s.sheetUnreal!==null?s.sheetUnreal:mv-costBasis;
    const unrealPct=costBasis>0?unrealized/costBasis*100:0;
    const mvNTD=mv*(isUS?fxRate:1);
    const navPct=totalNAV>0?mvNTD/totalNAV*100:0;
    const rng=stockIntradayRange[s.code];
    const amplitude=(rng&&hasPrev)?(rng.h-rng.l)/prev*100:null;
    return {s,isUS,hasPrev,livePrice,dayChgPct,dayChgAmt,costBasis,mv,unrealized,unrealPct,navPct,mvNTD,amplitude};
  });

  const totalCost=rows.reduce((s,r)=>s+r.costBasis*(r.isUS?fxRate:1),0);
  rows.forEach(r=>{r.costPct=totalCost>0?r.costBasis*(r.isUS?fxRate:1)/totalCost*100:0;});

  // Sort
  const dir=holdingsSortDir==='asc'?1:-1;
  const sortMap={
    name:(a,b)=>dir*a.s.code.localeCompare(b.s.code),
    price:(a,b)=>dir*((a.livePrice||a.s.price)-(b.livePrice||b.s.price)),
    dayPct:(a,b)=>dir*((a.dayChgPct??-Infinity)-(b.dayChgPct??-Infinity)),
    dayAmt:(a,b)=>dir*((a.dayChgAmt??-Infinity)-(b.dayChgAmt??-Infinity)),
    avg:(a,b)=>dir*(a.s.avg-b.s.avg),
    unreal:(a,b)=>dir*(a.unrealized-b.unrealized),
    unrealPct:(a,b)=>dir*(a.unrealPct-b.unrealPct),
    mv:(a,b)=>dir*(a.mvNTD-b.mvNTD),
    navPct:(a,b)=>dir*(a.navPct-b.navPct),
    costPct:(a,b)=>dir*(a.costPct-b.costPct),
    amplitude:(a,b)=>dir*((a.amplitude??-Infinity)-(b.amplitude??-Infinity)),
  };
  rows.sort(sortMap[holdingsSortCol]||sortMap.mv);

  // ── TREND MODE: replace table with K-chart / 即時走勢 grid ──
  if(holdingsTabMode==='trend'){
    document.getElementById('hld-thead-row').innerHTML='';
    document.querySelector('.hld-tbl').style.display='none';
    let toolbar=document.getElementById('hld-trend-toolbar');
    if(!toolbar){
      toolbar=document.createElement('div');
      toolbar.id='hld-trend-toolbar';
      toolbar.className='cpt-wrap';
      toolbar.style.margin='0 12px 10px';
      toolbar.innerHTML=`
        <button class="cpt-btn" data-p="intraday" onclick="setTrendPeriod('intraday')">即時</button>
        <button class="cpt-btn" data-p="daily"    onclick="setTrendPeriod('daily')">日K</button>
        <button class="cpt-btn" data-p="weekly"   onclick="setTrendPeriod('weekly')">周K</button>`;
      document.querySelector('.hld-wrap').insertBefore(toolbar,document.querySelector('.hld-wrap').firstChild);
    }
    toolbar.style.display='';
    toolbar.querySelectorAll('.cpt-btn').forEach(b=>b.classList.toggle('on',b.dataset.p===trendPeriod));
    let trendGrid=document.getElementById('hld-trend-grid');
    if(!trendGrid){
      trendGrid=document.createElement('div');
      trendGrid.id='hld-trend-grid';
      document.querySelector('.hld-wrap').appendChild(trendGrid);
    }
    trendGrid.style.display='';
    renderTrendGrid(rows,trendGrid,trendPeriod);
    if(trendPeriod!=='intraday'&&!_intradayFetchDone){_intradayFetchDone=true;fetchAllSparklines();}
    return;
  }
  // Restore table if switching away from trend
  document.querySelector('.hld-tbl').style.display='';
  const _tg=document.getElementById('hld-trend-grid');
  if(_tg)_tg.style.display='none';
  const _ttb=document.getElementById('hld-trend-toolbar');
  if(_ttb)_ttb.style.display='none';

  // Cell renderer per column key
  function cell(key,r){
    const {s,isUS,hasPrev,livePrice,dayChgPct,dayChgAmt,costBasis,mv,unrealized,unrealPct,navPct,costPct,amplitude}=r;
    const cur=isUS?'$':'';const m=isUS?'US':'TW';const pc=v=>clsPNmkt(v,m);
    const sgn=v=>v===null?'--':(v>=0?'+':'-')+cur+Math.abs(Math.round(v)).toLocaleString();
    switch(key){
      case 'price':    return `<td class="r">${(livePrice||s.price).toLocaleString()}</td>`;
      case 'amplitude':return `<td class="r neu">${amplitude!=null?amplitude.toFixed(2)+'%':'--'}</td>`;
      case 'dayPct':   return `<td class="r ${hasPrev?pc(dayChgPct):'neu'}">${hasPrev?fmtPct(dayChgPct):'--'}</td>`;
      case 'dayAmt':   return `<td class="r ${hasPrev?pc(dayChgAmt):'neu'}">${hasPrev?sgn(dayChgAmt):'--'}</td>`;
      case 'avg':      return `<td class="r">${cur}${s.avg.toFixed(2)}</td>`;
      case 'unreal':   return `<td class="r ${pc(unrealized)}">${(unrealized>=0?'+':'-')+cur+Math.abs(Math.round(unrealized)).toLocaleString()}</td>`;
      case 'unrealPct':return `<td class="r ${pc(unrealPct)}">${fmtPct(unrealPct)}</td>`;
      case 'mv':       return `<td class="r">${cur}${Math.round(mv).toLocaleString()}</td>`;
      case 'navPct':   return `<td class="r">${navPct.toFixed(1)}%</td>`;
      case 'costPct':  return `<td class="r">${costPct.toFixed(1)}%</td>`;
      default: return `<td class="r">--</td>`;
    }
  }

  expandedStock=null;
  tbody.innerHTML=rows.map(r=>`<tr class="hld-row" data-code="${r.s.code}" data-mkt="${r.s.mkt}" onclick="toggleStockExpand('${r.s.code}','${r.s.mkt}')">
    <td class="l hld-name-td"><span class="hld-ticker">${r.s.code}</span><span class="hld-sname">${r.s.name}</span>${sparklineSVG(r.s.code,r.isUS)}</td>
    ${cols.map(c=>cell(c.key,r)).join('')}
  </tr>`).join('');

  // Fade in after content update
  tbody.classList.remove('hld-fade');
  void tbody.offsetWidth; // force reflow
  tbody.classList.add('hld-fade');

  // Fetch intraday prices once per portfolio load and update sparklines
  if(!_intradayFetchDone){
    _intradayFetchDone=true;
    fetchAllSparklines();
  }
}

/* ════════════════════════════════════════════
   HOLDINGS SUMMARY CHART (% return)
════════════════════════════════════════════ */
function hsSetPeriod(mode,btn){
  hsPeriodMode=mode;
  document.querySelectorAll('.hs-period').forEach(b=>{
    if(b.id!=='hs-bench-btn')b.classList.remove('on');
  });
  if(btn&&btn.id!=='hs-bench-btn')btn.classList.add('on');
  renderHsSummaryChart();
}

function renderBenchmarkButtons(){
  const area=document.getElementById('hs-bench-area');
  if(!area)return;
  if(currentPortfolio==='US'){
    area.innerHTML=
      `<button class="hs-period${usBenchQQQ?' on':''}" onclick="toggleUSBench('QQQ')">QQQ</button>`+
      `<button class="hs-period${usBenchSPY?' on':''}" onclick="toggleUSBench('SPY')">S&P500</button>`+
      `<button class="hs-period${usBenchNASDAQ?' on':''}" onclick="toggleUSBench('NASDAQ')">NASDAQ</button>`;
  } else {
    area.innerHTML=`<button class="hs-period${showHsBench?' on':''}" id="hs-bench-btn" onclick="toggleHsBench()">＋大盤</button>`;
  }
}

function toggleHsBench(){
  showHsBench=!showHsBench;
  renderBenchmarkButtons();
  renderHsSummaryChart();
}

function toggleUSBench(sym){
  if(sym==='QQQ')usBenchQQQ=!usBenchQQQ;
  else if(sym==='SPY')usBenchSPY=!usBenchSPY;
  else if(sym==='NASDAQ')usBenchNASDAQ=!usBenchNASDAQ;
  renderBenchmarkButtons();
  renderHsSummaryChart();
}

function toggleHsSummary(){
  const body=document.getElementById('hs-body');
  const btn=document.getElementById('hs-toggle');
  const vis=body.style.display!=='none';
  body.style.display=vis?'none':'';
  btn.textContent=vis?'∨':'∧';
}

function renderHsSummaryChart(){
  const mkt=currentPortfolio;
  const now=new Date();

  function cutByPeriod(rows,dateKey){
    const cutoff=new Date(now);
    if(hsPeriodMode==='ALL')return rows;
    if(hsPeriodMode==='YTD')return rows.filter(r=>String(r[dateKey]).startsWith(String(now.getFullYear())));
    if(hsPeriodMode==='1D'){cutoff.setDate(cutoff.getDate()-1);return rows.filter(r=>new Date(r[dateKey])>=cutoff);}
    if(hsPeriodMode==='5D'){cutoff.setDate(cutoff.getDate()-5);return rows.filter(r=>new Date(r[dateKey])>=cutoff);}
    const months={'1M':1,'3M':3,'6M':6,'1Y':12}[hsPeriodMode]||6;
    cutoff.setMonth(cutoff.getMonth()-months);
    return rows.filter(r=>new Date(r[dateKey])>=cutoff);
  }

  let src=[];
  if(mkt==='US'){
    const rows=cutByPeriod(usPortfolio,'d');
    if(!rows.length){clearHsChart();return;}
    // Normalize to period start so portfolio and benchmarks share the same 0% baseline
    const basePct=rows[0].pct;
    src=rows.map(r=>({d:r.d,pct:+(r.pct-basePct).toFixed(4),absVal:r.navUSD||null}));
  } else {
    let rows=twHistoryData.length?twHistoryData:histMonthly.map(r=>({date:r[0],pv:r[1],twii:null}));
    rows=cutByPeriod(rows,'date');
    if(!rows.length){clearHsChart();return;}
    const base=rows[0].pv;
    src=rows.map(r=>({d:r.date,pct:base>0?(r.pv-base)/base*100:0,twii:r.twii,absVal:r.pv||null}));
  }

  const labels=src.map(r=>r.d);
  const vals=src.map(r=>+r.pct.toFixed(3));
  const lastPct=vals[vals.length-1];
  const isPos=lastPct>=0;

  const lineColor=isPos?'#8B7FD4':'#FF3B30';

  const datasets=[{
    label:'投資組合',data:vals,
    borderColor:lineColor,
    backgroundColor:'transparent', // set to gradient by plugin before draw
    fill:true,tension:.35,pointRadius:0,pointHitRadius:12,borderWidth:2,
  }];

  // Benchmark
  const anyUsBench=usBenchQQQ||usBenchSPY||usBenchNASDAQ;
  if(showHsBench||(mkt==='US'&&anyUsBench)){
    if(mkt!=='US'){
      // TW / ALL: show TWII
      const firstTwii=src.find(r=>r.twii)?.twii||null;
      if(firstTwii){
        datasets.push({
          label:'TWII',
          data:src.map(r=>r.twii!=null?+((r.twii-firstTwii)/firstTwii*100).toFixed(3):null),
          borderColor:'#34C759',backgroundColor:'transparent',
          fill:false,tension:.35,pointRadius:0,borderDash:[5,3],borderWidth:1.5,spanGaps:true,
        });
      }
    } else {
      // US: show QQQ and/or SPY individually
      const benchDefs=[
        {sym:'QQQ',   active:usBenchQQQ,    color:'#FF9F0A'},
        {sym:'SPY',   active:usBenchSPY,    color:'#34C759'},
        {sym:'NASDAQ',active:usBenchNASDAQ, color:'#BF5AF2'},
      ];
      // Helper: find nearest benchmark pct within 3-day tolerance
      const nearestPct=(targetD,byDate,sortedDates)=>{
        if(byDate[targetD]!==undefined)return byDate[targetD];
        const t=new Date(targetD).getTime();
        let best=null,bestDiff=Infinity;
        for(const d of sortedDates){
          const diff=Math.abs(new Date(d).getTime()-t);
          if(diff<bestDiff){bestDiff=diff;best=byDate[d];}
          else break; // diff increasing = passed closest point
        }
        return bestDiff<=3*86400000?best:null;
      };
      benchDefs.forEach(({sym,active,color})=>{
        if(!active)return;
        const pts=usBenchmarkHistory[sym];
        if(!pts||!pts.length)return;
        const cut=cutByPeriod(pts,'d');
        if(!cut.length)return;
        const base=cut[0].price;
        const pctByDate={};
        const sortedBenchDates=cut.map(p=>p.d); // already sorted ascending
        cut.forEach(p=>pctByDate[p.d]=+((p.price-base)/base*100).toFixed(3));
        datasets.push({
          label:sym,
          data:labels.map(d=>nearestPct(d,pctByDate,sortedBenchDates)),
          borderColor:color,backgroundColor:'transparent',
          fill:false,tension:.35,pointRadius:0,borderDash:[5,3],borderWidth:1.5,spanGaps:true,
        });
      });
    }
  }

  const fmtAbs=v=>mkt==='US'?'USD '+Math.round(v).toLocaleString():'NT$'+Math.round(v).toLocaleString();
  const baseAbsVal=src[0]?.absVal??null;

  // Info bar DOM refs
  const infoBar=document.getElementById('hs-info-bar');
  const ibDate=document.getElementById('hs-ib-date');
  const ibNav=document.getElementById('hs-ib-nav');
  const ibPnl=document.getElementById('hs-ib-pnl');

  function updateInfoBar(idx){
    if(!infoBar)return;
    const pt=src[idx];
    if(!pt){infoBar.classList.remove('show');return;}
    const raw=labels[idx];
    const dObj=new Date(raw);
    ibDate.textContent=isNaN(dObj)?raw:
      (dObj.getMonth()+1).toString().padStart(2,'0')+'/'+
      dObj.getDate().toString().padStart(2,'0')+'/'+dObj.getFullYear();
    ibNav.textContent=pt.absVal!=null?(hidden?'****':fmtAbs(pt.absVal)):'';
    const v=vals[idx];
    let pnlTxt='';
    if(pt.absVal!=null&&baseAbsVal!=null){
      const diff=pt.absVal-baseAbsVal;
      pnlTxt=(diff>=0?'+':'')+fmtAbs(diff)+' ('+(v>=0?'+':'')+v.toFixed(2)+'%)';
    } else {
      pnlTxt=(v>=0?'+':'')+v.toFixed(2)+'%';
    }
    ibPnl.textContent=hidden?'****':pnlTxt;
    ibPnl.className='hs-ib-pnl '+clsPNmkt(v,mkt);
    infoBar.classList.add('show');
  }

  // 切換期間 / 切換台美股時重置資訊列
  infoBar?.classList.remove('show');

  const canvasCtx=document.getElementById('hsSummaryChart').getContext('2d');
  if(hsSummaryChartInst)hsSummaryChartInst.destroy();
  hsSummaryChartInst=new Chart(canvasCtx,{
    type:'line',data:{labels,datasets},
    options:{
      responsive:true,maintainAspectRatio:false,
      layout:{padding:{top:40,right:0,bottom:4,left:0}},
      plugins:{
        legend:{display:false},
        tooltip:{enabled:false,mode:'index',intersect:false}
      },
      scales:{
        x:{
          grid:{display:false},border:{display:false},
          ticks:{
            color:'#8E8E93',font:{size:11},
            maxTicksLimit:hsPeriodMode==='1M'?10:7,
            callback(v){
              const d=new Date(this.getLabelForValue(v));
              if(isNaN(d))return '';
              if(hsPeriodMode==='1M'){return (d.getMonth()+1)+'/'+(d.getDate());}
              const mon=d.toLocaleDateString('en-US',{month:'short'});
              return d.getMonth()===0?[mon,String(d.getFullYear())]:mon;
            }
          }
        },
        y:{
          position:'right',border:{display:false},
          grid:{color:'rgba(0,0,0,.04)'},
          ticks:{color:'#8E8E93',font:{size:11},callback:v=>v.toFixed(0)+'%'},
          afterFit(scale){scale.width=Math.max(scale.width,72);}
        }
      },
      animation:{duration:500}
    },
    plugins:[{
      id:'gradientFill',
      beforeDraw(chart){
        const {ctx:c,chartArea}=chart;
        if(!chartArea)return;
        const g=c.createLinearGradient(0,chartArea.top,0,chartArea.bottom);
        if(isPos){g.addColorStop(0,'rgba(139,127,212,.22)');g.addColorStop(1,'rgba(139,127,212,0)');}
        else{g.addColorStop(0,'rgba(255,59,48,.18)');g.addColorStop(1,'rgba(255,59,48,0)');}
        chart.data.datasets[0].backgroundColor=g;
      }
    },{
      id:'crosshair',
      afterDraw(chart){
        const ds=chart.data.datasets[0];
        if(!ds||!ds.data.length)return;
        const {ctx:c,chartArea:{top,bottom,left,right}}=chart;
        const PAD=6,BH=20,BH2=34,GAP=3;

        function spreadBadges(badges){
          badges.sort((a,b)=>a.y-b.y);
          for(let i=1;i<badges.length;i++){
            const ph=(badges[i-1].bh||BH),ch=(badges[i].bh||BH);
            const minY=badges[i-1].y+ph/2+GAP+ch/2;
            if(badges[i].y<minY)badges[i].y=minY;
          }
          badges.forEach(b=>{const bh=b.bh||BH;b.y=Math.max(top+bh/2,Math.min(bottom-bh/2,b.y));});
        }

        function drawBadge(x,y,lbl,sub,bc){
          const bh=sub?BH2:BH;
          c.font='bold 11px -apple-system,sans-serif';
          const tw=c.measureText(lbl).width;
          let sw=0;
          if(sub){c.font='10px -apple-system,sans-serif';sw=c.measureText(sub).width;c.font='bold 11px -apple-system,sans-serif';}
          const bw=Math.max(tw,sw)+PAD*2;
          c.fillStyle=bc;c.beginPath();c.roundRect(x,y-bh/2,bw,bh,4);c.fill();
          c.fillStyle='#fff';c.textAlign='left';c.textBaseline='middle';
          if(sub){c.fillText(lbl,x+PAD,y-7);c.font='10px -apple-system,sans-serif';c.fillText(sub,x+PAD,y+7);c.font='bold 11px -apple-system,sans-serif';}
          else{c.fillText(lbl,x+PAD,y);}
        }

        // Zero reference line
        const zeroY=chart.scales.y.getPixelForValue(0);
        if(zeroY>=top&&zeroY<=bottom){
          c.save();c.strokeStyle='rgba(142,142,147,.5)';c.lineWidth=1;c.setLineDash([4,4]);
          c.beginPath();c.moveTo(left,zeroY);c.lineTo(right,zeroY);c.stroke();
          c.setLineDash([]);c.restore();
        }

        c.save();c.font='bold 11px -apple-system,sans-serif';
        const active=chart.tooltip?._active;
        const isHovering=active?.length>0;

        // End-of-line dots + badges (shown when not hovering)
        const lastBadges=[];
        chart.data.datasets.forEach((dset,di)=>{
          const meta=chart.getDatasetMeta(di);
          let lastIdx=-1;
          for(let i=dset.data.length-1;i>=0;i--){if(dset.data[i]!=null){lastIdx=i;break;}}
          if(lastIdx<0)return;
          const lastPt=meta.data[lastIdx],lastV=dset.data[lastIdx];
          if(!lastPt||lastV==null)return;
          const dc=di===0?lineColor:dset.borderColor,dotR=di===0?4:3.5;
          c.fillStyle=dc;c.beginPath();c.arc(lastPt.x,lastPt.y,dotR,0,Math.PI*2);c.fill();
          c.fillStyle='#fff';c.beginPath();c.arc(lastPt.x,lastPt.y,di===0?2:1.5,0,Math.PI*2);c.fill();
          const absV=di===0&&src[lastIdx]?.absVal!=null?fmtAbs(src[lastIdx].absVal):null;
          lastBadges.push({y:lastPt.y,lbl:(lastV>=0?'+':'')+lastV.toFixed(2)+'%',sub:absV,bh:absV?BH2:BH,color:dc});
        });

        if(!isHovering){
          spreadBadges(lastBadges);
          lastBadges.forEach(({y,lbl,sub,color:bc})=>{drawBadge(right+4,y,lbl,sub,bc);});
        }

        if(!active?.length){c.restore();return;}
        const idx=active[0].index;
        const meta0=chart.getDatasetMeta(0);
        const ptX=meta0.data[idx]?.x;
        if(ptX==null){c.restore();return;}

        // Update info bar with date / NAV / P&L vs period start
        updateInfoBar(idx);

        // Vertical crosshair
        c.beginPath();c.moveTo(ptX,top);c.lineTo(ptX,bottom);
        c.lineWidth=1;c.strokeStyle='rgba(100,100,100,.4)';
        c.setLineDash([4,3]);c.stroke();c.setLineDash([]);

        // Date badge at bottom of chart
        const raw=chart.data.labels[idx];
        const dObj=new Date(raw);
        const dateStr=isNaN(dObj)?raw:
          (dObj.getMonth()+1).toString().padStart(2,'0')+'/'+
          dObj.getDate().toString().padStart(2,'0')+'/'+dObj.getFullYear();
        const dtw=c.measureText(dateStr).width,dbw=dtw+PAD*2;
        const dbx=Math.min(Math.max(ptX-dbw/2,left),right-dbw);
        c.fillStyle='#1C1C1E';c.beginPath();c.roundRect(dbx,bottom+4,dbw,BH,4);c.fill();
        c.fillStyle='#fff';c.textAlign='left';c.textBaseline='middle';
        c.fillText(dateStr,dbx+PAD,bottom+4+BH/2);

        // Right-side hover badges (% only)
        const hoverBadges=[];
        chart.data.datasets.forEach((dset,di)=>{
          const meta=chart.getDatasetMeta(di);
          const hv=dset.data[idx];if(hv==null)return;
          const hpt=meta.data[idx];if(!hpt)return;
          hoverBadges.push({y:hpt.y,lbl:(hv>=0?'+':'')+hv.toFixed(2)+'%',sub:null,bh:BH,color:di===0?'#3A3A3C':dset.borderColor});
        });
        spreadBadges(hoverBadges);
        hoverBadges.forEach(({y,lbl,sub,color:bc})=>{drawBadge(right+4,y,lbl,sub,bc);});
        c.restore();
      }
    }]
  });
}

function clearHsChart(){
  const ctx=document.getElementById('hsSummaryChart').getContext('2d');
  if(hsSummaryChartInst)hsSummaryChartInst.destroy();
  hsSummaryChartInst=null;
}


/* ════════════════════════════════════════════
   HISTORY PANEL
════════════════════════════════════════════ */
function initHistory(){
  updateHistoryChart();
}

function setRange(m){
  currentRange=m;
  document.querySelectorAll('#panel-history .sc-btn').forEach(b=>{
    if(['1M','3M','6M','1Y','全部'].some(t=>b.textContent===t))b.classList.remove('on');
  });
  const labels=['1M','3M','6M','1Y','全部'];
  const vals=[1,3,6,12,0];
  const idx=vals.indexOf(m);
  if(idx>=0){
    document.querySelectorAll('#panel-history .sc-btn')[idx].classList.add('on');
  }
  updateHistoryChart();
}

function toggleBenchmark(){
  showBenchmark=!showBenchmark;
  document.getElementById('twii-btn').classList.toggle('on',showBenchmark);
  updateHistoryChart();
}

function updateHistoryChart(){
  const isUS=currentPortfolio==='US';
  document.getElementById('us-nav-wrap').style.display=isUS?'':'none';
  if(isUS){renderUSNavChart();return;}
  const now=new Date();
  let src=twHistoryData.length
    ?twHistoryData.map(r=>({d:r.date,v:r.pv,tw:r.twii}))
    :histMonthly.map(r=>({d:r[0],v:r[1],tw:null}));
  if(currentRange>0){const c=new Date(now);c.setMonth(c.getMonth()-currentRange);src=src.filter(r=>new Date(r.d)>=c);}
  const many=src.length>120;
  const ds=[{
    label:'投資組合 (NT$)',data:src.map(r=>r.v),
    borderColor:'#007AFF',backgroundColor:'rgba(0,122,255,.08)',
    fill:true,tension:.35,pointRadius:many?0:3,borderWidth:2,
  }];
  if(showBenchmark){
    const firstTW=src.find(r=>r.tw!=null)?.tw||null;
    const firstPV=src[0]?.v||1;
    if(firstTW)ds.push({
      label:'TWII（同比）',
      data:src.map(r=>r.tw!=null?Math.round(firstPV*r.tw/firstTW):null),
      borderColor:'#34C759',backgroundColor:'transparent',
      fill:false,tension:.35,pointRadius:0,borderDash:[5,3],borderWidth:1.5,spanGaps:true,
    });
  }
  drawHistChart('lineChart',src.map(r=>r.d),ds,'NT$');
}

function renderUSNavChart(){
  if(!usPortfolio.length)return;
  const now=new Date();
  let rows=usPortfolio;
  if(currentRange>0){const c=new Date(now);c.setMonth(c.getMonth()-currentRange);rows=rows.filter(r=>new Date(r.d)>=c);}
  drawHistChart('usNavChart',rows.map(r=>r.d),[{
    label:'IB NAV (USD)',data:rows.map(r=>r.navUSD||0),
    borderColor:'#34C759',backgroundColor:'rgba(52,199,89,.08)',
    fill:true,tension:.35,pointRadius:3,borderWidth:2,
  }],'$');
}

function drawHistChart(id,labels,datasets,prefix){
  const ctx=document.getElementById(id).getContext('2d');
  if(id==='lineChart'&&lineChartInst)lineChartInst.destroy();
  if(id==='usNavChart'&&usNavChartInst)usNavChartInst.destroy();
  const ch=new Chart(ctx,{
    type:'line',data:{labels,datasets},
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{
        legend:{display:true,labels:{color:'#1C1C1E',font:{size:13,weight:'600'}}},
        tooltip:{
          backgroundColor:'#1C1C1E',titleColor:'#8E8E93',bodyColor:'#fff',padding:12,
          callbacks:{label:c=>`${prefix}${Math.round(c.parsed.y).toLocaleString()}`}
        }
      },
      scales:{
        x:{grid:{display:false},border:{display:false},ticks:{color:'#8E8E93',font:{size:12},maxTicksLimit:8}},
        y:{grid:{color:'rgba(0,0,0,.04)'},border:{display:false},
          ticks:{color:'#8E8E93',font:{size:12},callback:v=>`${prefix}${Math.round(v).toLocaleString()}`}}
      },
      animation:{duration:800}
    }
  });
  if(id==='lineChart')lineChartInst=ch;
  else usNavChartInst=ch;
}

/* ════════════════════════════════════════════
   DIVIDENDS PANEL
════════════════════════════════════════════ */
function renderDividends(){
  const mkt=currentPortfolio;
  let records=[];
  if(mkt!=='US'){
    records=dividendsTW.map(r=>({
      date:r.date,ticker:r.code,name:r.name,amount:r.amount,
      currency:'TWD',type:'Dividends',mkt:'TW',status:r.status
    }));
  }
  loadUSDividends(records);
}

async function loadTWDividends(){
  try{
    const res=await gas({action:'read',sheet:'dividends_tw'});
    if(!res.ok||!res.data?.length)return;
    const hdr=res.data[0].map(h=>String(h).trim());
    const dtI=hdr.indexOf('date'),cdI=hdr.indexOf('code'),nmI=hdr.indexOf('name'),
          shI=hdr.indexOf('shares'),cpsI=hdr.indexOf('cps'),amtI=hdr.indexOf('amount'),
          payI=hdr.indexOf('pay_date'),stI=hdr.indexOf('status');
    dividendsTW=res.data.slice(1).filter(r=>r[0]).map(r=>{
      const code=String(r[cdI]).trim();
      const status=String(r[stI]||'received').trim();
      const cps=+r[cpsI]||0;
      let amount=+r[amtI]||0;
      if(status==='upcoming'&&!amount){
        // 尚未發生：用目前持股數估算金額供顯示參考
        const hold=stockData.find(s=>s.code===code.padStart(4,'0'));
        amount=hold?hold.sh*cps:0;
      }
      return {
        date:String(r[dtI]).slice(0,10),code,name:String(r[nmI]||code).trim(),
        shares:+r[shI]||0,cps,amount,payDate:String(r[payI]||'').slice(0,10),status
      };
    });
    _sc('divtw',dividendsTW);
    if(document.getElementById('panel-dividends').classList.contains('on'))renderDividends();
    renderXirrMetric();
  }catch(e){console.error('loadTWDividends',e);}
}

async function loadUSDividends(twRecs){
  let usDiv=[];
  try{
    const res=await gas({action:'read',sheet:'dividends'});
    if(res.ok&&res.data?.length>1){
      const hdr=res.data[0].map(h=>String(h).trim());
      const mktI=hdr.indexOf('market'),tkI=hdr.indexOf('ticker'),dtI=hdr.indexOf('date'),
            amtI=hdr.indexOf('amount'),tpI=hdr.indexOf('type'),curI=hdr.indexOf('currency'),nmI=hdr.indexOf('name');
      usDiv=res.data.slice(1).filter(r=>r[0]&&(mktI<0||normMkt(r[mktI])==='US')).map(r=>({
        date:String(r[dtI]).slice(0,10),ticker:String(r[tkI]).trim(),
        name:String(r[nmI>=0?nmI:tkI]).trim(),amount:+r[amtI]||0,
        currency:String(r[curI]).trim(),type:String(r[tpI]).trim(),mkt:'US'
      }));
    }
  }catch(_){}
  const mkt=currentPortfolio;
  const all=(mkt==='TW'?twRecs:mkt==='US'?usDiv:[...twRecs,...usDiv]).sort((a,b)=>b.date.localeCompare(a.date));
  renderDivTable(all);
}

function renderDivTable(records){
  const years=[...new Set(records.map(r=>r.date.slice(0,4)))].sort((a,b)=>b-a);
  const wrap=document.getElementById('div-year-wrap');
  wrap.innerHTML=years.map(y=>`<button class="sc-btn${y===divYearFilter?' on':''}" onclick="divYearFilter='${y}';renderDividends()">${y}</button>`).join('')
    +`<button class="sc-btn${divOnlyReceived?' on':''}" onclick="divOnlyReceived=!divOnlyReceived;localStorage.setItem('divOnlyRcv',divOnlyReceived?'1':'0');renderDividends()" title="開啟後合計與列表只計入已除息的股利，排除已公告未除息的">已入袋</button>`;
  let filtered=records.filter(r=>r.date.startsWith(divYearFilter));
  if(divOnlyReceived)filtered=filtered.filter(r=>r.status!=='upcoming');
  const total=filtered.reduce((s,r)=>s+Math.abs(r.amount)*(r.currency==='TWD'?1:fxRate),0);
  const body=document.getElementById('div-body');
  if(!filtered.length){
    body.innerHTML=`<div style="text-align:center;padding:40px;color:#8E8E93;font-size:.9rem">${divYearFilter} 年無紀錄</div>`;
    return;
  }
  const sumHtml=`<div class="div-sum">💰 ${divYearFilter} 年股利合計${divOnlyReceived?'（已入袋）':''}：NT$${Math.round(total).toLocaleString()}</div>`;
  body.innerHTML=sumHtml+filtered.map(r=>{
    const isDividend=r.type==='Dividends';
    const cur=r.currency==='TWD'?'NT$':'$';
    const dateStr=String(r.date).slice(0,10).replace(/-/g,'/');
    const nameHtml=r.name&&r.name!==r.ticker?`<span class="d-name">${r.name}</span>`:'';
    const isUpcoming=r.status==='upcoming';
    const badgeCls=isUpcoming?'upcoming':(isDividend?'div':'wht');
    const badgeTxt=isUpcoming?'已公告':(isDividend?'現金股利':'預扣稅');
    return `<div class="d-card ${isDividend?'div-type':'wht-type'}">
  <div class="d-card-inner">
    <div class="d-row1">
      <div class="d-row1-left">
        <span class="dbadge ${badgeCls}">${badgeTxt}</span>
        <span class="d-ticker">${r.ticker}</span>
        ${nameHtml}
      </div>
      <span class="d-date">${dateStr}</span>
    </div>
    <div class="d-row2">
      <span class="d-cur">${r.currency}</span>
      <span class="d-amt ${r.amount>=0?'pos':'neg'}">${cur}${Math.abs(r.amount).toLocaleString()}</span>
    </div>
  </div>
</div>`;
  }).join('');
}

/* ════════════════════════════════════════════
   LENDING PANEL
════════════════════════════════════════════ */
async function renderLending(){
  const mc=document.getElementById('lending-metrics');
  const tbl=document.getElementById('lending-table');
  mc.innerHTML='<div class="skel" style="height:70px;width:120px"></div>';
  try{
    const res=await gas({action:'read',sheet:'lending'});
    if(!res.ok||!res.data?.length){mc.innerHTML='<div class="empty">暫無借券資料</div>';return;}
    const hdr=res.data[0].map(h=>String(h).trim());
    const rows=res.data.slice(1).filter(r=>r[0]);
    const incI=hdr.indexOf('income');
    const totalIncome=rows.reduce((s,r)=>s+(+r[incI]||0),0);
    mc.innerHTML=`
      <div class="mm"><label>借券總收益</label><div class="val pos">NT$${Math.round(totalIncome).toLocaleString()}</div></div>
      <div class="mm"><label>借券筆數</label><div class="val">${rows.length}</div></div>`;
    tbl.innerHTML=`<table class="hl-table" style="width:100%">
      <thead><tr>${hdr.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
  }catch(_){mc.innerHTML='<div class="empty" style="color:#FF3B30">讀取失敗</div>';}
}

/* ════════════════════════════════════════════
   TRADE PANEL
════════════════════════════════════════════ */
function setTradeFilter(f,btn){
  tradeFilter=f;
  document.querySelectorAll('.tf').forEach(b=>b.classList.remove('on'));
  if(btn)btn.classList.add('on');
  renderTrades();
}

async function renderTrades(){
  const list=document.getElementById('trade-list');
  let trades=[];
  if(tradeFilter!=='TW')trades.push(...usTradesData);
  if(tradeFilter!=='US'){
    if(!allTrades.length)await calcTradeFees();
    trades.push(...allTrades);
  }
  trades.sort((a,b)=>b.date.localeCompare(a.date));
  if(tradeFilter==='BUY')trades=trades.filter(t=>t.side==='BUY');
  if(tradeFilter==='SELL')trades=trades.filter(t=>t.side==='SELL');
  if(!trades.length){list.innerHTML='<div class="empty">暫無交易紀錄</div>';return;}
  list.innerHTML=trades.slice(0,100).map(t=>{
    const isUS=t.mkt==='US';
    const isBuy=t.side==='BUY';
    const amt=t.qty*t.price;
    const cur=isUS?'$':'NT$';
    const fmt=n=>n.toLocaleString();
    const dateStr=String(t.date).slice(0,10).replace(/-/g,'/');
    const feeHtml=t.fee?`<div class="t-row3"><span class="t-fee">手續費 ${cur}${fmt(t.fee)}</span></div>`:'';
    return `<div class="t-card ${isBuy?'buy':'sell'}">
  <div class="t-card-inner">
    <div class="t-row1">
      <div class="t-row1-left">
        <span class="t-badge ${isBuy?'buy':'sell'}">${isBuy?'買入':'賣出'}</span>
        <span class="t-ticker">${t.ticker||t.code||'--'}</span>
        <span class="t-mkt">${isUS?'US':'TW'}</span>
      </div>
      <span class="t-date">${dateStr}</span>
    </div>
    <div class="t-row2">
      <span class="t-desc">${fmt(t.qty||0)} 股 × ${cur}${fmt(t.price||0)}</span>
      <span class="t-total ${isBuy?'buy':'sell'}">${cur}${fmt(Math.round(amt))}</span>
    </div>
    ${feeHtml}
  </div>
</div>`;
  }).join('');
}

/* BOOT */
renderOverview();

/* ════ SWIPE 手勢 ════
   總覽頁：左右滑 → 切換台股 / 美股
   其他頁：左右滑 → 切換分頁（防呆：距離 100px、角度 2.5x、速度 380ms、冷卻 400ms）
═══════════════════════════════════════════ */
(()=>{
  let tx=0,ty=0,tt=0,cooldown=false;
  const SKIP_SCROLL='.hld-wrap,.hs-chart-wrap';
  document.addEventListener('touchstart',e=>{
    tx=e.touches[0].clientX;ty=e.touches[0].clientY;tt=Date.now();
  },{passive:true});
  document.addEventListener('touchend',e=>{
    if(cooldown)return;
    if(e.target.closest(SKIP_SCROLL))return;
    const dx=e.changedTouches[0].clientX-tx;
    const dy=e.changedTouches[0].clientY-ty;
    const dt=Date.now()-tt;
    if(Math.abs(dx)<100)return;
    if(Math.abs(dx)<Math.abs(dy)*2.5)return;
    if(dt>380)return;
    cooldown=true;
    const onOverview=document.getElementById('panel-overview')?.classList.contains('on');
    if(onOverview){
      // 總覽頁：切換台股 / 美股
      setPortfolio(dx<0?'US':'TW');
    } else {
      // 其他頁：切換 Tab
      const cur=PANEL_ORDER.find(p=>document.getElementById('panel-'+p)?.classList.contains('on'))||'overview';
      const ci=PANEL_ORDER.indexOf(cur);
      const ni=dx<0?Math.min(ci+1,PANEL_ORDER.length-1):Math.max(ci-1,0);
      if(ni!==ci)sw(PANEL_ORDER[ni]);
    }
    setTimeout(()=>cooldown=false,400);
  },{passive:true});
})();

/* ════ SCROLL: 回到頂部按鈕 ════ */
window.addEventListener('scroll',()=>{
  const btn=document.getElementById('back-top');
  if(btn)btn.classList.toggle('show',window.scrollY>300);
},{passive:true});
