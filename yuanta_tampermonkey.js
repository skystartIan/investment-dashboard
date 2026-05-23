
// ==UserScript==
// @name         元大定期定額自動下載
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  自動登入元大網站，處理 CAPTCHA，下載投資明細，執行 Python 解析
// @author       yuanta_sync
// @match        https://global.yuanta.com.tw/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.anthropic.com
// @connect      static.yuanta.com.tw
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 攔截「請輸入密碼」alert
    const _origAlert = window.alert;
    window.alert = function(msg) {
        if (typeof msg === 'string' && msg.includes('請輸入密碼')) {
            console.log('[元大自動化] 攔截 alert: ' + msg);
            return;
        }
        _origAlert.call(window, msg);
    };

    // ══════════════════════════════════════════════════
    // 從本地 server 讀取設定
    // ══════════════════════════════════════════════════
    async function loadConfig() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'http://localhost:8765/config',
                onload: function (res) {
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch (e) {
                        reject(new Error('設定伺服器回應格式錯誤'));
                    }
                },
                onerror: () => reject(new Error('無法連線到設定伺服器，請確認 yuanta_config_server.py 已啟動'))
            });
        });
    }

    let CONFIG = {
        WEB_ID: '',
        PASSWORD: '',
        ANTHROPIC_KEY: '',
        PYTHON_EXE: 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python311-arm64\\python.exe',
        SCRIPT_PATH: 'C:\\Users\\Administrator\\Documents\\yuanta_sync\\yuanta_web_dca.py',
    };

    // ══════════════════════════════════════════════════
    // 工具函式
    // ══════════════════════════════════════════════════
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function log(msg) {
        console.log(`[元大自動化] ${msg}`);
    }

    function waitFor(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const el = document.querySelector(selector);
                if (el) return resolve(el);
                if (Date.now() - start > timeout) return reject(new Error(`等待 ${selector} 逾時`));
                setTimeout(check, 300);
            };
            check();
        });
    }

    // ══════════════════════════════════════════════════
    // 圖片轉 base64
    // ══════════════════════════════════════════════════
    function fetchImageAsBase64(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'arraybuffer',
                onload: function (res) {
                    const bytes = new Uint8Array(res.response);
                    let binary = '';
                    for (let i = 0; i < bytes.byteLength; i++) {
                        binary += String.fromCharCode(bytes[i]);
                    }
                    const base64 = btoa(binary);
                    // 用檔案魔術字節判斷真實格式
                    let contentType = 'image/jpeg';
                    if (bytes[0] === 0x89 && bytes[1] === 0x50) contentType = 'image/png';
                    else if (bytes[0] === 0x47 && bytes[1] === 0x49) contentType = 'image/gif';
                    else if (bytes[0] === 0x52 && bytes[1] === 0x49) contentType = 'image/webp';
                    resolve({ base64, contentType });
                },
                onerror: reject
            });
        });
    }

    // ══════════════════════════════════════════════════
    // 呼叫 Claude API 判斷 CAPTCHA
    // ══════════════════════════════════════════════════
    async function solveCaptchaWithClaude(question, images) {
        log(`呼叫 Claude API 判斷 CAPTCHA: ${question}`);

        const content = [
            {
                type: 'text',
                text: `你是圖片辨識專家。題目是：${question}\n\n以下每張圖片都有對應的 id，請仔細辨識每張圖片的內容（注意：圖片可能是插圖、卡通、圖示風格），判斷哪些圖片符合題目要求。\n\n重要：只回傳 JSON 格式，不要有任何其他文字或 markdown：{"correct_ids": ["id1", "id2"]}`
            }
        ];

        for (const img of images) {
            content.push({ type: 'text', text: `圖片 id=${img.id}:` });
            content.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: img.contentType,
                    data: img.base64
                }
            });
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.anthropic.com/v1/messages',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': CONFIG.ANTHROPIC_KEY,
                    'anthropic-version': '2023-06-01',
                },
                data: JSON.stringify({
                    model: 'claude-sonnet-4-5',
                    max_tokens: 200,
                    messages: [{ role: 'user', content }]
                }),
                onload: function (res) {
                    try {
                        log(`API 狀態碼: ${res.status}`);
                        log(`API 回應: ${res.responseText.substring(0, 200)}`);
                        const data = JSON.parse(res.responseText);
                        if (data.error) {
                            reject(new Error(`API 錯誤: ${data.error.message}`));
                            return;
                        }
                        const text = data.content[0].text.trim()
                            .replace(/```json\n?/g, '')
                            .replace(/```\n?/g, '')
                            .trim();
                        log(`Claude 回應: ${text}`);
                        const jsonStr = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
                        const json = JSON.parse(jsonStr);
                        resolve(json.correct_ids || []);
                    } catch (e) {
                        reject(new Error(`解析失敗: ${e.message}`));
                    }
                },
                onerror: reject
            });
        });
    }

    // ══════════════════════════════════════════════════
    // CAPTCHA 本地資料庫查詢 / 儲存
    // ══════════════════════════════════════════════════
    async function lookupCaptchaDB(images) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'http://localhost:8765/captcha/lookup',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ images: images.map(img => ({ id: img.id, b64: img.base64 })) }),
                onload: res => { try { resolve(JSON.parse(res.responseText).results || {}); } catch { resolve({}); } },
                onerror: () => resolve({})
            });
        });
    }

    async function saveCaptchaDB(images, label) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'http://localhost:8765/captcha/save',
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                images: images.map(img => ({
                    b64:    img.base64,
                    hashes: img.hashes,  // {ph, ah, dh}
                    label:  label
                }))
            }),
            onload: res => { try { const r = JSON.parse(res.responseText); log(`💾 資料庫已存 ${r.saved} 筆，共 ${r.total} 筆`); } catch {} },
            onerror: () => {}
        });
    }

    async function resolveCaptcha(question, images) {
        const labelMatch = question.match(/【(.+?)】/);
        const targetLabel = labelMatch ? labelMatch[1] : null;
        log(`目標類別: ${targetLabel}`);

        // 查資料庫（回傳 hashes 和 label）
        const dbResults = await lookupCaptchaDB(images);

        // 把 hashes 存回 images
        images.forEach(img => {
            if (dbResults[img.id]) {
                img.hashes = dbResults[img.id].hashes;
                img.label  = dbResults[img.id].label;
            }
        });

        // 全部命中 → 直接用資料庫
        if (targetLabel) {
            const allKnown = images.every(img => img.label !== undefined && img.label !== null);
            if (allKnown) {
                const correctIds = images.filter(img => img.label === targetLabel).map(img => img.id);
                if (correctIds.length > 0) {
                    log(`✅ 資料庫命中！`);
                    return correctIds;
                }
            }
        }

        // 未命中 → 呼叫 Claude API
        log('資料庫未命中，呼叫 Claude API...');
        const correctIds = await solveCaptchaWithClaude(question, images);

        // 把答案存入資料庫（需要有 hashes）
        if (targetLabel && correctIds.length > 0) {
            const correctImgs = images.filter(img => correctIds.includes(img.id) && img.hashes);
            if (correctImgs.length > 0) {
                await saveCaptchaDB(correctImgs, targetLabel);
            }
        }

        return correctIds;
    }

    // ══════════════════════════════════════════════════
    // 處理 CAPTCHA
    // ══════════════════════════════════════════════════
    async function handleCaptcha() {
        log('等待 CAPTCHA modal...');
        await waitFor('#modalYCaptchaV2', 15000);
        await sleep(500);

        // 最多重試 5 次
        for (let attempt = 1; attempt <= 5; attempt++) {
            log(`CAPTCHA 第 ${attempt} 次嘗試`);

            // 讀取題目
            const titleEl = document.querySelector('#modalYCaptchaV2 .modal-title');
            const question = titleEl ? titleEl.textContent.trim() : '請選擇正確的圖片';
            log(`題目: ${question}`);

            // 收集所有頁面的圖片（點右箭頭翻頁）
            const imgData = [];
            const seenIds = new Set();

            // 先收集當前頁
            const collectCurrentPage = () => {
                const rows = document.querySelectorAll('#tableCaptcha tr:not(.d-none)');
                rows.forEach(row => {
                    row.querySelectorAll('img.y-captcha-image').forEach(img => {
                        if (img.id && img.src && !seenIds.has(img.id)) {
                            seenIds.add(img.id);
                            imgData.push({ id: img.id, url: img.src });
                        }
                    });
                });
            };

            collectCurrentPage();

            // 翻頁直到沒有下一頁
            for (let page = 0; page < 10; page++) {
                const nextBtn = document.querySelector('#tableCaptcha tr:not(.d-none) a:not(.d-none) .fa-chevron-right')?.closest('a');
                if (!nextBtn) break;
                nextBtn.click();
                await sleep(800);
                collectCurrentPage();
            }

            log(`共找到 ${imgData.length} 張圖片（含翻頁）`);

            // 下載圖片轉 base64
            const images = [];
            for (const item of imgData) {
                try {
                    const { base64, contentType } = await fetchImageAsBase64(item.url);
                    images.push({ id: item.id, base64, contentType });
                } catch (e) {
                    log(`下載圖片失敗 ${item.id}: ${e}`);
                }
            }

            // 查資料庫或呼叫 Claude API
            const correctIds = await resolveCaptcha(question, images);
            log(`應點擊: ${correctIds.join(', ')}`);

            // 點擊正確圖片
            for (const id of correctIds) {
                const imgEl = document.getElementById(id);
                if (imgEl) {
                    imgEl.click();
                    log(`點擊圖片 ${id}`);
                    await sleep(300);
                }
            }

            await sleep(500);

            // 點驗證按鈕
            const confirmBtn = document.getElementById('btnConfirm');
            if (confirmBtn) {
                confirmBtn.click();
                log('點擊驗證按鈕');
            }

            await sleep(2000);

            // 檢查是否有「請再試一次」錯誤訊息
            const errorMsg = document.querySelector('#modalYCaptchaV2 .message.text-danger');
            if (errorMsg && errorMsg.textContent.trim()) {
                log(`第 ${attempt} 次失敗: ${errorMsg.textContent.trim()}，重試...`);
                await sleep(1000);
                continue; // 重試
            }

            // 檢查 modal 是否關閉（驗證成功）
            const modal = document.getElementById('modalYCaptchaV2');
            if (!modal || modal.style.display === 'none' || !modal.classList.contains('show')) {
                log('CAPTCHA 驗證成功！');
                return;
            }

            log(`第 ${attempt} 次結果不明，繼續等待...`);
            await sleep(1000);
        }

        throw new Error('CAPTCHA 重試 5 次仍失敗');
    }

    // ══════════════════════════════════════════════════
    // 主流程：登入頁
    // ══════════════════════════════════════════════════
    // 用 native setter 填入 input（繞過 React/Vue 合成事件問題）
    function fillInput(el, value) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur',   { bubbles: true }));
    }

    async function handleLoginPage() {
        log('開始登入流程...');

        // 等帳號/密碼欄位出現
        let idField, pwField;
        for (let i = 0; i < 20; i++) {
            idField = document.querySelector('#loginid');
            pwField = document.querySelector('#loginPWD');
            if (idField && pwField) break;
            await sleep(500);
        }

        if (idField && CONFIG.WEB_ID) {
            fillInput(idField, CONFIG.WEB_ID);
            log(`填入帳號: ${CONFIG.WEB_ID}`);
        } else {
            log('⚠️ 找不到帳號欄位或設定中無 WEB_ID');
        }

        if (pwField && CONFIG.PASSWORD) {
            fillInput(pwField, CONFIG.PASSWORD);
            log('填入密碼');
        } else {
            log('⚠️ 找不到密碼欄位或設定中無 PASSWORD');
        }

        await sleep(500);
        log('帳號密碼填入完成，點擊「我是元大客戶」');

        // 點「我是元大客戶」label
        const label = document.querySelector('label[for="chbYCaptchaV2"]');
        if (label) {
            label.click();
            log('點擊「我是元大客戶」');
        }

        await sleep(2000);

        // 處理 CAPTCHA
        try {
            await handleCaptcha();
        } catch (e) {
            log(`CAPTCHA 處理失敗: ${e}，請手動處理`);
            return;
        }

        // CAPTCHA 驗證後等待 checkbox 真正被勾選
        await sleep(1000);
        for (let i = 0; i < 10; i++) {
            const chb = document.getElementById('chbYCaptchaV2');
            if (chb && chb.checked) {
                log('chbYCaptchaV2 已勾選');
                break;
            }
            log(`等待 checkbox 勾選... (${i+1})`);
            await sleep(500);
        }

        // 等待 yCaptchaV2_SetFinish 完全執行完畢
        await sleep(3000);

        // 點登入按鈕
        const loginBtn = document.getElementById('loginBtn');
        if (loginBtn) {
            loginBtn.click();
            log('點擊登入按鈕');
        }
    }

    // ══════════════════════════════════════════════════
    // 主流程：投資明細頁
    // ══════════════════════════════════════════════════
    async function handleTransPage() {
        log('投資明細頁面，開始下載...');
        await sleep(2000);

        // 選「本月」
        const select = document.getElementById('selectDateRange');
        if (select) {
            select.value = '3';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            log('選擇「本月」');
            await sleep(1500);
        }

        // 點下載按鈕
        const dlBtn = document.getElementById('btnDownloadExcel');
        if (dlBtn) {
            dlBtn.click();
            log('點擊下載按鈕');
            await sleep(4000);
        }

        log('✅ 投資明細下載完成！跳轉到未實現損益...');
        window.location.href = 'https://global.yuanta.com.tw/NexusWebTrade/nexuswebtrade/UnRealPF';
    }

    // ══════════════════════════════════════════════════
    // 主流程：未實現損益頁
    // ══════════════════════════════════════════════════
    async function handleHolding2Page() {
        log('未實現損益頁面，開始下載...');
        await sleep(2000);

        const dlBtn = document.getElementById('btnDownloadExcel');
        if (dlBtn) {
            dlBtn.click();
            log('點擊下載未實現損益');
            await sleep(4000);
        }

        log('✅ 全部下載完成！關閉頁面...');

        const notice = document.createElement('div');
        notice.style.cssText = 'position:fixed;top:20px;right:20px;background:#4CAF50;color:white;padding:15px 20px;border-radius:8px;z-index:99999;font-size:16px;';
        notice.textContent = '✅ 下載完成，3 秒後關閉頁面';
        document.body.appendChild(notice);

        await sleep(3000);
        // sessionStorage 關閉頁面後自動清除，不需要手動移除
        window.close();    }

    // ══════════════════════════════════════════════════
    // 頁面路由
    // ══════════════════════════════════════════════════
    async function main() {
        // 先從本地 server 載入設定
        try {
            const cfg = await loadConfig();
            CONFIG.WEB_ID        = cfg.WEB_ID;
            CONFIG.PASSWORD      = cfg.PASSWORD;
            CONFIG.ANTHROPIC_KEY = cfg.ANTHROPIC_KEY;
            log('設定載入成功');
        } catch (e) {
            log(`❌ ${e.message}`);
            alert(`❌ ${e.message}\n\n請先執行：\nC:\\Python311-arm64\\python.exe yuanta_config_server.py`);
            return;
        }

    const url = window.location.href;
    const urlLower = url.toLowerCase();

    // 登入頁不設 flag（每次開新頁都要重新執行）
    // 下載頁用 sessionStorage 防止重複下載（關閉頁面後自動清除）
    if (!urlLower.includes('/login/otplogin')) {
        const PAGE_KEY = 'yuanta_done_' + window.location.pathname.split('/').pop().toLowerCase();
        if (sessionStorage.getItem(PAGE_KEY) === 'done') {
            log('此頁面已執行過，跳過');
            return;
        }
        sessionStorage.setItem(PAGE_KEY, 'done');
    }

        if (urlLower.includes('/login/otplogin')) {
            await handleLoginPage();
        } else if (urlLower.includes('/ra/checkcert')) {
            // 安控憑證檢查頁面，點「離開」跳過
            log('安控檢查頁面，尋找離開按鈕...');
            await sleep(2000);
            const btns = document.querySelectorAll('button');
            for (const btn of btns) {
                if (btn.textContent.trim() === '離開') {
                    btn.click();
                    log('點擊「離開」跳過安控檢查');
                    break;
                }
            }
        } else if (urlLower.includes('/nexuswebtrade/trans')) {
            await handleTransPage();
        } else if (urlLower.includes('/nexuswebtrade/unrealpf')) {
            await handleHolding2Page();
        } else if (urlLower.includes('/announce') || urlLower.includes('/nexuswebtrade')) {
            log('登入成功，檢查安控元件彈窗...');
            await sleep(2000);
            const closeBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '離開');
            if (closeBtn) {
                closeBtn.click();
                log('關閉安控元件彈窗');
                await sleep(1000);
            }
            log('跳轉到投資明細...');
            window.location.href = 'https://global.yuanta.com.tw/NexusWebTrade/nexuswebtrade/trans';
        }
    }

    // 啟動
    window.addEventListener('load', () => {
        setTimeout(main, 500);
    });

})();