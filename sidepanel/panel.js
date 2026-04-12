/**
 * sidepanel/panel.js
 * 侧边栏主逻辑：管理跨页追加、状态、计算与渲染
 */
document.addEventListener('DOMContentLoaded', async () => {

  // --- State ---
  let allSkus = new Map(); // SKU ID -> Data
  let scannedPages = 0;
  
  // Settings Let
  let targetDays = 7;
  let safetyDays = 3;
  let includeInTransit = true;
  let showOnlyNeedStock = false;

  // --- UI Elements ---
  const els = {
    badge: document.getElementById('statusBadge'),
    scrapeBtn: document.getElementById('scrapeBtn'),
    scrapeBtnText: document.getElementById('scrapeBtnText'),
    exportBtn: document.getElementById('exportBtn'),
    clearBtn: document.getElementById('clearBtn'),
    
    targetDays: document.getElementById('targetDays'),
    safetyDays: document.getElementById('safetyDays'),
    includeInTransit: document.getElementById('includeInTransit'),
    showOnlyNeedStock: document.getElementById('showOnlyNeedStock'),
    formulaText: document.getElementById('formulaText'),
    
    emptyState: document.getElementById('emptyState'),
    errorState: document.getElementById('errorState'),
    errorMsg: document.getElementById('errorMsg'),
    
    progressBanner: document.getElementById('progressBanner'),
    pageCount: document.getElementById('pageCount'),
    totalSkuCount: document.getElementById('totalSkuCount'),
    skuCount: document.getElementById('skuCount'),
    
    tableWrapper: document.getElementById('tableWrapper'),
    tableBody: document.getElementById('tableBody'),
    
    summaryBar: document.getElementById('summaryBar'),
    sumTotal: document.getElementById('sumTotal'),
    sumNeedStock: document.getElementById('sumNeedStock'),
    sumWarn: document.getElementById('sumWarn'),
    sumSafe: document.getElementById('sumSafe'),
    sumTotalStock: document.getElementById('sumTotalStock'),
  };

  // --- Init ---
  await loadState();
  initListeners();
  handleSettingChange();

  // --- Listeners ---
  function initListeners() {
    els.scrapeBtn.addEventListener('click', handleScrape);
    els.clearBtn.addEventListener('click', handleClear);
    els.exportBtn.addEventListener('click', handleExport);

    // Number Inputs
    document.querySelectorAll('.num-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const targetId = e.currentTarget.dataset.target;
        const delta = parseInt(e.currentTarget.dataset.delta, 10);
        const input = document.getElementById(targetId);
        let val = parseInt(input.value, 10) + delta;
        val = Math.max(parseInt(input.min, 10) || 0, Math.min(val, parseInt(input.max, 10) || 999));
        input.value = val;
        handleSettingChange();
      });
    });

    els.targetDays.addEventListener('change', handleSettingChange);
    els.safetyDays.addEventListener('change', handleSettingChange);
    els.includeInTransit.addEventListener('change', handleSettingChange);
    els.showOnlyNeedStock.addEventListener('change', () => updateView());
  }

  function handleSettingChange() {
    // 处理 0 变成 falsy 导致触发默认值的问题（如 0 || 45 变成 45）
    const parsedTarget = parseInt(els.targetDays.value, 10);
    const parsedSafety = parseInt(els.safetyDays.value, 10);
    
    targetDays = isNaN(parsedTarget) ? 7 : parsedTarget;
    safetyDays = isNaN(parsedSafety) ? 3 : parsedSafety;
    includeInTransit = els.includeInTransit.checked;
    
    if (els.formulaText) {
        els.formulaText.textContent = `建议备货 = max(0, 日均 × ${targetDays}天 − 当前库存)`;
    }
    
    recalculateAll();
    updateView();
  }

  async function handleClear() {
    allSkus.clear();
    scannedPages = 0;
    await saveState();
    updateView();
  }

  // --- Core Logic ---
  
  async function handleScrape() {
    setLoading(true);
    els.errorState.style.display = 'none';

    try {
      // 1. Get active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error("无法获取当前页面");
      
      // 2. Inject CSS/JS if not already present (failsafe)
      try {
          await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content/scraper.js']
          });
      } catch (e) {
          // Script might already be injected, ignore
      }

      // 3. Send message to scraper
      chrome.tabs.sendMessage(tab.id, { action: 'scrape' }, async (response) => {
         
        if (chrome.runtime.lastError) {
             setLoading(false);
             showError("无法与页面通信，请刷新 TEMU 页面后重试");
             return;
        }

        if (!response || !response.ok) {
            setLoading(false);
            showError(response?.error || "抓取失败，未找到数据");
            return;
        }

        // 4. Process Data
        const newData = response.data;
        console.log('newData,newData',newData);
        scannedPages++;
        
        newData.forEach(sku => {
            // Calc daily avg simply here, or wait for recalculate
            allSkus.set(sku.id, sku);
        });

        recalculateAll();
        await saveState();
        updateView();
        
        setLoading(false);
        els.badge.textContent = "抓取成功";
        els.badge.className = "status-badge done";
        setTimeout(() => {
           els.badge.textContent = "就绪";
           els.badge.className = "status-badge ready";
        }, 3000);

      });

    } catch (err) {
      setLoading(false);
      showError(err.message);
    }
  }

  function recalculateAll() {
    allSkus.forEach((sku, id) => {
       // Daily avg (prefer 30 days, fallback to 7 days)
       let dailyAvg = 0;
       if (sku.sales30 > 0) {
           dailyAvg = sku.sales30 / 30;
       } else if (sku.sales7 > 0) {
           dailyAvg = sku.sales7 / 7;
       }
       
       sku.dailyAvg = dailyAvg;
       sku.unavailable = sku.unavailable || 0;
       
       const baseStock = sku.stock + sku.unavailable;
       const totalStock = includeInTransit ? (baseStock + sku.inTransit) : baseStock;
       const remainDays = dailyAvg > 0 ? (totalStock / dailyAvg) : 999;
       
       const targetQty = Math.ceil(dailyAvg * targetDays);
       const recommendQty = Math.max(0, targetQty - totalStock);
       
       let status = 'safe';
       if (recommendQty > 0) status = 'danger';
       else if (remainDays < targetDays + safetyDays) status = 'warn';

       sku.calc = {
           dailyAvg: Number(dailyAvg.toFixed(1)),
           totalStock,
           remainDays: Number(remainDays.toFixed(1)),
           targetQty,
           recommendQty,
           status
       };
    });
  }

  // --- Rendering ---
  
  function updateView() {
    if (allSkus.size === 0) {
        els.emptyState.style.display = 'flex';
        els.tableWrapper.style.display = 'none';
        els.summaryBar.style.display = 'none';
        els.progressBanner.style.display = 'none';
        els.exportBtn.disabled = true;
        els.scrapeBtnText.textContent = "读取当前页";
        return;
    }

    els.emptyState.style.display = 'none';
    els.errorState.style.display = 'none';
    els.tableWrapper.style.display = 'block';
    els.summaryBar.style.display = 'flex';
    els.progressBanner.style.display = 'flex';
    els.exportBtn.disabled = false;
    els.scrapeBtnText.textContent = "继续追加本页";

    // Update Progress
    els.pageCount.textContent = scannedPages;
    els.totalSkuCount.textContent = allSkus.size;

    // 保持最初从 DOM 按顺序抓取的排序，不再打乱
    const skus = Array.from(allSkus.values());
    
    const displaySkus = showOnlyNeedStock 
        ? skus.filter(s => s.calc.recommendQty > 0)
        : skus;

    // Render Table
    renderTable(displaySkus);
    
    // Render Stats
    updateSummary(skus);
  }

  function renderTable(skus) {
      els.tableBody.innerHTML = '';
      
      // 先计算每个行对应 SKC 的 rowspan 跨度
      const rowSpans = new Array(skus.length).fill(1);
      for (let i = skus.length - 1; i > 0; i--) {
          if (skus[i].skc && skus[i].skc === skus[i-1].skc) {
              rowSpans[i-1] += rowSpans[i];
              rowSpans[i] = 0;
          }
      }
      
      skus.forEach((sku, index) => {
          const tr = document.createElement('tr');
          if (index % 2 === 1) tr.classList.add('stripe');
          
          // 给每一组的第一行加上边界样式
          if (rowSpans[index] > 0) {
              tr.classList.add('group-start');
          }
          
          const c = sku.calc;
          
          let statusHtml = '';
          if (c.status === 'danger') statusHtml = '<span class="badge badge-danger">需备货</span>';
          else if (c.status === 'warn') statusHtml = '<span class="badge badge-warn">偏低</span>';
          else statusHtml = '<span class="badge badge-success">充足</span>';
          
          let remainDaysHtml = '';
          if (c.remainDays > 300) remainDaysHtml = '<span class="days-cell days-inf">>300</span>';
          else remainDaysHtml = `<span class="days-cell days-${c.status}">${c.remainDays}</span>`;
          
          let skcHtml = '';
          if (rowSpans[index] > 0) {
              // 只在组的第一行输出 SKC 格子，并且撑满之后的合并行
              skcHtml = `<td class="sku-code skc-group" rowspan="${rowSpans[index]}" title="${sku.skc || '-'}">${sku.skc || '-'}</td>`;
          }

          tr.innerHTML = `
              ${skcHtml}
              <td class="sku-code" title="${sku.skuCode}">${sku.skuCode}</td>
              <td class="sku-name">${sku.spec}</td>
              <td class="num-col">${sku.sales7}</td>
              <td class="num-col">${sku.sales30}</td>
              <td class="num-col">${c.dailyAvg}</td>
              <td class="num-col">${sku.stock}</td>
              <td class="num-col">${sku.unavailable}</td>
              <td class="num-col">${sku.inTransit}</td>
              <td class="num-col">${remainDaysHtml}</td>
              <td class="num-col">${c.targetQty}</td>
              <td class="num-col highlight-col ${c.recommendQty === 0 ? 'zero' : ''}">${c.recommendQty}</td>
              <td class="status-col">${statusHtml}</td>
          `;
          els.tableBody.appendChild(tr);
      });
  }

  function updateSummary(skus) {
      let needStock = 0;
      let warn = 0;
      let safe = 0;
      let totalStock = 0;

      skus.forEach(s => {
          const st = s.calc.status;
          if (st === 'danger') needStock++;
          else if (st === 'warn') warn++;
          else safe++;
          
          totalStock += s.calc.recommendQty;
      });

      els.sumTotal.textContent = skus.length;
      els.sumNeedStock.textContent = needStock;
      els.sumWarn.textContent = warn;
      els.sumSafe.textContent = safe;
      els.sumTotalStock.textContent = totalStock;
      
      els.skuCount.textContent = `显示 ${els.tableBody.children.length} 项`;
  }

  // --- Storage ---
  
  async function saveState() {
     const data = {
         skus: Array.from(allSkus.entries()),
         pages: scannedPages
     };
     await chrome.storage.session.set({ appData: data });
  }

  async function loadState() {
      const result = await chrome.storage.session.get('appData');
      if (result.appData) {
          allSkus = new Map(result.appData.skus);
          scannedPages = result.appData.pages || 0;
      }
  }

  // --- Utils ---
  
  function setLoading(isLoading) {
      els.scrapeBtn.disabled = isLoading;
      if (isLoading) {
          els.badge.className = "status-badge loading";
          els.badge.textContent = "抓取中...";
      }
  }

  function showError(msg) {
      els.errorState.style.display = 'flex';
      els.errorMsg.textContent = msg;
      
      els.badge.className = "status-badge error";
      els.badge.textContent = "出错了";
  }

  function handleExport() {
      if (allSkus.size === 0) return;
      
      const skus = Array.from(allSkus.values());
      const headers = ['SKC', 'SKU货号', '颜色/尺码', '近7天销量', '近30天销量', '日均销量', '可用库存', '暂不可用', '在途/已发货', '剩余天数', '目标总量', '建议备货'];
      
      const csvContent = [
          headers.join(','),
          ...skus.map(s => {
              const c = s.calc;
              return [
                 `"${s.skc || ''}"`,
                 `"${s.skuCode}"`,
                 `"${s.spec}"`,
                 s.sales7,
                 s.sales30,
                 c.dailyAvg,
                 s.stock,
                 s.unavailable || 0,
                 s.inTransit,
                 c.remainDays,
                 c.targetQty,
                 c.recommendQty
              ].join(',');
          })
      ].join('\n');
      
      const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `temu_库存分析_${new Date().toISOString().slice(0,10)}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  }

});
