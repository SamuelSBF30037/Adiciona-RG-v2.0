'use strict';

const textarea   = document.getElementById('rgNumbers');
const countEl    = document.getElementById('count');
const progressEl = document.getElementById('progress-fill');
const statusEl   = document.getElementById('status');
const btnStart   = document.getElementById('btn-start');

// ── Helpers ────────────────────────────────────────────────────────────────

function parseRGs(raw) {
  return raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function setStatus(msg, type = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (type ? ` ${type}` : '');
}

function setProgress(current, total) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressEl.style.width = pct + '%';
  setStatus(`Inserindo ${current} de ${total} RGs… (${pct}%)`, 'running');
}

function setDone(total) {
  progressEl.style.width = '100%';
  setStatus(`✓ ${total} RG${total !== 1 ? 's' : ''} inserido${total !== 1 ? 's' : ''} com sucesso`, 'done');
  btnStart.disabled = false;
  btnStart.innerHTML = '<svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:#fff;flex-shrink:0"><path d="M8 5v14l11-7z"/></svg> Processar novamente';
}

// ── Live counter ────────────────────────────────────────────────────────────

textarea.addEventListener('input', () => {
  const rgs = parseRGs(textarea.value);
  countEl.textContent = rgs.length + (rgs.length === 1 ? ' RG' : ' RGs');
  btnStart.disabled = rgs.length === 0;
  if (rgs.length === 0) {
    progressEl.style.width = '0%';
    setStatus('Aguardando início');
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

btnStart.addEventListener('click', () => {
  const rgs = parseRGs(textarea.value);
  if (rgs.length === 0) return;

  btnStart.disabled = true;
  progressEl.style.width = '0%';
  setStatus('Conectando à página…', 'running');

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) {
      setStatus('Erro: nenhuma aba ativa encontrada.', 'error');
      btnStart.disabled = false;
      return;
    }

    chrome.scripting.executeScript(
      { target: { tabId: tab.id }, func: injectedProcessor, args: [rgs] },
      () => {
        if (chrome.runtime.lastError) {
          setStatus('Erro ao injetar script na página.', 'error');
          btnStart.disabled = false;
        }
      }
    );
  });
});

// ── Progress messages from injected script ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'rg:progress') setProgress(msg.current, msg.total);
  if (msg.type === 'rg:done')     setDone(msg.total);
  if (msg.type === 'rg:error')    setStatus('Erro: ' + msg.message, 'error');
});

// ── Injected script (runs in page context) ──────────────────────────────────

function injectedProcessor(rgList) {
  const FILL_DELAY   = 800;   // ms before typing value
  const CLICK_DELAY  = 2500;  // ms to wait after clicking Adicionar

  function findElements() {
    let field = document.querySelector('input[name="rg"]');
    let btn   = document.querySelector('input[value="Adicionar"]');
    if (field && btn) return { field, btn };

    for (const frame of document.querySelectorAll('iframe')) {
      try {
        const doc = frame.contentDocument || frame.contentWindow.document;
        field = doc.querySelector('input[name="rg"]');
        btn   = doc.querySelector('input[value="Adicionar"]');
        if (field && btn) return { field, btn };
      } catch (_) { /* cross-origin iframe – skip */ }
    }
    return null;
  }

  function waitForElements(retries = 20) {
    return new Promise((resolve, reject) => {
      (function attempt(n) {
        const els = findElements();
        if (els) return resolve(els);
        if (n <= 0) return reject(new Error('Elementos do formulário não encontrados após 10s.'));
        setTimeout(() => attempt(n - 1), 500);
      })(retries);
    });
  }

  function fillAndClick({ field, btn }, value) {
    return new Promise(resolve => {
      field.focus();
      field.value = '';
      setTimeout(() => {
        field.value = value;
        // Dispatch events so frameworks (React, Vue, etc.) pick up the change
        field.dispatchEvent(new Event('input',  { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        btn.click();
        setTimeout(resolve, CLICK_DELAY);
      }, FILL_DELAY);
    });
  }

  async function run() {
    let elements;
    try {
      elements = await waitForElements();
    } catch (err) {
      chrome.runtime.sendMessage({ type: 'rg:error', message: err.message });
      return;
    }

    // Also shrink the iframe height if needed (preserves original behaviour)
    try {
      const xpath = '/html/body/form/table/tbody/tr[5]/td/iframe';
      const iframe = document.evaluate(
        xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
      ).singleNodeValue;
      if (iframe) iframe.style.height = '200px';
    } catch (_) {}

    for (let i = 0; i < rgList.length; i++) {
      await fillAndClick(elements, rgList[i]);
      chrome.runtime.sendMessage({ type: 'rg:progress', current: i + 1, total: rgList.length });
      // Re-fetch elements in case page reloaded after adding
      try { elements = await waitForElements(6); } catch (_) {}
    }

    chrome.runtime.sendMessage({ type: 'rg:done', total: rgList.length });
  }

  run();
}
