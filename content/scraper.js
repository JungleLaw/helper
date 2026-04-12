/**
 * content/scraper.js
 * 注入 TEMU 卖家中心页面，负责抓取 SKU 库存销售数据
 * 通过 chrome.runtime.onMessage 接收 {action:'scrape'} 消息，返回结构化数据
 */

(function () {
  'use strict';

  // ─── 消息监听入口 ─────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action !== 'scrape') return false;
    try {
      const result = scrapeSkuTable();
      sendResponse({ ok: true, data: result });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true; // 保持消息通道开启（异步兼容）
  });

  // ─── 核心抓取函数 ──────────────────────────────────────────────────────────────
  function scrapeSkuTable() {
    const skus = [];

    // 1. 找到包含数据的表格的正文区域
    const domRow = document.querySelector('tr[data-testid*="table-body-tr"]') || document.querySelector('tbody tr');
    if (!domRow) {
      throw new Error('未找到 SKU 数据行，请确认已打开「销售管理」页面并在有数据的状态下使用');
    }

    const currentTbody = domRow.closest('tbody') || domRow.parentElement;

    // 2. 找到与之唯一匹配的表头区域
    let currentThead = null;
    // 优先用高度特征标志锁定
    const specificThead = document.querySelector('thead[data-testid*="table-middle-thead"]');
    if (specificThead) {
        currentThead = specificThead;
    } else {
        // 如果没有标志，寻找同级或最近公共祖先下的 thead
        let wrapper = currentTbody.closest('.TB_tableWrapper_5-120-1, [data-testid*="table"], .ant-table-wrapper, [class*="manager"]');
        if (wrapper) {
            currentThead = wrapper.querySelector('thead');
        }
    }
    // 终极保底
    if (!currentThead) currentThead = document.querySelector('thead');

    // 3. 利用纯正的 HTML Table Grid 算法映射表头
    // 彻底解决复杂 colspan rowspan 复合表头导致的数据错列问题！
    const theadTrs = Array.from(currentThead.querySelectorAll('tr'));
    const headGrid = buildGrid(theadTrs);
    let colMap = { sku: -1, sales7: -1, sales30: -1, stock: -1, transit: -1, unavailable: -1 };

    if (headGrid.length > 0) {
        // 表头不论叠加了多少层，它的【最后一行】必然是一维平铺的、直接倒向正文列的 1:1 映射！
        const lastRow = headGrid[headGrid.length - 1];
        for (let c = 0; c < lastRow.length; c++) {
            const cell = lastRow[c];
            if (!cell) continue;
            const text = cell.textContent.replace(/\s+/g, '').trim();
            
            if (text.includes('SKU货号') || text.includes('SKU信息')) colMap.sku = c;
            else if (text.includes('7天')) colMap.sales7 = c; // '近7天'
            else if (text.includes('30天')) colMap.sales30 = c; // '近30天'
            else if (text.includes('暂不可用')) colMap.unavailable = c; // 优先拦截 '仓内暂不可用库存'
            else if (text.includes('可用') || text.includes('发货可用')) colMap.stock = c; // '仓内可用库存'
            else if (text.includes('已发货') || text === '在途') colMap.transit = c; // '已发货库存'
        }
    }

    // 4. 解析表体（自动将缺头缺脚的 rowspan 单元格铺平成完美二维数组，与表头列号绝对对齐）
    const tbodyTrs = Array.from(currentTbody.querySelectorAll('tr'));
    const grid = buildGrid(tbodyTrs);
    
    const useFallback = (colMap.sales7 === -1 || colMap.stock === -1);

    const processedCells = new Set();

    for (let r = 0; r < grid.length; r++) {
      const rowArr = grid[r];
      if (rowArr.length < 5) continue;
      if (rowArr[0] && rowArr[0].textContent.includes('合计')) continue;

      // 如果完全找不到表头，退回根据同行数据估算（最差情况）
      let skuCellIdx = colMap.sku;
      if (useFallback || skuCellIdx === -1) {
          for (let c = 0; c < rowArr.length; c++) {
              if (rowArr[c] && (rowArr[c].textContent.includes('SKU货号：') || rowArr[c].textContent.includes('SKU ID：'))) {
                  skuCellIdx = c;
                  break;
              }
          }
      }

      if (skuCellIdx === -1 || !rowArr[skuCellIdx]) continue;
      const skuCell = rowArr[skuCellIdx];

      // 防止重复处理（由于 rowspan 会引出同一个元素的重复检测）
      if (processedCells.has(skuCell)) continue;
      
      const cellText = skuCell.textContent;
      if (!cellText.includes('SKU')) continue; 
      
      processedCells.add(skuCell);

      const parsed = parseSkuData(skuCell, cellText);
      if (!parsed) continue;

      const getNum = (cIdx) => {
          if (cIdx === -1) return 0;
          const cell = rowArr[cIdx];
          if (!cell) return 0;
          // 防止把“/”或者空字符串解析成 NaN
          return parseNum(cell.textContent);
      };

      // 提取本行的 SKC (得益于 buildGrid，无论合并与否，本行一定包含商品框内容)
      let skc = '';
      for (let c = 0; c < rowArr.length; c++) {
          const cell = rowArr[c];
          if (!cell) continue;
          const matchSKC = cell.textContent.match(/SKC货号：([A-Za-z0-9\-_]+)/);
          if (matchSKC) {
              skc = matchSKC[1];
              break;
          }
      }

      // 组装最终对象，完美的列对应
      skus.push({
        id: parsed.id,
        skc: skc,
        skuCode: parsed.skuCode,
        spec: parsed.spec,
        sales7: useFallback ? getNum(skuCellIdx + 3) : getNum(colMap.sales7),
        sales30: useFallback ? getNum(skuCellIdx + 4) : getNum(colMap.sales30),
        stock: useFallback ? getNum(skuCellIdx + 6) : getNum(colMap.stock),
        unavailable: useFallback ? 0 : getNum(colMap.unavailable),
        inTransit: useFallback ? getNum(skuCellIdx + 7) : getNum(colMap.transit)
      });
    }

    if (skus.length === 0) {
      throw new Error('页面中没有找到有效的 SKU 数据，请检查列表列配置，确保包含“近7天销量”和“可用库存”列');
    }
    return skus;
  }

  // ─── Grid网格化工具 ──────────────────────────────────────────────────────────
  // 将具有 rowspan 和 colspan 的嵌套 tr>td 解析为完美的 2D 数组网格映射
  function buildGrid(rows) {
    const grid = [];
    for (let r = 0; r < rows.length; r++) {
      if (!grid[r]) grid[r] = [];
      const tr = rows[r];
      const cells = Array.from(tr.children); 
      
      let cIdx = 0;
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        
        while (grid[r][cIdx] !== undefined) {
          cIdx++;
        }
        
        const rowSpan = parseInt(cell.getAttribute('rowspan') || '1', 10);
        const colSpan = parseInt(cell.getAttribute('colspan') || '1', 10);
        
        for (let rs = 0; rs < rowSpan; rs++) {
          for (let cs = 0; cs < colSpan; cs++) {
            const y = r + rs;
            const x = cIdx + cs;
            if (!grid[y]) grid[y] = [];
            grid[y][x] = cell;
          }
        }
        cIdx += colSpan;
      }
    }
    return grid;
  }

  // ─── 文本信息提取 ────────────────────────────────────────────────────────────
  function parseSkuData(skuCell, cellText) {
      let skuId = null;
      let skuCode = null;
      let spec = '默认';

      // 提取独立文本节点寻找规格和货号
      const subEls = Array.from(skuCell.querySelectorAll('*'));
      let foundSpec = false;
      
      subEls.forEach(el => {
          const t = el.textContent.trim();
          if (t.startsWith('SKU ID：')) {
              skuId = t.replace('SKU ID：', '').trim();
          } else if (t.startsWith('SKU货号：')) {
              skuCode = t.replace('SKU货号：', '').trim();
          } else if (!foundSpec && !t.includes('SKU') && !t.includes('备货') && t.length > 0 && t.length < 50) {
              if (el.children.length === 0) {
                spec = t;
                foundSpec = true;
              }
          }
      });

      if (!skuCode) {
          const matchCode = cellText.match(/SKU货号：([A-Za-z0-9\-_]+)/);
          if (matchCode) skuCode = matchCode[1];
      }
      if (!skuId) {
          const matchId = cellText.match(/SKU ID：(\d+)/);
          if (matchId) skuId = matchId[1];
      }
      
      if (!skuCode) return null;
      
      return {
          id: skuId || `${skuCode}_${spec}`,
          skuCode,
          spec
      };
  }

  // ─── 统一数值读取 ────────────────────────────────────────────────────────────
  function parseNum(str) {
      if (!str) return 0;
      const cleaned = str.replace(/[^\d.-]/g, '');
      const n = parseFloat(cleaned);
      return isNaN(n) ? 0 : n;
  }

})();
