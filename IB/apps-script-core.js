// ═══════════════════════════════════════════════════════════════
// apps-script-core.js  ·  投資日記 GAS 核心  v6.1
// 包含：IB美股、台股價格、股利、觸發器、API端點
// ═══════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// IB Flex Query
// ════════════════════════════════════════════════════════════════
function setIBCredentials() {
  // ★ 安全鎖：防止誤跑蓋掉 Token
  throw new Error('請直接在專案設定 → 指令碼屬性修改，不要執行這個函式！');
}

function checkIBToken() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('IB_TOKEN');
  var queryId = props.getProperty('IB_QUERY_ID');
  Logger.log('IB_TOKEN: ' + (token ? token.substring(0,10)+'...' : '❌ 未設定'));
  Logger.log('IB_QUERY_ID: ' + (queryId || '❌ 未設定'));
}

// ════════════════════════════════════════════════════════════════
// Telegram 通知
// 指令碼屬性需設定：TELEGRAM_BOT_TOKEN、TELEGRAM_CHAT_ID
// ════════════════════════════════════════════════════════════════
function setTelegramCredentials() {
  // ★ 安全鎖：請直接在「專案設定 → 指令碼屬性」手動填入，不要執行這個函式
  throw new Error('請直接在專案設定 → 指令碼屬性修改，不要執行這個函式！');
}

function sendTelegram(msg) {
  var props  = PropertiesService.getScriptProperties();
  var token  = props.getProperty('TELEGRAM_BOT_TOKEN');
  var chatId = props.getProperty('TELEGRAM_CHAT_ID');
  if (!token || !chatId) { Logger.log('[Telegram] Token/ChatId 未設定，略過'); return; }
  try {
    UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({chat_id: chatId, text: msg}),
      muteHttpExceptions: true
    });
  } catch(e) {
    Logger.log('[Telegram] 發送失敗：' + e);
  }
}

function fetchIBData(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('IB_TOKEN');
  var queryId = props.getProperty('IB_QUERY_ID');
  if (!token || !queryId) return {ok:false, error:'IB Token 未設定'};

  try {
    var step1Url = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?v=3&t='+token+'&q='+queryId;
    Logger.log('fetchIBData Step1 請求中...');
    var resp1 = UrlFetchApp.fetch(step1Url, {muteHttpExceptions:true});
    var rawText1 = resp1.getContentText();
    Logger.log('Step1 HTTP: ' + resp1.getResponseCode());
    Logger.log('Step1 回應: ' + rawText1.substring(0, 300));
    var xml1 = XmlService.parse(rawText1);
    var root1 = xml1.getRootElement();
    var status = root1.getChildText('Status');
    Logger.log('Step1 Status: ' + status);
    if (status !== 'Success') {
      var errMsg = root1.getChildText('ErrorMessage') || rawText1.substring(0, 200);
      Logger.log('Step1 失敗: ' + errMsg);
      return {ok:false, error:'IB Step1 失敗: ' + errMsg};
    }
    var refCode  = root1.getChildText('ReferenceCode');
    var step2Base = root1.getChildText('Url') || 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';
    step2Base = step2Base.replace('gdcdyn.interactivebrokers.com', 'ndcdyn.interactivebrokers.com');
    Logger.log('Step1 成功，ReferenceCode: ' + refCode + '，Step2 URL: ' + step2Base);

    var xmlText2 = '';
    for (var attempt = 0; attempt < 10; attempt++) {
      Utilities.sleep(5000);
      var step2Url = step2Base + '?v=3&t=' + token + '&q=' + refCode;
      var resp2 = UrlFetchApp.fetch(step2Url, {muteHttpExceptions:true});
      xmlText2 = resp2.getContentText();
      if (xmlText2.indexOf('<FlexQueryResponse') >= 0 || (xmlText2.indexOf('1019') < 0 && xmlText2.length > 100)) break;
      Logger.log('fetchIBData 嘗試 '+(attempt+1)+': 還在產生中...');
    }
    var xml2 = XmlService.parse(xmlText2);
    var flex = xml2.getRootElement();
    var periodMatch2 = xmlText2.match(/fromDate="(\d+)"\s+toDate="(\d+)"\s+period="([^"]+)"/);
    if (periodMatch2) Logger.log('[IB] 查詢期間: ' + periodMatch2[1] + ' ~ ' + periodMatch2[2] + ' (' + periodMatch2[3] + ')');

    var positions = [];
    var posNodes = flex.getDescendants().filter(function(node) {
      return node.getType() === XmlService.ContentTypes.ELEMENT && node.asElement().getName() === 'OpenPosition';
    });
    posNodes.forEach(function(node) {
      var el = node.asElement();
      var qty = parseFloat(el.getAttribute('position') ? el.getAttribute('position').getValue() : '0');
      if (qty === 0) return;
      positions.push({
        ticker:   el.getAttribute('symbol')       ? el.getAttribute('symbol').getValue()       : '',
        name:     el.getAttribute('description')  ? el.getAttribute('description').getValue()  : '',
        shares:   qty,
        avg_cost: parseFloat(el.getAttribute('costBasisPrice') ? el.getAttribute('costBasisPrice').getValue() : '0'),
        price:    parseFloat(el.getAttribute('markPrice')      ? el.getAttribute('markPrice').getValue()      : '0'),
        currency: el.getAttribute('currency')     ? el.getAttribute('currency').getValue()     : 'USD',
        pnl:      parseFloat(el.getAttribute('fifoPnlUnrealized') ? el.getAttribute('fifoPnlUnrealized').getValue() : '0')
      });
    });

    var trades = [];
    var tradeNodes = flex.getDescendants().filter(function(node) {
      return node.getType() === XmlService.ContentTypes.ELEMENT && node.asElement().getName() === 'Trade';
    });
    tradeNodes.forEach(function(node) {
      var el = node.asElement();
      var buySell = el.getAttribute('buySell') ? el.getAttribute('buySell').getValue() : '';
      if (buySell !== 'BUY' && buySell !== 'SELL') return;
      var trCurrency = el.getAttribute('currency') ? el.getAttribute('currency').getValue() : '';
      if (trCurrency !== '' && trCurrency !== 'USD') return;
      trades.push({
        date:     el.getAttribute('tradeDate')   ? el.getAttribute('tradeDate').getValue().slice(0,8)   : '',
        ticker:   el.getAttribute('symbol')      ? el.getAttribute('symbol').getValue()                 : '',
        name:     el.getAttribute('description') ? el.getAttribute('description').getValue()            : '',
        side:     buySell,
        qty:      Math.abs(parseFloat(el.getAttribute('quantity')    ? el.getAttribute('quantity').getValue()    : '0')),
        price:    parseFloat(el.getAttribute('tradePrice')   ? el.getAttribute('tradePrice').getValue()   : '0'),
        fee:      Math.abs(parseFloat(el.getAttribute('ibCommission') ? el.getAttribute('ibCommission').getValue() : '0')),
        currency: el.getAttribute('currency')    ? el.getAttribute('currency').getValue()               : 'USD'
      });
    });
    Logger.log('XML 解析：找到 ' + trades.length + ' 筆原始交易（去重前）');

    var endingCashUSD = 0;
    var cashNodes = flex.getDescendants().filter(function(node) {
      return node.getType() === XmlService.ContentTypes.ELEMENT && node.asElement().getName() === 'CashReportCurrency';
    });
    var maxAbsEC = 0;
    cashNodes.forEach(function(node) {
      var el = node.asElement(); var attrs = el.getAttributes(); var attrMap = {};
      attrs.forEach(function(a){ attrMap[a.getName()] = a.getValue(); });
      var ec = parseFloat(attrMap['endingCash'] || '0');
      if (!isNaN(ec) && Math.abs(ec) > Math.abs(maxAbsEC)) maxAbsEC = ec;
    });
    endingCashUSD = maxAbsEC;

    var dividends = [];
    var cashTxNodes = flex.getDescendants().filter(function(node) {
      return node.getType() === XmlService.ContentTypes.ELEMENT && node.asElement().getName() === 'CashTransaction';
    });
    cashTxNodes.forEach(function(node) {
      var el = node.asElement(); var attrs = el.getAttributes(); var attrMap = {};
      attrs.forEach(function(a){ attrMap[a.getName()] = a.getValue(); });
      var type = attrMap['type'] || '';
      if (type !== 'Dividends' && type !== 'Withholding Tax') return;
      var dateRaw = attrMap['dateTime'] || attrMap['date'] || '';
      var date = dateRaw.length >= 8 ? dateRaw.slice(0,4)+'-'+dateRaw.slice(4,6)+'-'+dateRaw.slice(6,8) : dateRaw.slice(0,10);
      var amount = parseFloat(attrMap['amount'] || '0');
      if (!attrMap['symbol'] || isNaN(amount) || amount === 0) return;
      dividends.push({ ticker: attrMap['symbol']||'', name: attrMap['description']||'', date: date, currency: attrMap['currency']||'USD', amount: amount, type: type, exDate: (attrMap['exDate']||'').slice(0,10) });
    });

    _updateUSHoldings(ss, positions);
    _saveIBCash(ss, endingCashUSD);
    var newTrades = _appendUSTrades(ss, trades);
    var newDivs   = _appendUSDividends(ss, dividends);
    _saveTimestamp(ss, 'us_synced_at');

    Logger.log('fetchIBData 完成：持倉 '+positions.length+' 筆，新交易 '+newTrades+' 筆，股息 '+newDivs+' 筆');
    return {ok:true, positions:positions.length, newTrades:newTrades, newDividends:newDivs, cash:endingCashUSD};
  } catch(e) {
    Logger.log('fetchIBData 錯誤：'+e);
    return {ok:false, error:e.toString()};
  }
}

function _saveIBCash(ss, cashUSD) {
  var sheet = ss.getSheetByName('config');
  if (!sheet) sheet = ss.insertSheet('config');
  var data = sheet.getDataRange().getValues();
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  var updates = {'ib_cash_usd': cashUSD};
  Object.keys(updates).forEach(function(key) {
    var found = false;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]).trim() === key) {
        sheet.getRange(i+1, 2).setValue(updates[key]);
        sheet.getRange(i+1, 3).setValue(today);
        found = true; break;
      }
    }
    if (!found) { sheet.appendRow([key, updates[key], today]); data.push([key, updates[key], today]); }
  });
}

function _saveTimestamp(ss, key) {
  var sheet = ss.getSheetByName('config');
  if (!sheet) sheet = ss.insertSheet('config');
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  var data = sheet.getDataRange().getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i+1, 2).setValue(now);
      sheet.getRange(i+1, 3).setValue('');
      return;
    }
  }
  sheet.appendRow([key, now, '']);
}

function _updateUSHoldings(ss, positions) {
  var sheet = ss.getSheetByName('holdings_us');
  if (!sheet) return;
  var data = sheet.getDataRange().getValues();
  var hdr = data[0].map(function(h){ return String(h).trim(); });
  var ibPnlCol = hdr.indexOf('ib_pnl');
  if (ibPnlCol < 0) { hdr.push('ib_pnl'); ibPnlCol = hdr.length - 1; data[0] = hdr; data.slice(1).forEach(function(row){ while(row.length<hdr.length) row.push(''); }); }
  var tiCol=hdr.indexOf('ticker'), mktCol=hdr.indexOf('market'), shCol=hdr.indexOf('shares'), avCol=hdr.indexOf('avg_cost'), prCol=hdr.indexOf('current_price'), nmCol=hdr.indexOf('name');
  var usRows = {};
  data.slice(1).forEach(function(row, i) { if (String(row[mktCol]).trim() === 'US') usRows[String(row[tiCol]).trim()] = i+1; });
  positions.forEach(function(p) {
    if (usRows[p.ticker] !== undefined) {
      var ri = usRows[p.ticker]; while(data[ri].length<hdr.length) data[ri].push('');
      data[ri][shCol]=p.shares; data[ri][avCol]=p.avg_cost; data[ri][prCol]=p.price; data[ri][nmCol]=p.name; data[ri][ibPnlCol]=p.pnl;
    } else {
      var newRow = new Array(hdr.length).fill('');
      newRow[tiCol]=p.ticker; newRow[mktCol]='US'; newRow[shCol]=p.shares; newRow[avCol]=p.avg_cost; newRow[prCol]=p.price; newRow[nmCol]=p.name; newRow[ibPnlCol]=p.pnl;
      data.push(newRow);
    }
  });
  var activeTickers = {}; positions.forEach(function(p){ activeTickers[p.ticker]=true; });
  var filtered = [data[0]].concat(data.slice(1).filter(function(row) {
    while(row.length<hdr.length) row.push('');
    if (String(row[mktCol]).trim() !== 'US') return false;
    return activeTickers[String(row[tiCol]).trim()];
  }));
  sheet.clearContents();
  sheet.getRange(1,1,filtered.length,filtered[0].length).setValues(filtered);
}

function _appendUSDividends(ss, dividends) {
  if (!dividends || !dividends.length) return 0;
  var sheet = ss.getSheetByName('dividends');
  if (!sheet) { sheet = ss.insertSheet('dividends'); sheet.getRange(1,1,1,8).setValues([['market','ticker','name','date','ex_date','currency','amount','type']]).setFontWeight('bold'); }
  var data = sheet.getDataRange().getValues();
  var hdr = data[0].map(function(h){ return String(h).trim(); });
  var tkCol=hdr.indexOf('ticker'), dtCol=hdr.indexOf('date'), tpCol=hdr.indexOf('type');
  var existKeys = new Set();
  data.slice(1).forEach(function(row) {
    var dk = _toISODate(row[dtCol]);
    existKeys.add(String(row[tkCol])+'|'+dk+'|'+String(row[tpCol]));
  });
  var added = 0;
  dividends.forEach(function(d) {
    var key = d.ticker+'|'+d.date+'|'+d.type;
    if (existKeys.has(key)) return;
    sheet.appendRow(['US', d.ticker, d.name, d.date, d.exDate, d.currency, d.amount, d.type]);
    existKeys.add(key); added++;
  });
  return added;
}

function cleanNavSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('us_nav');
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('us_nav 為空'); return; }
  var data = sheet.getDataRange().getValues();
  var hdr  = data[0];
  var dtCol = hdr.map(function(h){return String(h).trim();}).indexOf('date');
  var kept = [hdr];
  var removed = 0;
  data.slice(1).forEach(function(row) {
    var iso = _toISODate(row[dtCol]);
    var yr  = parseInt(iso.slice(0,4), 10);
    if (isNaN(yr) || yr < 2020) { removed++; return; }
    row[dtCol] = iso;
    kept.push(row);
  });
  kept.sort(function(a,b){
    if (a === hdr) return -1;
    if (b === hdr) return 1;
    return String(b[dtCol]).localeCompare(String(a[dtCol]));
  });
  sheet.clearContents();
  sheet.getRange(1,1,kept.length,kept[0].length).setValues(kept);
  Logger.log('cleanNavSheet 完成：移除 '+removed+' 筆錯誤年份，保留 '+(kept.length-1)+' 筆');
}

function cleanTradesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('us_trades');
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('us_trades 為空'); return; }
  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(function(h){return String(h).trim();});
  var dtCol=hdr.indexOf('date'), tkCol=hdr.indexOf('ticker')>=0?hdr.indexOf('ticker'):hdr.indexOf('code');
  var sdCol=hdr.indexOf('side'), qtCol=hdr.indexOf('qty'), feCol=hdr.indexOf('fee');
  var nmCol=hdr.indexOf('name');

  function normSide(s) {
    var u = String(s).trim().toUpperCase();
    if (u==='買') return 'BUY';
    if (u==='賣') return 'SELL';
    if (u==='BUY' || u==='SELL') return u;
    return u;
  }

  data.slice(1).forEach(function(row) { row[sdCol] = normSide(row[sdCol]); });

  var groups = {};
  data.slice(1).forEach(function(row) {
    var d   = _toISODate(row[dtCol]);
    row[dtCol] = d;
    var fee = feCol>=0 ? Math.round(Math.abs(parseFloat(row[feCol]||0))*100) : 0;
    var key = d+'|'+String(row[tkCol]).trim()+'|'+normSide(row[sdCol])+'|'+String(row[qtCol])+'|'+fee;
    if (!groups[key]) {
      groups[key] = row;
    } else {
      var hasName = nmCol>=0 && String(row[nmCol]).trim() !== '';
      var existHasName = nmCol>=0 && String(groups[key][nmCol]).trim() !== '';
      if (hasName && !existHasName) groups[key] = row;
    }
  });

  var kept = [data[0]];
  Object.keys(groups).forEach(function(k){ kept.push(groups[k]); });
  var removed = data.length - 1 - (kept.length - 1);

  kept.sort(function(a,b){
    if (a === data[0]) return -1;
    if (b === data[0]) return 1;
    return String(b[dtCol]).localeCompare(String(a[dtCol]));
  });
  sheet.clearContents();
  sheet.getRange(1,1,kept.length,kept[0].length).setValues(kept);
  Logger.log('cleanTradesSheet 完成：移除 '+removed+' 筆重複，保留 '+(kept.length-1)+' 筆');
}

function cleanDividendsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('dividends');
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('dividends sheet 為空，無需清理'); return; }
  var data = sheet.getDataRange().getValues();
  var hdr = data[0].map(function(h){ return String(h).trim(); });
  var tkCol=hdr.indexOf('ticker'), dtCol=hdr.indexOf('date'), tpCol=hdr.indexOf('type');
  var seen = {};
  var kept = [hdr];
  var removed = 0;
  data.slice(1).forEach(function(row) {
    var dk = _toISODate(row[dtCol]);
    var key = String(row[tkCol])+'|'+dk+'|'+String(row[tpCol]);
    if (seen[key]) { removed++; return; }
    seen[key] = true;
    kept.push(row);
  });
  sheet.clearContents();
  sheet.getRange(1, 1, kept.length, kept[0].length).setValues(kept);
  Logger.log('dividends 清理完成：移除 ' + removed + ' 筆重複，保留 ' + (kept.length-1) + ' 筆');
}

function _readUSDividends(ss) {
  var sheet = ss.getSheetByName('dividends');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var hdr = data[0].map(function(h){ return String(h).trim(); });
  var mktCol=hdr.indexOf('market'), tkCol=hdr.indexOf('ticker'), nmCol=hdr.indexOf('name'),
      dtCol=hdr.indexOf('date'), exCol=hdr.indexOf('ex_date'), curCol=hdr.indexOf('currency'),
      amtCol=hdr.indexOf('amount'), tpCol=hdr.indexOf('type');
  var result = [];
  data.slice(1).forEach(function(row) {
    if (String(row[mktCol]).trim() !== 'US') return;
    result.push({ market:'US', ticker:String(row[tkCol]).trim(), name:String(row[nmCol]).trim(), date:_toISODate(row[dtCol]), ex_date:_toISODate(row[exCol]||''), currency:String(row[curCol]).trim(), amount:+row[amtCol]||0, type:String(row[tpCol]).trim() });
  });
  return result;
}

function _readUSNav(ss) {
  var sheet = ss.getSheetByName('us_nav');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data = sheet.getDataRange().getValues();
  var hdr  = data[0].map(String);
  var dtCol = hdr.indexOf('date');
  var ibCol = hdr.indexOf('ib_nav_usd');
  var eqCol = hdr.indexOf('equity_usd');
  if (ibCol < 0 && eqCol < 0) { ibCol = -1; eqCol = hdr.indexOf('nav_usd'); if (eqCol < 0) eqCol = 1; }
  if (dtCol < 0) dtCol = 0;
  return data.slice(1).map(function(r) {
    var d   = r[dtCol] instanceof Date ? Utilities.formatDate(r[dtCol],'Asia/Taipei','yyyy-MM-dd') : String(r[dtCol]).slice(0,10);
    var ibv = ibCol >= 0 ? (+r[ibCol]||0) : 0;
    var eqv = eqCol >= 0 ? (+r[eqCol]||0) : 0;
    return [d, ibv > 0 ? ibv : eqv];
  }).filter(function(r){ return r[0] && r[1] > 0; });
}

function _appendUSTrades(ss, trades) {
  if (!trades || !trades.length) return 0;
  var sheet = ss.getSheetByName('us_trades');
  if (!sheet) {
    sheet = ss.insertSheet('us_trades');
    sheet.getRange(1,1,1,10).setValues([['date','ticker','name','side','qty','price','fee','currency','market','note']]).setFontWeight('bold');
  }
  var data = sheet.getDataRange().getValues();
  var hdr = data[0].map(function(h){ return String(h).trim(); });
  var dtCol = hdr.indexOf('date');
  var tkCol = hdr.indexOf('ticker') >= 0 ? hdr.indexOf('ticker') : hdr.indexOf('code');
  var sdCol = hdr.indexOf('side'), qtCol = hdr.indexOf('qty');

  function normSide(s) {
    var u = String(s).trim().toUpperCase();
    if (u === '買') return 'BUY';
    if (u === '賣') return 'SELL';
    if (u === 'BUY' || u === 'SELL') return u;
    return u;
  }

  var feCol2 = hdr.indexOf('fee');
  var existKeys = new Set();
  data.slice(1).forEach(function(row) {
    var d    = _toISODate(row[dtCol]);
    var tk   = String(row[tkCol]);
    var side = normSide(String(row[sdCol]));
    var qty  = String(row[qtCol]);
    var fee  = feCol2 >= 0 ? Math.round(Math.abs(parseFloat(row[feCol2]||0))*100) : 0;
    existKeys.add(d+'|'+tk+'|'+side+'|'+qty+'|'+fee);
  });

  var added = 0;
  trades.forEach(function(t) {
    var date    = t.date.length===8 ? t.date.slice(0,4)+'-'+t.date.slice(4,6)+'-'+t.date.slice(6,8) : t.date;
    var side    = normSide(t.side);
    var feeRnd  = Math.round(Math.abs(t.fee||0)*100);
    var exactKey = date+'|'+t.ticker+'|'+side+'|'+t.qty+'|'+feeRnd;
    if (existKeys.has(exactKey)) return;
    var newRow = new Array(hdr.length).fill('');
    newRow[dtCol]  = date;
    newRow[tkCol]  = t.ticker;
    if (hdr.indexOf('name')>=0)     newRow[hdr.indexOf('name')]     = t.name;
    newRow[sdCol]  = side;
    newRow[qtCol]  = t.qty;
    if (hdr.indexOf('price')>=0)    newRow[hdr.indexOf('price')]    = t.price;
    if (hdr.indexOf('fee')>=0)      newRow[hdr.indexOf('fee')]      = t.fee;
    if (hdr.indexOf('currency')>=0) newRow[hdr.indexOf('currency')] = t.currency || 'USD';
    if (hdr.indexOf('market')>=0)   newRow[hdr.indexOf('market')]   = 'US';
    sheet.appendRow(newRow);
    existKeys.add(exactKey);
    added++;
  });
  if (added > 0 && sheet.getLastRow() > 2) {
    sheet.getRange(2, 1, sheet.getLastRow()-1, hdr.length)
         .sort({column: dtCol+1, ascending: false});
  }
  return added;
}

// ════════════════════════════════════════════════════════════════
// 動態匯率
// ════════════════════════════════════════════════════════════════
function getFxRate() {
  try {
    var url = 'https://rate.bot.com.tw/xrt/flcsv/0/day';
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
    var csv = resp.getContentText('UTF-8');
    var lines = csv.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var cols = lines[i].split(',');
      if (cols[0] && cols[0].trim() === 'USD') {
        var rate = parseFloat(cols[3]);
        if (!isNaN(rate) && rate > 0) return {ok:true, rate:rate, source:'台灣銀行'};
      }
    }
    return {ok:true, rate:32.5, source:'預設值'};
  } catch(e) { return {ok:true, rate:32.5, source:'預設值（API失敗）'}; }
}

// ════════════════════════════════════════════════════════════════
// 52週高低點
// ════════════════════════════════════════════════════════════════
function get52WeekHighLow(codes, market) {
  var result = {};
  if (!codes || !codes.length) return {ok:true, data:{}};
  if (market === 'TW') {
    codes.forEach(function(code) {
      try {
        var c = String(code).padStart(4,'0');
        var high=0, low=Infinity;
        var now = new Date();
        for (var m=0; m<12; m++) {
          var d = new Date(now.getFullYear(), now.getMonth()-m, 1);
          var ym = Utilities.formatDate(d, 'Asia/Taipei', 'yyyyMMdd');
          var url = 'https://www.twse.com.tw/rwd/zh/stock/STOCK_DAY?response=json&date='+ym+'&stockNo='+c;
          var resp = UrlFetchApp.fetch(url, {muteHttpExceptions:true});
          if (resp.getResponseCode() !== 200) continue;
          var j = JSON.parse(resp.getContentText());
          if (!j.data) continue;
          j.data.forEach(function(row) {
            var h=parseFloat(String(row[4]).replace(/,/g,'')); var l=parseFloat(String(row[5]).replace(/,/g,''));
            if (!isNaN(h) && h>high) high=h; if (!isNaN(l) && l<low) low=l;
          });
          Utilities.sleep(200);
        }
        if (high > 0) result[c] = {high:high, low:low===Infinity?0:low};
      } catch(e) { Logger.log('52w TW '+code+': '+e); }
    });
  } else {
    codes.forEach(function(ticker) {
      try {
        var url = 'https://query1.finance.yahoo.com/v8/finance/chart/'+ticker+'?range=52wk&interval=1d';
        var resp = UrlFetchApp.fetch(url, {muteHttpExceptions:true, headers:{'User-Agent':'Mozilla/5.0'}});
        if (resp.getResponseCode() !== 200) return;
        var j = JSON.parse(resp.getContentText());
        var meta = j.chart&&j.chart.result&&j.chart.result[0]&&j.chart.result[0].meta;
        if (meta) result[ticker] = {high:meta.fiftyTwoWeekHigh||0, low:meta.fiftyTwoWeekLow||0};
      } catch(e) { Logger.log('52w US '+ticker+': '+e); }
    });
  }
  return {ok:true, data:result};
}

// ════════════════════════════════════════════════════════════════
// 即時現價（美股）
// ════════════════════════════════════════════════════════════════
function getRealtimePrices(codes, market) {
  var result = {};
  if (!codes || !codes.length) return {ok:true, data:{}};
  if (market === 'US') {
    codes.forEach(function(ticker) {
      try {
        var url = 'https://query1.finance.yahoo.com/v8/finance/chart/'+ticker+'?interval=1m&range=1d';
        var resp = UrlFetchApp.fetch(url, {muteHttpExceptions:true, headers:{'User-Agent':'Mozilla/5.0'}});
        if (resp.getResponseCode() !== 200) return;
        var j = JSON.parse(resp.getContentText());
        var meta = j.chart&&j.chart.result&&j.chart.result[0]&&j.chart.result[0].meta;
        if (meta && meta.regularMarketPrice) result[ticker] = {price:meta.regularMarketPrice, prevClose:meta.chartPreviousClose||meta.previousClose||0, high52:meta.fiftyTwoWeekHigh||0, low52:meta.fiftyTwoWeekLow||0};
      } catch(e) { Logger.log('realtime US '+ticker+': '+e); }
    });
  }
  return {ok:true, data:result};
}

// ════════════════════════════════════════════════════════════════
// 台股收盤價（TWSE + TPEX）
// ════════════════════════════════════════════════════════════════
function _fetchTWSEDayClose(yyyymmdd) {
  var prices = {};
  try {
    var resp = UrlFetchApp.fetch('https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&date='+yyyymmdd+'&type=ALLBUT0999', {muteHttpExceptions:true, headers:{'User-Agent':'Mozilla/5.0'}});
    if (resp.getResponseCode() === 200) {
      var j = JSON.parse(resp.getContentText());
      var rows = [];
      if (j.tables) { for (var i=0;i<j.tables.length;i++) { if (j.tables[i].title&&j.tables[i].title.indexOf('每日收盤行情')>=0&&j.tables[i].data&&j.tables[i].data.length>10) { rows=j.tables[i].data; break; } } }
      if (!rows.length) rows = j.data9||j.data8||[];
      rows.forEach(function(row) {
        var code=String(row[0]).trim(); if (!/^\d{4}$/.test(code)) return;
        var close=parseFloat(String(row[8]||'').replace(/,/g,'')); if (!isNaN(close)&&close>0) prices[code]=close;
      });
    }
  } catch(e) { Logger.log('TWSE '+yyyymmdd+': '+e); }
  Utilities.sleep(300);
  var tpex = _fetchTPEXDayClose(yyyymmdd);
  Object.keys(tpex).forEach(function(code){ if (!prices[code]) prices[code]=tpex[code]; });
  return prices;
}

function _fetchTPEXDayClose(yyyymmdd) {
  var prices = {};
  try {
    var y=parseInt(yyyymmdd.slice(0,4))-1911, m=yyyymmdd.slice(4,6), d=yyyymmdd.slice(6,8);
    var url = 'https://www.tpex.org.tw/web/stock/aftertrading/otc_quotes_no1430/stk_wn1430_result.php?l=zh-tw&d='+y+'/'+m+'/'+d+'&se=EW&_='+new Date().getTime();
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions:true, headers:{'User-Agent':'Mozilla/5.0'}});
    if (resp.getResponseCode() !== 200) return prices;
    var j = JSON.parse(resp.getContentText());
    var returnedDate = String(j.date||'').replace(/-/g,'').slice(0,8);
    if (returnedDate && returnedDate !== yyyymmdd) return prices;
    var rows = j.aaData||(j.tables&&j.tables[0]&&j.tables[0].data)||[];
    rows.forEach(function(row) {
      var code=String(row[0]).trim(); if (!/^\d{4}$/.test(code)) return;
      var close=parseFloat(String(row[2]||'').replace(/,/g,'')); if (!isNaN(close)&&close>0) prices[code]=close;
    });
  } catch(e) { Logger.log('TPEX '+yyyymmdd+': '+e); }
  return prices;
}

// ════════════════════════════════════════════════════════════════
// 台股股利
// ════════════════════════════════════════════════════════════════
function _fetchDividendData(ss, codes) {
  var codeSet = {};
  codes.forEach(function(c){ codeSet[String(c).padStart(4,'0')]=true; });
  var history=[], upcoming=[];
  var today=Utilities.formatDate(new Date(),'Asia/Taipei','yyyy-MM-dd');
  var thisYear=today.slice(0,4), lastYear=String(parseInt(thisYear)-1);

  var twsePeriods=[{strDate:lastYear+'0101',endDate:lastYear+'1231'},{strDate:thisYear+'0101',endDate:thisYear+'1231'}];
  twsePeriods.forEach(function(p) {
    try {
      var url='https://www.twse.com.tw/rwd/zh/exRight/TWT49U?response=json&strDate='+p.strDate+'&endDate='+p.endDate;
      var resp=UrlFetchApp.fetch(url,{muteHttpExceptions:true,headers:{'User-Agent':'Mozilla/5.0'}});
      if (resp.getResponseCode()!==200) return;
      var j=JSON.parse(resp.getContentText()); var fields=j.fields||[]; var data=j.data||[];
      var iDate=_findFieldIdx(fields,['除息日']), iCode=_findFieldIdx(fields,['代號','股票代號']), iName=_findFieldIdx(fields,['名稱','股票名稱']), iCash=_findFieldIdx(fields,['現金股利','息值']);
      if (iDate<0||iCode<0||iCash<0) return;
      data.forEach(function(row) {
        var code=String(row[iCode]||'').trim().padStart(4,'0'); if (!codeSet[code]) return;
        var cps=parseFloat(String(row[iCash]||'0').replace(/,/g,'')); if (isNaN(cps)||cps<=0) return;
        var exDate=_parseTWDate(String(row[iDate]||'').trim()); if (!exDate) return;
        var name=iName>=0?String(row[iName]||'').trim():code;
        var rec={code:code,name:name,date:exDate,cps:cps};
        if (exDate<=today) history.push(rec); else upcoming.push(rec);
      });
    } catch(e) { Logger.log('TWT49U '+p.strDate+': '+e); }
    Utilities.sleep(400);
  });

  var tpexPeriods=[{d:(parseInt(lastYear)-1911)+'/01/01',ed:(parseInt(lastYear)-1911)+'/12/31'},{d:(parseInt(thisYear)-1911)+'/01/01',ed:(parseInt(thisYear)-1911)+'/12/31'}];
  tpexPeriods.forEach(function(p) {
    try {
      var url='https://www.tpex.org.tw/web/stock/exright/dailyquo/exDailyQ_result.php?l=zh-tw&d='+p.d+'&ed='+p.ed;
      var resp=UrlFetchApp.fetch(url,{muteHttpExceptions:true,headers:{'User-Agent':'Mozilla/5.0'}});
      if (resp.getResponseCode()!==200) return;
      var j=JSON.parse(resp.getContentText()); var rows=j.aaData||[];
      rows.forEach(function(row) {
        var code=String(row[1]||'').trim().padStart(4,'0'); if (!codeSet[code]) return;
        var cps=parseFloat(String(row[13]||'0').replace(/,/g,'')); if (isNaN(cps)||cps<=0) return;
        var exDate=_parseTWDate(String(row[0]||'').trim()); if (!exDate) return;
        var name=String(row[2]||'').trim();
        var rec={code:code,name:name,date:exDate,cps:cps};
        if (exDate<=today) history.push(rec); else upcoming.push(rec);
      });
    } catch(e) { Logger.log('TPEX exDailyQ '+p.d+': '+e); }
    Utilities.sleep(400);
  });

  try {
    var resp3=UrlFetchApp.fetch('https://openapi.twse.com.tw/v1/opendata/t187ap45_L',{muteHttpExceptions:true,headers:{'User-Agent':'Mozilla/5.0'}});
    if (resp3.getResponseCode()===200) {
      var rows3=JSON.parse(resp3.getContentText());
      rows3.forEach(function(r) {
        var code=String(r['公司代號']||'').trim().padStart(4,'0'); if (!codeSet[code]||code.startsWith('00')) return;
        var cps=(parseFloat(r['股東配發-盈餘分配之現金股利(元/股)']||0))+(parseFloat(r['股東配發-法定盈餘公積發放之現金(元/股)']||0))+(parseFloat(r['股東配發-資本公積發放之現金(元/股)']||0));
        if (isNaN(cps)||cps<=0) return;
        var raw=String(r['董事會（擬議）股利分派日']||'').trim(); var exDate='';
        if (raw.length===7) exDate=(parseInt(raw.slice(0,3))+1911)+'-'+raw.slice(3,5)+'-'+raw.slice(5,7);
        if (!exDate) return;
        var alreadyIn=history.some(function(h){return h.code===code;})||upcoming.some(function(u){return u.code===code&&u.date===exDate;});
        if (alreadyIn) return;
        upcoming.push({code:code,name:String(r['公司名稱']||''),date:exDate,cps:Math.round(cps*100)/100,isDraft:(r['決議（擬議）進度']||'').indexOf('擬議')>=0,period:String(r['股利所屬年(季)度']||'')});
      });
    }
  } catch(e) { Logger.log('t187ap45_L: '+e); }

  var sheetDiv=ss.getSheetByName('dividends'); var sheetRecords=[];
  if (sheetDiv&&sheetDiv.getLastRow()>1) {
    sheetDiv.getDataRange().getValues().slice(1).forEach(function(r) {
      if (!r[0]) return;
      sheetRecords.push({code:String(r[0]).padStart(4,'0'),name:String(r[1]),date:String(r[2]).slice(0,10),shares:parseInt(r[3])||0,cps:parseFloat(r[4])||0});
    });
  }

  function dedup(arr){ var seen={}; return arr.filter(function(r){ var k=r.code+'|'+r.date; if(seen[k]) return false; seen[k]=true; return true; }); }
  return {ok:true, history:dedup(history), upcoming:dedup(upcoming), sheet:sheetRecords};
}

function _findFieldIdx(fields, candidates) {
  for (var i=0;i<candidates.length;i++){ var idx=fields.indexOf(candidates[i]); if(idx>=0) return idx; }
  return -1;
}

function _parseTWDate(s) {
  if (!s) return ''; s=s.trim();
  if (/^\d{3}\/\d{2}\/\d{2}$/.test(s)) { var p=s.split('/'); return (parseInt(p[0])+1911)+'-'+p[1]+'-'+p[2]; }
  if (/^\d{7}$/.test(s)) return (parseInt(s.slice(0,3))+1911)+'-'+s.slice(3,5)+'-'+s.slice(5,7);
  if (/^\d{8}$/.test(s)) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}

// ════════════════════════════════════════════════════════════════
// 美股 NAV 歷史
// ════════════════════════════════════════════════════════════════
var NAV_QUERY_ID = PropertiesService.getScriptProperties().getProperty('IB_NAV_QUERY_ID');

function _writeIBNavRows(ss, navHistory) {
  if (!navHistory || !navHistory.length) return 0;
  var HEADER = ['date','ib_nav_usd','equity_usd','margin_usd'];
  var sheet = ss.getSheetByName('us_nav');
  if (!sheet) {
    sheet = ss.insertSheet('us_nav');
    sheet.getRange(1,1,1,HEADER.length).setValues([HEADER]).setFontWeight('bold');
  }

  var allData = sheet.getLastRow() > 1
    ? sheet.getDataRange().getValues()
    : [HEADER.slice()];
  var hdr = allData[0].map(String);

  function ensureCol(name) {
    var idx = hdr.indexOf(name);
    if (idx < 0) {
      idx = hdr.length;
      hdr.push(name);
      allData[0] = hdr;
      for (var x = 1; x < allData.length; x++) allData[x].push('');
    }
    return idx;
  }
  var dtCol  = hdr.indexOf('date');  if (dtCol  < 0) dtCol  = 0;
  var navCol = ensureCol('ib_nav_usd');
  var eqCol  = ensureCol('equity_usd');
  var mgCol  = ensureCol('margin_usd');
  if (navCol < 0) { navCol = hdr.indexOf('nav_usd'); if (navCol < 0) navCol = ensureCol('ib_nav_usd'); }

  var dateRowIdx = {};
  for (var i = 1; i < allData.length; i++) {
    var d = _navDateStr(allData[i][dtCol]);
    if (d) dateRowIdx[d] = i;
  }

  var updated = 0, added = 0;
  navHistory.forEach(function(n) {
    if (!n.date) return;
    if (dateRowIdx[n.date] !== undefined) {
      var row = allData[dateRowIdx[n.date]];
      if (n.nav)    row[navCol] = n.nav;
      if (n.equity) row[eqCol]  = n.equity;
      if (n.margin) row[mgCol]  = n.margin;
      updated++;
    } else {
      var newRow = new Array(hdr.length).fill('');
      newRow[dtCol]  = n.date;
      if (n.nav)    newRow[navCol] = n.nav;
      if (n.equity) newRow[eqCol]  = n.equity;
      if (n.margin) newRow[mgCol]  = n.margin;
      allData.push(newRow);
      dateRowIdx[n.date] = allData.length - 1;
      added++;
    }
  });

  function _navDateStr(v) {
    if (v && typeof v.getTime === 'function') {
      return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
    }
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    if (/^\d{8}$/.test(s)) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
    try { return Utilities.formatDate(new Date(s), 'Asia/Taipei', 'yyyy-MM-dd'); } catch(e) {}
    return s;
  }
  var body = allData.slice(1).filter(function(r){ return r[dtCol]; });
  body.sort(function(a, b) {
    var da = _navDateStr(a[dtCol]);
    var db = _navDateStr(b[dtCol]);
    return db > da ? 1 : db < da ? -1 : 0;
  });

  body = body.map(function(r) {
    var row = r.slice();
    row[dtCol] = _navDateStr(r[dtCol]);
    return row;
  });

  sheet.clearContents();
  sheet.getRange(1,1,1,hdr.length).setValues([hdr]).setFontWeight('bold');
  if (body.length) sheet.getRange(2,1,body.length,hdr.length).setValues(body);

  Logger.log('_writeIBNavRows: 覆蓋 '+updated+' 筆（IB精確值，含 equity/margin），新增 '+added+' 筆');
  return updated + added;
}

function backfillNAVHistory() {
  if (!NAV_QUERY_ID) { Logger.log('backfillNAVHistory: IB_NAV_QUERY_ID 未設定'); return; }
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  var result=_fetchNAVFromIB(ss,NAV_QUERY_ID);
  Logger.log('backfillNAVHistory 結果: '+JSON.stringify(result));
}

function _fetchNAVFromIB(ss, queryId) {
  var props=PropertiesService.getScriptProperties(); var token=props.getProperty('IB_TOKEN');
  if(!token) return {ok:false,error:'IB Token 未設定'};
  try{
    var step1Url='https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?v=3&t='+token+'&q='+queryId;
    var resp1=UrlFetchApp.fetch(step1Url,{muteHttpExceptions:true});
    var root1=XmlService.parse(resp1.getContentText()).getRootElement();
    var status=root1.getChildText('Status'); if(status!=='Success') return {ok:false,error:'Step1: '+root1.getChildText('ErrorMessage')};
    var refCode=root1.getChildText('ReferenceCode');
    var navBase = root1.getChildText('Url') || 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';
    navBase = navBase.replace('gdcdyn.interactivebrokers.com', 'ndcdyn.interactivebrokers.com');
    Logger.log('NAV Step1 成功，ReferenceCode: '+refCode+'，Step2 URL: '+navBase);
    var xmlText='';
    Utilities.sleep(8000);
    var step2Resp, step2Code;
    for(var i=0;i<40;i++){
      Utilities.sleep(5000);
      var step2Url=navBase+'?v=3&t='+token+'&q='+refCode;
      step2Resp=UrlFetchApp.fetch(step2Url,{muteHttpExceptions:true});
      step2Code=step2Resp.getResponseCode();
      xmlText=step2Resp.getContentText();
      Logger.log('NAV 嘗試'+(i+1)+' HTTP:'+step2Code+' len:'+xmlText.length+' head:'+xmlText.substring(0,200));
      if(xmlText.indexOf('<FlexQueryResponse') >= 0) break;
      if(xmlText.indexOf('1019') < 0 && xmlText.length > 50) break;
    }
    if(xmlText.indexOf('<FlexQueryResponse') < 0) return {ok:false,error:'IB 產生超時，最後回應: '+xmlText.substring(0,300)};

    Logger.log('[NAV XML 前2000字] ' + xmlText.substring(0, 2000));
    var periodMatch = xmlText.match(/fromDate="(\d+)"\s+toDate="(\d+)"\s+period="([^"]+)"/);
    if (periodMatch) Logger.log('[NAV] 查詢期間: ' + periodMatch[1] + ' ~ ' + periodMatch[2] + ' (' + periodMatch[3] + ')');

    var flex=XmlService.parse(xmlText).getRootElement();
    var allNodes=flex.getDescendants().filter(function(n){return n.getType()===XmlService.ContentTypes.ELEMENT;});
    var uniqueNames={};
    allNodes.forEach(function(n){uniqueNames[n.asElement().getName()]=true;});
    Logger.log('[NAV XML 元素名稱] ' + Object.keys(uniqueNames).join(', '));

    var navByDate={};

    ['NavInBase','NAVInBase','navInBase','NetAssetValue'].forEach(function(nodeName){
      var nodes=allNodes.filter(function(n){return n.asElement().getName()===nodeName;});
      if(!nodes.length) return;
      nodes.forEach(function(node){
        var el=node.asElement(); var attrs=el.getAttributes(); var attrMap={};
        attrs.forEach(function(a){attrMap[a.getName()]=a.getValue();});
        var currency=attrMap['currency']||attrMap['currencyPrimary']||'';
        var reportDate=attrMap['reportDate']||attrMap['date']||'';
        var total=parseFloat(attrMap['total']||'0');
        if(!reportDate||isNaN(total)||total===0) return;
        var dateStr=reportDate.length===8?reportDate.slice(0,4)+'-'+reportDate.slice(4,6)+'-'+reportDate.slice(6,8):reportDate.slice(0,10);
        if(!navByDate[dateStr]) navByDate[dateStr]={};
        if(currency==='BASE_SUMMARY') navByDate[dateStr].baseSummary=total;
        else if(currency==='USD'||currency==='') navByDate[dateStr].usd=total;
      });
    });

    var changeNodes=allNodes.filter(function(n){return n.asElement().getName()==='ChangeInNAV';});
    changeNodes.forEach(function(node){
      var el=node.asElement(); var attrs=el.getAttributes(); var attrMap={};
      attrs.forEach(function(a){attrMap[a.getName()]=a.getValue();});
      var currency=attrMap['currency']||'';
      var reportDate=attrMap['toDate']||attrMap['reportDate']||attrMap['date']||'';
      var total=parseFloat(attrMap['endingValue']||attrMap['total']||'0');
      if(!reportDate||isNaN(total)||total===0) return;
      var dateStr=reportDate.length===8?reportDate.slice(0,4)+'-'+reportDate.slice(4,6)+'-'+reportDate.slice(6,8):reportDate.slice(0,10);
      if(!navByDate[dateStr]) navByDate[dateStr]={};
      if(currency==='BASE_SUMMARY') navByDate[dateStr].baseSummary=total;
      else if(currency==='USD'||currency==='') navByDate[dateStr].usd=total;
    });

    var eqNodes=allNodes.filter(function(n){return n.asElement().getName()==='EquitySummaryByReportDateInBase';});
    Logger.log('[NAV] EquitySummaryByReportDateInBase 找到: '+eqNodes.length+' 筆');
    eqNodes.forEach(function(node){
      var el=node.asElement(); var attrs=el.getAttributes(); var attrMap={};
      attrs.forEach(function(a){attrMap[a.getName()]=a.getValue();});
      var currency=attrMap['currency']||'';
      if(currency&&currency!=='USD') return;
      var reportDate=attrMap['reportDate']||'';
      var total     =parseFloat(attrMap['total']    ||'0');
      var totalLong =parseFloat(attrMap['totalLong']||'0');
      var totalShort=parseFloat(attrMap['totalShort']||'0');
      if(!reportDate||isNaN(totalLong)||totalLong===0) return;
      var dateStr=reportDate.length===8?reportDate.slice(0,4)+'-'+reportDate.slice(4,6)+'-'+reportDate.slice(6,8):reportDate.slice(0,10);
      if(!navByDate[dateStr]) navByDate[dateStr]={};
      if(!navByDate[dateStr].baseSummary) navByDate[dateStr].nav=total;
      navByDate[dateStr].equity=totalLong;
      navByDate[dateStr].margin=totalShort;
    });

    Logger.log('[NAV] navByDate 筆數: ' + Object.keys(navByDate).length);
    Logger.log('[NAV] navByDate sample: ' + JSON.stringify(Object.keys(navByDate).slice(0,3).map(function(d){return [d, navByDate[d]];})));

    var navHistory=[];
    Object.keys(navByDate).forEach(function(dateStr){
      var v=navByDate[dateStr];
      var ibNav  = v.baseSummary || v.nav || 0;
      var equity = v.equity || 0;
      var margin = v.margin || 0;
      if(equity>0||ibNav>0) navHistory.push({date:dateStr, nav:ibNav, equity:equity, margin:margin});
    });

    if(navHistory.length>0){
      var added=_writeIBNavRows(ss,navHistory);
      return {ok:true, added:added, total:navHistory.length};
    }
    return {ok:false,error:'無法解析 NAV 節點（元素: '+Object.keys(uniqueNames).join(',')+')' };
  }catch(e){Logger.log('_fetchNAVFromIB 錯誤: '+e);return {ok:false,error:e.toString()};}
}

// ════════════════════════════════════════════════════════════════
// 每日觸發器函式
// ════════════════════════════════════════════════════════════════
function dailyUpdateIB() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var result = fetchIBData(ss);
  Logger.log('dailyUpdateIB fetchIB: ' + JSON.stringify(result));
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  if (result.ok) {
    sendTelegram(
      '✅ [IB美股] 持倉同步成功 ' + now + '\n' +
      '持倉：' + result.positions + ' 筆\n' +
      '新交易：' + result.newTrades + ' 筆\n' +
      '新股息：' + result.newDividends + ' 筆\n' +
      '現金：$' + (result.cash != null ? result.cash.toFixed(2) : 'N/A')
    );
  } else {
    sendTelegram('❌ [IB美股] 持倉同步失敗 ' + now + '\n錯誤：' + result.error);
  }
}

function dailyUpdateIBNav() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  if (!NAV_QUERY_ID) {
    sendTelegram('❌ [IB NAV] IB_NAV_QUERY_ID 未設定 ' + now);
    return;
  }
  var navResult = _fetchNAVFromIB(ss, NAV_QUERY_ID);
  Logger.log('dailyUpdateIBNav NAV: ' + JSON.stringify(navResult));
  if (navResult.ok) {
    sendTelegram(
      '✅ [IB NAV] 資產淨值更新成功 ' + now + '\n' +
      '寫入 ' + navResult.added + ' 筆（共 ' + navResult.total + ' 天）'
    );
  } else {
    sendTelegram('❌ [IB NAV] 資產淨值更新失敗 ' + now + '\n錯誤：' + navResult.error);
  }
}

function dailyUpdateUSPrices() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm');
  Logger.log('dailyUpdateUSPrices 開始');
  try {
    var r = _writePricesUS(ss);
    Logger.log('dailyUpdateUSPrices 完成：' + JSON.stringify(r));
    if (!r || r.ok === true) {
      sendTelegram('✅ [美股價格] 收盤價寫入成功 ' + now + (r ? '\n日期：' + r.date : ''));
    } else if (r.ok === 'skip') {
      // 正常跳過（盤中 / 已存在）→ 不發通知，只記 log
      Logger.log('dailyUpdateUSPrices 跳過：' + r.reason);
    } else {
      sendTelegram('⚠️ [美股價格] 無法寫入 ' + now + '\n原因：' + (r.reason || '未知'));
    }
  } catch(e) {
    Logger.log('dailyUpdateUSPrices 錯誤：' + e);
    sendTelegram('❌ [美股價格] 收盤價更新失敗 ' + now + '\n錯誤：' + e);
  }
}

// ════════════════════════════════════════════════════════════════
// us_prices：每日美股收盤價
// ════════════════════════════════════════════════════════════════
function _normSideUS(s) {
  var u = String(s).trim().toUpperCase();
  if (u === '買' || u === 'BUY')  return 'BUY';
  if (u === '賣' || u === 'SELL') return 'SELL';
  return u;
}

function _toISODate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'UTC', 'yyyy-MM-dd');
  }
  var s = String(val).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  return s;
}

function _computeUSHoldingIntervals(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('us_trades');
  if (!sheet || sheet.getLastRow() < 2)
    return {intervals: [], allTickers: [], currentTickers: []};

  var data   = sheet.getDataRange().getValues();
  var hdr    = data[0].map(function(h){ return String(h).trim(); });
  var dtCol  = hdr.indexOf('date');
  var tkCol  = hdr.indexOf('ticker');
  var sdCol  = hdr.indexOf('side');
  var qtCol  = hdr.indexOf('qty');
  if (dtCol < 0 || tkCol < 0 || sdCol < 0 || qtCol < 0) {
    Logger.log('_computeUSHoldingIntervals: us_trades 欄位不完整');
    return {intervals: [], allTickers: [], currentTickers: []};
  }

  var rows = data.slice(1).filter(function(r){ return r[dtCol] && r[tkCol]; });
  rows.sort(function(a, b){
    var da = _toISODate(a[dtCol]), db = _toISODate(b[dtCol]);
    return da < db ? -1 : da > db ? 1 : 0;
  });

  var qty      = {};
  var openFrom = {};
  var intervals = [];

  rows.forEach(function(row) {
    var dateStr = _toISODate(row[dtCol]);
    var ticker  = String(row[tkCol]).trim();
    var side    = _normSideUS(row[sdCol]);
    var q       = parseFloat(row[qtCol]) || 0;

    if (!qty[ticker]) qty[ticker] = 0;
    var prevQty = qty[ticker];

    if (side === 'BUY') {
      qty[ticker] += q;
      if (prevQty === 0 && qty[ticker] > 0) {
        openFrom[ticker] = dateStr;
      }
    } else if (side === 'SELL') {
      qty[ticker] = Math.max(0, qty[ticker] - q);
      if (prevQty > 0 && qty[ticker] === 0 && openFrom[ticker]) {
        intervals.push({ticker: ticker, from: openFrom[ticker], to: dateStr});
        delete openFrom[ticker];
      }
    }
  });

  Object.keys(openFrom).forEach(function(ticker) {
    if (qty[ticker] > 0) {
      intervals.push({ticker: ticker, from: openFrom[ticker], to: null});
    }
  });

  var tickerSet = {};
  intervals.forEach(function(iv){ tickerSet[iv.ticker] = true; });
  var allTickers     = Object.keys(tickerSet).sort();
  var currentTickers = intervals
        .filter(function(iv){ return iv.to === null; })
        .map(function(iv){ return iv.ticker; });

  Logger.log('_computeUSHoldingIntervals: ' + allTickers.length + ' 支，目前持有 ' + currentTickers.length + ' 支');
  return {intervals: intervals, allTickers: allTickers, currentTickers: currentTickers};
}

function _fetchYahooLatest(ticker) {
  try {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
              '?interval=1d&range=5d';
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    if (resp.getResponseCode() !== 200) return null;
    var data = JSON.parse(resp.getContentText());
    var result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;
    var timestamps = result.timestamp || [];
    var closes     = (result.indicators.quote[0] || {}).close || [];
    for (var i = closes.length - 1; i >= 0; i--) {
      if (closes[i] !== null && closes[i] !== undefined) {
        var d = new Date(timestamps[i] * 1000);
        var dateStr = Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
        return {date: dateStr, close: Math.round(closes[i] * 10000) / 10000};
      }
    }
    return null;
  } catch(e) {
    Logger.log('_fetchYahooLatest ' + ticker + ' 失敗：' + e);
    return null;
  }
}

function _fetchYahooHistory(ticker, startDate, endDate) {
  try {
    var p1 = Math.floor(new Date(startDate).getTime() / 1000);
    var p2 = Math.floor(new Date(endDate).getTime()   / 1000) + 86400;
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
              '?interval=1d&period1=' + p1 + '&period2=' + p2;
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    if (resp.getResponseCode() !== 200) return [];
    var data   = JSON.parse(resp.getContentText());
    var result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) return [];
    var timestamps = result.timestamp || [];
    var closes     = (result.indicators.quote[0] || {}).close || [];
    var out = [];
    for (var i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null && closes[i] !== undefined) {
        var d = new Date(timestamps[i] * 1000);
        out.push({date: Utilities.formatDate(d, 'America/New_York', 'yyyy-MM-dd'),
                  close: Math.round(closes[i] * 10000) / 10000});
      }
    }
    return out;
  } catch(e) {
    Logger.log('_fetchYahooHistory ' + ticker + ' 失敗：' + e);
    return [];
  }
}

var US_BENCHMARK_MAP = {'S&P500': '^GSPC', QQQ: 'QQQ', NASDAQ: '^IXIC'};
var US_BENCHMARKS    = Object.keys(US_BENCHMARK_MAP);

// 從 holdings_us（IB OpenPosition 直接資料）讀取目前持倉的美股 ticker
function _getUSHoldingsTickers(ss) {
  var sheet = ss.getSheetByName('holdings_us');
  if (!sheet || sheet.getLastRow() < 2) return [];
  var data  = sheet.getDataRange().getValues();
  var hdr   = data[0].map(function(h){ return String(h).trim(); });
  var tiCol = hdr.indexOf('ticker');
  var mktCol = hdr.indexOf('market');
  if (tiCol < 0) return [];
  var tickers = [];
  data.slice(1).forEach(function(row) {
    var mkt = mktCol >= 0 ? String(row[mktCol]).trim() : 'US';
    var tk  = String(row[tiCol]).trim();
    if (mkt === 'US' && tk) tickers.push(tk);
  });
  return tickers;
}

function _writePricesUS(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();

  // 1. 從 holdings_us 讀取目前持倉（IB OpenPosition 直接資料，比 us_trades 反推更準確）
  var currentTickers = _getUSHoldingsTickers(ss).filter(function(t){
    return US_BENCHMARKS.indexOf(t) < 0;
  });

  // 2. 抓最新收盤
  var priceMap = {};
  currentTickers.forEach(function(tk) {
    var r = _fetchYahooLatest(tk);
    if (r) priceMap[tk] = r;
    Utilities.sleep(200);
  });
  US_BENCHMARKS.forEach(function(displayName) {
    var yfTicker = US_BENCHMARK_MAP[displayName];
    var r = _fetchYahooLatest(yfTicker);
    if (r) priceMap[displayName] = r;
    Utilities.sleep(200);
  });
  var toFetch = currentTickers.concat(US_BENCHMARKS);
  Logger.log('_writePricesUS 抓到 ' + Object.keys(priceMap).length + '/' + toFetch.length + ' 支');
  Object.keys(priceMap).forEach(function(tk) {
    Logger.log('[USPrice] ' + tk + ': ' + priceMap[tk].date + ' close=' + priceMap[tk].close);
  });

  // 用出現最多次的日期做為 row 的 key
  var dateCounts = {};
  Object.keys(priceMap).forEach(function(tk){
    var d = priceMap[tk].date;
    dateCounts[d] = (dateCounts[d] || 0) + 1;
  });
  var priceDate = Object.keys(dateCounts).sort(function(a,b){
    return dateCounts[b] - dateCounts[a];
  })[0];
  if (!priceDate) { Logger.log('_writePricesUS: 無法決定日期'); return {ok:false, reason:'no_date'}; }

  // ★ 今天跳過：Yahoo 給的是今天盤中價，不是收盤價
  var today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  if (priceDate === today) {
    Logger.log('_writePricesUS: ' + priceDate + ' 是今天盤中，跳過（等收盤後再寫）');
    return {ok:'skip', reason:'intraday', date:priceDate};
  }

  // 3. 取得或建立 us_prices，處理 header 擴增
  var ws = ss.getSheetByName('us_prices');
  if (!ws) ws = ss.insertSheet('us_prices');

  var allData        = ws.getLastRow() > 0 ? ws.getDataRange().getValues() : [];
  var existingHeader = allData.length > 0 ? allData[0].map(String) : [];
  var existingStock  = existingHeader.filter(function(c){
    return c !== 'date' && US_BENCHMARKS.indexOf(c) < 0;
  });

  var existingSet = {};
  existingStock.forEach(function(t){ existingSet[t] = true; });
  var newOnly     = currentTickers.filter(function(t){ return !existingSet[t]; }).sort();
  var mergedStock = existingStock.concat(newOnly);
  var newHeader   = ['date'].concat(mergedStock).concat(US_BENCHMARKS);

  if (JSON.stringify(newHeader) !== JSON.stringify(existingHeader)) {
    var oldIdx = {};
    existingHeader.forEach(function(c, i){ oldIdx[c] = i; });
    var realigned = allData.slice(1).map(function(row){
      return newHeader.map(function(col){
        return col in oldIdx ? (row[oldIdx[col]] !== undefined ? row[oldIdx[col]] : '') : '';
      });
    });
    ws.clearContents();
    ws.appendRow(newHeader);
    if (realigned.length) ws.getRange(2,1,realigned.length,newHeader.length).setValues(realigned);
    Logger.log('_writePricesUS header 更新：' + newHeader.join(','));
    allData = ws.getDataRange().getValues();
  }

  function _dsNorm(v) {
    if (!v) return '';
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
    return String(v).slice(0, 10);
  }

  // 4. 去重
  for (var ri = 1; ri < allData.length; ri++) {
    if (_dsNorm(allData[ri][0]) === priceDate) {
      Logger.log('_writePricesUS: ' + priceDate + ' 已存在，跳過');
      return {ok:'skip', reason:'exists', date:priceDate};
    }
  }

  // 5. 組 row
  var row = [priceDate]
    .concat(mergedStock.map(function(t){
      return (priceMap[t] && priceMap[t].date === priceDate) ? priceMap[t].close : '';
    }))
    .concat(US_BENCHMARKS.map(function(t){
      return priceMap[t] ? priceMap[t].close : '';
    }));
  ws.appendRow(row);

  // 6. 降冪排序
  var allRows = ws.getDataRange().getValues();
  if (allRows.length > 1) {
    var sortHdr  = allRows[0];
    var sortBody = allRows.slice(1).sort(function(a, b) {
      var da = _dsNorm(a[0]), db = _dsNorm(b[0]);
      return db > da ? 1 : db < da ? -1 : 0;
    });
    ws.clearContents();
    ws.getRange(1, 1, 1, sortHdr.length).setValues([sortHdr]).setFontWeight('bold');
    if (sortBody.length) {
      ws.getRange(2, 1, sortBody.length, sortHdr.length).setValues(sortBody);
    }
  }
  Logger.log('✅ _writePricesUS 完成：' + priceDate + '，持倉 ' + currentTickers.length + ' 支 + ' + US_BENCHMARKS.join('/'));
  return {ok:true, date:priceDate};
}

function cleanupUSPrices() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ws = ss.getSheetByName('us_prices');
  if (!ws || ws.getLastRow() < 2) { Logger.log('cleanupUSPrices: 無資料'); return; }

  var allData = ws.getDataRange().getValues();
  var hdr = allData[0];
  var rows = allData.slice(1);

  function dsNorm(v) {
    if (!v) return '';
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
    return String(v).slice(0, 10);
  }
  function nonEmpty(row) {
    var cnt = 0;
    for (var i = 1; i < row.length; i++) {
      if (row[i] !== '' && row[i] !== null && row[i] !== undefined) cnt++;
    }
    return cnt;
  }

  var bestByDate = {};
  rows.forEach(function(row) {
    var d = dsNorm(row[0]);
    if (!d || d.length < 10) return;
    if (!bestByDate[d] || nonEmpty(row) > nonEmpty(bestByDate[d])) {
      bestByDate[d] = row;
    }
  });

  var origCount = rows.length;
  var deduped = Object.keys(bestByDate).sort().reverse().map(function(d) {
    var r = bestByDate[d].slice();
    r[0] = d;
    return r;
  });

  ws.clearContents();
  ws.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
  if (deduped.length) ws.getRange(2, 1, deduped.length, hdr.length).setValues(deduped);
  Logger.log('cleanupUSPrices 完成：原 ' + origCount + ' 筆 → 去重後 ' + deduped.length + ' 筆（移除 ' + (origCount - deduped.length) + ' 筆重複）');
}

function backfillUSPrices() {
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var today   = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');

  var computed  = _computeUSHoldingIntervals(ss);
  var intervals = computed.intervals;
  var allTickers = computed.allTickers;
  if (!intervals.length) { Logger.log('backfillUSPrices: us_trades 無資料'); return; }
  Logger.log('backfillUSPrices: ' + allTickers.length + ' 支標的，' + intervals.length + ' 個持有區間');

  var histMap = {};
  var globalFrom = intervals.reduce(function(m,iv){ return iv.from < m ? iv.from : m; }, today);

  // holdings_us 比對修正：確保目前 IB 有持股的標的，price history 延伸到今天
  // 處理兩種情況：(A) us_trades 完全沒有紀錄；(B) 有紀錄但演算法誤判已清倉（BUY 缺失導致淨量歸零）
  _getUSHoldingsTickers(ss).forEach(function(tk) {
    if (US_BENCHMARKS.indexOf(tk) >= 0) return;
    var tkIvs = intervals.filter(function(iv){ return iv.ticker === tk; });
    if (tkIvs.length === 0) {
      // (A) 完全沒有交易記錄 → 從 globalFrom 開始補
      intervals.push({ticker: tk, from: globalFrom, to: null});
      if (allTickers.indexOf(tk) < 0) allTickers.push(tk);
      Logger.log('backfillUSPrices: 從 holdings_us 補入 ' + tk + '（無交易記錄），自 ' + globalFrom + ' 起');
    } else {
      // (B) 有交易記錄但演算法誤判已清倉（所有 interval 的 to 都有值）→ 從最後清倉日補到今天
      var hasCurrent = tkIvs.some(function(iv){ return iv.to === null; });
      if (!hasCurrent) {
        var lastTo = tkIvs.reduce(function(m, iv){ return iv.to > m ? iv.to : m; }, '');
        if (lastTo) {
          intervals.push({ticker: tk, from: lastTo, to: null});
          Logger.log('backfillUSPrices: ' + tk + ' 補充 ' + lastTo + ' 至今的 price history（交易記錄不完整，IB 仍有持股）');
        }
      }
    }
  });
  allTickers.sort();

  var stockCols = allTickers.filter(function(t){ return US_BENCHMARKS.indexOf(t) < 0; });

  var allFetchList = stockCols.concat(
    US_BENCHMARKS.filter(function(b){ return stockCols.indexOf(b) < 0; })
  );

  allFetchList.forEach(function(displayName) {
    var isBenchmark = US_BENCHMARKS.indexOf(displayName) >= 0;
    var yfTicker    = isBenchmark ? US_BENCHMARK_MAP[displayName] : displayName;

    var tkIntervals = isBenchmark
      ? [{ from: globalFrom, to: null }]
      : intervals.filter(function(iv){ return iv.ticker === displayName; });

    tkIntervals.forEach(function(iv) {
      var fetchEnd = iv.to || today;
      var fetched  = _fetchYahooHistory(yfTicker, iv.from, fetchEnd);
      fetched.forEach(function(r) {
        if (r.date >= iv.from && (iv.to === null || r.date <= iv.to)) {
          if (!histMap[r.date]) histMap[r.date] = {};
          histMap[r.date][displayName] = r.close;
        }
      });
      Logger.log('  ' + displayName + (isBenchmark ? '('+yfTicker+')' : '') +
                 ' [' + iv.from + ' ~ ' + (iv.to || '今') + ']: ' + fetched.length + ' 天');
    });
    Utilities.sleep(400);
  });

  var dates = Object.keys(histMap).sort().reverse();
  Logger.log('backfillUSPrices: 共 ' + dates.length + ' 個交易日');

  var ws = ss.getSheetByName('us_prices');
  if (!ws) ws = ss.insertSheet('us_prices');
  ws.clearContents();

  var header = ['date'].concat(stockCols).concat(US_BENCHMARKS);
  var rows   = [header];

  dates.forEach(function(dt) {
    var day = histMap[dt] || {};
    var row = [dt]
      .concat(stockCols.map(function(t){ return day[t] !== undefined ? day[t] : ''; }))
      .concat(US_BENCHMARKS.map(function(t){ return day[t] !== undefined ? day[t] : ''; }));
    rows.push(row);
  });

  var BATCH = 500;
  ws.getRange(1, 1, 1, header.length).setValues([header]);
  for (var b = 1; b < rows.length; b += BATCH) {
    var chunk = rows.slice(b, b + BATCH);
    ws.getRange(b + 1, 1, chunk.length, header.length).setValues(chunk);
    Utilities.sleep(300);
  }
  Logger.log('✅ backfillUSPrices 完成：' + (rows.length-1) + ' 天，' + stockCols.length + ' 支標的 + ' + US_BENCHMARKS.join('/'));
}

function backfillUSNav() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var priceWS = ss.getSheetByName('us_prices');
  if (!priceWS || priceWS.getLastRow() < 2) {
    Logger.log('backfillUSNav: us_prices 無資料'); return;
  }
  var priceData = priceWS.getDataRange().getValues();
  var priceHdr  = priceData[0].map(function(h){ return String(h).trim(); });

  var priceDateMap = {};
  for (var r = 1; r < priceData.length; r++) {
    var raw = priceData[r][0];
    if (!raw) continue;
    var d = _toISODate(raw);
    if (!d) continue;
    var map = {};
    for (var c = 1; c < priceHdr.length; c++) {
      var val = parseFloat(priceData[r][c]);
      if (!isNaN(val) && val > 0) map[priceHdr[c]] = val;
    }
    priceDateMap[d] = map;
  }

  var tradesWS = ss.getSheetByName('us_trades');
  if (!tradesWS || tradesWS.getLastRow() < 2) {
    Logger.log('backfillUSNav: us_trades 無資料'); return;
  }
  var tData  = tradesWS.getDataRange().getValues();
  var tHdr   = tData[0].map(function(h){ return String(h).trim(); });
  var tDtCol = tHdr.indexOf('date');
  var tTkCol = tHdr.indexOf('ticker');
  var tSdCol = tHdr.indexOf('side');
  var tQtCol = tHdr.indexOf('qty');

  var trades = tData.slice(1).filter(function(r){ return r[tDtCol] && r[tTkCol]; });
  trades.sort(function(a, b){
    var da = _toISODate(a[tDtCol]), db = _toISODate(b[tDtCol]);
    return da < db ? -1 : da > db ? 1 : 0;
  });
  var tradeDates = trades.map(function(r){ return _toISODate(r[tDtCol]); });

  var allDates = Object.keys(priceDateMap).sort();
  if (!allDates.length) { Logger.log('backfillUSNav: us_prices 無日期'); return; }

  var holdings = {};
  var tIdx = 0;
  var navRows = [];

  allDates.forEach(function(dateStr) {
    while (tIdx < trades.length && tradeDates[tIdx] <= dateStr) {
      var row    = trades[tIdx];
      var ticker = String(row[tTkCol]).trim();
      var side   = _normSideUS(row[tSdCol]);
      var qty    = parseFloat(row[tQtCol]) || 0;
      if (!holdings[ticker]) holdings[ticker] = 0;
      if (side === 'BUY')  holdings[ticker] += qty;
      if (side === 'SELL') holdings[ticker] = Math.max(0, holdings[ticker] - qty);
      tIdx++;
    }

    var prices = priceDateMap[dateStr] || {};
    var stockVal = 0;
    Object.keys(holdings).forEach(function(tk) {
      var sh = holdings[tk];
      if (sh <= 0) return;
      var p = prices[tk];
      if (p && p > 0) stockVal += sh * p;
    });

    if (stockVal > 0) {
      navRows.push([dateStr, Math.round(stockVal * 100) / 100]);
    }
  });

  Logger.log('backfillUSNav: 計算出 ' + navRows.length + ' 天');

  var navWS = ss.getSheetByName('us_nav');
  if (!navWS) navWS = ss.insertSheet('us_nav');

  var ibNavMap    = {};
  var ibMarginMap = {};
  if (navWS.getLastRow() > 1) {
    var exData = navWS.getDataRange().getValues();
    var exHdr  = exData[0].map(String);
    var exDt   = exHdr.indexOf('date');
    var exIb   = exHdr.indexOf('ib_nav_usd');
    var exMg   = exHdr.indexOf('margin_usd');
    for (var ei = 1; ei < exData.length; ei++) {
      var ed = String(exData[ei][exDt]).slice(0,10);
      if (!ed) continue;
      if (exIb >= 0) { var ev = parseFloat(exData[ei][exIb]); if (!isNaN(ev) && ev !== 0) ibNavMap[ed] = ev; }
      if (exMg >= 0) { var em = parseFloat(exData[ei][exMg]); if (!isNaN(em) && em !== 0) ibMarginMap[ed] = em; }
    }
  }

  var header = ['date', 'ib_nav_usd', 'equity_usd', 'margin_usd'];
  navRows.sort(function(a, b){ return b[0] > a[0] ? 1 : -1; });

  var mergedRows = navRows.map(function(r) {
    return [r[0], ibNavMap[r[0]] || '', r[1], ibMarginMap[r[0]] || ''];
  });
  Object.keys(ibNavMap).forEach(function(d) {
    if (!navRows.some(function(r){ return r[0] === d; })) {
      mergedRows.push([d, ibNavMap[d], '', ibMarginMap[d] || '']);
    }
  });
  mergedRows.sort(function(a, b){ return b[0] > a[0] ? 1 : -1; });

  navWS.clearContents();
  var BATCH = 500;
  navWS.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  for (var b = 0; b < mergedRows.length; b += BATCH) {
    var chunk = mergedRows.slice(b, b + BATCH);
    navWS.getRange(b + 2, 1, chunk.length, header.length).setValues(chunk);
  }
  Logger.log('✅ backfillUSNav 完成：' + navRows.length + ' 天 equity_usd');
}

function backfillNavHybrid() {
  Logger.log('=== backfillNavHybrid 開始 ===');
  Logger.log('Step 1：backfillUSNav（prices × trades）');
  backfillUSNav();
  Logger.log('Step 2：backfillNAVHistory（IB Flex Query）');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var navResult = _fetchNAVFromIB(ss, NAV_QUERY_ID);
  Logger.log('IB NAV 結果：' + JSON.stringify(navResult));
  Logger.log('=== backfillNavHybrid 完成 ===');
}

function repairUSNav() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('us_nav');
  if (!sheet || sheet.getLastRow() < 2) { Logger.log('us_nav 無資料'); return; }

  var allData = sheet.getDataRange().getValues();
  var hdr     = allData[0].map(String);
  var dtCol   = hdr.indexOf('date');
  var navCol  = hdr.indexOf('ib_nav_usd');
  var eqCol   = hdr.indexOf('equity_usd');
  var mgCol   = hdr.indexOf('margin_usd');
  if (dtCol < 0) { Logger.log('repairUSNav: 找不到 date 欄'); return; }

  function parseDate(v) {
    if (!v) return '';
    if (v && typeof v.getTime === 'function') {
      return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
    }
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
    if (/^\d{8}$/.test(s)) return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
    try {
      var d = new Date(s);
      if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd');
    } catch(e) {}
    return '';
  }

  var merged = {};
  for (var i = 1; i < allData.length; i++) {
    var d = parseDate(allData[i][dtCol]);
    if (!d || d === 'NaN-NaN-NaN') continue;
    if (!merged[d]) merged[d] = {nav:'', equity:'', margin:''};
    var nav = navCol >= 0 ? allData[i][navCol] : '';
    var eq  = eqCol  >= 0 ? allData[i][eqCol]  : '';
    var mg  = mgCol  >= 0 ? allData[i][mgCol]  : '';
    if (nav !== '' && nav !== 0 && !isNaN(parseFloat(nav))) merged[d].nav    = parseFloat(nav);
    if (eq  !== '' && eq  !== 0 && !isNaN(parseFloat(eq)))  merged[d].equity = parseFloat(eq);
    if (mg  !== '' && mg  !== 0 && !isNaN(parseFloat(mg)))  merged[d].margin = parseFloat(mg);
  }

  var dates = Object.keys(merged).sort().reverse();
  var newHeader = ['date','ib_nav_usd','equity_usd','margin_usd'];
  var rows = [newHeader];
  dates.forEach(function(d) {
    var r = merged[d];
    rows.push([d, r.nav !== undefined ? r.nav : '', r.equity !== undefined ? r.equity : '', r.margin !== undefined ? r.margin : '']);
  });

  sheet.clearContents();
  sheet.getRange(1,1,rows.length,newHeader.length).setValues(rows);
  sheet.getRange(1,1,1,newHeader.length).setFontWeight('bold');
  Logger.log('✅ repairUSNav 完成：' + (rows.length-1) + ' 天');
}

function insertIBKRGrants() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('us_trades');
  if (!sheet) { Logger.log('找不到 us_trades'); return; }

  var grants = [
    {date:'2025-07-08', qty:0.0045, price:56.62},
    {date:'2025-11-27', qty:2.2274, price:64.19},
    {date:'2025-12-18', qty:2.3974, price:62.94}
  ];

  var hdr = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0]
              .map(function(h){ return String(h).trim(); });
  var dtCol = hdr.indexOf('date'),   tkCol = hdr.indexOf('ticker'),
      nmCol = hdr.indexOf('name'),   sdCol = hdr.indexOf('side'),
      qtCol = hdr.indexOf('qty'),    prCol = hdr.indexOf('price'),
      feCol = hdr.indexOf('fee'),    cuCol = hdr.indexOf('currency'),
      mkCol = hdr.indexOf('market'), ntCol = hdr.indexOf('note');

  var existKeys = new Set();
  var data = sheet.getLastRow() > 1 ? sheet.getRange(2,1,sheet.getLastRow()-1,hdr.length).getValues() : [];
  data.forEach(function(r){ existKeys.add(String(r[dtCol]).slice(0,10)+'|'+String(r[tkCol]).trim()); });

  var added = 0;
  grants.forEach(function(g) {
    var key = g.date + '|IBKR';
    if (existKeys.has(key)) { Logger.log('已存在，跳過：' + key); return; }
    var row = new Array(hdr.length).fill('');
    if (dtCol >= 0) row[dtCol] = g.date;
    if (tkCol >= 0) row[tkCol] = 'IBKR';
    if (nmCol >= 0) row[nmCol] = 'Interactive Brokers';
    if (sdCol >= 0) row[sdCol] = '買';
    if (qtCol >= 0) row[qtCol] = g.qty;
    if (prCol >= 0) row[prCol] = g.price;
    if (feCol >= 0) row[feCol] = 0;
    if (cuCol >= 0) row[cuCol] = 'USD';
    if (mkCol >= 0) row[mkCol] = 'US';
    if (ntCol >= 0) row[ntCol] = '股票獎勵兌現（IB 贈股，含4:1拆股後淨額）';
    sheet.appendRow(row);
    existKeys.add(key);
    added++;
    Logger.log('新增：' + g.date + ' IBKR ' + g.qty + ' 股 @ $' + g.price);
  });
  Logger.log('insertIBKRGrants 完成：新增 ' + added + ' 筆');
}

// ════════════════════════════════════════════════════════════════
// 觸發器設定
// ════════════════════════════════════════════════════════════════
function setupAllTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t){ScriptApp.deleteTrigger(t);});
  ScriptApp.newTrigger('dailyUpdateIB').timeBased().everyDays(1).atHour(12).nearMinute(10).create();
  ScriptApp.newTrigger('dailyUpdateUSPrices').timeBased().everyDays(1).atHour(12).nearMinute(40).create();
  ScriptApp.newTrigger('dailyUpdateIBNav').timeBased().everyDays(1).atHour(12).nearMinute(25).create();
  Logger.log('✓ 觸發器設定完成：dailyUpdateIB 12:10 + dailyUpdateUSPrices 12:40 + dailyUpdateIBNav 12:25（台灣時間）');
}

function cleanHoldingsSheet(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('holdings_us');
  if (!sheet) { Logger.log('cleanHoldingsSheet: holdings_us 表不存在'); return; }

  var data = sheet.getDataRange().getValues();
  if (data.length < 2) { Logger.log('cleanHoldingsSheet: 無資料'); return; }

  var hdr    = data[0].map(function(h){ return String(h).trim(); });
  var mktCol = hdr.indexOf('market');
  var tiCol  = hdr.indexOf('ticker');

  var usBefore = 0, twRemoved = 0, dupRemoved = 0;
  var seen = {};
  var kept = [data[0]];

  data.slice(1).forEach(function(row) {
    var mkt = String(row[mktCol] || '').trim();
    var tk  = String(row[tiCol]  || '').trim();
    if (mkt !== 'US') { twRemoved++; return; }
    usBefore++;
    if (seen[tk]) { dupRemoved++; return; }
    seen[tk] = true;
    kept.push(row);
  });

  sheet.clearContents();
  sheet.getRange(1, 1, kept.length, hdr.length).setValues(kept);
  Logger.log('cleanHoldingsSheet 完成：US=' + usBefore + '，移除台股=' + twRemoved + '，移除重複=' + dupRemoved);
}
// ════════════════════════════════════════════════════════════════
// Fugle 台股盤中即時 K 線（1分鐘）
// 需在專案設定 → 指令碼屬性設定 FUGLE_API_KEY
// ════════════════════════════════════════════════════════════════
function fetchFugleIntraday_(symbol) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('FUGLE_API_KEY');
    if (!apiKey) return { ok: false, error: 'FUGLE_API_KEY 未設定' };
    // symbol 是路徑參數，不是 query string：/candles/{symbol}
    var url = 'https://api.fugle.tw/marketdata/v1.0/stock/intraday/candles/' + encodeURIComponent(symbol);
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'X-API-KEY': apiKey },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return { ok: false, error: 'HTTP ' + resp.getResponseCode() };
    var json = JSON.parse(resp.getContentText());
    if (!json.data || !json.data.length) return { ok: false, error: 'no data' };
    return {
      ok: true,
      data: json.data.map(function(d) {
        return { t: d.date, c: d.close, o: d.open, h: d.high, l: d.low };
      }).filter(function(r) { return r.c != null; })
    };
  } catch(e) {
    return { ok: false, error: e.toString() };
  }
}

// ════════════════════════════════════════════════════════════════
// 批次盤中K：一次 HTTP 進來，GAS 端用 UrlFetchApp.fetchAll 平行打富果/Yahoo
// symbols 格式 "2330:TW,00919:TW,AAPL:US"；回傳 { ok, data: {code: [candles]} }
// TW 先走富果，失敗的再批次退 Yahoo .TW → .TWO；US 直接 Yahoo 5m
// ════════════════════════════════════════════════════════════════
function fetchIntradayBatch_(symbolsParam) {
  try {
    var items = String(symbolsParam || '').split(',').map(function(s) {
      var p = s.split(':');
      return { code: p[0].trim(), mkt: (p[1] || 'TW').trim().toUpperCase() };
    }).filter(function(it) { return it.code; });
    if (!items.length) return { ok: false, error: 'no symbols' };

    // CacheService：每檔各存一鍵（單值上限 100KB，整批存會爆），45 秒內重複請求直接回快取
    // 多裝置（手機+電腦）同時開頁面時不會重複打富果，也省 API 配額
    var CACHE_TTL = 45;
    var cache = CacheService.getScriptCache();
    var out = {};   // code → [candles]
    var prevMap = {}; // code → 昨收（僅 Yahoo 來源有；富果為 null，前端退回 Sheet 昨收）
    var cached = cache.getAll(items.map(function(it) { return 'idb2_' + it.code; }));
    items = items.filter(function(it) {
      var hit = cached['idb2_' + it.code];
      if (!hit) return true;
      try {
        var v = JSON.parse(hit);
        out[it.code] = v.k;
        if (v.p) prevMap[it.code] = v.p;
        return false;
      } catch (e) { return true; }
    });
    if (!items.length) return { ok: true, data: out, prev: prevMap, cached: true };

    var apiKey = PropertiesService.getScriptProperties().getProperty('FUGLE_API_KEY') || '';
    var yahooReq_ = function(sym) {
      return {
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym)
           + '?interval=5m&range=1d&includePrePost=false',
        method: 'get',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
        muteHttpExceptions: true
      };
    };

    // 第一輪：TW→富果 1分K、US→Yahoo 5分K，全部平行
    var reqs = items.map(function(it) {
      if (it.mkt === 'US') return yahooReq_(it.code);
      return {
        url: 'https://api.fugle.tw/marketdata/v1.0/stock/intraday/candles/' + encodeURIComponent(it.code),
        method: 'get',
        headers: { 'X-API-KEY': apiKey },
        muteHttpExceptions: true
      };
    });
    var resps = UrlFetchApp.fetchAll(reqs);
    var retry = [];
    items.forEach(function(it, i) {
      if (it.mkt === 'US') {
        var y = _parseYahooCandles_(resps[i]);
        if (y && y.k.length >= 3) { out[it.code] = y.k; if (y.p) prevMap[it.code] = y.p; }
        // US 沒有退回來源，失敗就略過
      } else {
        var candles = _parseFugleCandles_(resps[i]);
        if (candles && candles.length >= 3) out[it.code] = candles;
        else retry.push(it);
      }
    });

    // 第二/三輪：富果沒資料的台股批次退 Yahoo（假日也能拿到最近交易日走勢）
    ['.TW', '.TWO'].forEach(function(sfx) {
      if (!retry.length) return;
      var rs = UrlFetchApp.fetchAll(retry.map(function(it) { return yahooReq_(it.code + sfx); }));
      var next = [];
      retry.forEach(function(it, i) {
        var y = _parseYahooCandles_(rs[i]);
        if (y && y.k.length >= 3) { out[it.code] = y.k; if (y.p) prevMap[it.code] = y.p; }
        else next.push(it);
      });
      retry = next;
    });

    // 新抓到的寫入快取（單值 >100KB 會 put 失敗，逐鍵 try 不讓例外中斷回應）
    var toCache = {};
    items.forEach(function(it) {
      if (out[it.code]) toCache['idb2_' + it.code] = JSON.stringify({ k: out[it.code], p: prevMap[it.code] || null });
    });
    try { cache.putAll(toCache, CACHE_TTL); } catch (e) {
      Object.keys(toCache).forEach(function(k) {
        try { cache.put(k, toCache[k], CACHE_TTL); } catch (e2) {}
      });
    }

    return { ok: true, data: out, prev: prevMap };
  } catch (e) {
    return { ok: false, error: e.toString() };
  }
}

function _parseFugleCandles_(resp) {
  try {
    if (resp.getResponseCode() !== 200) return null;
    var json = JSON.parse(resp.getContentText());
    if (!json.data || !json.data.length) return null;
    return json.data.map(function(d) {
      return { t: d.date, c: d.close, o: d.open, h: d.high, l: d.low };
    }).filter(function(r) { return r.c != null; });
  } catch (e) { return null; }
}

// 回傳 { k:[candles], p:昨收 }；昨收取自 Yahoo meta（跟盤中K同一交易日對齊，
// 不會像 Sheet 同步價一樣在盤中過期）
function _parseYahooCandles_(resp) {
  try {
    if (resp.getResponseCode() !== 200) return null;
    var json = JSON.parse(resp.getContentText());
    var res = json.chart && json.chart.result && json.chart.result[0];
    if (!res || !res.timestamp) return null;
    var meta = res.meta || {};
    var prev = meta.chartPreviousClose || meta.previousClose || null;
    var q = res.indicators.quote[0];
    var k = res.timestamp.map(function(t, i) {
      return { t: t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] };
    }).filter(function(r) { return r.c != null; });
    return { k: k, p: prev };
  } catch (e) { return null; }
}

function fetchYahooChart_(symbol, interval, range) {
  try {
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol
            + '?interval=' + interval + '&range=' + range + '&includePrePost=false';
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return { ok: false };
    var json = JSON.parse(resp.getContentText());
    var res = json.chart && json.chart.result && json.chart.result[0];
    if (!res) return { ok: false };
    var meta = res.meta || {};
    var ts = res.timestamp;
    var q  = res.indicators.quote[0];
    return {
      ok: true,
      prev: meta.chartPreviousClose || meta.previousClose || null,
      data: ts.map(function(t, i) {
        return { t: t, d: new Date(t * 1000).toISOString().slice(0, 10),
                 o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] };
      }).filter(function(r) { return r.o != null && r.c != null; })
    };
  } catch(e) {
    return { ok: false, error: e.toString() };
  }
}

// ════════════════════════════════════════════════════════════════
// kcache：每日盤後預抓所有持股日K(6mo)/周K(1y)，存入 kcache 工作表
// 設定：專案 → 觸發條件 → 新增，選 buildKCache（不帶底線），時間驅動，每日 14:00~15:00
// 前端以 action:'read_kcache' 一次讀回全部（取代逐檔即時抓 Yahoo）
// ════════════════════════════════════════════════════════════════
// 公開包裝函式：可在執行選單/觸發器中選取（結尾底線的函式不會出現在選單）
function buildKCache() {
  buildKCache_();
}

function buildKCache_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var syms = getAllHoldingSymbols_();
  var sheet = ss.getSheetByName('kcache');
  if (!sheet) sheet = ss.insertSheet('kcache');
  var rows = [['code', 'market', 'data', 'updated']];
  var now = new Date();
  syms.forEach(function(it) {
    var daily  = fetchOHLCsmart_(it.code, it.market, '1d',  '6mo');
    var weekly = fetchOHLCsmart_(it.code, it.market, '1wk', '1y');
    var obj = {
      d: (daily  && daily.ok)  ? daily.data  : [],
      w: (weekly && weekly.ok) ? weekly.data : []
    };
    rows.push([it.code, it.market, JSON.stringify(obj), now]);
    Utilities.sleep(300); // 避免 Yahoo 並行限流
  });
  sheet.clearContents();
  sheet.getRange(1, 1, rows.length, 4).setValues(rows);
  Logger.log('buildKCache_ 完成：' + (rows.length - 1) + ' 檔');
}

// 台股先 .TW（上市）失敗再 .TWO（上櫃）；美股直接用代號
function fetchOHLCsmart_(code, market, interval, range) {
  if (market !== 'TW') return fetchYahooChart_(code, interval, range);
  var d = fetchYahooChart_(code + '.TW', interval, range);
  if (d && d.ok && d.data && d.data.length > 3) return d;
  var d2 = fetchYahooChart_(code + '.TWO', interval, range);
  if (d2 && d2.ok && d2.data && d2.data.length > 3) return d2;
  return d;
}

// 讀 holdings_tw / holdings_us 取得所有代號 + 市場
function getAllHoldingSymbols_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];
  [['holdings_tw', 'TW'], ['holdings_us', 'US']].forEach(function(pair) {
    var sh = ss.getSheetByName(pair[0]);
    if (!sh) return;
    var data = sh.getDataRange().getValues();
    if (data.length < 2) return;
    var hdr = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
    var tiI = hdr.findIndex(function(h) { return /^(ticker|code|symbol)/.test(h); });
    var shI = hdr.findIndex(function(h) { return /^(shares|qty)/.test(h); });
    if (tiI < 0) tiI = 0;
    for (var i = 1; i < data.length; i++) {
      var code = String(data[i][tiI] || '').trim();
      var sh2  = shI >= 0 ? (Number(data[i][shI]) || 0) : 1;
      if (code && sh2 > 0) out.push({ code: code, market: pair[1] });
    }
  });
  return out;
}

// 前端讀取：回傳 { ok, data:{ code:{d:[...],w:[...]} }, updated }
function readKCache_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('kcache');
  if (!sh) return { ok: false, error: 'kcache 尚未建立，請先執行 buildKCache_' };
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return { ok: false, error: 'kcache 無資料' };
  var map = {}, updated = '';
  for (var i = 1; i < data.length; i++) {
    var code = String(data[i][0] || '').trim();
    if (!code) continue;
    try { map[code] = JSON.parse(data[i][2]); } catch(e) {}
    if (data[i][3]) updated = data[i][3];
  }
  return { ok: true, data: map, updated: updated };
}