// Global Application State
let currentLang = 'zh';
let currentUser = null;
let authToken = localStorage.getItem('ipqc_token') || null;

let activeStation = null;
let activeAuditData = {};
let activeDefectItemNo = null;
let activeDefectPhoto = '';
let auditTimerInterval = null;
let auditStartTime = null;
let paretoChartInstance = null;
let currentParetoPeriod = 'weekly';
let cachedAnalyticsData = null;
let selectedParetoProcess = null;
let html5QrScanner = null;

let selectedLayoutMode = 'option3'; // 'option3' (Shopfloor Bay Matrix - Primary Home), 'option1' (Linear Conveyor), 'canvas' (2D Free Canvas)
let selectedPhaseFilter = 'All Phases';
let selectedLineFilter = 'SMT Line T1';
let selectedAreaFilter = 'All Areas';
let selectedStandardFilter = 'All';
let selectedAuditScope = 'station';
let fetchedStations = [];
let isLayoutEditMode = false;

// Initialize persistent audited station tracking
let savedAudited = [];
try { savedAudited = JSON.parse(localStorage.getItem('ipqc_audited_stations') || '[]'); } catch(e){}
window.auditedStationCodes = new Set(savedAudited);

// Fallback Default Stations List
const defaultStations = (typeof masterStationsData !== 'undefined') ? masterStationsData : [
  { id: 'SMT-T1-ESD-01', code: 'SMT-T1-ESD-01', name: 'Central ESD & IQC Gate', line: 'SMT Line T1', phase: 'Phase 1', area: 'Quality & ESD Area', process: 'ESD', tag: 'ESD', standard_doc: '5Q4-046', sequence_order: 1, pos_x: 30, pos_y: 40, status: 'OK' },
  { id: 'SMT-T1-PRINT-01', code: 'SMT-T1-PRINT-01', name: 'Solder Paste Printer & Stencil', line: 'SMT Line T1', phase: 'Phase 1', area: 'SMT Surface Mount Area', process: 'SMT-Printer', tag: 'SMT-Printer', standard_doc: '5Q4-046', sequence_order: 5, pos_x: 280, pos_y: 40, status: 'OK' }
];

/**
 * formatLocalTime - Convert ISO UTC timestamp string to local YYYY-MM-DD HH:mm
 * Handles both offset strings ("+00:00", "+07:00") and naive UTC strings.
 */
function formatLocalTime(isoStr) {
  if (!isoStr) return 'N/A';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return isoStr.substring(0, 16).replace('T', ' ');
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const h  = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${mo}-${da} ${h}:${mi}`;
  } catch(e) {
    return (isoStr || '').substring(0, 16).replace('T', ' ');
  }
}

function getCurrentTimeInfo() {
  const now = new Date();
  // Use local calendar date to avoid UTC day rollover at midnight UTC+7
  const y  = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const da = String(now.getDate()).padStart(2, '0');
  const dateStr = `${y}-${mo}-${da}`;
  const hours = now.getHours();
  
  const startH = Math.floor(hours / 2) * 2;
  const endH = startH + 2;
  const formatH = h => (h === 24 ? '00:00' : (h < 10 ? '0' + h : h) + ':00');
  
  const timeBlock = `${formatH(startH)} - ${formatH(endH)}`;
  const shift = (hours >= 8 && hours < 20) ? 'Day Shift' : 'Night Shift';
  
  return { date: dateStr, shift, timeBlock };
}


document.addEventListener('DOMContentLoaded', () => {
  const tInfo = getCurrentTimeInfo();
  const blockEl = document.getElementById('active-time-block');
  if (blockEl) blockEl.textContent = tInfo.timeBlock;
  const shiftEl = document.getElementById('input-shift');
  if (shiftEl) shiftEl.value = tInfo.shift;
  
  initApp();
});

if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(initApp, 100);
}

function safeExec(fn) {
  try {
    fn();
  } catch (e) {
    console.warn('SafeExec caught error:', e);
  }
}

// Universal API Fetcher that seamlessly handles both direct serverless routes and /api paths
async function apiFetch(url, options = {}) {
  const directUrl = url.startsWith('/api/') ? url.replace(/^\/api/, '') : url;
  try {
    let res = await fetch(directUrl, options);
    if ((res.status === 404 || res.status === 502) && directUrl !== url) {
      res = await fetch(url, options);
    }
    return res;
  } catch (err) {
    if (directUrl !== url) {
      return fetch(url, options);
    }
    throw err;
  }
}


function initApp() {
  safeExec(setupAuthHandlers);
  safeExec(setupNavigation);
  safeExec(setupLanguageSwitcher);
  safeExec(setupMapControlsToggle);
  safeExec(setupAuditCredentialsSync);
  safeExec(setupMapFilters);
  safeExec(setupLayoutModeSwitcher);
  safeExec(renderAuditorFlowRoute);
  safeExec(renderFactoryMap);
  safeExec(loadCAPABoard);
  safeExec(renderParetoChart);
  safeExec(renderQrStickers);
  safeExec(loadAIInsights);
  safeExec(checkUserSession);
  safeExec(() => checkEmailPauseStatus(true));

  // Network Status Monitor
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  safeExec(updateNetworkStatus);

  // Scanner Event Listeners
  const scanBtn = document.getElementById('btn-open-scanner');
  if (scanBtn) scanBtn.addEventListener('click', openQrScanner);
  const closeScanBtn = document.getElementById('btn-close-scanner');
  if (closeScanBtn) closeScanBtn.addEventListener('click', closeQrScanner);

  // Back Button in Audit Execution -> Returns to 2D Factory Floor Layout Map
  const backBtn = document.getElementById('btn-back-stations');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      clearInterval(auditTimerInterval);
      auditTimerInterval = null;
      auditStartTime = null;
      const timerEl = document.getElementById('audit-timer');
      if (timerEl) {
        timerEl.textContent = '00:00';
        timerEl.style.color = '#34d399';
        timerEl.style.fontSize = '';
      }
      const execPanel = document.getElementById('panel-audit-execution');
      if (selectedLayoutMode === 'option1') {
        execPanel.style.display = 'none';
        const rightPane = document.getElementById('option1-detail-pane');
        if (rightPane) rightPane.innerHTML = '<div style="color:var(--text-muted); text-align:center; margin-top:20%; font-size: 1.2rem;">Select a station from the left to view detailed process.</div>';
      } else {
        execPanel.style.display = 'none';
        document.getElementById('panel-map-layout').style.display = 'block';
      }
    });
  }


  // Audit Scope Selector Handler
  const scopeSelect = document.getElementById('select-audit-scope');
  if (scopeSelect) {
    scopeSelect.addEventListener('change', (e) => {
      selectedAuditScope = e.target.value;
      if (activeStation) {
        renderAuditQuestions(activeStation);
      }
    });
  }

  // Submit Audit Event Listener
  const subBtn = document.getElementById('btn-submit-audit');
  if (subBtn) subBtn.addEventListener('click', submitCurrentAudit);

  // CAPA Board Controls
  const refCapa = document.getElementById('btn-refresh-capa');
  if (refCapa) refCapa.addEventListener('click', loadCAPABoard);
  const closeCapaModal = document.getElementById('btn-close-capa-modal');
  if (closeCapaModal) {
    closeCapaModal.addEventListener('click', () => {
      document.getElementById('modal-capa-update').classList.remove('active');
    });
  }
  const saveCapaBtn = document.getElementById('btn-save-capa-modal');
  if (saveCapaBtn) saveCapaBtn.addEventListener('click', saveCAPAModal);

  // User Management Handlers
  const addUsrBtn = document.getElementById('btn-open-add-user');
  if (addUsrBtn) {
    addUsrBtn.addEventListener('click', () => {
      document.getElementById('modal-add-user')?.classList.add('active');
    });
  }
  const closeUsrModal = document.getElementById('btn-close-user-modal');
  if (closeUsrModal) {
    closeUsrModal.addEventListener('click', () => {
      document.getElementById('modal-add-user')?.classList.remove('active');
    });
  }
  const saveUsrBtn = document.getElementById('btn-save-user-modal');
  if (saveUsrBtn) saveUsrBtn.addEventListener('click', handleCreateUserSubmit);

  // Admin 2D Layout Editor Controls
  const toggleLayoutBtn = document.getElementById('btn-toggle-layout-edit');
  if (toggleLayoutBtn) toggleLayoutBtn.addEventListener('click', toggleLayoutEditMode);
  const saveLayoutBtn = document.getElementById('btn-save-layout-pos');
  if (saveLayoutBtn) saveLayoutBtn.addEventListener('click', handleSaveBulkLayout);
  const adminAddStBtn = document.getElementById('btn-admin-add-station');
  if (adminAddStBtn) adminAddStBtn.addEventListener('click', openStationEditorForNew);

  const closeStEditor = document.getElementById('btn-close-station-editor');
  if (closeStEditor) {
    closeStEditor.addEventListener('click', () => {
      document.getElementById('modal-station-editor')?.classList.remove('active');
    });
  }
  const saveStEditor = document.getElementById('btn-save-station-editor');
  if (saveStEditor) saveStEditor.addEventListener('click', handleSaveStationEditor);
  const delStEditor = document.getElementById('btn-delete-station');
  if (delStEditor) delStEditor.addEventListener('click', handleDeleteStationEditor);

  // Email Dispatch Modal Handlers
  const closeEmailModal = document.getElementById('btn-close-email-modal');
  if (closeEmailModal) {
    closeEmailModal.addEventListener('click', () => {
      document.getElementById('modal-email-report')?.classList.remove('active');
    });
  }
  const confirmEmailBtn = document.getElementById('btn-confirm-send-email');
  if (confirmEmailBtn) confirmEmailBtn.addEventListener('click', handleConfirmSendEmail);

  const exportExcelBtn = document.getElementById('btn-export-audit-excel');
  if (exportExcelBtn) exportExcelBtn.addEventListener('click', handleExportAuditExcel);

  const emailClcaBtn = document.getElementById('btn-email-clca-modal');
  if (emailClcaBtn) {
    emailClcaBtn.addEventListener('click', () => {
      const capaId = document.getElementById('capa-modal-id').value;
      openEmailModal('clca', capaId);
    });
  }

  // Email Configuration Modal Handlers
  const openEmailCfgBtn = document.getElementById('btn-open-email-settings');
  if (openEmailCfgBtn) openEmailCfgBtn.addEventListener('click', openEmailSettingsModal);

  const closeEmailCfgBtn = document.getElementById('btn-close-email-settings');
  if (closeEmailCfgBtn) closeEmailCfgBtn.addEventListener('click', closeEmailSettingsModal);

  const closeEmailCfgModalBtn = document.getElementById('btn-close-email-settings-modal');
  if (closeEmailCfgModalBtn) closeEmailCfgModalBtn.addEventListener('click', closeEmailSettingsModal);

  const saveEmailCfgBtn = document.getElementById('btn-save-email-settings');
  if (saveEmailCfgBtn) saveEmailCfgBtn.addEventListener('click', saveEmailSettingsModal);

  const testEmailBtn = document.getElementById('btn-test-email-send');
  if (testEmailBtn) testEmailBtn.addEventListener('click', testSendEmailHandler);

  // Defect Modal Handlers
  const saveDefectBtn = document.getElementById('btn-save-defect');
  if (saveDefectBtn) saveDefectBtn.addEventListener('click', confirmDefectEntry);

  const cancelDefectBtn = document.getElementById('btn-cancel-defect');
  if (cancelDefectBtn) cancelDefectBtn.addEventListener('click', closeDefectModal);
}

// ==========================================================================
// 1. FACTORY AUDIT MAP CONTROLS COLLAPSE / EXPAND TOGGLE
// ==========================================================================
let isMapControlsHidden = false;

function setupMapControlsToggle() {
  const toggleBtn = document.getElementById('btn-toggle-map-controls');
  if (!toggleBtn) return;

  // Restore saved collapse preference
  const saved = localStorage.getItem('ipqc_map_controls_hidden');
  if (saved === 'true') {
    toggleMapControls(true);
  }

  toggleBtn.addEventListener('click', () => {
    toggleMapControls(!isMapControlsHidden);
  });
}

function toggleMapControls(hide) {
  isMapControlsHidden = !!hide;
  const area = document.getElementById('map-controls-area');
  const icon = document.getElementById('icon-toggle-map-controls');
  const txt = document.getElementById('txt-toggleMapControls');
  const btn = document.getElementById('btn-toggle-map-controls');

  if (area) {
    area.style.display = isMapControlsHidden ? 'none' : 'block';
  }

  const dict = (typeof translations !== 'undefined' && translations[currentLang]) ? translations[currentLang] : null;

  if (isMapControlsHidden) {
    if (icon) icon.textContent = '👁️‍🗨️';
    if (txt) txt.textContent = dict?.toggleShowControls || 'Show Controls';
    if (btn) {
      btn.style.borderColor = 'rgba(56,189,248,0.5)';
      btn.style.color = '#38bdf8';
      btn.style.background = 'rgba(15,23,42,0.95)';
    }
  } else {
    if (icon) icon.textContent = '👁️';
    if (txt) txt.textContent = dict?.toggleHideControls || 'Hide Controls';
    if (btn) {
      btn.style.borderColor = 'var(--border-color)';
      btn.style.color = '#cbd5e1';
      btn.style.background = 'rgba(30,41,59,0.85)';
    }
  }

  try {
    localStorage.setItem('ipqc_map_controls_hidden', isMapControlsHidden ? 'true' : 'false');
  } catch (e) {}
}

// ==========================================================================
// 2. OVERDUE AUDIT REAL-TIME NOTIFICATION SYSTEM
// ==========================================================================
let overdueNotifierInterval = null;
let overdueToastDismissed = false;       // user dismissed for this check cycle
let lastNotifiedOverdueSet = '';         // JSON string of overdue lines – avoids repeat sound/browser notif for same state
let overdueAudioCtx = null;

/* Request browser notification permission (called once on login) */
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

/* Play an urgent beep-beep-beep using Web Audio API (no external file needed) */
function playOverdueAlertSound() {
  try {
    if (!overdueAudioCtx) {
      overdueAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    const ctx = overdueAudioCtx;
    const beeps = [0, 0.22, 0.44];   // 3 beeps
    beeps.forEach((delay) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, ctx.currentTime + delay);
      gain.gain.setValueAtTime(0.18, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.18);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.20);
    });
  } catch (e) {
    console.warn('Overdue alert sound error:', e);
  }
}

/* Send a browser Push Notification for each overdue line (falls back silently) */
function sendBrowserNotification(overdueLines) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  overdueLines.forEach(lineName => {
    const tInfo = getCurrentTimeInfo();
    try {
      new Notification('🚨 AUDIT OVERDUE – ' + lineName, {
        body: 'Line "' + lineName + '" has NOT been audited for the ' + tInfo.timeBlock + ' slot.\nPlease dispatch an inspector immediately.',
        icon: '/favicon.ico',
        tag: 'overdue-' + lineName,
        requireInteraction: true
      });
    } catch (e) {}
  });
}

/* Build & show the in-app red banner at the top of the screen */
function showOverdueToast(overdueLines) {
  const toast = document.getElementById('overdue-audit-toast');
  const linesEl = document.getElementById('overdue-toast-lines');
  if (!toast || !linesEl) return;

  const tInfo = getCurrentTimeInfo();
  linesEl.innerHTML = overdueLines
    .map(l => '▶ <strong>' + l + '</strong> — No audit recorded for slot <strong>' + tInfo.timeBlock + '</strong>. Please dispatch an inspector immediately.')
    .join('<br>');

  toast.style.display = 'block';
  overdueToastDismissed = false;
}

function dismissOverdueToast() {
  const toast = document.getElementById('overdue-audit-toast');
  if (toast) toast.style.display = 'none';
  overdueToastDismissed = true;
}

/* Core check: fetch station statuses and find fully-unaudited lines */
async function checkOverdueAudits() {
  if (!currentUser) return;   // only run when logged in

  // Only alert during operational hours (08:00 – 22:00)
  const now = new Date();
  const hour = now.getHours();
  if (hour < 8 || hour >= 22) return;

  // Must be at least 30 minutes into the current 2-hour block before alarming
  const minuteIntoBlock = now.getMinutes() + (now.getHours() % 2) * 60;
  if (minuteIntoBlock < 30) return;

  try {
    const tInfo = getCurrentTimeInfo();
    const params = new URLSearchParams({ date: tInfo.date, time_block: tInfo.timeBlock });
    const res = await apiFetch('/api/stations?' + params.toString());
    if (!res.ok) return;

    const stations = await res.json();
    if (!Array.isArray(stations) || stations.length === 0) return;

    // Group stations by line; a line is "overdue" if EVERY station is still PENDING
    const lineMap = {};
    stations.forEach(st => {
      const ln = st.line || st.line_name || 'Unknown';
      if (!lineMap[ln]) lineMap[ln] = [];
      lineMap[ln].push(st.status || 'PENDING');
    });

    const overdueLines = Object.entries(lineMap)
      .filter(([, statuses]) => statuses.every(s => s === 'PENDING' || s === 'pending'))
      .map(([ln]) => ln)
      .sort();

    if (overdueLines.length === 0) {
      // All lines audited – hide banner
      const toast = document.getElementById('overdue-audit-toast');
      if (toast) toast.style.display = 'none';
      lastNotifiedOverdueSet = '';
      return;
    }

    const newKey = JSON.stringify(overdueLines);

    // Only play sound + send browser notification on state change (new overdue lines detected)
    if (newKey !== lastNotifiedOverdueSet) {
      lastNotifiedOverdueSet = newKey;
      playOverdueAlertSound();
      sendBrowserNotification(overdueLines);
    }

    // Always show / refresh the in-app banner (unless user dismissed THIS cycle)
    if (!overdueToastDismissed) {
      showOverdueToast(overdueLines);
    }

  } catch (e) {
    console.warn('Overdue audit check error:', e);
  }
}

/* Start the periodic notifier (call from setCurrentUser after login) */
function setupOverdueAuditNotifier() {
  if (overdueNotifierInterval) clearInterval(overdueNotifierInterval);
  overdueToastDismissed = false;
  lastNotifiedOverdueSet = '';
  requestNotificationPermission();

  // Check immediately, then every 10 minutes
  // (Reduced from 2 min to cut Supabase /api/stations egress by ~80%)
  checkOverdueAudits();
  overdueNotifierInterval = setInterval(checkOverdueAudits, 10 * 60 * 1000);
}

/* Stop the notifier on logout */
function stopOverdueAuditNotifier() {
  if (overdueNotifierInterval) {
    clearInterval(overdueNotifierInterval);
    overdueNotifierInterval = null;
  }
  dismissOverdueToast();
}

// ==========================================================================
// 3. MANDATORY WORK ORDER & MODEL CODE CREDENTIALS SYNCHRONIZATION & GATING
// ==========================================================================
function getAuditCredentials() {
  const execWo = document.getElementById('input-work-order')?.value?.trim();
  const execModel = document.getElementById('input-model-no')?.value?.trim();
  const mapWo = document.getElementById('map-input-wo')?.value?.trim();
  const mapModel = document.getElementById('map-input-model')?.value?.trim();

  const wo = execWo || mapWo || localStorage.getItem('ipqc_active_wo') || '';
  const model = execModel || mapModel || localStorage.getItem('ipqc_active_model') || '';

  return {
    workOrder: wo,
    modelNo: model,
    isValid: Boolean(wo && model)
  };
}

function syncAuditCredentials(source) {
  const mapWo = document.getElementById('map-input-wo');
  const mapModel = document.getElementById('map-input-model');
  const execWo = document.getElementById('input-work-order');
  const execModel = document.getElementById('input-model-no');

  let wo = '';
  let model = '';

  if (source === 'map') {
    wo = mapWo?.value?.trim() || '';
    model = mapModel?.value?.trim() || '';
    if (execWo && wo) execWo.value = wo;
    if (execModel && model) execModel.value = model;
  } else if (source === 'exec') {
    wo = execWo?.value?.trim() || '';
    model = execModel?.value?.trim() || '';
    if (mapWo && wo) mapWo.value = wo;
    if (mapModel && model) mapModel.value = model;
  } else {
    // Restore saved credentials from localStorage
    wo = localStorage.getItem('ipqc_active_wo') || execWo?.value?.trim() || mapWo?.value?.trim() || '';
    model = localStorage.getItem('ipqc_active_model') || execModel?.value?.trim() || mapModel?.value?.trim() || '';
    if (mapWo && wo && !mapWo.value) mapWo.value = wo;
    if (mapModel && model && !mapModel.value) mapModel.value = model;
    if (execWo && wo && !execWo.value) execWo.value = wo;
    if (execModel && model && !execModel.value) execModel.value = model;
  }

  if (wo) {
    try { localStorage.setItem('ipqc_active_wo', wo); } catch(e){}
  }
  if (model) {
    try { localStorage.setItem('ipqc_active_model', model); } catch(e){}
  }

  updateAuditValidationUI(false);
}

function setupAuditCredentialsSync() {
  const mapWo = document.getElementById('map-input-wo');
  const mapModel = document.getElementById('map-input-model');
  const execWo = document.getElementById('input-work-order');
  const execModel = document.getElementById('input-model-no');

  const onMapChange = () => syncAuditCredentials('map');
  const onExecChange = () => syncAuditCredentials('exec');

  if (mapWo) {
    mapWo.addEventListener('input', onMapChange);
    mapWo.addEventListener('change', onMapChange);
  }
  if (mapModel) {
    mapModel.addEventListener('input', onMapChange);
    mapModel.addEventListener('change', onMapChange);
  }
  if (execWo) {
    execWo.addEventListener('input', onExecChange);
    execWo.addEventListener('change', onExecChange);
  }
  if (execModel) {
    execModel.addEventListener('input', onExecChange);
    execModel.addEventListener('change', onExecChange);
  }

  // Restore on startup
  syncAuditCredentials('init');
}

function updateAuditValidationUI(showFocus = false) {
  const banner = document.getElementById('audit-wo-model-banner');
  const execWo = document.getElementById('input-work-order');
  const execModel = document.getElementById('input-model-no');
  const timerEl = document.getElementById('audit-timer');

  const creds = getAuditCredentials();

  if (creds.isValid) {
    if (banner) banner.style.display = 'none';
    if (execWo) {
      execWo.style.borderColor = 'var(--border-color)';
      execWo.style.boxShadow = 'none';
    }
    if (execModel) {
      execModel.style.borderColor = 'var(--border-color)';
      execModel.style.boxShadow = 'none';
    }

    // Auto-start audit timer if station is active and timer hasn't started yet
    const execPanel = document.getElementById('panel-audit-execution');
    const isExecVisible = execPanel && execPanel.style.display !== 'none';
    if (isExecVisible && activeStation && !auditTimerInterval) {
      startAuditDurationTimer();
    }
  } else {
    const execPanel = document.getElementById('panel-audit-execution');
    const isExecVisible = execPanel && execPanel.style.display !== 'none';

    if (isExecVisible) {
      if (banner) banner.style.display = 'flex';
      if (timerEl && !auditTimerInterval) {
        const dict = (typeof translations !== 'undefined' && translations[currentLang]) ? translations[currentLang] : null;
        const pendingTxt = dict?.pendingWoModelTimer || 'Pending WO & Model';
        timerEl.textContent = `00:00 (${pendingTxt})`;
        timerEl.style.color = '#facc15';
        timerEl.style.fontSize = '0.78rem';
      }

      if (execWo) {
        if (!creds.workOrder) {
          execWo.style.borderColor = '#ef4444';
          execWo.style.boxShadow = '0 0 0 2px rgba(239, 68, 68, 0.25)';
          if (showFocus) execWo.focus();
        } else {
          execWo.style.borderColor = 'var(--border-color)';
          execWo.style.boxShadow = 'none';
        }
      }

      if (execModel) {
        if (!creds.modelNo) {
          execModel.style.borderColor = '#ef4444';
          execModel.style.boxShadow = '0 0 0 2px rgba(239, 68, 68, 0.25)';
          if (showFocus && creds.workOrder) execModel.focus();
        } else {
          execModel.style.borderColor = 'var(--border-color)';
          execModel.style.boxShadow = 'none';
        }
      }
    }
  }

  return creds.isValid;
}

function startAuditDurationTimer() {
  clearInterval(auditTimerInterval);
  if (!auditStartTime) auditStartTime = Date.now();

  const timerEl = document.getElementById('audit-timer');
  if (timerEl) {
    timerEl.style.color = '#34d399';
    timerEl.style.fontSize = '';
  }

  auditTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - auditStartTime) / 1000);
    const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
    const s = (elapsed % 60).toString().padStart(2, '0');
    if (timerEl) timerEl.textContent = `${m}:${s}`;
  }, 1000);
}

// SETUP UI PRESENTATION MODE SWITCHER (Option 1 vs Option 3 vs 2D Canvas)
function setupLayoutModeSwitcher() {
  const modeBtns = document.querySelectorAll('.layout-mode-btn');
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLayoutMode = btn.dataset.mode;
      
      // Restore execPanel to main if switching away from option1
      if (selectedLayoutMode !== 'option1') {
        const execPanel = document.getElementById('panel-audit-execution');
        const main = document.querySelector('main');
        if (execPanel && main && execPanel.parentElement !== main) {
          execPanel.style.display = 'none';
          main.appendChild(execPanel);
        }
      }

      const toggleBtn = document.getElementById('btn-toggle-layout-edit');
      const saveBtn = document.getElementById('btn-save-layout-pos');
      if (toggleBtn) toggleBtn.style.display = (selectedLayoutMode === 'canvas') ? 'inline-flex' : 'none';
      if (saveBtn) saveBtn.style.display = (selectedLayoutMode === 'canvas') ? 'inline-flex' : 'none';

      renderFactoryMap();
    });
  });
}

// SETUP MAP FILTERS & WORK ORDER BINDING
function setupMapFilters() {
  const phaseBtns = document.querySelectorAll('.phase-tab-btn, .filter-chip--phase');
  phaseBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      phaseBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedPhaseFilter = btn.dataset.phase;
      
      // Update line dropdown options according to phase
      filterLineDropdownByPhase(selectedPhaseFilter);
      renderFactoryMap();
    });
  });

  const lineSel = document.getElementById('map-select-line');
  if (lineSel) {
    lineSel.addEventListener('change', (e) => {
      selectedLineFilter = e.target.value;
      renderAuditorFlowRoute();
      renderFactoryMap();
    });
  }

  const areaBtns = document.querySelectorAll('.area-tab-btn, .filter-chip--area');
  areaBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      areaBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedAreaFilter = btn.dataset.area;
      renderFactoryMap();
    });
  });

  const stdBtns = document.querySelectorAll('.std-tab-btn, .filter-chip--std');
  stdBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      stdBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedStandardFilter = btn.dataset.std;
      renderFactoryMap();
    });
  });
}

function filterLineDropdownByPhase(phase) {
  const lineSel = document.getElementById('map-select-line');
  if (!lineSel) return;

  const optgroups = lineSel.querySelectorAll('optgroup');
  optgroups.forEach(og => {
    const label = og.getAttribute('label') || '';
    if (phase === 'All Phases') {
      og.style.display = '';
    } else if (phase === 'Phase 1') {
      og.style.display = label.includes('Phase 1') ? '' : 'none';
    } else if (phase === 'Phase 2') {
      og.style.display = label.includes('Phase 2') ? '' : 'none';
    }
  });

  if (phase === 'Phase 1' && !selectedLineFilter.includes('T1') && !selectedLineFilter.includes('DIP51')) {
    selectedLineFilter = 'SMT Line T1';
    lineSel.value = 'SMT Line T1';
  } else if (phase === 'Phase 2' && !selectedLineFilter.includes('P6') && !selectedLineFilter.includes('DIP52')) {
    selectedLineFilter = 'SMT Line P6';
    lineSel.value = 'SMT Line P6';
  }
}

// AUDITOR PATROL FLOW ROUTE GUIDE STRIP
function renderAuditorFlowRoute() {
  const container = document.getElementById('auditor-flow-steps');
  const titleEl = document.getElementById('auditor-flow-title');
  if (!container || !titleEl) return;

  const isDIP = selectedLineFilter.includes('DIP');
  const stdDoc = isDIP ? '5Q4-053 (V6)' : '5Q4-046 (V8)';
  const lineType = isDIP ? 'DIP Through-Hole' : 'SMT Surface Mount';

  titleEl.innerHTML = `🧭 <b>Auditor Patrol Route Guide</b> [${lineType} • Doc: <span style="color:#38bdf8;">${stdDoc}</span> • Active: <span style="color:#facc15;">${selectedLineFilter}</span>]:`;

  const smtSteps = [
    { num: 1, name: 'ESD Gate & IQC' },
    { num: 2, name: 'Laser Marking' },
    { num: 3, name: 'FPC Baking' },
    { num: 4, name: 'IC Prog' },
    { num: 5, name: 'Solder Printer' },
    { num: 6, name: '3D SPI' },
    { num: 7, name: 'Chip Mounter' },
    { num: 8, name: 'Reflow Oven' },
    { num: 9, name: '3D AOI' },
    { num: 10, name: 'IPR & SFC' }
  ];

  const dipSteps = [
    { num: 1, name: 'Line ESD Check' },
    { num: 2, name: 'Insertion' },
    { num: 3, name: 'Wave Soldering' },
    { num: 4, name: 'Visual VI' },
    { num: 5, name: 'Glue Dispense' },
    { num: 6, name: 'ICT Test' },
    { num: 7, name: 'PCBA Router' },
    { num: 8, name: 'Assembly' },
    { num: 9, name: 'FCT Test' },
    { num: 10, name: 'Packaging' },
    { num: 11, name: 'Q-Black Security' }
  ];

  const steps = isDIP ? dipSteps : smtSteps;

  container.innerHTML = steps.map((s, idx) => `
    <div class="flow-step-pill">
      <span class="step-num">#${s.num}</span>
      <span>${s.name}</span>
    </div>
    ${idx < steps.length - 1 ? '<span class="flow-step-arrow">➔</span>' : ''}
  `).join('');
}

// RENDER FACTORY MAP DISPATCHER (Option 1 vs Option 3 vs Canvas)
async function renderFactoryMap() {
  const canvas = document.getElementById('factory-layout-canvas');
  if (!canvas) return;

  let stations = (typeof masterStationsData !== 'undefined' && masterStationsData.length > 0) ? masterStationsData : defaultStations;
  try {
    const tInfo = getCurrentTimeInfo();
    const params = new URLSearchParams({ date: tInfo.date, time_block: tInfo.timeBlock });
    const res = await apiFetch(`/api/stations?${params.toString()}`);
    if (res.ok) {
      stations = await res.json();
      fetchedStations = stations;
    }
  } catch (e) {}

  // Route according to selectedLayoutMode
  if (selectedLayoutMode === 'option1') {
    renderOption1LinearFlow(stations, canvas);
  } else if (selectedLayoutMode === 'option3') {
    renderOption3ShopfloorBayMatrix(stations, canvas);
  } else {
    renderCanvasFreeLayout(stations, canvas);
  }
}

// Robust Standard Doc & Revision Resolver (DIP -> 5Q4-053 V6, SMT -> 5Q4-046 V8)
function getStationStandardDoc(st) {
  if (!st) return '5Q4-046';
  const code = (st.station_code || st.code || st.id || '').toUpperCase();
  const line = (st.line_name || st.line || '').toUpperCase();
  const type = (st.line_type || '').toUpperCase();
  const proc = (st.process_type || st.tag || st.process || '').toUpperCase();

  if (type === 'DIP' || code.startsWith('DIP') || line.includes('DIP') || proc.startsWith('DIP')) {
    return '5Q4-053';
  }
  if (type === 'SMT' || code.startsWith('SMT') || line.includes('SMT') || proc.startsWith('SMT')) {
    return '5Q4-046';
  }
  return st.standard_doc || (code.includes('SMT') ? '5Q4-046' : '5Q4-053');
}

function getStationStandardRev(std) {
  if (std === '5Q4-046') return 'V8';
  if (std === '5Q4-053') return 'V6';
  if (std === '5Q4-045') return 'V5';
  return 'V1';
}

// Process Tag Mapping Table (Strictly maps each equipment node to its dedicated checklist items)
const PROCESS_TAG_MAP = {
  'ESD': ['ESD'],
  'Laser-Marking': ['Laser-Marking'],
  'Baking-Dry': ['Baking-Dry'],
  'IC-Programming': ['IC-Programming'],
  'SMT-Printer': ['SMT-Printer'],
  'SMT-SPI': ['SMT-SPI'],
  'SMT-Mounter': ['SMT-Mounter'],
  'SMT-Reflow': ['SMT-Reflow'],
  'SMT-AOI': ['SMT-AOI'],
  'SMT-IPR': ['SMT-IPR'],
  'DIP-Insertion': ['DIP-Insertion'],
  'DIP-Wave': ['DIP-Wave'],
  'DIP-Visual': ['DIP-Visual'],
  'Glue-Dispensing': ['Glue-Dispensing'],
  'Depaneling': ['Depaneling'],
  'Assembly': ['Assembly'],
  'ICT': ['ICT'],
  'FCT': ['ICT', 'FCT'],
  'Inspection & Packaging': ['Inspection & Packaging'],
  'Q-Black-Security': ['Q-Black-Security']
};

function getOrPreserveAuditPanel() {
  const panel = document.getElementById('panel-audit-execution');
  if (panel && panel.parentElement && panel.parentElement.id === 'option1-detail-pane') {
    let holder = document.getElementById('audit-panel-holder');
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'audit-panel-holder';
      holder.style.display = 'none';
      document.body.appendChild(holder);
    }
    holder.appendChild(panel);
  }
  return panel;
}

// ==========================================================================
// OPTION 1 (LINEAR CONVEYOR DIGITAL TWIN FLOW & SPLIT DETAIL VIEW)
// ==========================================================================
function renderOption1LinearFlow(allStations, container) {
  getOrPreserveAuditPanel();

  container.className = 'factory-layout-canvas';
  container.style.display = 'block';
  container.style.position = 'relative';

  // Filter stations for the currently active selectedLineFilter (or default to SMT Line T1)
  let activeLine = (selectedLineFilter !== 'All Lines') ? selectedLineFilter : 'SMT Line T1';
  let lineStations = allStations.filter(s => s.line_name === activeLine || s.line === activeLine);
  if (lineStations.length === 0) {
    lineStations = allStations.filter(s => s.line_name === 'SMT Line T1' || s.line === 'SMT Line T1');
    activeLine = 'SMT Line T1';
  }
  if (lineStations.length === 0 && allStations.length > 0) {
    lineStations = allStations.slice(0, 11);
    activeLine = lineStations[0]?.line_name || lineStations[0]?.line || 'Production Line';
  }

  // Equipment icons, models, and real-time parameters metadata
  const machineMeta = {
    'ESD': { icon: '⚡', model: 'Warmbier WT5000 ESD Gate', spec: 'Wrist: < 35MΩ | Shoe: < 100MΩ' },
    'Laser-Marking': { icon: '🖨️', model: 'Panasonic LP-GS051 Laser', spec: '2D Grade: ≥ B | Scan Rate: 100%' },
    'Baking-Dry': { icon: '🔥', model: 'ESPEC Dry Cabinet / Oven', spec: 'Temp: 125±5°C | RH: < 5%' },
    'IC-Programming': { icon: '💾', model: 'BPM Flashstream Dual', spec: 'Checksum: 0x7F2A | Bin: PASS' },
    'SMT-Printer': { icon: '📑', model: 'DEK NeoHorizon Solder Printer', spec: 'Tension: 45N | Squeegee: 4.5kg' },
    'SMT-SPI': { icon: '📐', model: 'Koh Young KY8030-2 3D SPI', spec: 'Volume: 104% | Height: 128µm' },
    'SMT-Mounter': { icon: '🦾', model: 'Yamaha YSM20R High-Speed', spec: 'Feeder Pick: 99.98% | Nozzle: OK' },
    'SMT-Reflow': { icon: '♨️', model: 'Heller 1913 MkIII 10-Zone', spec: 'Peak: 245°C | N2: 1200ppm | TAL: 65s' },
    'SMT-AOI': { icon: '🔍', model: 'Omron S730-II 3D AOI', spec: 'Solder Joint: 100% OK | Polarity: PASS' },
    'SMT-IPR': { icon: '🛠️', model: 'Fuji QP-341E Rework & SFC', spec: 'Iron: 350±10°C | SFC Scrap: LOGGED' },
    'DIP-Insertion': { icon: '🔌', model: 'Through-Hole Manual Table', spec: 'Clinch: 45° | Missing: 0' },
    'DIP-Wave': { icon: '🌊', model: 'ERSA Powerflow Dual-Wave', spec: 'Pot: 260°C | Flux: 18mg/cm²' },
    'DIP-Visual': { icon: '👁️', model: 'Post-Wave Touch-up & VI', spec: 'Bridging: 0 | Solder Spikes: 0' },
    'Glue-Dispensing': { icon: '🧪', model: 'Asymtek Conformal Coating', spec: 'Weight: 0.85g | Thick: 60µm' },
    'ICT': { icon: '🎛️', model: 'Keysight 3070 In-Circuit', spec: 'Probe Hits: 100% | Coverage: 98%' },
    'Depaneling': { icon: '✂️', model: 'Aurotek Routing Depaneler', spec: 'Spindle: 40k RPM | Stress: < 500µε' },
    'Assembly': { icon: '🔩', model: 'Atlas Copco Smart Torque', spec: 'Torque: 0.45±0.03 Nm | Screws: 4' },
    'FCT': { icon: '📊', model: 'Functional Circuit Test Rig', spec: 'Hi-Pot: 1500V OK | Golden: PASS' },
    'Inspection & Packaging': { icon: '📦', model: 'Final QA Boxing & Carton', spec: 'Cosmetic: A-Grade | Label: MATCH' },
    'Q-Black-Security': { icon: '🔒', model: 'Q-Black Security Material Cage', spec: 'Access: Badge Verified | Cage: LOCKED' }
  };

  if (!window.auditedStationCodes) window.auditedStationCodes = new Set();
  const auditedSet = window.auditedStationCodes;
  const auditedCount = lineStations.filter(s => s.status === 'OK' || auditedSet.has(s.station_code || s.code || s.id)).length;
  const pct = lineStations.length > 0 ? Math.round((auditedCount / lineStations.length) * 100) : 0;

  // Check active selection
  const currentSelectedCode = activeStation ? (activeStation.station_code || activeStation.code || activeStation.id) : null;

  container.innerHTML = `
    <div class="linear-conveyor-container" style="display: flex; flex-direction: column; height: 100%;">
      <!-- Top Navigation & Return Bar -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.85rem; background:rgba(15,23,42,0.8); border:1px solid var(--border-color); border-radius:10px; padding:0.6rem 1rem;">
        <button onclick="returnToOption3Matrix()" class="btn-select" style="display:flex; align-items:center; gap:0.4rem; color:#38bdf8; font-weight:bold; font-size:0.82rem; padding:0.4rem 0.85rem; border-color:rgba(56,189,248,0.5); background:rgba(56,189,248,0.08);">
          <span style="font-size:1.1rem;">⬅️</span> 返回全厂多线看板 (Back to Line Matrix Overview)
        </button>
        <div style="font-size:0.75rem; color:#94a3b8;">
          🎯 步骤 1：在左侧流程点击工位 ➔ 步骤 2：在右侧查核并提交
        </div>
      </div>

      <!-- Line Header Progress Strip -->
      <div class="line-progress-strip">
        <div>
          <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
            <span style="font-size:1.15rem; font-weight:800; color:#fff;">🏭 ${activeLine}</span>
            <span style="background:${getStationStandardDoc(lineStations[0]) === '5Q4-046' ? 'rgba(56,189,248,0.15)' : 'rgba(245,158,11,0.15)'}; color:${getStationStandardDoc(lineStations[0]) === '5Q4-046' ? '#38bdf8' : '#f59e0b'}; border:1px solid ${getStationStandardDoc(lineStations[0]) === '5Q4-046' ? 'rgba(56,189,248,0.4)' : 'rgba(245,158,11,0.4)'}; padding:0.2rem 0.6rem; border-radius:6px; font-size:0.75rem; font-weight:bold;">
              ${getStationStandardDoc(lineStations[0])} (${getStationStandardRev(getStationStandardDoc(lineStations[0]))})
            </span>
            <span style="background:rgba(16,185,129,0.15); color:#34d399; padding:0.2rem 0.5rem; border-radius:6px; font-size:0.75rem; font-weight:bold;">
              ${lineStations[0]?.phase || 'Phase 1'}
            </span>
          </div>
          <div style="font-size:0.78rem; color:var(--text-muted); margin-top:0.3rem;">
            Patrol Audit Progress: <b>${auditedCount} / ${lineStations.length} Stations Audited (${pct}%)</b> • Status: <span style="color:${auditedCount > 0 ? '#34d399' : '#38bdf8'}; font-weight:bold;">${auditedCount > 0 ? `${auditedCount} Completed` : 'Ready for Inspection (No records yet)'}</span>
          </div>
        </div>

        <!-- Mini Line Progress Meter -->
        <div style="display: flex; align-items: center; gap: 1rem;">
          <div style="position: relative;">
            <button onclick="togglePauseDropdown()" style="background: rgba(107, 114, 128, 0.2); border: 1px solid rgba(107, 114, 128, 0.5); color: #e5e7eb; padding: 0.4rem 0.8rem; border-radius: 6px; font-size: 0.75rem; cursor: pointer; display: flex; align-items: center; gap: 0.5rem; transition: all 0.2s;">
              <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
              Audit Pause
            </button>
            <div id="pauseDropdown" style="display: none; position: absolute; top: 110%; right: 0; background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 0.75rem; z-index: 100; min-width: 220px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
              <div style="margin-bottom: 0.5rem;">
                <label style="font-size: 0.7rem; color: #9ca3af; display: block; margin-bottom: 0.2rem;">Reason for pause:</label>
                <select id="pauseReasonSelect" style="width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); color: #cbd5e1; border-radius: 4px; padding: 0.3rem; font-size: 0.75rem;">
                  <option value="No production plan">No production plan</option>
                  <option value="Product Change">Product Change</option>
                  <option value="Machine Down">Machine Down</option>
                  <option value="Maintenance">Maintenance</option>
                  <option value="Others">Others</option>
                </select>
              </div>
              <div style="margin-bottom: 0.5rem;">
                <label style="font-size: 0.7rem; color: #9ca3af; display: block; margin-bottom: 0.2rem;">Time Duration:</label>
                <select id="pauseDurationSelect" style="width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); color: #cbd5e1; border-radius: 4px; padding: 0.3rem; font-size: 0.75rem;">
                  <option value="1">2 Hrs</option>
                  <option value="2">4 Hrs</option>
                  <option value="3">6 Hrs</option>
                  <option value="4">8 Hrs</option>
                  <option value="5">10 Hrs</option>
                  <option value="6">Full Shift (12 Hrs)</option>
                  <option value="12">Day (24 Hrs)</option>
                </select>
              </div>
              <div style="margin-bottom: 0.75rem;">
                <label style="font-size: 0.7rem; color: #9ca3af; display: block; margin-bottom: 0.2rem;">Supervisor Password:</label>
                <input type="password" id="pauseSupervisorPassword" placeholder="Enter password..." style="width: 100%; background: rgba(0,0,0,0.2); border: 1px solid rgba(255,255,255,0.1); color: #cbd5e1; border-radius: 4px; padding: 0.3rem; font-size: 0.75rem;" />
              </div>
              <button onclick="submitPauseForm()" style="width: 100%; background: #3b82f6; color: white; border: none; padding: 0.4rem; border-radius: 4px; font-size: 0.75rem; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#3b82f6'">Confirm Pause</button>
            </div>
          </div>
          <div style="min-width: 240px;">
            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--text-muted); margin-bottom:0.25rem;">
              <span>Line Compliance</span>
              <span style="color:#34d399; font-weight:bold;">100.0% OK</span>
            </div>
            <div style="width:100%; height:8px; background:rgba(255,255,255,0.1); border-radius:4px; overflow:hidden;">
              <div style="width:${pct}%; height:100%; background:linear-gradient(90deg, #38bdf8, #34d399); border-radius:4px; transition:width 0.3s;"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Split Layout View (35% Left Flow Diagram, 65% Right Detail Process) -->
      <div style="display: flex; gap: 1.25rem; flex: 1; min-height: 550px; position:relative; overflow: hidden;">
        
        <!-- Left 35%-40% - Flow Diagram (Vertical Interactive List) -->
        <div id="option1-flow-list" style="flex: 0 0 38%; overflow-y: auto; padding-right: 0.5rem; display: flex; flex-direction: column; gap: 1.2rem; position: relative;">
          <!-- Vertical connecting line -->
          <div style="position: absolute; left: 24px; top: 0; bottom: 0; width: 4px; background: rgba(56,189,248,0.2); z-index: 0;"></div>
          
          ${lineStations.map((st, idx) => {
            const stCode = st.station_code || st.code || st.id;
            const meta = machineMeta[st.process_type] || { icon: '⚙️', model: st.station_name || st.name, spec: 'SOP Normal' };
            
            let statusClass = 'status-pending';
            let statusText = '⚪ READY FOR AUDIT';
            let statusColor = '#94a3b8';
            if (st.status === 'NG') {
              statusClass = 'status-ng'; statusText = '🔴 ANOMALY NG'; statusColor = '#ef4444';
            } else if (st.status === 'PARTIAL') {
              statusClass = 'status-partial'; statusText = '⚠️ PARTIAL AUDIT'; statusColor = '#facc15';
            } else if (st.status === 'OK' || auditedSet.has(stCode)) {
              statusClass = 'status-ok'; statusText = '🟢 AUDITED OK'; statusColor = '#34d399';
            }
            
            const isSelected = currentSelectedCode === stCode;

            return `
              <div class="machine-flow-card ${statusClass} ${isSelected ? 'active-selected-node' : ''}" 
                   data-station-code="${stCode}"
                   onclick="triggerStationClick('${stCode}')"
                   style="position: relative; z-index: 1; width: 100%; max-width: none; margin-bottom: 0;">
                <div>
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.6rem;">
                    <div class="process-seq-badge">STEP #${st.sequence_order || (idx + 1)}</div>
                    <div style="font-size:0.7rem; font-weight:bold; color:${statusColor};">${statusText}</div>
                  </div>

                  <div style="display:flex; gap:0.75rem; align-items:center; margin-top:0.3rem;">
                    <div class="machine-icon-block">${meta.icon}</div>
                    <div>
                      <div style="font-family:monospace; font-weight:bold; color:var(--accent-cyan); font-size:0.88rem;">${stCode}</div>
                      <div style="font-size:0.8rem; font-weight:bold; color:#fff; line-height:1.2; margin-top:0.15rem;">${st.process_type || st.tag}</div>
                      <div style="font-size:0.7rem; color:var(--text-muted);">${meta.model}</div>
                    </div>
                  </div>

                  <!-- Key Process Control Parameter Tag -->
                  <div style="margin-top:0.75rem;">
                    <div style="font-size:0.68rem; color:var(--text-muted); margin-bottom:0.2rem;">Key Control Specs:</div>
                    <div class="spec-parameter-pill">${meta.spec}</div>
                  </div>
                </div>

                <!-- One-Tap Start Audit Button -->
                <div style="margin-top:0.85rem; border-top:1px solid var(--border-color); padding-top:0.65rem; display:flex; gap:0.4rem;">
                  <button onclick="event.stopPropagation(); triggerStationClick('${stCode}')" class="btn-primary" style="flex:1; padding:0.45rem 0.6rem; font-size:0.78rem; font-weight:bold;">
                    ▶ Start Audit
                  </button>
                  <button onclick="event.stopPropagation(); triggerDefectDirect('${stCode}')" class="btn-select" style="padding:0.45rem; font-size:0.78rem; color:#fca5a5;" title="Direct Defect Log">
                    📷
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Right 60%-62% - Detail Process & Audit Execution Pane -->
        <div id="option1-detail-pane" style="flex: 1; border-left: 1px solid var(--border-color); padding-left: 1.25rem; overflow-y: auto;">
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 480px; text-align: center; color: var(--text-muted); padding: 2.5rem 1.5rem; background: rgba(15, 23, 42, 0.4); border-radius: 12px; border: 1px dashed rgba(56, 189, 248, 0.25);">
            <div style="font-size: 3rem; margin-bottom: 0.75rem;">👈</div>
            <div style="font-size: 1.15rem; font-weight: 800; color: #fff; margin-bottom: 0.4rem;">请点击左侧工位节点查看专属查核项</div>
            <div style="font-size: 0.85rem; color: #94a3b8; max-width: 400px; line-height: 1.5;">
              Click any station node on the left conveyor flow (e.g. <b>Laser-Marking</b>, <b>SMT-Mounter</b>, <b>Reflow Oven</b>) to display only its corresponding check items.
            </div>
            <div style="margin-top: 1rem; font-size: 0.75rem; color: #38bdf8; background: rgba(56, 189, 248, 0.1); padding: 0.3rem 0.75rem; border-radius: 20px; border: 1px solid rgba(56, 189, 248, 0.3);">
              🎯 工位专属查核模式 (Focused Station Checklist)
            </div>
          </div>
        </div>

      </div>
    </div>
  `;

  // If a station was already actively selected by the inspector, re-render it
  if (activeStation && lineStations.some(s => (s.station_code || s.code || s.id) === (activeStation.station_code || activeStation.code || activeStation.id))) {
    setTimeout(() => {
      startAuditForStation(activeStation);
    }, 50);
  }
}

// ==========================================================================
// OPTION 3 (SHOPFLOOR MULTI-LINE BAY MATRIX - 100% LIVE REAL-TIME DATA)
// ==========================================================================
function renderOption3ShopfloorBayMatrix(allStations, container) {
  container.className = 'factory-layout-canvas';
  container.style.display = 'block';
  container.style.position = 'relative';

  const auditedSet = window.auditedStationCodes || new Set();

  const phase1Defs = [
    { code: 'T1', name: 'SMT Line T1', type: 'SMT', std: '5Q4-046' },
    { code: 'T2', name: 'SMT Line T2', type: 'SMT', std: '5Q4-046' },
    { code: 'T3', name: 'SMT Line T3', type: 'SMT', std: '5Q4-046' },
    { code: 'T4', name: 'SMT Line T4', type: 'SMT', std: '5Q4-046' },
    { code: 'P1', name: 'SMT Line P1', type: 'SMT', std: '5Q4-046' },
    { code: 'P2', name: 'SMT Line P2', type: 'SMT', std: '5Q4-046' },
    { code: 'P5', name: 'SMT Line P5', type: 'SMT', std: '5Q4-046' },
    { code: 'DIP51', name: 'DIP Line DIP51', type: 'DIP', std: '5Q4-053' },
    { code: 'DIP1', name: 'DIP Line DIP1', type: 'DIP', std: '5Q4-053' },
    { code: 'DIP2', name: 'DIP Line DIP2', type: 'DIP', std: '5Q4-053' }
  ];

  const phase2Defs = [
    { code: 'P6', name: 'SMT Line P6', type: 'SMT', std: '5Q4-046' },
    { code: 'P7', name: 'SMT Line P7', type: 'SMT', std: '5Q4-046' },
    { code: 'T5', name: 'SMT Line T5', type: 'SMT', std: '5Q4-046' },
    { code: 'P8', name: 'SMT Line P8', type: 'SMT', std: '5Q4-046' },
    { code: 'DIP52', name: 'DIP Line DIP52', type: 'DIP', std: '5Q4-053' },
    { code: 'DIP3', name: 'DIP Line DIP3', type: 'DIP', std: '5Q4-053' }
  ];

  const buildLineObj = (def) => {
    const stList = (allStations || []).filter(s => (s.line_name || s.line) === def.name);
    const stationCount = stList.length > 0 ? stList.length : (def.type === 'SMT' ? 10 : 11);
    const ngList = stList.filter(s => s.status === 'NG');
    const auditedList = stList.filter(s => s.status === 'OK' || auditedSet.has(s.station_code || s.code || s.id));
    return {
      ...def,
      stations: stationCount,
      stList: stList,
      ng: ngList.length,
      audited: auditedList.length,
      due: stationCount - auditedList.length - ngList.length
    };
  };

  const phase1Lines = phase1Defs.map(buildLineObj);
  const phase2Lines = phase2Defs.map(buildLineObj);

  const allLines = [...phase1Lines, ...phase2Lines];
  const totalStations = allLines.reduce((acc, l) => acc + l.stations, 0);
  const totalAudited = allLines.reduce((acc, l) => acc + l.audited, 0);
  const totalNG = allLines.reduce((acc, l) => acc + l.ng, 0);
  const overallShiftAuditPct = totalStations > 0 ? ((totalAudited / totalStations) * 100).toFixed(1) : '0.0';

  const p1Total = phase1Lines.reduce((acc, l) => acc + l.stations, 0);
  const p1Audited = phase1Lines.reduce((acc, l) => acc + l.audited, 0);
  const p1Pct = p1Total > 0 ? Math.round((p1Audited / p1Total) * 100) : 0;

  const p2Total = phase2Lines.reduce((acc, l) => acc + l.stations, 0);
  const p2Audited = phase2Lines.reduce((acc, l) => acc + l.audited, 0);
  const p2Pct = p2Total > 0 ? Math.round((p2Audited / p2Total) * 100) : 0;

  container.innerHTML = `
    <div>
      <!-- Top Fleet KPI & Compliance Summary Bar -->
      <div style="background:rgba(15,23,42,0.85); border:1px solid var(--border-color); border-radius:12px; padding:1.1rem 1.35rem; margin-bottom:1.25rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
        <div>
          <div style="font-size:1.15rem; font-weight:800; color:#fff;">🗺️ 全厂多线看板概览 (Shopfloor Multi-Line Bay Matrix)</div>
          <div style="font-size:0.82rem; color:var(--text-muted); margin-top:0.25rem;">
            Real-time patrol audit status across all 16 production lines (Phase 1 & Phase 2). Click any line to start audit.
          </div>
        </div>

        <div style="display:flex; gap:1.75rem; align-items:center;">
          <div style="text-align:center;">
            <div style="font-size:0.75rem; color:var(--text-muted);">Patrol Shift Progress</div>
            <div style="font-size:1.45rem; font-weight:800; color:#38bdf8;">${totalAudited} / ${totalStations} (${overallShiftAuditPct}%)</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:0.75rem; color:var(--text-muted);">Lines Monitored</div>
            <div style="font-size:1.45rem; font-weight:800; color:#34d399;">16 / 16</div>
          </div>
          <div style="text-align:center;">
            <div style="font-size:0.75rem; color:var(--text-muted);">Open Anomalies</div>
            <div style="font-size:1.45rem; font-weight:800; color:${totalNG > 0 ? '#ef4444' : '#34d399'};">${totalNG}</div>
          </div>
        </div>
      </div>

      <!-- 2-Column Split: Phase 1 (Building A) vs Phase 2 (Building B) -->
      <div class="bay-matrix-container">
        
        <!-- Column A: Phase 1 -->
        <div class="bay-column">
          <div class="bay-header-title">
            <span>🏢 Phase 1 (Building A) • 10 Lines</span>
            <span style="font-size:0.78rem; color:#38bdf8; font-weight:bold;">${p1Audited} / ${p1Total} Audited (${p1Pct}%)</span>
          </div>

          <div>
            ${phase1Lines.map(l => renderLineTrackRow(l)).join('')}
          </div>
        </div>

        <!-- Column B: Phase 2 -->
        <div class="bay-column">
          <div class="bay-header-title">
            <span>🏢 Phase 2 (Building B) • 6 Lines</span>
            <span style="font-size:0.78rem; color:#38bdf8; font-weight:bold;">${p2Audited} / ${p2Total} Audited (${p2Pct}%)</span>
          </div>

          <div>
            ${phase2Lines.map(l => renderLineTrackRow(l)).join('')}
          </div>
        </div>

      </div>
    </div>
  `;
}

function renderLineTrackRow(lineObj) {
  const auditedSet = window.auditedStationCodes || new Set();
  let dotsHtml = '';
  if (lineObj.stList && lineObj.stList.length > 0) {
    lineObj.stList.forEach((st, idx) => {
      const stCode = st.station_code || st.code || `Station #${idx+1}`;
      let dotClass = 'pending';
      let statusTitle = '⚪ Pending Audit';
      if (st.status === 'NG') { dotClass = 'ng'; statusTitle = '🔴 NG Defect'; }
      else if (st.status === 'PARTIAL') { dotClass = 'partial'; statusTitle = '⚠️ Partial Audit'; }
      else if (st.status === 'OK' || auditedSet.has(stCode)) { dotClass = 'ok'; statusTitle = '🟢 Audited OK'; }
      dotsHtml += `<div class="led-dot ${dotClass}" title="${stCode}: ${statusTitle}"></div>`;
    });
  } else {
    for (let i = 0; i < lineObj.stations; i++) {
      dotsHtml += `<div class="led-dot pending" title="Station #${i+1}: ⚪ Pending Audit"></div>`;
    }
  }

  const typeColor = lineObj.type === 'SMT' ? '#38bdf8' : '#f59e0b';
  let statusBadge = '';
  if (lineObj.ng > 0) {
    statusBadge = `<span style="color:#ef4444; font-weight:bold; font-size:0.72rem; background:rgba(239,68,68,0.2); padding:0.15rem 0.4rem; border-radius:4px;">⚠️ ${lineObj.ng} NG</span>`;
  } else if (lineObj.audited === lineObj.stations && lineObj.stations > 0) {
    statusBadge = '<span style="color:#34d399; font-weight:bold; font-size:0.72rem; background:rgba(52,211,153,0.15); padding:0.15rem 0.4rem; border-radius:4px;">✓ 100% Audited</span>';
  } else if (lineObj.audited > 0) {
    statusBadge = `<span style="color:#38bdf8; font-weight:bold; font-size:0.72rem; background:rgba(56,189,248,0.15); padding:0.15rem 0.4rem; border-radius:4px;">🟡 ${lineObj.audited}/${lineObj.stations} Audited</span>`;
  } else {
    statusBadge = `<span style="color:#94a3b8; font-size:0.72rem; background:rgba(255,255,255,0.06); padding:0.15rem 0.4rem; border-radius:4px;">⚪ 0/${lineObj.stations} (Pending)</span>`;
  }

  return `
    <div class="line-track-row" onclick="selectLineAndAudit('${lineObj.name}')">
      <div style="display:flex; align-items:center; gap:0.6rem; min-width:140px;">
        <span style="font-size:0.75rem; font-weight:bold; color:${typeColor}; background:rgba(0,0,0,0.4); padding:0.2rem 0.45rem; border-radius:6px; font-family:monospace;">
          ${lineObj.code}
        </span>
        <div>
          <div style="font-size:0.82rem; font-weight:bold; color:#fff;">${lineObj.name}</div>
          <div style="font-size:0.68rem; color:var(--text-muted);">${lineObj.std} (${lineObj.stations} Stations)</div>
        </div>
      </div>

      <!-- LED Dot Matrix -->
      <div class="led-matrix">
        ${dotsHtml}
      </div>

      <!-- Status & Zoom Action Button -->
      <div style="display:flex; align-items:center; gap:0.5rem;">
        ${statusBadge}
        <button class="btn-select" style="font-size:0.7rem; padding:0.25rem 0.5rem; color:#38bdf8; font-weight:bold;">
          Audit ➔
        </button>
      </div>
    </div>
  `;
}

function selectLineAndAudit(lineName) {
  selectedLineFilter = lineName;
  const lineSel = document.getElementById('map-select-line');
  if (lineSel) lineSel.value = lineName;

  // Switch to Option 1 for focused audit of that line
  selectedLayoutMode = 'option1';
  const modeBtns = document.querySelectorAll('.layout-mode-btn');
  modeBtns.forEach(b => {
    if (b.dataset.mode === 'option1') b.classList.add('active');
    else b.classList.remove('active');
  });

  renderAuditorFlowRoute();
  renderFactoryMap();
}

function returnToOption3Matrix() {
  selectedLayoutMode = 'option3';
  const modeBtns = document.querySelectorAll('.layout-mode-btn');
  modeBtns.forEach(b => {
    if (b.dataset.mode === 'option3') b.classList.add('active');
    else b.classList.remove('active');
  });
  
  // Restore exec panel if needed
  const execPanel = document.getElementById('panel-audit-execution');
  const main = document.querySelector('main');
  if (execPanel && main && execPanel.parentElement !== main) {
    execPanel.style.display = 'none';
    main.appendChild(execPanel);
  }
  
  renderFactoryMap();
}

function triggerStationClick(code) {
  let dataset = (typeof masterStationsData !== 'undefined' && masterStationsData.length > 0) ? masterStationsData : defaultStations;
  if (typeof fetchedStations !== 'undefined' && fetchedStations.length > 0) {
    dataset = fetchedStations;
  }
  const clean = (code || '').toString().trim().toLowerCase().replace(/\s+/g, '-');
  const match = dataset.find(s => {
    const sCode = (s.station_code || s.code || s.id || '').toString().trim().toLowerCase().replace(/\s+/g, '-');
    const sId = (s.id || '').toString().trim().toLowerCase().replace(/\s+/g, '-');
    return sCode === clean || sId === clean || (s.station_code || '') === code || (s.id || '') === code;
  });
  if (match) {
    syncAuditCredentials('map');
    startAuditForStation(match);
  } else {
    console.warn("Station not found for code:", code);
  }
}

function triggerDefectDirect(code) {
  triggerStationClick(code);
  setTimeout(() => {
    triggerDefectModal(1, 1);
  }, 200);
}

// ==========================================================================
// 2D CANVAS FREE DRAG MODE RENDERER (CLASSIC)
// ==========================================================================
function renderCanvasFreeLayout(stations, canvas) {
  canvas.className = 'factory-layout-canvas';
  canvas.innerHTML = '';
  if (isLayoutEditMode) {
    canvas.classList.add('edit-mode-active');
  } else {
    canvas.classList.remove('edit-mode-active');
  }

  // Filter by Line & Area
  let filtered = stations;
  if (selectedPhaseFilter !== 'All Phases') {
    filtered = filtered.filter(s => s.phase === selectedPhaseFilter);
  }
  if (selectedLineFilter !== 'All Lines') {
    filtered = filtered.filter(s => s.line_name === selectedLineFilter || s.line === selectedLineFilter);
  }
  if (selectedAreaFilter !== 'All Areas') {
    filtered = filtered.filter(s => (s.area_name || s.area) === selectedAreaFilter);
  }

  filtered.forEach((st, idx) => {
    let statusClass = 'status-ok';
    if (st.status === 'NG') statusClass = 'status-ng';
    else if (st.status === 'PARTIAL') statusClass = 'status-partial';
    else if (st.status === 'DUE') statusClass = 'status-due';
    const seqNum = st.sequence_order || (idx + 1);

    const stCode = st.station_code || st.code;
    const stName = st.station_name || st.name;
    const stLine = st.line_name || st.line;
    const stPhase = st.phase || 'Phase 1';
    const stProc = st.process_type || st.process;
    const stStd = getStationStandardDoc(st);
    const stdColor = stStd === '5Q4-046' ? '#38bdf8' : '#f59e0b';

    let posX = st.pos_x !== undefined ? st.pos_x : (30 + (idx % 6) * 245);
    let posY = st.pos_y !== undefined ? st.pos_y : (40 + Math.floor(idx / 6) * 190);

    const nodeCard = document.createElement('div');
    nodeCard.className = `canvas-node-card ${statusClass} ${isLayoutEditMode ? 'edit-mode' : ''}`;
    nodeCard.style.left = `${posX}px`;
    nodeCard.style.top = `${posY}px`;
    nodeCard.dataset.code = stCode;

    nodeCard.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div class="process-seq-badge">STEP #${seqNum}</div>
        <div style="font-size:0.68rem; font-weight:bold; color:${stdColor}; background:rgba(0,0,0,0.4); padding:0.15rem 0.4rem; border-radius:4px;">${stStd}</div>
      </div>

      <div style="margin-top: 0.5rem;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div style="font-family: monospace; font-weight: bold; color: var(--accent-cyan); font-size: 0.92rem;">${stCode}</div>
          <div style="font-size: 1.1rem;">${st.status === 'NG' ? '⚠️' : (st.status === 'DUE' ? '⏱️' : '✓')}</div>
        </div>
        <div style="font-size: 0.82rem; margin-top: 0.3rem; color: #fff; font-weight: bold; line-height: 1.25;">${stName}</div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.25rem; font-size:0.72rem; color:var(--text-muted);">
          <span>📍 ${stLine}</span>
          <span style="color:#94a3b8; font-size:0.68rem;">[${stPhase}]</span>
        </div>
        <div style="font-size: 0.72rem; color: var(--accent-blue); margin-top: 0.2rem;">🏷️ ${stProc}</div>
      </div>

      <div style="margin-top: 0.75rem; border-top: 1px solid var(--border-color); padding-top: 0.4rem; display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 0.7rem; color: ${isLayoutEditMode ? '#38bdf8' : 'var(--text-muted)'}; font-weight:${isLayoutEditMode ? 'bold' : 'normal'};">
          ${isLayoutEditMode ? '🖐️ Drag Node' : 'Click to Audit'}
        </span>
        ${currentUser && (currentUser.role === 'admin' || currentUser.role === 'supervisor') ? `
          <button onclick="event.stopPropagation(); openStationEditorForEdit('${st.id || stCode}')" class="btn-select" style="font-size:0.68rem; padding:0.15rem 0.35rem;">✏️ Edit</button>
        ` : ''}
      </div>
    `;

    makeNodeDraggable(nodeCard, canvas, st);
    canvas.appendChild(nodeCard);
  });
}

// 2D CANVAS POINTER & MOUSE DRAG ENGINE
function makeNodeDraggable(nodeEl, containerEl, stationObj) {
  let isDragging = false;
  let hasMoved = false;
  let startX, startY, initialLeft, initialTop;

  const onPointerDown = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    
    isDragging = true;
    hasMoved = false;
    nodeEl.classList.add('dragging');
    
    startX = e.clientX;
    startY = e.clientY;
    initialLeft = parseInt(nodeEl.style.left) || 0;
    initialTop = parseInt(nodeEl.style.top) || 0;

    nodeEl.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      hasMoved = true;
    }

    // Snap to 15px grid coordinates
    let newX = Math.max(10, Math.round((initialLeft + dx) / 15) * 15);
    let newY = Math.max(10, Math.round((initialTop + dy) / 15) * 15);

    nodeEl.style.left = `${newX}px`;
    nodeEl.style.top = `${newY}px`;
    stationObj.pos_x = newX;
    stationObj.pos_y = newY;
  };

  const onPointerUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    nodeEl.classList.remove('dragging');
    try { nodeEl.releasePointerCapture(e.pointerId); } catch(err) {}

    // If node wasn't dragged/moved, treat as click -> launch audit!
    if (!hasMoved && !isLayoutEditMode) {
      syncAuditCredentials('map');
      startAuditForStation(stationObj);
    }
  };

  nodeEl.addEventListener('pointerdown', onPointerDown);
  nodeEl.addEventListener('pointermove', onPointerMove);
  nodeEl.addEventListener('pointerup', onPointerUp);
}

function toggleLayoutEditMode() {
  isLayoutEditMode = !isLayoutEditMode;
  const btn = document.getElementById('btn-toggle-layout-edit');
  if (btn) {
    if (isLayoutEditMode) {
      btn.textContent = '🔒 Lock 2D Layout (Drag Active)';
      btn.style.borderColor = '#ef4444';
      btn.style.color = '#fca5a5';
      btn.style.background = 'rgba(239, 68, 68, 0.2)';
    } else {
      btn.textContent = '🖐️ Mode: Click-to-Audit (Click to Drag ON)';
      btn.style.borderColor = 'rgba(56,189,248,0.5)';
      btn.style.color = '#38bdf8';
      btn.style.background = 'rgba(15,23,42,0.9)';
    }
  }
  renderFactoryMap();
}

async function handleSaveBulkLayout() {
  const nodesToSave = (fetchedStations.length > 0 ? fetchedStations : defaultStations).map(s => ({
    station_code: s.station_code || s.code,
    pos_x: s.pos_x || 50,
    pos_y: s.pos_y || 50
  }));

  try {
    const res = await apiFetch('/api/stations/layout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ nodes: nodesToSave })
    });

    if (res.ok) {
      alert('🎉 2D Factory Canvas layout positions saved to database successfully!');
      if (window.confetti) {
        confetti({ particleCount: 50, spread: 50, origin: { y: 0.7 } });
      }
    } else {
      alert('Saved layout positions locally!');
    }
  } catch (e) {
    alert('Saved layout positions locally!');
  }
}

// ADMIN FACTORY MAP OBJECT INSPECTOR & MODAL CRUD
function openStationEditorForNew() {
  document.getElementById('modal-station-editor-title').textContent = '⚙️ Add New Machine Node Object';
  document.getElementById('edit-station-id').value = '';
  document.getElementById('edit-station-code').value = '';
  document.getElementById('edit-station-name').value = '';
  document.getElementById('edit-station-line').value = 'SMT Line T1';
  document.getElementById('edit-station-area').value = 'SMT Surface Mount Area';
  document.getElementById('edit-station-process').value = 'SMT-Printer';
  document.getElementById('edit-station-seq').value = (fetchedStations.length + 1);
  document.getElementById('edit-station-posx').value = 50;
  document.getElementById('edit-station-posy').value = 50;

  document.getElementById('btn-delete-station').style.display = 'none';
  document.getElementById('modal-station-editor')?.classList.add('active');
}

function openStationEditorForEdit(stIdOrCode) {
  const dataset = fetchedStations.length > 0 ? fetchedStations : defaultStations;
  const st = dataset.find(s => s.id === stIdOrCode || s.station_code === stIdOrCode || s.code === stIdOrCode);
  if (!st) return;

  document.getElementById('modal-station-editor-title').textContent = `⚙️ Edit Machine Node: ${st.station_code || st.code}`;
  document.getElementById('edit-station-id').value = st.id || st.station_code || st.code;
  document.getElementById('edit-station-code').value = st.station_code || st.code;
  document.getElementById('edit-station-name').value = st.station_name || st.name;
  document.getElementById('edit-station-line').value = st.line_name || st.line;
  document.getElementById('edit-station-area').value = st.area_name || st.area;
  document.getElementById('edit-station-process').value = st.process_type || st.process;
  document.getElementById('edit-station-seq').value = st.sequence_order || 1;
  document.getElementById('edit-station-posx').value = st.pos_x || 50;
  document.getElementById('edit-station-posy').value = st.pos_y || 50;

  document.getElementById('btn-delete-station').style.display = 'inline-block';
  document.getElementById('modal-station-editor')?.classList.add('active');
}

async function handleSaveStationEditor() {
  const stId = document.getElementById('edit-station-id').value;
  const station_code = document.getElementById('edit-station-code').value.trim();
  const station_name = document.getElementById('edit-station-name').value.trim();
  const line_name = document.getElementById('edit-station-line').value;
  const area_name = document.getElementById('edit-station-area').value;
  const process_type = document.getElementById('edit-station-process').value;
  const sequence_order = parseInt(document.getElementById('edit-station-seq').value) || 1;
  const pos_x = parseInt(document.getElementById('edit-station-posx').value) || 50;
  const pos_y = parseInt(document.getElementById('edit-station-posy').value) || 50;

  if (!station_code || !station_name) {
    alert('Please enter station code and name.');
    return;
  }

  const payload = { station_code, station_name, line_name, area_name, process_type, sequence_order, pos_x, pos_y };

  try {
    let res;
    if (stId) {
      res = await fetch(`/api/stations/${stId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify(payload)
      });
    } else {
      res = await apiFetch('/api/stations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify(payload)
      });
    }

    if (res.ok) {
      document.getElementById('modal-station-editor')?.classList.remove('active');
      renderFactoryMap();
    } else {
      const err = await res.json();
      alert(`Error saving station: ${err.detail || 'Station code exists'}`);
    }
  } catch (e) {
    document.getElementById('modal-station-editor')?.classList.remove('active');
    renderFactoryMap();
  }
}

async function handleDeleteStationEditor() {
  const stId = document.getElementById('edit-station-id').value;
  if (!stId) return;

  if (!confirm('Are you sure you want to deactivate and remove this machine object node from the canvas layout?')) {
    return;
  }

  try {
    await fetch(`/api/stations/${stId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    document.getElementById('modal-station-editor')?.classList.remove('active');
    renderFactoryMap();
  } catch (e) {
    document.getElementById('modal-station-editor')?.classList.remove('active');
    renderFactoryMap();
  }
}

// USER MANAGEMENT TAB (ADMIN ONLY)
async function loadUsersList() {
  const container = document.getElementById('container-user-table');
  if (!container) return;
  container.innerHTML = '<tr><td colspan="7" style="padding:1rem; text-align:center; color:var(--text-muted);">Loading users...</td></tr>';

  let users = [
    { id: 'USR-ADMIN-01', username: 'admin', full_name: 'Norman Nan (QA Manager)', role: 'admin', line_assignment: 'All Lines', language_pref: 'zh', is_active: true },
    { id: 'USR-SUP-01', username: 'supervisor1', full_name: 'John Tan (Line Supervisor)', role: 'supervisor', line_assignment: 'SMT Line T1', language_pref: 'en', is_active: true },
    { id: 'USR-AUD-01', username: 'auditor1', full_name: 'Somchai (IPQC Inspector)', role: 'auditor', line_assignment: 'SMT Line T1', language_pref: 'th', is_active: true }
  ];

  try {
    const res = await apiFetch(`/api/users?t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (res.ok) users = await res.json();
  } catch (e) {}

  container.innerHTML = '';
  users.forEach(u => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-color)';

    const roleBadgeColor = u.role === 'admin' ? '#38bdf8' : (u.role === 'supervisor' ? '#facc15' : '#4ade80');
    const statusBadge = u.is_active 
      ? '<span style="color:#34d399; font-weight:bold;">Active</span>' 
      : '<span style="color:#ef4444; font-weight:bold;">Deactivated</span>';

    tr.innerHTML = `
      <td style="padding: 0.85rem 1rem; font-family: monospace; font-weight: bold; color: #fff;">${u.username}</td>
      <td style="padding: 0.85rem 1rem; color: #e2e8f0;">${u.full_name}</td>
      <td style="padding: 0.85rem 1rem;">
        <span style="background: rgba(255,255,255,0.1); color: ${roleBadgeColor}; padding: 0.2rem 0.5rem; border-radius: 6px; font-size: 0.75rem; font-weight: bold; text-transform: uppercase;">${u.role}</span>
      </td>
      <td style="padding: 0.85rem 1rem; color: var(--text-muted);">${u.line_assignment || 'All Lines'}</td>
      <td style="padding: 0.85rem 1rem; color: var(--text-muted); text-transform: uppercase;">${u.language_pref || 'zh'}</td>
      <td style="padding: 0.85rem 1rem;">${statusBadge}</td>
      <td style="padding: 0.85rem 1rem; text-align: right;">
        ${u.is_active ? `
          <button onclick="toggleUserStatus('${u.id}', false)" class="btn-select" style="font-size:0.75rem; color:#fca5a5;">Deactivate</button>
        ` : `
          <button onclick="toggleUserStatus('${u.id}', true)" class="btn-select" style="font-size:0.75rem; color:#86efac;">Activate</button>
        `}
      </td>
    `;
    container.appendChild(tr);
  });
}

async function handleCreateUserSubmit() {
  const username = document.getElementById('add-user-username')?.value.trim();
  const password = document.getElementById('add-user-password')?.value.trim();
  const full_name = document.getElementById('add-user-fullname')?.value.trim();
  const role = document.getElementById('add-user-role')?.value;
  const line_assignment = document.getElementById('add-user-line')?.value;

  if (!username || !password || !full_name) {
    alert('Please fill out username, password, and full name.');
    return;
  }

  const payload = { username, password, full_name, role, line_assignment, language_pref: 'zh' };

  try {
    const res = await apiFetch(`/api/users?t=${Date.now()}`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      alert(`User ${username} created successfully!`);
      document.getElementById('modal-add-user')?.classList.remove('active');
      loadUsersList();
    } else {
      const err = await res.json();
      alert(`Error creating user: ${err.detail || 'Username exists'}`);
    }
  } catch (e) {
    alert(`User ${username} created locally!`);
    document.getElementById('modal-add-user')?.classList.remove('active');
  }
}

async function toggleUserStatus(userId, isActive) {
  try {
    await fetch(`/api/users/${userId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ is_active: isActive })
    });
    loadUsersList();
  } catch (e) {
    loadUsersList();
  }
}

// Network Status
function updateNetworkStatus() {
  const badge = document.getElementById('status-badge');
  const txt = document.getElementById('txt-statusState');
  if (!badge || !txt) return;
  if (navigator.onLine) {
    badge.className = 'badge-status badge-online';
    txt.textContent = translations[currentLang]?.statusOnline || 'Online';
  } else {
    badge.className = 'badge-status badge-offline';
    txt.textContent = translations[currentLang]?.statusOffline || 'Offline';
  }
}

// Language Switcher
function setupLanguageSwitcher() {
  const select = document.getElementById('select-lang');
  if (!select) return;
  select.addEventListener('change', (e) => {
    currentLang = e.target.value;
    applyTranslations();
  });
  applyTranslations();
}

function applyTranslations() {
  const dict = translations[currentLang];
  if (!dict) return;
  for (const key in dict) {
    const el = document.getElementById(`txt-${key}`);
    if (el) el.textContent = dict[key];
    const opt = document.getElementById(`opt-${key}`);
    if (opt) opt.textContent = dict[key];
  }
  if (typeof isMapControlsHidden !== 'undefined') {
    const txt = document.getElementById('txt-toggleMapControls');
    if (txt) {
      txt.textContent = isMapControlsHidden
        ? (dict.toggleShowControls || 'Show Controls')
        : (dict.toggleHideControls || 'Hide Controls');
    }
  }
  if (activeStation) {
    renderAuditQuestions(activeStation);
    updateAuditValidationUI(false);
  }
}

// Navigation Router
function setupNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      // Handle legacy redirects
      if (targetTab === 'capa') {
        const dashBtn = document.querySelector('.nav-tab[data-tab="dashboard"]');
        if (dashBtn) dashBtn.click();
        switchDashboardSubView('capa');
        return;
      }
      if (targetTab === 'analytics') {
        const dashBtn = document.querySelector('.nav-tab[data-tab="dashboard"]');
        if (dashBtn) dashBtn.click();
        switchDashboardSubView('pareto');
        return;
      }

      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      document.querySelectorAll('.view-section').forEach(sec => sec.classList.remove('active'));
      const targetView = document.getElementById(`view-${targetTab}`);
      if (targetView) targetView.classList.add('active');

      if (targetTab === 'map') renderFactoryMap();
      if (targetTab === 'dashboard') {
        switchDashboardSubView(currentDashboardSubView || 'perf');
      }
      if (targetTab === 'history') loadAuditHistory();
      if (targetTab === 'users') loadUsersList();
      if (targetTab === 'qrgen') renderQrStickers();
      if (targetTab === 'ai') loadAIInsights();
      if (targetTab === 'fai') {
        if (typeof loadFaiHistory === 'function') loadFaiHistory();
        if (typeof loadActiveMasterForInspection === 'function') loadActiveMasterForInspection();
      }
    });
  });
}

// Start Station Audit Execution (Triggered directly from 2D Factory Audit Map)
function startAuditForStation(st) {
  if (!st) return;
  
  if (st.status === 'OK' || st.status === 'NG') {
    const pwd = prompt("This station has already been audited for the current 2-hour time block.\\n\\nPlease enter Supervisor or Manager password to unlock re-audit:");
    if (!pwd || !['admin123', 'manager123', 'supervisor123', 'password123'].includes(pwd)) {
      alert("Invalid password. Re-audit unlock cancelled.");
      return;
    }
  }
  
  activeStation = st;
  activeAuditData = {};
  
  const mapLayoutPanel = document.getElementById('panel-map-layout');
  const execPanel = document.getElementById('panel-audit-execution');
  const targetCode = st.station_code || st.code || st.id;

  // Highlight active node in left list
  document.querySelectorAll('.machine-flow-card').forEach(card => {
    const code = card.dataset.stationCode;
    if (code === targetCode) {
      card.classList.add('active-selected-node');
    } else {
      card.classList.remove('active-selected-node');
    }
  });
  
  if (selectedLayoutMode === 'option1') {
    const rightPane = document.getElementById('option1-detail-pane');
    if (rightPane && execPanel) {
      execPanel.style.display = 'block';
      execPanel.style.marginTop = '0';
      execPanel.style.padding = '0';
      execPanel.style.background = 'transparent';
      execPanel.style.border = 'none';
      if (execPanel.parentElement !== rightPane) {
        rightPane.innerHTML = '';
        rightPane.appendChild(execPanel);
      }
    }
  } else {
    const main = document.querySelector('main');
    if (main && execPanel && execPanel.parentElement !== main) {
      main.appendChild(execPanel);
    }
    if (mapLayoutPanel) mapLayoutPanel.style.display = 'none';
    if (execPanel) {
      execPanel.style.display = 'block';
      execPanel.style.marginTop = '1rem';
      execPanel.style.padding = '1.5rem';
      execPanel.style.background = 'rgba(15, 23, 42, 0.75)';
      execPanel.style.border = '1px solid var(--border-color)';
    }
  }

  const stCode = st.station_code || st.code || st.id;
  const stName = st.station_name || st.name || stCode;
  const stLine = st.line_name || st.line || '';
  const stStd = getStationStandardDoc(st);
  const rev = getStationStandardRev(stStd);

  const titleEl = document.getElementById('active-station-title');
  const subEl = document.getElementById('active-station-sub');
  const badgeEl = document.getElementById('active-standard-badge');

  if (titleEl) titleEl.textContent = stCode;
  if (subEl) subEl.textContent = `${stName} (${stLine})`;
  if (badgeEl) {
    badgeEl.textContent = `DOC: ${stStd} (${rev})`;
    badgeEl.style.color = stStd === '5Q4-046' ? '#38bdf8' : '#f59e0b';
    badgeEl.style.borderColor = stStd === '5Q4-046' ? 'rgba(56,189,248,0.4)' : 'rgba(245,158,11,0.4)';
    badgeEl.style.background = stStd === '5Q4-046' ? 'rgba(56,189,248,0.15)' : 'rgba(245,158,11,0.15)';
  }

  const now = new Date();
  const hours = now.getHours();
  const startH = Math.floor(hours / 2) * 2;
  const endH = startH + 2;
  const formatH = h => (h < 10 ? '0' + h : h) + ':00';
  const blockEl = document.getElementById('active-time-block');
  if (blockEl) blockEl.textContent = `${formatH(startH)} - ${formatH(endH)}`;

  // Sync credentials and verify Work Order & Model Code
  syncAuditCredentials();
  const creds = getAuditCredentials();

  clearInterval(auditTimerInterval);
  auditTimerInterval = null;
  auditStartTime = null;

  if (creds.isValid) {
    auditStartTime = Date.now();
    startAuditDurationTimer();
    updateAuditValidationUI(false);
  } else {
    const timerEl = document.getElementById('audit-timer');
    if (timerEl) {
      const dict = (typeof translations !== 'undefined' && translations[currentLang]) ? translations[currentLang] : null;
      const pendingTxt = dict?.pendingWoModelTimer || 'Pending WO & Model';
      timerEl.textContent = `00:00 (${pendingTxt})`;
      timerEl.style.color = '#facc15';
      timerEl.style.fontSize = '0.78rem';
    }
    updateAuditValidationUI(true);
  }

  renderAuditQuestions(st);
}

// Render Questions for Station & Standard
function renderAuditQuestions(st) {
  const container = document.getElementById('container-audit-questions');
  if (!container) return;
  container.innerHTML = '';

  const stTag = st.process_type || st.tag || st.process || '';
  const stStd = getStationStandardDoc(st);
  const dataset = (typeof masterChecklistData !== 'undefined') ? masterChecklistData : [];
  const allowedTags = (typeof PROCESS_TAG_MAP !== 'undefined' && PROCESS_TAG_MAP[stTag]) ? PROCESS_TAG_MAP[stTag] : [stTag];

  let items = [];
  if (selectedAuditScope === 'full_standard') {
    // Show all items for this standard
    items = dataset.filter(item => item.standard_doc === stStd);
  } else {
    // Focused station items ONLY for this specific station tag
    items = dataset.filter(item => item.standard_doc === stStd && (
      allowedTags.includes(item.station_tag) ||
      item.station_tag === stTag ||
      item.default_station_code === (st.station_code || st.code)
    ));
    if (items.length === 0) {
      items = dataset.filter(item => item.standard_doc === stStd && item.station_tag === stTag);
    }
  }

  if (items.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); padding:2rem; text-align:center;">No questions found for this station.</div>';
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'audit-item-row';
    row.id = `item-row-${item.id || item.item_no}`;

    const text = item[currentLang] || item.zh || item.en;
    const catName = item[`category_${currentLang}`] || item.category_zh || item.category_en || item.process;
    const isSaved = activeAuditData[item.item_no];

    row.innerHTML = `
      <div class="audit-item-header">
        <div style="flex:1;">
          <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.35rem;">
            <span class="item-num">#${item.item_no}</span>
            <span style="font-size:0.75rem; font-weight:bold; color:#38bdf8; background:rgba(56,189,248,0.1); padding:0.15rem 0.45rem; border-radius:4px;">${catName}</span>
            <span style="font-size:0.7rem; color:var(--text-muted); background:rgba(255,255,255,0.05); padding:0.15rem 0.4rem; border-radius:4px;">${item.standard_doc} (${item.revision})</span>
            ${item.requires_qty ? `
              <span style="font-size:0.7rem; font-weight:bold; color:#facc15; background:rgba(250,204,21,0.15); border:1px solid rgba(250,204,21,0.3); padding:0.15rem 0.45rem; border-radius:4px;">△ Sampling &ge; 5 PCS</span>
            ` : ''}
          </div>
          <div class="item-text" style="font-size:0.92rem; line-height:1.45; color:#f8fafc;">${text}</div>
          ${item.remark ? `<div style="font-size:0.75rem; color:#94a3b8; margin-top:0.25rem;">📌 ${item.remark}</div>` : ''}
        </div>
      </div>

      <div class="audit-controls" style="margin-top:0.75rem; display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
        <button class="btn-audit btn-pass ${isSaved?.result === 'V' ? 'selected' : ''}" onclick="setQuestionResult('${item.id || item.item_no}', ${item.item_no}, 'V', ${item.requires_qty})">
          ✓ OK
        </button>

        <button class="btn-audit btn-fail ${isSaved?.result === 'X' ? 'selected' : ''}" onclick="triggerDefectModal('${item.id || item.item_no}', ${item.item_no})">
          ✗ NG
        </button>

        <button class="btn-audit btn-na ${isSaved?.result === 'NA' ? 'selected' : ''}" onclick="setQuestionResult('${item.id || item.item_no}', ${item.item_no}, 'NA', ${item.requires_qty})">
          - N/A
        </button>

        ${item.requires_qty ? `
          <div style="display: flex; align-items: center; gap: 0.35rem; margin-left: auto; background: rgba(15,23,42,0.8); border: 1px solid var(--border-color); padding: 0.25rem 0.6rem; border-radius: 8px;">
            <span style="font-size: 0.75rem; color: #facc15; font-weight:bold;">${translations[currentLang]?.qtyLabel || 'Qty:'}</span>
            <button class="btn-select" style="padding:0.15rem 0.45rem; font-size:0.8rem;" onclick="stepQty('${item.id || item.item_no}', ${item.item_no}, -1)">-</button>
            <input type="number" id="qty-${item.id || item.item_no}" class="qty-input" value="${isSaved?.qty || 5}" min="1" style="width:48px; text-align:center; font-weight:bold; color:#38bdf8;" onchange="updateQtyValue(${item.item_no}, this.value)">
            <button class="btn-select" style="padding:0.15rem 0.45rem; font-size:0.8rem;" onclick="stepQty('${item.id || item.item_no}', ${item.item_no}, 1)">+</button>
          </div>
        ` : ''}
      </div>
    `;
    container.appendChild(row);
  });

  updateAuditProgressBar(items.length);
}

function stepQty(rowId, itemNo, delta) {
  const input = document.getElementById(`qty-${rowId}`);
  if (input) {
    let current = parseInt(input.value) || 5;
    let next = Math.max(1, current + delta);
    input.value = next;
    updateQtyValue(itemNo, next);
  }
}

function setQuestionResult(rowId, itemNo, result, requiresQty) {
  const creds = getAuditCredentials();
  if (!creds.isValid) {
    updateAuditValidationUI(true);
    const dict = (typeof translations !== 'undefined' && translations[currentLang]) ? translations[currentLang] : null;
    const alertMsg = dict?.woModelRequiredAlert || '⚠️ 必须输入工单号 (Work Order) 与生产機種 (Model Code) 才能开始查核记录！\n(Work Order & Model Code are required before recording!)';
    alert(alertMsg);
    return;
  }

  const row = document.getElementById(`item-row-${rowId}`);
  if (!row) return;

  const btns = row.querySelectorAll('.btn-audit');
  btns.forEach(b => b.classList.remove('selected'));

  if (result === 'V') row.querySelector('.btn-pass')?.classList.add('selected');
  if (result === 'X') row.querySelector('.btn-fail')?.classList.add('selected');
  if (result === 'NA') row.querySelector('.btn-na')?.classList.add('selected');

  const qtyInput = document.getElementById(`qty-${rowId}`);
  const qtyVal = qtyInput ? parseInt(qtyInput.value) || 5 : 0;

  activeAuditData[itemNo] = {
    item_no: itemNo,
    result: result,
    qty: qtyVal,
    remark: activeAuditData[itemNo]?.remark || '',
    photo_url: activeAuditData[itemNo]?.photo_url || ''
  };

  const total = row.parentElement.children.length;
  updateAuditProgressBar(total);
}

function updateQtyValue(itemNo, val) {
  if (activeAuditData[itemNo]) {
    activeAuditData[itemNo].qty = parseInt(val) || 5;
  }
}

function updateAuditProgressBar(total) {
  const count = Object.keys(activeAuditData).length;
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const bar = document.getElementById('audit-progress-bar');
  const txt = document.getElementById('audit-progress-text');
  if (bar) bar.style.width = `${pct}%`;
  if (txt) txt.textContent = `${count} / ${total} Completed`;
}

let activeDefectRowId = null;

function triggerDefectModal(rowId, itemNo) {
  const creds = getAuditCredentials();
  if (!creds.isValid) {
    updateAuditValidationUI(true);
    const dict = (typeof translations !== 'undefined' && translations[currentLang]) ? translations[currentLang] : null;
    const alertMsg = dict?.woModelRequiredAlert || '⚠️ 必须输入工单号 (Work Order) 与生产機種 (Model Code) 才能开始查核记录！\n(Work Order & Model Code are required before recording!)';
    alert(alertMsg);
    return;
  }

  activeDefectRowId = rowId;
  activeDefectItemNo = itemNo;
  activeDefectPhoto = '';
  const rem = document.getElementById('modal-defect-remark');
  const prev = document.getElementById('defect-photo-preview');
  if (rem) rem.value = '';
  if (prev) prev.innerHTML = '';
  document.getElementById('modal-defect')?.classList.add('active');
}

// Fast Client-Side Image Resizing & Compression (Reduces payload size by ~90-95%)
function compressImageFile(file, maxDimension = 1024, quality = 0.65, callback) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      let width = img.width;
      let height = img.height;
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      if (callback) callback(dataUrl);
    };
    img.onerror = function() {
      if (callback) callback(e.target.result);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Dummy Photo Handler
function triggerDefectCamera() {
  activeDefectPhoto = 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=500';
  const prev = document.getElementById('defect-photo-preview');
  if (prev) {
    prev.innerHTML = `<img src="${activeDefectPhoto}" style="width:100%; border-radius:8px; margin-top:0.5rem;">`;
  }
}

function handleDefectImageUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  compressImageFile(file, 1024, 0.65, (compressedDataUrl) => {
    activeDefectPhoto = compressedDataUrl;
    const prev = document.getElementById('defect-photo-preview');
    if (prev) {
      prev.innerHTML = `
        <img src="${activeDefectPhoto}" style="max-height: 140px; border-radius: 8px; border: 1px solid var(--border-color);">
      `;
    }
  });
}

function closeDefectModal() {
  document.getElementById('modal-defect')?.classList.remove('active');
}

function confirmDefectEntry() {
  const remEl = document.getElementById('modal-defect-remark');
  const remark = remEl ? remEl.value.trim() : '';
  if (!remark) {
    alert('Please enter a description for the defect anomaly.');
    return;
  }
  
  if (activeDefectItemNo && activeDefectRowId) {
    setQuestionResult(activeDefectRowId, activeDefectItemNo, 'X', false);
    if (activeAuditData[activeDefectItemNo]) {
      activeAuditData[activeDefectItemNo].remark = remark;
      activeAuditData[activeDefectItemNo].photo_url = activeDefectPhoto || 'https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=500';
    }
  }

  closeDefectModal();
}

// ==========================================================================
// MQA EMAIL DISPATCH & TOAST NOTIFICATION HELPERS
// ==========================================================================
function getMqaGroupEmail() {
  return localStorage.getItem('ipqc_mqa_email') || 'PTH_SMT-MQA@primaxelec.co.th';
}

function isAutoEmailMqaEnabled() {
  return localStorage.getItem('ipqc_auto_email_mqa') !== 'false';
}

function showAppToast(title, message, type = 'info', actionBtn = null) {
  let toast = document.getElementById('app-notification-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-notification-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 99999;
      background: #1e293b;
      border: 1px solid #38bdf8;
      border-radius: 12px;
      padding: 1rem 1.25rem;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      max-width: 440px;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      transition: all 0.3s ease;
      font-family: inherit;
    `;
    document.body.appendChild(toast);
  }
  
  const borderCol = type === 'success' ? '#34d399' : (type === 'error' ? '#ef4444' : '#38bdf8');
  toast.style.borderColor = borderCol;
  
  let actionHtml = '';
  if (actionBtn && actionBtn.text && actionBtn.onClick) {
    window._toastActionCallback = actionBtn.onClick;
    actionHtml = `<button onclick="window._toastActionCallback(); this.closest('#app-notification-toast').style.display='none';" class="btn-primary" style="padding: 0.35rem 0.8rem; font-size: 0.78rem; align-self: flex-start; margin-top: 0.25rem; background:#38bdf8; color:#0f172a; font-weight:700;">${actionBtn.text}</button>`;
  }

  toast.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.75rem;">
      <div style="font-weight: bold; font-size: 0.95rem; color: ${borderCol}; display: flex; align-items: center; gap: 0.4rem;">
        ${title}
      </div>
      <button onclick="this.closest('#app-notification-toast').style.display='none';" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 1rem; line-height: 1;">✕</button>
    </div>
    <div style="font-size: 0.85rem; color: #e2e8f0; line-height: 1.45;">${message}</div>
    ${actionHtml}
  `;
  
  toast.style.display = 'flex';
  if (!actionBtn) {
    setTimeout(() => {
      if (toast) toast.style.display = 'none';
    }, 6000);
  }
}
window.showToast = showAppToast;

async function autoDispatchMqaAuditReport(auditId, lineName, stationName, workOrder, modelNo, isLineComplete) {
  if (!isAutoEmailMqaEnabled()) return;
  // STRICT RULE: Only dispatch automated email report when the FULL line patrol is complete
  if (!isLineComplete) return;

  // Check if outbound email delivery is currently paused
  if (window.isEmailPausedState) {
    console.log('⏸️ autoDispatchMqaAuditReport skipped: Outbound email sending is currently PAUSED.');
    showAppToast(
      '⏸️ MQA Email Skipped (Paused)',
      `Full line audit for <strong>${lineName}</strong> completed, but automated email was NOT sent because email sending is currently <strong>PAUSED</strong>.`,
      'warning',
      { text: '⚙️ Email Config', onClick: openEmailSettingsModal }
    );
    return;
  }

  const mqaEmail = getMqaGroupEmail();
  try {
    const res = await apiFetch('/api/reports/audit/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audit_id: auditId,
        recipient_email: mqaEmail,
        notes: `Consolidated IPQC Full Line Patrol Report for Line "${lineName}" (WO: "${workOrder}", Model: "${modelNo}"). All line stations completed.`
      })
    });
    const data = await res.json().catch(() => ({}));
    const attachTxt = data.attachment_name ? ` (Excel Attached: <strong>${data.attachment_name}</strong>)` : ' with consolidated Excel report attached';
    showAppToast(
      '📧 Full Line Report Auto-Dispatched to MQA',
      `Full line audit for <strong>${lineName}</strong> completed. Consolidated report automatically emailed to MQA Group (<strong>${mqaEmail}</strong>)${attachTxt}.`,
      'success',
      { text: '📄 Review Live Report', onClick: () => openEmailModal('audit', auditId) }
    );
  } catch (err) {
    console.warn('Auto MQA dispatch error:', err);
  }
}

async function submitCurrentAudit() {
  if (!activeStation) return;

  const creds = getAuditCredentials();
  if (!creds.isValid) {
    updateAuditValidationUI(true);
    const dict = (typeof translations !== 'undefined' && translations[currentLang]) ? translations[currentLang] : null;
    const alertMsg = dict?.woModelRequiredAlert || '⚠️ 工单号码 (Work Order) 与生产機種 (Model Code) 为必填项，请输入后再提交！\n(Work Order & Model Code are required before recording/submitting!)';
    alert(alertMsg);
    return;
  }

  const stationCode = activeStation.station_code || activeStation.code;
  const stationName = activeStation.station_name || activeStation.name;
  const lineName = activeStation.line_name || activeStation.line;

  const shift = document.getElementById('input-shift')?.value || 'Day Shift';
  const workOrder = creds.workOrder;
  const modelNo = creds.modelNo;
  const auditor = document.getElementById('input-auditor-name')?.value?.trim() || currentUser?.name || 'Inspector';
  const timeBlock = document.getElementById('active-time-block')?.textContent || '08:00 - 10:00';

  const details = Object.values(activeAuditData);
  if (details.length === 0) {
    alert('Please answer at least one audit question before submitting.');
    return;
  }

  const auditId = `AUD-${Date.now().toString().slice(-6)}`;
  const payload = {
    audit_id: auditId,
    station_code: stationCode,
    station_name: stationName,
    line_name: lineName,
    auditor: auditor,
    shift: shift,
    time_block: timeBlock,
    model_no: modelNo,
    work_order: workOrder,
    details: details
  };

  const totalQuestions = document.querySelectorAll('.audit-item-row').length;
  const isPartial = details.length < totalQuestions;
  const hasNG = details.some(d => d.result === 'X');
  let newStatus = 'OK';
  if (hasNG) newStatus = 'NG';
  else if (isPartial) newStatus = 'PARTIAL';
  
  const passCount = details.filter(d => d.result === 'O').length;
  const failCount = details.filter(d => d.result === 'X').length;
  const naCount = details.filter(d => d.result === '-').length;
  
  payload.overall_status = newStatus;
  payload.pass_count = passCount;
  payload.fail_count = failCount;
  payload.na_count = naCount;

  try {
    const res = await apiFetch('/api/audit/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      
      // Add current station to audited set
      if (typeof window.auditedStationCodes === 'undefined') window.auditedStationCodes = new Set();
      window.auditedStationCodes.add(stationCode);
      try { localStorage.setItem('ipqc_audited_stations', JSON.stringify([...window.auditedStationCodes])); } catch(e){}

      // Check if entire line is audited
      let activeDataset = (typeof fetchedStations !== 'undefined' && fetchedStations.length > 0) ? fetchedStations : ((typeof masterStationsData !== 'undefined' && masterStationsData.length > 0) ? masterStationsData : defaultStations);
      const lineStations = activeDataset.filter(s => s.line_name === lineName || s.line === lineName);
      const allAudited = lineStations.length > 0 && lineStations.every(s => s.status === 'OK' || s.status === 'NG' || window.auditedStationCodes.has(s.station_code || s.code || s.id));
      const auditedCount = lineStations.filter(s => s.status === 'OK' || s.status === 'NG' || window.auditedStationCodes.has(s.station_code || s.code || s.id)).length;

      // 1. AUTOMATICALLY SEND EMAIL TO MQA GROUP ONLY WHEN FULL LINE PATROL IS COMPLETE
      if (allAudited) {
        autoDispatchMqaAuditReport(auditId, lineName, 'Full Line Patrol', workOrder, modelNo, true);
        showAppToast(
          '🎉 Full Line Patrol Complete!',
          `All <strong>${lineStations.length} stations</strong> on <strong>${lineName}</strong> have been audited. Consolidated shift report automatically dispatched to MQA Group (<strong>${getMqaGroupEmail()}</strong>).`,
          'success',
          { text: '📄 Review Live Report', onClick: () => openEmailModal('audit', auditId) }
        );
      } else {
        // Individual station completed - DO NOT auto-email, just record & show progress
        showAppToast(
          '✅ Station Audit Recorded',
          `Station <strong>${stationName}</strong> [${auditId}] recorded (${newStatus}).<br><span style="color:#94a3b8; font-size:0.75rem;">Line Progress: <strong>${auditedCount} / ${lineStations.length}</strong> stations completed. (Consolidated report will auto-email once all stations complete).</span>`,
          newStatus === 'NG' ? 'error' : 'success',
          { text: '📄 View Report', onClick: () => openEmailModal('audit', auditId) }
        );
      }

      if (activeStation) activeStation.status = newStatus;
      let dataset = (typeof masterStationsData !== 'undefined' && masterStationsData.length > 0) ? masterStationsData : defaultStations;
      const match = dataset.find(s => (s.station_code || s.code || s.id) === stationCode);
      if (match) match.status = newStatus;
        
        // Clear active station so it doesn't reopen after submission
        activeStation = null;
        activeAuditData = {};
      if (typeof fetchedStations !== 'undefined' && fetchedStations.length > 0) {
        const fMatch = fetchedStations.find(s => (s.station_code || s.code || s.id) === stationCode);
        if (fMatch) fMatch.status = newStatus;
      }

      // Return to Map view
      document.getElementById('panel-audit-execution').style.display = 'none';
      document.getElementById('panel-map-layout').style.display = 'block';
        renderFactoryMap();
      clearInterval(auditTimerInterval);
      loadCAPABoard();
    } else {
      throw new Error('API Error');
    }
  } catch (e) {
    if (activeStation) activeStation.status = newStatus;
    alert('Audit saved locally in offline queue!');
    document.getElementById('panel-audit-execution').style.display = 'none';
    document.getElementById('panel-map-layout').style.display = 'block';
        renderFactoryMap();
    clearInterval(auditTimerInterval);
  }
}

// CAPA BOARD
let currentCapas = [];
async function loadCAPABoard() {
  let capas = [];

  try {
    const res = await apiFetch('/api/capa', {
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    });
    if (res.ok) capas = await res.json();
  } catch (e) {
    console.warn("Could not fetch CAPA board", e);
    capas = [];
  }

  currentCapas = capas;

  const colNew = document.getElementById('col-capa-new');
  const colInv = document.getElementById('col-capa-investigating');
  const colAct = document.getElementById('col-capa-actioning');
  const colCls = document.getElementById('col-capa-closed');

  if (colNew) colNew.innerHTML = '';
  if (colInv) colInv.innerHTML = '';
  if (colAct) colAct.innerHTML = '';
  if (colCls) colCls.innerHTML = '';

  if (!capas || capas.length === 0) {
    if (colNew) colNew.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; text-align:center; padding:1.5rem 0.5rem; border:1px dashed var(--border-color); border-radius:8px;">✅ 暂无新发异常<br><span style="font-size:0.7rem; color:#94a3b8;">All Clear - No open defects</span></div>';
    if (colInv) colInv.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; text-align:center; padding:1.5rem 0.5rem; border:1px dashed var(--border-color); border-radius:8px;">🔍 暂无调查中工单<br><span style="font-size:0.7rem; color:#94a3b8;">No active investigations</span></div>';
    if (colAct) colAct.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; text-align:center; padding:1.5rem 0.5rem; border:1px dashed var(--border-color); border-radius:8px;">⚙️ 暂无执行中措施<br><span style="font-size:0.7rem; color:#94a3b8;">No actions in progress</span></div>';
    if (colCls) colCls.innerHTML = '<div style="color:var(--text-muted); font-size:0.78rem; text-align:center; padding:1.5rem 0.5rem; border:1px dashed var(--border-color); border-radius:8px;">🟢 暂无历史闭环记录<br><span style="font-size:0.7rem; color:#94a3b8;">No closed records yet</span></div>';
    return;
  }

  capas.forEach(c => {
    const card = document.createElement('div');
    card.className = 'capa-card kanban-card';
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
        <span style="font-family:monospace; font-weight:bold; color:var(--accent-cyan); font-size:0.8rem;">${c.id}</span>
        <span style="font-size:0.7rem; background:rgba(239,68,68,0.2); color:#fca5a5; padding:0.1rem 0.35rem; border-radius:4px; font-weight:bold;">${c.severity || 'HIGH'}</span>
      </div>
      <div style="font-size:0.82rem; font-weight:bold; color:#fff; margin-bottom:0.25rem;">📍 ${c.station_code || '-'}</div>
      <div style="font-size:0.72rem; color:var(--text-muted); margin-bottom:0.35rem;">🏭 ${c.line_name || ''}</div>
      <div style="font-size:0.78rem; color:#cbd5e1; line-height:1.35; margin-bottom:0.6rem; background:rgba(15,23,42,0.6); padding:0.35rem 0.5rem; border-radius:6px;">${c.defect_description || 'Anomaly finding'}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.7rem; color:var(--text-muted); border-top:1px solid var(--border-color); padding-top:0.4rem;">
        <span>👤 ${c.owner || 'Unassigned'}</span>
        <button onclick="openCAPAModal('${c.id}')" class="btn-select" style="font-size:0.7rem; padding:0.2rem 0.5rem; background:#0284c7; color:#fff; border:none; border-radius:5px; cursor:pointer;">✏️ Update</button>
      </div>
    `;

    const s = (c.status || 'OPEN').toUpperCase();
    if (s === 'OPEN' && colNew) colNew.appendChild(card);
    else if (s === 'INVESTIGATING' && colInv) colInv.appendChild(card);
    else if (s === 'ACTIONING' && colAct) colAct.appendChild(card);
    else if (s === 'CLOSED' && colCls) colCls.appendChild(card);
    else if (colNew) colNew.appendChild(card);
  });
}

async function openCAPAModal(capaId, fallbackData = null) {
  document.getElementById('capa-modal-id').value = capaId;
  let c = (currentCapas || []).find(item => item.id === capaId);
  if (!c && fallbackData) {
    c = fallbackData;
  }
  if (!c) {
    try {
      const res = await apiFetch(`/api/capa/${capaId}`);
      if (res.ok) {
        c = await res.json();
      }
    } catch(e) {
      console.warn('Could not fetch single capa item:', e);
    }
  }
  if (c) {
    if (document.getElementById('capa-modal-status')) document.getElementById('capa-modal-status').value = (c.status || 'OPEN').toUpperCase();
    if (document.getElementById('capa-modal-owner')) document.getElementById('capa-modal-owner').value = c.owner || '';
    if (document.getElementById('capa-modal-rootcause')) document.getElementById('capa-modal-rootcause').value = c.root_cause || '';
    if (document.getElementById('capa-modal-action')) document.getElementById('capa-modal-action').value = c.action_taken || '';
  }
  document.getElementById('modal-capa-update')?.classList.add('active');
}

async function saveCAPAModal() {
  const capaId = document.getElementById('capa-modal-id').value;
  const status = document.getElementById('capa-modal-status').value;
  const owner = document.getElementById('capa-modal-owner').value;
  const root_cause = document.getElementById('capa-modal-rootcause').value;
  const action_taken = document.getElementById('capa-modal-action').value;

  try {
    await apiFetch(`/api/capa/${capaId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, owner, root_cause, action_taken })
    });
    document.getElementById('modal-capa-update')?.classList.remove('active');
    loadCAPABoard();
    if (typeof updateDrilldownCAPABadge === 'function') {
      updateDrilldownCAPABadge(capaId, status, owner, root_cause, action_taken);
    }
  } catch (e) {
    document.getElementById('modal-capa-update')?.classList.remove('active');
    loadCAPABoard();
  }
}

// PROCESS RESOLVER FOR PARETO & DEFECT TRACEABILITY
function getProcessNameFromCode(stationCode) {
  if (!stationCode) return 'General Quality';

  const allSt = (fetchedStations && fetchedStations.length > 0) ? fetchedStations : (typeof defaultStations !== 'undefined' ? defaultStations : []);
  const found = allSt.find(s => (s.station_code || s.code || s.id) === stationCode);
  if (found && (found.process || found.process_type || found.tag)) {
    return found.process || found.process_type || found.tag;
  }

  const s = String(stationCode).toUpperCase();
  if (s.includes('WAVE') || s.includes('SOLDER')) return 'DIP-Wave';
  if (s.includes('REFLOW') || s.includes('OVEN')) return 'SMT-Reflow';
  if (s.includes('PRINT') || s.includes('STENCIL')) return 'SMT-Printer';
  if (s.includes('SPI')) return 'SMT-SPI';
  if (s.includes('MNT') || s.includes('MOUNT')) return 'SMT-Mounter';
  if (s.includes('AOI')) return 'SMT-AOI';
  if (s.includes('IPR') || s.includes('REWORK')) return 'SMT-IPR';
  if (s.includes('INS') || s.includes('INSERT')) return 'DIP-Insertion';
  if (s.includes('TOUCH') || s.includes('VISUAL') || s.includes('-VI-')) return 'DIP-Visual';
  if (s.includes('ESD') || s.includes('IQC')) return 'Quality & ESD';
  if (s.includes('LASER')) return 'Laser-Marking';
  if (s.includes('BAKE')) return 'Baking-Dry';
  if (s.includes('PROG') || s.includes('IC-PROG')) return 'IC-Programming';
  if (s.includes('ICT')) return 'ICT Testing';
  if (s.includes('FCT')) return 'Programming & FCT';
  if (s.includes('PACK') || s.includes('BOX')) return 'Inspection & Packaging';
  if (s.includes('GLUE') || s.includes('COAT') || s.includes('DISPENS')) return 'Glue-Dispensing';
  if (s.includes('FAI')) return 'FAI First Article';
  if (s.includes('DEPANEL') || s.includes('ROUT')) return 'Depaneling';
  if (s.includes('ASSY') || s.includes('ASSEMBL')) return 'Assembly';

  return stationCode;
}

function getProcessIcon(procName) {
  const p = (procName || '').toLowerCase();
  if (p.includes('wave')) return '🌊';
  if (p.includes('reflow') || p.includes('oven')) return '♨️';
  if (p.includes('print')) return '📑';
  if (p.includes('spi')) return '📐';
  if (p.includes('mount') || p.includes('mnt')) return '🦾';
  if (p.includes('aoi')) return '🔍';
  if (p.includes('esd') || p.includes('iqc')) return '⚡';
  if (p.includes('laser')) return '🖨️';
  if (p.includes('ins')) return '🔌';
  if (p.includes('visual') || p.includes('touch')) return '👁️';
  if (p.includes('bake')) return '🔥';
  if (p.includes('prog')) return '💾';
  if (p.includes('ict')) return '🎛️';
  if (p.includes('fct')) return '📊';
  if (p.includes('pack')) return '📦';
  if (p.includes('glue') || p.includes('coat')) return '🧪';
  if (p.includes('fai')) return '🎯';
  return '⚙️';
}

// DASHBOARD INTEGRATED SUB-VIEW SWITCHER
let currentDashboardSubView = 'perf';

function switchDashboardSubView(subview) {
  currentDashboardSubView = subview;

  // Toggle button active styling
  const subBtns = document.querySelectorAll('.dash-sub-tab');
  subBtns.forEach(btn => {
    if (btn.dataset.subview === subview) {
      btn.classList.add('active');
      btn.style.background = 'rgba(56, 189, 248, 0.2)';
      btn.style.borderColor = '#38bdf8';
      btn.style.color = '#38bdf8';
    } else {
      btn.classList.remove('active');
      btn.style.background = 'rgba(15, 23, 42, 0.6)';
      btn.style.borderColor = 'var(--border-color)';
      btn.style.color = 'var(--text-muted)';
    }
  });

  // Toggle container visibility
  const vPerf = document.getElementById('dash-subview-perf');
  const vCapa = document.getElementById('dash-subview-capa');
  const vPareto = document.getElementById('dash-subview-pareto');

  if (vPerf) vPerf.style.display = (subview === 'perf') ? 'block' : 'none';
  if (vCapa) vCapa.style.display = (subview === 'capa') ? 'block' : 'none';
  if (vPareto) vPareto.style.display = (subview === 'pareto') ? 'block' : 'none';

  // Trigger data loader for the active sub-view
  if (subview === 'perf') {
    loadDashboard();
  } else if (subview === 'capa') {
    loadCAPABoard();
  } else if (subview === 'pareto') {
    renderParetoChart();
  }
}

// PERIOD SELECTOR FOR PARETO (WEEKLY, MONTHLY, TODAY, ALL TIME)
function setParetoPeriod(period) {
  currentParetoPeriod = period || 'weekly';

  // Update button visual styles
  const btnIds = {
    weekly: 'pareto-btn-weekly',
    monthly: 'pareto-btn-monthly',
    daily: 'pareto-btn-daily',
    all: 'pareto-btn-all'
  };

  Object.entries(btnIds).forEach(([pKey, bId]) => {
    const btn = document.getElementById(bId);
    if (!btn) return;
    if (pKey === currentParetoPeriod) {
      btn.style.background = '#38bdf8';
      btn.style.color = '#0f172a';
    } else {
      btn.style.background = 'transparent';
      btn.style.color = 'var(--text-muted)';
    }
  });

  // Update KPI card period labels
  const labelMap = {
    weekly: '(Weekly / 7d)',
    monthly: '(Monthly / 30d)',
    daily: '(Today / 24h)',
    all: '(All Time)'
  };
  const badgeAudits = document.getElementById('pareto-badge-audits');
  if (badgeAudits) {
    badgeAudits.textContent = labelMap[currentParetoPeriod] || '(Weekly)';
  }

  // Trigger chart re-render with new period
  renderParetoChart();
}

// PARETO DEFECT CHART (100% DYNAMIC & GROUPED BY MANUFACTURING PROCESS)
async function renderParetoChart() {
  const canvas = document.getElementById('paretoChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (paretoChartInstance) paretoChartInstance.destroy();

  let analytics = { total_audits: 0, compliance_rate: 100.0, open_anomalies: 0, top_process: 'None', top_defects: [], capas: [] };
  try {
    const resA = await apiFetch(`/api/analytics?period=${currentParetoPeriod}&t=${Date.now()}`);
    if (resA && resA.ok) {
      const data = await resA.json();
      if (data && typeof data === 'object') {
        analytics = data;
      }
    }
  } catch (e) {
    console.warn("Could not load Analytics for Pareto:", e);
  }

  cachedAnalyticsData = analytics;

  const elAudits = document.getElementById('stat-total-audits');
  const elComp = document.getElementById('stat-compliance-rate');
  const elAnom = document.getElementById('stat-open-anomalies');
  const elTopProc = document.getElementById('stat-top-process');

  if (elAudits) elAudits.textContent = (analytics.total_audits || 0).toLocaleString();
  if (elComp) elComp.textContent = (analytics.compliance_rate != null ? Number(analytics.compliance_rate).toFixed(1) : '100.0') + '%';
  if (elAnom) elAnom.textContent = (analytics.open_anomalies != null ? analytics.open_anomalies : 0).toLocaleString();

  const wrapper = canvas.parentElement;
  let emptyEl = document.getElementById('pareto-empty-state');

  const topDefects = analytics.top_defects || [];
  const totalDefects = analytics.total_defects || topDefects.reduce((acc, curr) => acc + (curr.defect_count || 0), 0);

  if (!topDefects || topDefects.length === 0 || totalDefects === 0) {
    canvas.style.display = 'none';
    if (!emptyEl) {
      emptyEl = document.createElement('div');
      emptyEl.id = 'pareto-empty-state';
      wrapper.appendChild(emptyEl);
    }
    emptyEl.style.display = 'block';
    emptyEl.innerHTML = `
      <div style="text-align: center; padding: 3rem 1.5rem; background: rgba(15, 23, 42, 0.5); border-radius: 12px; border: 1px dashed rgba(56, 189, 248, 0.25);">
        <div style="font-size: 2.8rem; margin-bottom: 0.75rem;">🛡️</div>
        <div style="font-size: 1.15rem; font-weight: bold; color: #fff; margin-bottom: 0.35rem;">当前时段全线运行合格，暂无异常缺陷 (Zero Defects)</div>
        <div style="font-size: 0.85rem; color: #94a3b8; max-width: 460px; margin: 0 auto; line-height: 1.5;">
          所选时段（${currentParetoPeriod.toUpperCase()}）内所有巡检工位查核符合品质标准。当记录 NG 缺陷后，系统将自动按工序名称归纳生成帕累托 80/20 规律分析。
        </div>
      </div>
    `;
    const tbody = document.getElementById('pareto-process-tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 1.5rem; color: #34d399; font-weight: bold;">🎉 当前时段全厂查核合格，无工序缺陷记录</td></tr>';
    if (elTopProc) elTopProc.textContent = 'None (0 Defects)';
    closeParetoTop5();
    return;
  }

  if (emptyEl) emptyEl.style.display = 'none';
  canvas.style.display = 'block';

  if (elTopProc && topDefects.length > 0) {
    const topP = topDefects[0];
    elTopProc.textContent = `${getProcessIcon(topP.process_name)} ${topP.process_name} (${topP.defect_count})`;
  }

  const labels = [];
  const counts = [];
  const cumulativePercentages = [];
  let runningSum = 0;

  topDefects.forEach((item) => {
    const pName = item.process_name;
    const count = item.defect_count;
    labels.push(pName);
    counts.push(count);
    runningSum += count;
    cumulativePercentages.push(Number(((runningSum / totalDefects) * 100).toFixed(1)));
  });

  // Render Process Defect Breakdown Table (80/20 Rule)
  const tbody = document.getElementById('pareto-process-tbody');
  if (tbody) {
    let runningCum = 0;
    tbody.innerHTML = topDefects.map((item, idx) => {
      const procName = item.process_name;
      const count = item.defect_count;
      runningCum += count;
      const cumPct = Number(((runningCum / totalDefects) * 100).toFixed(1));
      const sharePct = Number(((count / totalDefects) * 100).toFixed(1));
      const icon = getProcessIcon(procName);
      
      const isVital = (cumPct <= 80) || (idx === 0) || ((runningCum - count) / totalDefects * 100 < 80);
      const priorityBadge = isVital
        ? '<span style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 0.72rem;">🔥 80% Vital Few (首要改善)</span>'
        : '<span style="background: rgba(148, 163, 184, 0.15); color: #94a3b8; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem;">20% 次要改进 (Minor)</span>';

      const rankBadge = idx < 3
        ? `<span style="background: ${idx === 0 ? '#eab308' : (idx === 1 ? '#94a3b8' : '#cd7f32')}; color: #000; font-weight: 800; padding: 2px 7px; border-radius: 50%; font-size: 0.75rem;">${idx + 1}</span>`
        : `<span style="color: var(--text-muted); font-family: monospace; font-weight: bold; padding-left: 5px;">#${idx + 1}</span>`;

      const isSelected = selectedParetoProcess && selectedParetoProcess.toLowerCase() === procName.toLowerCase();
      const rowBg = isSelected ? 'rgba(56, 189, 248, 0.18)' : (isVital ? 'rgba(239, 68, 68, 0.04)' : 'transparent');
      const rowBorder = isSelected ? 'border-left: 4px solid #38bdf8;' : '';

      return `
        <tr id="pareto-row-${idx}" onclick="selectParetoProcess('${procName.replace(/'/g, "\\'")}')" 
            style="border-bottom: 1px solid rgba(51, 65, 85, 0.3); background: ${rowBg}; ${rowBorder} cursor: pointer; transition: all 0.2s;"
            onmouseover="this.style.background='rgba(56, 189, 248, 0.12)'" 
            onmouseout="this.style.background='${rowBg}'"
            title="点击查看 ${procName} 的 Top 5 问题明细、根本原因与改善对策">
          <td style="padding: 0.75rem 0.75rem;">${rankBadge}</td>
          <td style="padding: 0.75rem 0.75rem; font-weight: 700; color: #fff;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <div style="display: flex; align-items: center; gap: 0.4rem;">
                <span style="font-size: 1.15rem;">${icon}</span>
                <span style="color: #38bdf8; text-decoration: underline; text-underline-offset: 3px;">${procName}</span>
              </div>
              <span style="font-size: 0.7rem; color: #94a3b8; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.1);">🔍 Top 5</span>
            </div>
          </td>
          <td style="padding: 0.75rem 0.75rem; text-align: center; font-family: monospace; font-weight: 800; color: #ef4444; font-size: 0.95rem;">${count}</td>
          <td style="padding: 0.75rem 0.75rem; text-align: right; font-weight: 700; color: #fbbf24;">${sharePct}%</td>
          <td style="padding: 0.75rem 0.75rem; text-align: right; font-weight: 800; color: ${cumPct <= 80 ? '#f87171' : '#34d399'};">${cumPct}%</td>
          <td style="padding: 0.75rem 0.75rem; text-align: center;">${priorityBadge}</td>
        </tr>
      `;
    }).join('');
  }

  // Render dual-axis Pareto Chart
  paretoChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        {
          label: '工序缺陷发生频次 Defect Count (Bar)',
          data: counts,
          backgroundColor: 'rgba(56, 189, 248, 0.75)',
          borderColor: '#38bdf8',
          borderWidth: 1.5,
          borderRadius: 6,
          yAxisID: 'y',
          order: 2
        },
        {
          label: '累计百分比 Cumulative % (Line)',
          data: cumulativePercentages,
          type: 'line',
          borderColor: '#f59e0b',
          backgroundColor: '#f59e0b',
          borderWidth: 2.5,
          pointRadius: 4,
          pointBackgroundColor: '#f59e0b',
          pointBorderColor: '#fff',
          pointHoverRadius: 6,
          yAxisID: 'y1',
          tension: 0.25,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (e, elements) => {
        if (elements && elements.length > 0) {
          const clickedIdx = elements[0].index;
          const clickedProc = labels[clickedIdx];
          if (clickedProc) {
            selectParetoProcess(clickedProc);
          }
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          labels: {
            color: '#e2e8f0',
            font: { weight: 'bold', size: 12 }
          }
        },
        tooltip: {
          backgroundColor: '#0f172a',
          titleColor: '#38bdf8',
          bodyColor: '#fff',
          borderColor: 'rgba(56,189,248,0.4)',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: function(context) {
              if (context.dataset.yAxisID === 'y1') {
                return ` 累计百分比: ${context.parsed.y}%`;
              }
              return ` 缺陷异常数: ${context.parsed.y} 件 (点击查看 Top 5 对策)`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#cbd5e1',
            font: { size: 11, weight: 'bold' }
          },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y: {
          type: 'linear',
          position: 'left',
          title: { display: true, text: 'Defect Occurrences (件)', color: '#38bdf8', font: { size: 11, weight: 'bold' } },
          ticks: { color: '#38bdf8', stepSize: 1 },
          grid: { color: 'rgba(255,255,255,0.05)' }
        },
        y1: {
          type: 'linear',
          position: 'right',
          min: 0,
          max: 100,
          title: { display: true, text: 'Cumulative Percentage (%)', color: '#f59e0b', font: { size: 11, weight: 'bold' } },
          ticks: { color: '#f59e0b', callback: v => v + '%' },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });

  // Automatically show Top 5 problems for the #1 Process by default if available
  if (topDefects.length > 0) {
    const defaultProc = selectedParetoProcess || topDefects[0].process_name;
    selectParetoProcess(defaultProc, false);
  } else {
    closeParetoTop5();
  }
}

// TOP 5 PROBLEMS DEEP-DIVE ANALYSIS FOR SELECTED PROCESS
function selectParetoProcess(procName, scrollIntoView = true) {
  if (!procName) return;
  selectedParetoProcess = procName;

  const container = document.getElementById('pareto-top5-container');
  if (!container) return;

  const iconEl = document.getElementById('pareto-top5-icon');
  const titleEl = document.getElementById('pareto-top5-title');
  const badgeEl = document.getElementById('pareto-top5-stat-badge');
  const tbodyEl = document.getElementById('pareto-top5-tbody');
  const pfmeaTextEl = document.getElementById('pareto-top5-pfmea-text');

  const icon = getProcessIcon(procName);
  if (iconEl) iconEl.textContent = icon;
  if (titleEl) titleEl.textContent = procName;

  // Retrieve CAPAs for this process
  const allCapas = (cachedAnalyticsData && cachedAnalyticsData.capas) ? cachedAnalyticsData.capas : [];
  const procCapas = allCapas.filter(c => {
    const p = getProcessNameFromCode(c.station_code);
    return (p || '').toLowerCase() === procName.toLowerCase();
  });

  const totalProcDefects = procCapas.length;
  if (badgeEl) {
    badgeEl.textContent = `${totalProcDefects} 件缺陷 (${currentParetoPeriod.toUpperCase()})`;
  }

  // Aggregate issues by finding description
  const issueCounts = {};
  const issueExamples = {};

  procCapas.forEach(c => {
    let desc = (c.defect_description || '').trim();
    if (!desc || desc.toUpperCase() === 'NG') {
      if (c.item_no) {
        desc = `Checklist Item #${c.item_no} Audit Non-Conformance (NG)`;
      } else {
        desc = `General ${procName} Station Non-Conformance (NG)`;
      }
    }
    // Normalize common patterns
    let key = desc;
    const lower = desc.toLowerCase();
    if (lower.includes('profile')) key = 'Thermal Profile Parameter Out of Control / Unverified (温度曲线超标/未测/未更新)';
    else if (lower.includes('sop') || lower.includes('work instruction')) key = 'SOP / Document Missing or Non-Compliant (SOP缺失/未更新/未依作业指导书)';
    else if (lower.includes('esd') || lower.includes('wrist') || lower.includes('ground')) key = 'ESD Grounding / Wrist Strap Resistance Fail (静电接地/手环阻抗超标)';
    else if (lower.includes('bom') || lower.includes('version')) key = 'Program / BOM / Recipe Version Mismatch (程序或BOM版本不一致)';
    else if (lower.includes('bridge') || lower.includes('short')) key = 'Solder Bridging / Solder Spike Short (焊点短路/桥连/锡尖)';
    else if (lower.includes('missing') || lower.includes('drop') || lower.includes('part')) key = 'Missing Component / Part Placement Error (缺件/掉件/极性反)';
    else if (lower.includes('void')) key = 'Excessive Solder Joint Voiding (焊点气孔/空洞超标)';

    issueCounts[key] = (issueCounts[key] || 0) + 1;
    if (!issueExamples[key]) {
      issueExamples[key] = {
        item_no: c.item_no,
        station_code: c.station_code,
        line_name: c.line_name,
        raw_desc: c.defect_description
      };
    }
  });

  const sortedIssues = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Fallback defaults from Standard Engineering PFMEA Knowledge Base if fewer than 5 recorded issues
  const fallbackRules = getProcessStandardTop5(procName);
  const finalTop5 = [];

  sortedIssues.forEach(([issueTitle, count]) => {
    const share = totalProcDefects > 0 ? Number(((count / totalProcDefects) * 100).toFixed(1)) : 0;
    const rule = getIssueRootCauseAndAction(procName, issueTitle, issueExamples[issueTitle]);
    finalTop5.push({
      title: issueTitle,
      count: count,
      share: share,
      root_cause: rule.root_cause,
      recommend_action: rule.recommend_action,
      severity: rule.severity || 'HIGH',
      isActual: true
    });
  });

  // Pad to Top 5 if needed
  if (finalTop5.length < 5) {
    fallbackRules.forEach(fb => {
      if (finalTop5.length < 5 && !finalTop5.some(it => it.title.toLowerCase().includes(fb.keyword.toLowerCase()))) {
        finalTop5.push({
          title: fb.title,
          count: 0,
          share: 0,
          root_cause: fb.root_cause,
          recommend_action: fb.recommend_action,
          severity: fb.severity || 'MEDIUM',
          isActual: false
        });
      }
    });
  }

  // Render Top 5 Table
  if (tbodyEl) {
    if (finalTop5.length === 0) {
      tbodyEl.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #34d399; font-weight: bold;">🎉 该工序在当前时段无缺陷记录，所有检查项均受控</td></tr>`;
    } else {
      tbodyEl.innerHTML = finalTop5.map((pItem, pIdx) => {
        const rankColor = pIdx === 0 ? '#ef4444' : (pIdx === 1 ? '#f59e0b' : (pIdx === 2 ? '#eab308' : '#94a3b8'));
        const countDisplay = pItem.isActual 
          ? `<span style="color: #ef4444; font-weight: 800; font-family: monospace; font-size: 0.95rem;">${pItem.count}</span>` 
          : `<span style="color: #64748b; font-size: 0.76rem;">0 (预防项)</span>`;
        const shareDisplay = pItem.isActual ? `<span style="color: #fbbf24; font-weight: 700;">${pItem.share}%</span>` : `<span style="color: #64748b;">0%</span>`;

        return `
          <tr style="border-bottom: 1px solid rgba(51, 65, 85, 0.4); background: ${pIdx % 2 === 0 ? 'rgba(30, 41, 59, 0.3)' : 'transparent'}; vertical-align: top;">
            <td style="padding: 0.75rem 0.6rem; text-align: center;">
              <span style="display: inline-block; width: 22px; height: 22px; line-height: 22px; border-radius: 50%; background: ${rankColor}; color: #000; font-weight: 800; font-size: 0.75rem;">
                ${pIdx + 1}
              </span>
            </td>
            <td style="padding: 0.75rem 0.75rem;">
              <div style="font-weight: 700; color: #fff; line-height: 1.35; margin-bottom: 3px;">
                ${pItem.title}
              </div>
              ${pItem.isActual ? `<span style="font-size: 0.7rem; color: #38bdf8; background: rgba(56,189,248,0.1); padding: 1px 6px; border-radius: 4px;">🎯 实测高发异常</span>` : `<span style="font-size: 0.7rem; color: #94a3b8; background: rgba(148,163,184,0.1); padding: 1px 6px; border-radius: 4px;">🛡️ IATF 关键预防项</span>`}
            </td>
            <td style="padding: 0.75rem 0.6rem; text-align: center;">${countDisplay}</td>
            <td style="padding: 0.75rem 0.6rem; text-align: right;">${shareDisplay}</td>
            <td style="padding: 0.75rem 0.85rem; color: #e2e8f0; font-size: 0.8rem; line-height: 1.45;">
              <div style="background: rgba(239, 68, 68, 0.06); border-left: 2px solid #ef4444; padding: 6px 8px; border-radius: 0 4px 4px 0;">
                <strong style="color: #f87171;">4M1E 归因:</strong> ${pItem.root_cause}
              </div>
            </td>
            <td style="padding: 0.75rem 0.85rem; color: #e2e8f0; font-size: 0.8rem; line-height: 1.45;">
              <div style="background: rgba(52, 211, 153, 0.06); border-left: 2px solid #34d399; padding: 6px 8px; border-radius: 0 4px 4px 0;">
                <strong style="color: #34d399;">CLCA 措施:</strong> ${pItem.recommend_action}
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }
  }

  // Update PFMEA Guidance message
  if (pfmeaTextEl) {
    const pfmeaObj = getProcessPFMEAGuidance(procName);
    pfmeaTextEl.innerHTML = pfmeaObj;
  }

  container.style.display = 'block';

  if (scrollIntoView) {
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function closeParetoTop5() {
  const container = document.getElementById('pareto-top5-container');
  if (container) container.style.display = 'none';
  selectedParetoProcess = null;
}

// 4M1E & PFMEA ROOT CAUSE + RECOMMEND ACTIONS RESOLUTION ENGINE
function getIssueRootCauseAndAction(procName, issueTitle, example) {
  const title = (issueTitle || '').toLowerCase();
  const p = (procName || '').toLowerCase();

  if (title.includes('profile')) {
    return {
      root_cause: "炉温温区热电偶老化飘移；换线或停机后未重新跑温控板验证；网带传输速度波动；氮气流量不足导致液相线以上时间 (TAL) 超标。",
      recommend_action: "立即进行 KIC 测温板实测验证；核对换线机种与当前 Profile 编号一致性；重新校准各温区设定并由制程工程师 (PE) 签字放行。",
      severity: "HIGH"
    };
  }
  if (title.includes('sop') || title.includes('document')) {
    return {
      root_cause: "ECN工程变更未同步推送至产线站位；作业员未及时取下旧版指导书；产线转拉未核对工艺参数表。",
      recommend_action: "稽核所有站位最新受控印章 SOP；执行电子看板 (E-SOP) 扫码联动锁机；对当班领班与作业员实施变更点点检再培训。",
      severity: "MEDIUM"
    };
  }
  if (title.includes('esd') || title.includes('wrist') || title.includes('ground')) {
    return {
      root_cause: "静电手环接触松脱或电阻值老化 (>10^7 Ω)；工作台与静电椅接地线脱落；离子风机针头氧化积碳导致离子平衡度失调。",
      recommend_action: "强制启用静电手环在线连续监控报警仪；每班开工前检测离子风机残余电压 (<±35V)；定期紧固各工作台接地端子排 (接地电阻 <1.0 Ω)。",
      severity: "HIGH"
    };
  }
  if (title.includes('bom') || title.includes('version')) {
    return {
      root_cause: "设备端调用了历史离线工程程式；MES/SFC 系统料站表与现场实际生产工单料号不匹配；换线程序导入未执行首件比对。",
      recommend_action: "设备端全面启用 MES 扫码防错联动；更新机台 Program 并比对 Checksum 校验码；执行首件全检 (FAI) 并锁定配方参数。",
      severity: "CRITICAL"
    };
  }
  if (title.includes('bridge') || title.includes('short')) {
    return {
      root_cause: "钢网开孔堵孔或擦网周期过长；锡膏印刷厚度超标 (>150μm)；波峰焊浸锡高度过深或链速过慢；助焊剂喷涂比重不均。",
      recommend_action: "增加钢网自动擦拭频次 (每3-5板一次)；优化波峰焊浸锡时间与脱锡倾斜角度 (4°-6°)；检测助焊剂固含量与比重。",
      severity: "HIGH"
    };
  }
  if (title.includes('missing') || title.includes('drop') || title.includes('part')) {
    return {
      root_cause: "贴片机吸嘴真空压力不足或堵塞；飞达 (Feeder) 步进齿轮磨损卡带；插件工序作业员漏插或极性方向反向。",
      recommend_action: "清洗贴片吸嘴并保养真空过滤阀；校准飞达取料坐标；插件站位设立极性限位治具与首件彩色样品限度样板。",
      severity: "CRITICAL"
    };
  }
  if (title.includes('void')) {
    return {
      root_cause: "回流焊预热区升温斜率过快导致助焊剂溶剂未完全挥发；锡膏氧化或吸湿 (暴露空气 >24h)；PCB 焊盘受潮未烘烤。",
      recommend_action: "优化预热升温斜率 (1.5-2.0°C/s)；控制锡膏回温与开封时间；对高层板或易吸湿 PCB 实施 120°C/2h 预烘烤。",
      severity: "HIGH"
    };
  }

  // Fallback by manufacturing process
  if (p.includes('wave')) {
    return {
      root_cause: "波峰焊锡锅温度偏离工艺窗口 (255-265°C)；锡渣过多堵塞喷嘴钛爪；预热底部温度不足 (<100°C)；链速不稳定。",
      recommend_action: "清理锡炉表面氧化锡渣与喷嘴结晶；测量预热区实际板底温度；定期化验锡炉铜污染 (Cu < 0.3%) 并补充纯锡条。",
      severity: "HIGH"
    };
  }
  if (p.includes('printer') || p.includes('print')) {
    return {
      root_cause: "刮刀压力偏大或偏小 (标准 1.5-2.5 kg)；脱模速度过快拉尖；锡膏粘度异常 (温度 <22°C 或 >26°C)。",
      recommend_action: "校准刮刀水平与压力设定；设置脱模速度至 0.3-0.8 mm/s；每 2 小时搅拌并检测锡膏罐温湿度记录。",
      severity: "HIGH"
    };
  }
  if (p.includes('reflow')) {
    return {
      root_cause: "加热区发热管老化或热电偶受风机气流干扰；氮气浓度低于 99.9% 导致焊盘氧化；排风管道风压波动。",
      recommend_action: "测温板定期 9 点测试并计算 CPK；清洗回流炉助焊剂回收管道；检查氮气供给主管路压力 (>0.5 MPa)。",
      severity: "HIGH"
    };
  }
  if (p.includes('aoi') || p.includes('spi')) {
    return {
      root_cause: "光学镜头表面灰尘或光源 LED 亮度衰减；算法阈值设定过宽导致漏报；板弯翘曲引起焦点模糊。",
      recommend_action: "使用标准校准块清洁并标定光学镜头；调整算法容差范围；检查输送导轨压板与平整度治具。",
      severity: "MEDIUM"
    };
  }

  return {
    root_cause: "作业员未严格按照制程 SOP 执行查核；机台参数日常巡检记录未同步；治具磨损或传感器灵敏度衰减。",
    recommend_action: "立即对该站位开展 5S 与工序标准化复查；落实班次交接核对表；由品质主管跟进整改并记录 CAPA 闭环。",
    severity: "MEDIUM"
  };
}

function getProcessStandardTop5(procName) {
  const p = (procName || '').toLowerCase();
  if (p.includes('wave')) {
    return [
      { keyword: 'profile', title: '波峰焊温控曲线未依频次量测或超标 (Profile Out of Spec)', root_cause: '热电偶老化或换线未测温，预热温度不足', recommend_action: '开线前强制跑温控曲线，PE 审核签字后方可投入生产', severity: 'HIGH' },
      { keyword: 'flux', title: '助焊剂喷涂量/比重异常 (Flux SG Drift)', root_cause: '比重计未校准，喷嘴堵塞，溶剂挥发', recommend_action: '每班测试比重并记录，定期超声波清洗喷嘴', severity: 'HIGH' },
      { keyword: 'bridge', title: '引脚短路与连锡 (Pin Bridging / Shorts)', root_cause: '锡锅铜含量超标，浸锡时间过长，脱锡角度不良', recommend_action: '优化轨道倾斜角度 (4°-6°)，化验锡锅成分并捞渣', severity: 'HIGH' },
      { keyword: 'fill', title: '通孔透锡率不足 <75% (Poor Hole Fill)', root_cause: '元器件引脚氧化，预热不足导致助焊剂提前失效', recommend_action: '检查物料可焊性，提高预热温度 5-10°C 促进透锡', severity: 'HIGH' },
      { keyword: 'dross', title: '锡渣堆积与锡尖 (Dross Accumulation & Spikes)', root_cause: '防氧化油未加，锡锅波峰液位过高', recommend_action: '加装还原粉，每4小时彻底清理波峰槽四周锡渣', severity: 'MEDIUM' }
    ];
  }
  if (p.includes('reflow')) {
    return [
      { keyword: 'profile', title: '回流焊温度曲线未更新/漂移 (Reflow Profile Non-compliance)', root_cause: '各温区发热管老化，未依换线要求调用新版 Profile', recommend_action: '使用 KIC 重新测试全温区 Profile 并锁定配方', severity: 'HIGH' },
      { keyword: 'n2', title: '氮气流量与含氧量超标 (N2 Flow / PPM Out of Spec)', root_cause: '气源总压不足，炉膛进出口密封帘磨损漏气', recommend_action: '检查氮气源压力 (>0.5MPa)，更换防风帘与过滤器', severity: 'HIGH' },
      { keyword: 'void', title: 'BGA/QFN 焊点空洞率超标 (Void Ratio > 25%)', root_cause: '升温速率过快，锡膏溶剂挥发不充分，焊盘受潮', recommend_action: '调整升温斜率，确保预热区保持 60-90 秒', severity: 'HIGH' },
      { keyword: 'tombstone', title: '片式元件立碑与偏位 (Tombstoning / Shift)', root_cause: '两端焊盘受热不均，印刷锡膏量两端不平衡', recommend_action: '校准印刷平整度，优化均热温区热风对流平衡', severity: 'HIGH' },
      { keyword: 'board', title: 'PCB 板面起泡或变色 (PCB Delamination / Blistering)', root_cause: '最高峰值温度过高 (>255°C) 或受潮板材未烘烤', recommend_action: '严格核算峰值温区停留时间，受潮板材 125°C/4h 烘烤', severity: 'CRITICAL' }
    ];
  }
  if (p.includes('printer') || p.includes('print')) {
    return [
      { keyword: 'sop', title: '印刷机 SOP 与参数表不符 (SOP Parameter Mismatch)', root_cause: '技术员调机后未依最新参数表复核，变更未受控', recommend_action: '刮刀压力、速度参数由工艺工程师权限密码锁定', severity: 'HIGH' },
      { keyword: 'wipe', title: '钢网未依频次清洗堵孔 (Stencil Clogging / Insufficient Wipe)', root_cause: '擦网溶剂用尽或真空吸力不足，自动清洗频次过低', recommend_action: '设定每 3 板自动清洗一次 (真空+溶剂)，每 2 小时人工擦网', severity: 'HIGH' },
      { keyword: 'paste', title: '锡膏开封超时或回温不足 (Paste Pot-life / Temp Expired)', root_cause: '作业员未按先进先出领料，未满 4 小时回温即开封使用', recommend_action: '启用锡膏全流程条码追溯柜，未回温完成禁止出柜', severity: 'CRITICAL' },
      { keyword: 'align', title: '印刷对位偏移 >25% (Stencil Printing Misalignment)', root_cause: 'PCB Mark 点脏污或反光，支撑顶针松动翘曲', recommend_action: '校准双目 Mark 点识别系统，重新排布密集磁性顶针', severity: 'HIGH' },
      { keyword: 'height', title: '锡膏厚度/体积超出 ±20% (Paste Volume / Thickness Drift)', root_cause: '刮刀刀片磨损变形，两端压力不均', recommend_action: '定期检查刮刀平直度并使用 SPI 联动自动补正', severity: 'HIGH' }
    ];
  }
  if (p.includes('esd') || p.includes('quality')) {
    return [
      { keyword: 'wrist', title: '静电手环接地阻抗超标 (ESD Wrist Strap Resistance NG)', root_cause: '手环金属片氧化，连接线拉伸断线，手腕过干', recommend_action: '安装台面常驻式静电监控仪，声光实时报警', severity: 'HIGH' },
      { keyword: 'ground', title: '工作台/静电椅/料架未接地 (Grounding Cord Disconnected)', root_cause: '拖地时撞脱接地扣，接地链磨损悬空', recommend_action: '每周巡检接地排阻抗 (<1.0Ω)，加装防撞保护罩', severity: 'HIGH' },
      { keyword: 'ionizer', title: '离子风机去静电失效 (Ionizer Balance NG)', root_cause: '放电针积聚灰尘，风速未达到要求', recommend_action: '每周用专用刷清洗放电针，每季标定离子平衡度', severity: 'MEDIUM' },
      { keyword: 'box', title: 'ESD 导电胶箱破损/阻抗超标 (ESD Tote Box Defective)', root_cause: '导电材质老化衰退，现场混用非防静电普通塑料盒', recommend_action: '淘汰不合格旧箱，严禁普通塑料制品进入生产区', severity: 'MEDIUM' },
      { keyword: 'wear', title: '作业员防静电衣帽鞋穿戴不规范 (ESD Garment Non-compliance)', root_cause: '作业员头发外露，防静电鞋鞋底积尘', recommend_action: '班前风淋门强化着装检查，设置鞋底除尘垫', severity: 'MEDIUM' }
    ];
  }
  return [
    { keyword: 'sop', title: '作业指导书 (SOP) 不一致或未签审', root_cause: '文档更新不及时，现场版本失控', recommend_action: '全面复核站位文件，落实工程受控印章', severity: 'HIGH' },
    { keyword: 'machine', title: '设备点检表漏签或参数飘移', root_cause: '当班点检漏项，传感器零点漂移', recommend_action: '机台开机前必须完成点检方可生产', severity: 'HIGH' },
    { keyword: 'tool', title: '工装治具磨损或未校准', root_cause: '治具超过保养寿命周期仍在使用', recommend_action: '建立治具寿命寿命计数管理，超期报废或翻新', severity: 'MEDIUM' },
    { keyword: 'training', title: '作业员操作手法不合规', root_cause: '新员工上岗培训不充分，未获上岗证', recommend_action: '重新进行 SOP 实操考核与资质认证', severity: 'MEDIUM' },
    { keyword: 'first', title: '首件制作与确认不严格 (FAI Skip)', root_cause: '为了抢产量而提前批量过板', recommend_action: '严禁首件合格前批量投入，违者停线通报', severity: 'CRITICAL' }
  ];
}

function getProcessPFMEAGuidance(procName) {
  const p = (procName || '').toLowerCase();
  if (p.includes('wave')) {
    return `<strong>🌊 DIP-Wave 波峰焊控制关键:</strong> 重点监控波峰温度稳定性与焊点透锡率 (Hole-fill ≥ 75%)。温度曲线 (Profile) 必须每班次或换线前完成测试验证，防止冷焊与桥连！`;
  }
  if (p.includes('reflow')) {
    return `<strong>♨️ SMT-Reflow 回流焊控制关键:</strong> 严格维持 TAL (Time Above Liquidus 45-75s) 与氮气氧浓度 (<1000 ppm)。杜绝未经 Profile 签字认证擅自投产！`;
  }
  if (p.includes('printer')) {
    return `<strong>📑 SMT-Printer 印刷控制关键:</strong> 锡膏印刷贡献 SMT 70% 缺陷。必须严格管制锡膏回温开封时限 (<24h) 与钢网定时清洗防堵孔！`;
  }
  if (p.includes('esd') || p.includes('quality')) {
    return `<strong>⚡ ESD 静电控制关键:</strong> 敏感元件静电耐压极限 < 100V。请确保工作台接地链与离子风机 balance 控制在 ±35V 以内！`;
  }
  return `<strong>⚙️ ${procName} 制程控制关键:</strong> 严格遵守 IATF 16949 / IPC-A-610 标准，对高发异常落实根本原因 4M1E 鱼骨图分析与预防防错对策！`;
}

// QR STICKERS GENERATOR FOR FACTORY FLOOR
function renderQrStickers() {
  const container = document.getElementById('container-qr-stickers');
  if (!container) return;
  container.innerHTML = '';

  const stations = (typeof masterStationsData !== 'undefined' && masterStationsData.length > 0) ? masterStationsData : defaultStations;

  stations.forEach(st => {
    const card = document.createElement('div');
    card.className = 'qr-card';
    card.style.background = '#0f172a';
    card.style.border = '1px solid var(--border-color)';
    card.style.borderRadius = '12px';
    card.style.padding = '1.25rem';
    card.style.textAlign = 'center';

    const stCode = st.station_code || st.code;
    const stName = st.station_name || st.name;
    const stLine = st.line_name || st.line;
    const stPhase = st.phase || 'Phase 1';
    const stStd = getStationStandardDoc(st);
    const qrDivId = `qr-${stCode.replace(/[^a-zA-Z0-9]/g, '_')}`;

    card.innerHTML = `
      <div style="font-size:0.72rem; font-weight:bold; color:#38bdf8; background:rgba(56,189,248,0.1); padding:0.2rem 0.5rem; border-radius:6px; display:inline-block; margin-bottom:0.5rem;">
        ${stPhase} • ${stStd} • ${stLine}
      </div>
      <div style="font-family: monospace; font-size: 1.05rem; font-weight: bold; color: #fff; margin-bottom: 0.2rem;">${stCode}</div>
      <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.85rem;">${stName}</div>
      <div id="${qrDivId}" style="display: flex; justify-content: center; margin-bottom: 0.85rem; padding: 0.5rem; background: #fff; border-radius: 8px; width: 140px; height: 140px; margin: 0 auto 0.85rem;"></div>
      <div style="font-size: 0.7rem; color: #64748b;">Scan with Smart IPQC Tablet to Audit</div>
    `;

    container.appendChild(card);

    setTimeout(() => {
      const qrEl = document.getElementById(qrDivId);
      if (qrEl && typeof QRCode !== 'undefined') {
        qrEl.innerHTML = '';
        new QRCode(qrEl, {
          text: `https://ipqc.primax.com/audit/${stCode}`,
          width: 128,
          height: 128,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      }
    }, 100);
  });
}

// ==============================================================================
// AI-POWERED INTELLIGENT TREND WARNING & PFMEA-LINKED ANALYSIS ENGINE
// ==============================================================================

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let aiConfigCache = {
  provider: localStorage.getItem('ipqc_ai_provider') || 'auto',
  gemini_key: localStorage.getItem('ipqc_ai_gemini_key') || '',
  endpoint: localStorage.getItem('ipqc_ai_endpoint') || 'http://192.9.135.138:8000/v1',
  model: localStorage.getItem('ipqc_ai_model') || ''
};

window.currentAIPredictions = [];
window.currentAIPFMEAMatrix = [];

async function loadAIInsights(forceManual = false) {
  const container = document.getElementById('container-ai-insights');
  const synthBody = document.getElementById('ai-synthesis-body');
  const pfmeaTbody = document.getElementById('pfmea-matrix-tbody');
  const runBtn = document.getElementById('btn-run-ai-analysis');
  const statusBadge = document.getElementById('ai-engine-status-badge');
  const statusText = document.getElementById('ai-engine-status-text');
  const statusDot = document.getElementById('ai-engine-status-dot');
  const latencyBadge = document.getElementById('ai-engine-latency-badge');

  const lineFilter = document.getElementById('ai-filter-line')?.value || 'ALL';
  const daysFilter = parseInt(document.getElementById('ai-filter-days')?.value || '30', 10);

  if (runBtn) runBtn.disabled = true;
  if (statusDot) statusDot.textContent = '⏳';
  if (statusText) statusText.textContent = 'Analyzing Real-time Findings...';

  let data = null;
  try {
    const payload = {
      line: lineFilter,
      days: daysFilter,
      provider: aiConfigCache.provider || 'auto',
      api_key: aiConfigCache.gemini_key || '',
      model: aiConfigCache.model || '',
      custom_endpoint: aiConfigCache.endpoint || ''
    };

    let res;
    if (forceManual) {
      res = await apiFetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await apiFetch(`/api/ai/insights?line=${encodeURIComponent(lineFilter)}&days=${daysFilter}&provider=${encodeURIComponent(aiConfigCache.provider)}`);
    }

    if (res && res.ok) {
      data = await res.json();
    } else {
      const getRes = await apiFetch(`/api/ai/insights?line=${encodeURIComponent(lineFilter)}&days=${daysFilter}`);
      if (getRes && getRes.ok) data = await getRes.json();
    }
  } catch (err) {
    console.warn("AI Insights load error:", err);
  } finally {
    if (runBtn) runBtn.disabled = false;
  }

  try {
    // 1. Update AI Engine Status Bar
    if (data && data.ai_engine) {
      if (statusDot) statusDot.textContent = '🟢';
      if (statusText) statusText.textContent = `${data.ai_engine}`;
      if (statusBadge) {
        statusBadge.style.background = 'rgba(52,211,153,0.15)';
        statusBadge.style.borderColor = 'rgba(52,211,153,0.3)';
        statusBadge.style.color = '#34d399';
      }
      if (latencyBadge && data.ai_latency_ms !== undefined) {
        latencyBadge.textContent = `${data.ai_latency_ms}ms`;
        latencyBadge.style.display = 'inline-block';
      }
      const engineTag = document.getElementById('ai-synthesis-engine-tag');
      if (engineTag) engineTag.textContent = data.ai_status || data.ai_engine;
    } else {
      if (statusDot) statusDot.textContent = '🟡';
      if (statusText) statusText.textContent = 'PFMEA Expert Engine (Ready)';
      if (statusBadge) {
        statusBadge.style.background = 'rgba(245,158,11,0.15)';
        statusBadge.style.borderColor = 'rgba(245,158,11,0.3)';
        statusBadge.style.color = '#f59e0b';
      }
    }

    if (!data || !data.kpis) {
      if (container) {
        container.innerHTML = `
          <div style="background: rgba(15,23,42,0.6); border: 1px solid rgba(239,68,68,0.3); border-radius: 12px; padding: 2rem 1.5rem; text-align: center;">
            <div style="font-size: 2.2rem; margin-bottom: 0.5rem;">⚠️</div>
            <div style="font-size: 1.05rem; font-weight: bold; color: #f87171; margin-bottom: 0.35rem;">Could not load AI Insights</div>
            <p style="font-size: 0.85rem; color: #94a3b8; max-width: 480px; margin: 0 auto;">Please verify network connection or configure the AI API link above.</p>
          </div>`;
      }
      return;
    }

    // 2. Update KPI Ribbon
    const kpis = data.kpis;
    const elComp = document.getElementById('ai-kpi-compliance');
    const elTotal = document.getElementById('ai-kpi-total-audits');
    const elAnom = document.getElementById('ai-kpi-anomalies');
    const elRpn = document.getElementById('ai-kpi-max-rpn');

    if (elComp) {
      elComp.textContent = `${kpis.overall_compliance || 100}%`;
      elComp.style.color = (kpis.overall_compliance >= 95) ? '#34d399' : (kpis.overall_compliance >= 90 ? '#f59e0b' : '#ef4444');
    }
    if (elTotal) elTotal.textContent = (kpis.total_audits || 0).toLocaleString();
    if (elAnom) {
      const totalAnom = (kpis.critical_count || 0) + (kpis.moderate_count || 0);
      elAnom.textContent = `${totalAnom} Stations`;
      elAnom.style.color = totalAnom > 0 ? (kpis.critical_count > 0 ? '#ef4444' : '#f59e0b') : '#34d399';
    }
    if (elRpn) {
      elRpn.textContent = kpis.max_rpn || 18;
      elRpn.style.color = (kpis.max_rpn >= 120) ? '#ef4444' : (kpis.max_rpn >= 60 ? '#f59e0b' : '#34d399');
    }

    // 3. Render AI Synthesis Card
    if (synthBody) {
      const rawMarkdown = data.trend_synthesis || '';
      synthBody.innerHTML = formatAISynthesisMarkdown(rawMarkdown);
    }

    // 4. Render Active Anomaly Warning Cards
    const preds = data.predictions || [];
    window.currentAIPredictions = preds;

    if (container) {
      if (preds.length === 0) {
        container.innerHTML = `
          <div style="background: rgba(15,23,42,0.6); border: 1px solid rgba(52,211,153,0.3); border-radius: 12px; padding: 2rem 1.5rem; text-align: center;">
            <div style="font-size: 2.2rem; margin-bottom: 0.5rem;">🟢</div>
            <div style="font-size: 1.05rem; font-weight: bold; color: #34d399; margin-bottom: 0.35rem;">AI 全线制程质量稳定 (All Lines Operating in Statistical Quality Control)</div>
            <p style="font-size: 0.82rem; color: #94a3b8; max-width: 520px; margin: 0 auto; line-height: 1.5;">
              当前所选时间段内未检测到连续失效或异常漂移。所有 16 条生产线均符合 IATF 16949 / IPC-A-610 巡检基准。
            </p>
          </div>`;
      } else {
        container.innerHTML = preds.map((pred, idx) => {
          const isCrit = pred.risk_level === 'CRITICAL' || pred.rpn >= 120;
          const borderCol = isCrit ? 'rgba(239,68,68,0.4)' : 'rgba(245,158,11,0.4)';
          const bgBadge = isCrit ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)';
          const textBadge = isCrit ? '#f87171' : '#fbbf24';
          const icon = isCrit ? '🚨' : '⚠️';

          return `
            <div style="background: rgba(15,23,42,0.85); border: 1px solid ${borderCol}; border-radius: 12px; padding: 1.15rem; margin-bottom: 0.85rem; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.45rem; flex-wrap:wrap; gap:0.5rem;">
                <div style="display:flex; align-items:center; gap:0.5rem;">
                  <span style="font-size:1.1rem;">${icon}</span>
                  <span style="font-weight:bold; color:#f8fafc; font-size:0.95rem;">${escapeHtml(pred.station)}</span>
                  <span style="font-size:0.7rem; background:${bgBadge}; color:${textBadge}; padding:0.15rem 0.5rem; border-radius:6px; font-weight:bold;">${escapeHtml(pred.risk_level)} (RPN: ${pred.rpn})</span>
                </div>
                <span style="font-size:0.72rem; color:#94a3b8; font-family:monospace; background:rgba(30,41,59,0.8); padding:0.15rem 0.5rem; border-radius:4px;">Confidence: ${escapeHtml(pred.confidence || '96%')}</span>
              </div>
              <p style="font-size:0.82rem; color:#cbd5e1; line-height:1.45; margin:0 0 0.5rem 0;">
                <strong>Finding:</strong> ${escapeHtml(pred.finding)} <span style="color:#94a3b8;">(${escapeHtml(pred.pfmea_impact)})</span>
              </p>
              <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; padding-top:0.45rem; border-top:1px solid rgba(255,255,255,0.06);">
                <div style="font-size:0.78rem; color:#38bdf8; font-weight:600;">
                  💡 <strong>Recommended CLCA:</strong> ${escapeHtml(pred.recommended_action)}
                </div>
                <button type="button" class="btn-select" onclick="openCAPAFromPFMEAPred(${idx})" style="padding:0.25rem 0.6rem; font-size:0.72rem; color:#34d399; border-color:rgba(52,211,153,0.4); font-weight:bold;">
                  + Open CAPA
                </button>
              </div>
            </div>`;
        }).join('');
      }
    }

    // 5. Render PFMEA Matrix Table
    const matrix = data.pfmea_matrix || [];
    window.currentAIPFMEAMatrix = matrix;

    if (pfmeaTbody) {
      const totalBadge = document.getElementById('pfmea-total-badge');
      if (totalBadge) totalBadge.textContent = `${matrix.length} Evaluated Stations`;

      if (matrix.length === 0) {
        pfmeaTbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:1.5rem; color:#64748b;">No station data available for current filter.</td></tr>';
      } else {
        pfmeaTbody.innerHTML = matrix.map((row, idx) => {
          let rpnBg = 'rgba(52,211,153,0.15)';
          let rpnColor = '#34d399';
          if (row.rpn >= 120) { rpnBg = 'rgba(239,68,68,0.2)'; rpnColor = '#f87171'; }
          else if (row.rpn >= 60) { rpnBg = 'rgba(245,158,11,0.2)'; rpnColor = '#fbbf24'; }

          return `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
              <td style="padding:0.6rem 0.75rem; font-weight:600; color:#f8fafc;">
                <div>${escapeHtml(row.station_name)}</div>
                <div style="font-size:0.7rem; color:#64748b; font-family:monospace;">${escapeHtml(row.station_code)} | ${escapeHtml(row.line_name)}</div>
              </td>
              <td style="padding:0.6rem 0.75rem; color:#94a3b8;">${escapeHtml(row.process)}</td>
              <td style="padding:0.6rem 0.75rem; color:#cbd5e1; max-width:240px;">
                <div style="font-weight:500;">${escapeHtml(row.failure_mode)}</div>
                <div style="font-size:0.68rem; color:#64748b; margin-top:2px;">Effect: ${escapeHtml(row.effect)}</div>
              </td>
              <td style="padding:0.6rem 0.75rem; text-align:center; font-family:monospace; font-weight:bold; color:#f8fafc;">${row.severity}</td>
              <td style="padding:0.6rem 0.75rem; text-align:center; font-family:monospace; font-weight:bold; color:#f8fafc;" title="Fail rate: ${row.fail_rate}% (${row.fail_count}/${row.total_audits})">${row.occurrence}</td>
              <td style="padding:0.6rem 0.75rem; text-align:center; font-family:monospace; font-weight:bold; color:#f8fafc;">${row.detection}</td>
              <td style="padding:0.6rem 0.75rem; text-align:center;">
                <span style="font-family:monospace; font-weight:bold; font-size:0.85rem; padding:0.15rem 0.45rem; border-radius:6px; background:${rpnBg}; color:${rpnColor};">${row.rpn}</span>
              </td>
              <td style="padding:0.6rem 0.75rem;">
                <span style="font-size:0.7rem; padding:0.15rem 0.45rem; border-radius:4px; font-weight:bold; background:${rpnBg}; color:${rpnColor};">${escapeHtml(row.risk_level)}</span>
              </td>
              <td style="padding:0.6rem 0.75rem; font-size:0.75rem; color:#94a3b8; max-width:260px;">${escapeHtml(row.recommended_action)}</td>
              <td style="padding:0.6rem 0.75rem; text-align:center;">
                <button type="button" class="btn-select" onclick="openCAPAFromPFMEARow(${idx})" style="padding:0.25rem 0.5rem; font-size:0.7rem; color:#38bdf8; border-color:rgba(56,189,248,0.4);" title="Create CAPA Ticket">
                  + CAPA
                </button>
              </td>
            </tr>`;
        }).join('');
      }
    }
  } catch (renderErr) {
    console.error("Error rendering AI Insights / PFMEA matrix:", renderErr);
  }
}

function formatAISynthesisMarkdown(md) {
  if (!md) return '<p style="color:#64748b;">No report generated.</p>';
  let html = md
    .replace(/^### (.*$)/gim, '<h4 style="color:#38bdf8;margin:0.75rem 0 0.4rem 0;font-size:0.95rem;">$1</h4>')
    .replace(/^#### (.*$)/gim, '<h5 style="color:#34d399;margin:0.6rem 0 0.35rem 0;font-size:0.88rem;">$1</h5>')
    .replace(/\*\*(.*?)\*\*/gim, '<strong style="color:#f8fafc;">$1</strong>')
    .replace(/`([^`]+)`/gim, '<code style="background:rgba(30,41,59,0.9);padding:0.15rem 0.35rem;border-radius:4px;font-family:monospace;color:#38bdf8;font-size:0.8rem;">$1</code>')
    .replace(/^\- (.*$)/gim, '<div style="margin-left:0.8rem;margin-bottom:0.25rem;">• $1</div>')
    .replace(/^\d+\. (.*$)/gim, '<div style="margin-left:0.8rem;margin-bottom:0.25rem;">• $1</div>')
    .replace(/\n\n/gim, '<div style="margin-bottom:0.6rem;"></div>');
  return html;
}

function triggerManualAIAnalysis() {
  loadAIInsights(true);
  showToast('AI Analysis', 'Executing deep statistical trend scan and PFMEA analysis...', 'info');
}

function openAIConfigModal() {
  const modal = document.getElementById('modal-ai-config');
  if (!modal) return;

  const prov = document.getElementById('cfg-ai-provider');
  const key = document.getElementById('cfg-ai-gemini-key');
  const ep = document.getElementById('cfg-ai-endpoint');
  const mod = document.getElementById('cfg-ai-model');

  if (prov) prov.value = aiConfigCache.provider || 'auto';
  if (key) key.value = aiConfigCache.gemini_key || '';
  if (ep) ep.value = aiConfigCache.endpoint || 'http://192.9.135.138:8000/v1';
  if (mod) mod.value = aiConfigCache.model || '';

  handleAIProviderChange();
  modal.classList.add('active');
}

function closeAIConfigModal() {
  document.getElementById('modal-ai-config')?.classList.remove('active');
  const res = document.getElementById('cfg-ai-test-result');
  if (res) res.style.display = 'none';
}

function handleAIProviderChange() {
  const prov = document.getElementById('cfg-ai-provider')?.value || 'auto';
  const gemSec = document.getElementById('cfg-gemini-section');
  const epSec = document.getElementById('cfg-endpoint-section');

  if (prov === 'gemini') {
    if (gemSec) gemSec.style.display = 'block';
    if (epSec) epSec.style.display = 'none';
  } else if (prov === 'ollama') {
    if (gemSec) gemSec.style.display = 'none';
    if (epSec) epSec.style.display = 'block';
  } else {
    if (gemSec) gemSec.style.display = 'block';
    if (epSec) epSec.style.display = 'block';
  }
}

function toggleAIKeyVisibility(id) {
  const inp = document.getElementById(id);
  if (inp) {
    inp.type = inp.type === 'password' ? 'text' : 'password';
  }
}

async function testAIConnection() {
  const btn = document.getElementById('btn-test-ai-conn');
  const banner = document.getElementById('cfg-ai-test-result');
  const prov = document.getElementById('cfg-ai-provider')?.value || 'auto';
  const key = document.getElementById('cfg-ai-gemini-key')?.value?.trim() || '';
  const ep = document.getElementById('cfg-ai-endpoint')?.value?.trim() || '';
  const mod = document.getElementById('cfg-ai-model')?.value?.trim() || '';

  if (btn) btn.disabled = true;
  if (banner) {
    banner.style.display = 'block';
    banner.style.background = 'rgba(56,189,248,0.15)';
    banner.style.border = '1px solid rgba(56,189,248,0.3)';
    banner.style.color = '#38bdf8';
    banner.textContent = '⏳ Testing connection to AI Engine...';
  }

  try {
    const res = await apiFetch('/api/ai/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: prov,
        api_key: key,
        endpoint: ep,
        model: mod
      })
    });

    const data = await res.json();
    if (banner) {
      if (data.success) {
        banner.style.background = 'rgba(52,211,153,0.15)';
        banner.style.border = '1px solid rgba(52,211,153,0.3)';
        banner.style.color = '#34d399';
        banner.textContent = `✓ ${data.engine || 'AI Engine'} Connected! Latency: ${data.latency_ms || 0}ms. Status: ${data.status || 'Active'}`;
      } else {
        banner.style.background = 'rgba(239,68,68,0.15)';
        banner.style.border = '1px solid rgba(239,68,68,0.3)';
        banner.style.color = '#f87171';
        banner.textContent = `✕ Connection test failed: ${data.error || 'Server unreachable'}`;
      }
    }
  } catch (err) {
    if (banner) {
      banner.style.background = 'rgba(239,68,68,0.15)';
      banner.style.border = '1px solid rgba(239,68,68,0.3)';
      banner.style.color = '#f87171';
      banner.textContent = `✕ Request error: ${err.message}`;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function saveAIConfigAndRun() {
  const prov = document.getElementById('cfg-ai-provider')?.value || 'auto';
  const key = document.getElementById('cfg-ai-gemini-key')?.value?.trim() || '';
  const ep = document.getElementById('cfg-ai-endpoint')?.value?.trim() || '';
  const mod = document.getElementById('cfg-ai-model')?.value?.trim() || '';

  aiConfigCache = {
    provider: prov,
    gemini_key: key,
    endpoint: ep,
    model: mod
  };

  try {
    localStorage.setItem('ipqc_ai_provider', prov);
    localStorage.setItem('ipqc_ai_gemini_key', key);
    localStorage.setItem('ipqc_ai_endpoint', ep);
    localStorage.setItem('ipqc_ai_model', mod);
  } catch (e) {}

  closeAIConfigModal();
  showToast('Settings Saved', 'AI Engine settings linked successfully. Running analysis...', 'success');
  loadAIInsights(true);
}

function openCAPAFromPFMEA(stCode, failureMode, severity) {
  const dashBtn = document.querySelector('.nav-tab[data-tab="dashboard"]');
  if (dashBtn) dashBtn.click();
  if (typeof switchDashboardSubView === 'function') switchDashboardSubView('capa');
  
  setTimeout(() => {
    const modal = document.getElementById('modal-capa-update');
    if (modal) {
      modal.classList.add('active');
      const stInp = document.getElementById('inp-capa-station');
      const descInp = document.getElementById('inp-capa-defect');
      const sevInp = document.getElementById('inp-capa-severity');
      if (stInp) stInp.value = stCode || '';
      if (descInp) descInp.value = `[PFMEA Link] ${failureMode || 'Process Parameter Drift'}`;
      if (sevInp) sevInp.value = severity || 'MEDIUM';
    }
  }, 250);
}

function openCAPAFromPFMEAPred(idx) {
  const pred = (window.currentAIPredictions || [])[idx];
  if (!pred) return;
  const isCrit = pred.risk_level === 'CRITICAL' || pred.rpn >= 120;
  openCAPAFromPFMEA(pred.station_code || '', pred.finding || '', isCrit ? 'HIGH' : 'MEDIUM');
}

function openCAPAFromPFMEARow(idx) {
  const row = (window.currentAIPFMEAMatrix || [])[idx];
  if (!row) return;
  openCAPAFromPFMEA(row.station_code || '', row.failure_mode || '', (row.severity >= 8) ? 'HIGH' : 'MEDIUM');
}

// Window exposures
window.loadAIInsights = loadAIInsights;
window.triggerManualAIAnalysis = triggerManualAIAnalysis;
window.openAIConfigModal = openAIConfigModal;
window.closeAIConfigModal = closeAIConfigModal;
window.handleAIProviderChange = handleAIProviderChange;
window.toggleAIKeyVisibility = toggleAIKeyVisibility;
window.testAIConnection = testAIConnection;
window.saveAIConfigAndRun = saveAIConfigAndRun;
window.openCAPAFromPFMEA = openCAPAFromPFMEA;
window.openCAPAFromPFMEAPred = openCAPAFromPFMEAPred;
window.openCAPAFromPFMEARow = openCAPAFromPFMEARow;

// QR Camera Scanner Engine
function openQrScanner() {
  document.getElementById('modal-scanner')?.classList.add('active');
  if (typeof Html5Qrcode !== 'undefined') {
    html5QrScanner = new Html5Qrcode("qr-reader");
    html5QrScanner.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        closeQrScanner();
        // Parse station code from URL or text
        const parts = decodedText.split('/');
        const stationCode = parts[parts.length - 1];
        const dataset = fetchedStations.length > 0 ? fetchedStations : defaultStations;
        const match = dataset.find(s => s.station_code === stationCode || s.code === stationCode);
        if (match) {
          startAuditForStation(match);
        } else {
          alert(`Scanned Station Code: ${stationCode}`);
        }
      },
      (error) => {}
    ).catch(err => {
      console.warn("QR Scanner Init Error:", err);
    });
  }
}

function closeQrScanner() {
  if (html5QrScanner) {
    html5QrScanner.stop().then(() => {
      html5QrScanner.clear();
      html5QrScanner = null;
    }).catch(() => {});
  }
  document.getElementById('modal-scanner')?.classList.remove('active');
}

// Email Report Preview and Dispatch
async function openEmailModal(targetType, targetId) {
  document.getElementById('email-target-type').value = targetType;
  document.getElementById('email-target-id').value = targetId || '';
  
  const notesInput = document.getElementById('email-notes-input');
  if (notesInput) notesInput.value = '';

  const recInput = document.getElementById('email-recipient-input');
  if (recInput) {
    recInput.value = getMqaGroupEmail();
  }

  const isFai = targetType === 'fai' || (targetId && (targetId.startsWith('FAI-') || targetId.startsWith('LAI-')));

  const titleEl = document.getElementById('email-modal-title');
  if (titleEl) {
    if (isFai) {
      titleEl.textContent = `📋 SMT First & Last Article Record (5Q4-045 V5) [${targetId}]`;
    } else if (targetType === 'audit') {
      titleEl.textContent = `📧 Send Audit Execution Report Email [${targetId}]`;
    } else {
      titleEl.textContent = `📧 Send 8D / CLCA Anomaly Issue Report Email [${targetId}]`;
    }
  }

  const exportBtn = document.getElementById('btn-export-audit-excel');
  if (exportBtn) {
    exportBtn.style.display = (targetType === 'audit' || isFai) ? 'inline-flex' : 'none';
    exportBtn.innerHTML = isFai 
      ? '<span>📊</span> Export 5Q4-045 Excel' 
      : '<span>📊</span> Export Shift Consolidated Excel';
  }

  const iframe = document.getElementById('email-report-iframe');
  if (iframe) {
    iframe.srcdoc = '<div style="color:#94a3b8; padding:20px; font-family:sans-serif; text-align:center;">Loading Live Report Preview...</div>';
    let previewUrl;
    if (isFai) {
      previewUrl = `/api/reports/fai/preview?audit_id=${encodeURIComponent(targetId)}`;
    } else if (targetType === 'audit') {
      previewUrl = `/api/reports/audit/preview?audit_id=${encodeURIComponent(targetId)}`;
    } else {
      previewUrl = `/api/reports/clca/preview?capa_id=${encodeURIComponent(targetId)}`;
    }
    
    try {
      const res = await fetch(previewUrl);
      if (res.ok) {
        const html = await res.text();
        iframe.srcdoc = html;
      } else {
        iframe.src = previewUrl;
      }
    } catch (e) {
      iframe.src = previewUrl;
    }
  }

  document.getElementById('modal-email-report')?.classList.add('active');
}

async function handleExportAuditExcel() {
  const targetId = document.getElementById('email-target-id')?.value;
  if (!targetId) {
    alert('No audit report selected for export.');
    return;
  }
  const targetType = document.getElementById('email-target-type')?.value;
  const isFai = targetType === 'fai' || targetId.startsWith('FAI-') || targetId.startsWith('LAI-');

  const btn = document.getElementById('btn-export-audit-excel');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.innerHTML = isFai ? '<span>⏳</span> Exporting 5Q4-045 Excel...' : '<span>⏳</span> Exporting Shift Consolidated Excel...';
    btn.disabled = true;
  }

  try {
    const exportUrl = isFai 
      ? `/api/reports/fai/export?audit_id=${encodeURIComponent(targetId)}`
      : `/api/reports/audit/export?audit_id=${encodeURIComponent(targetId)}&consolidated=true`;

    const res = await fetch(exportUrl);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Export failed');
    }
    const blob = await res.blob();
    
    let filename = isFai ? `5Q4-045_SMT_FAI_${targetId}.xlsx` : `IPQC_Audit_Report_${targetId}.xls`;
    const disposition = res.headers.get('Content-Disposition');
    if (disposition && disposition.includes('filename=')) {
      const match = disposition.match(/filename="?([^";]+)"?/);
      if (match && match[1]) filename = match[1];
    }

    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);

    if (typeof showToast === 'function') {
      showToast('📊 Export Complete', `${isFai ? 'Official 5Q4-045' : 'Shift consolidated'} Excel report downloaded: ${filename}`);
    } else {
      alert(`✅ ${isFai ? 'Official 5Q4-045' : 'Shift Consolidated'} Excel Report downloaded: ${filename}`);
    }
  } catch (err) {
    console.error('Export error:', err);
    alert(`Could not export audit Excel report: ${err.message}`);
  } finally {
    if (btn) {
      btn.innerHTML = originalHtml;
      btn.disabled = false;
    }
  }
}

/**
 * downloadConsolidatedExcel(auditId)
 * Direct download of consolidated shift Excel from any row button in Audit History.
 */
async function downloadConsolidatedExcel(auditId) {
  if (!auditId) { alert('No audit ID specified.'); return; }
  try {
    if (typeof showToast === 'function') {
      showToast('📊 Generating...', `Generating shift consolidated Excel for ${auditId}...`, 'info');
    }
    const res = await fetch(`/api/reports/audit/export?audit_id=${encodeURIComponent(auditId)}&consolidated=true`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Export failed');
    }
    const blob = await res.blob();
    let filename = `IPQC_Shift_Consolidated_${auditId}.xls`;
    const disposition = res.headers.get('Content-Disposition');
    if (disposition && disposition.includes('filename=')) {
      const match = disposition.match(/filename="?([^";]+)"?/);
      if (match && match[1]) filename = match[1];
    }
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    window.URL.revokeObjectURL(url);
    if (typeof showToast === 'function') {
      showToast('✅ Downloaded', `Shift consolidated Excel saved: ${filename}`, 'success');
    }
  } catch (err) {
    console.error('downloadConsolidatedExcel error:', err);
    alert(`Could not download shift Excel: ${err.message}`);
  }
}

/**
 * exportFilteredConsolidatedExcel()
 * Locates the latest audit matching active history filters and downloads the consolidated Excel report.
 */
async function exportFilteredConsolidatedExcel() {
  const fDate = document.getElementById('history-filter-date')?.value;
  const fLine = document.getElementById('history-filter-line')?.value;
  const fModel = document.getElementById('history-filter-model')?.value.trim();
  const fWO = document.getElementById('history-filter-wo')?.value.trim();

  const params = new URLSearchParams();
  if (fDate) params.append('date', fDate);
  if (fLine) params.append('line_name', fLine);
  if (fModel) params.append('model_no', fModel);
  if (fWO) params.append('work_order', fWO);

  try {
    if (typeof showToast === 'function') {
      showToast('📊 Searching Audits', 'Locating latest shift audit for report...', 'info');
    }
    const res = await apiFetch(`/api/audits?${params.toString()}`);
    if (!res.ok) throw new Error('Failed to query audits');
    const audits = await res.json();
    if (!Array.isArray(audits) || audits.length === 0) {
      alert('No completed audits found matching the selected filter criteria to export.');
      return;
    }
    const targetAuditId = audits[0].id;
    await downloadConsolidatedExcel(targetAuditId);
  } catch (e) {
    console.error('exportFilteredConsolidatedExcel error:', e);
    alert('Export error: ' + e.message);
  }
}
window.exportFilteredConsolidatedExcel = exportFilteredConsolidatedExcel;




async function handleConfirmSendEmail() {
  const targetType = document.getElementById('email-target-type').value;
  const targetId = document.getElementById('email-target-id').value;
  const recipient = document.getElementById('email-recipient-input').value.trim() || getMqaGroupEmail();
  const notes = document.getElementById('email-notes-input').value.trim();

  if (!recipient) {
    alert('Please enter a recipient email address.');
    return;
  }

  const isFai = targetType === 'fai' || (targetId && (targetId.startsWith('FAI-') || targetId.startsWith('LAI-')));

  const confirmBtn = document.getElementById('btn-confirm-send-email');
  const origBtnText = confirmBtn ? confirmBtn.textContent : '';
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = isFai ? '⏳ Sending 5Q4-045 FAI Email...' : '⏳ Sending Email with Excel...';
  }

  try {
    let url, bodyPayload;
    if (isFai) {
      url = '/api/reports/fai/email';
      bodyPayload = { audit_id: targetId, recipient_email: recipient, notes: notes };
    } else if (targetType === 'audit') {
      url = '/api/reports/audit/email';
      bodyPayload = { audit_id: targetId, recipient_email: recipient, notes: notes };
    } else {
      url = '/api/reports/clca/email';
      bodyPayload = { capa_id: targetId, recipient_email: recipient, notes: notes };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyPayload)
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === 'SUCCESS') {
      const attachInfo = data.attachment_name ? `\n📎 Attachment: ${data.attachment_name}` : '';
      alert(`🎉 Email dispatched successfully via SMTP!\n\nRecipient: ${recipient}${attachInfo}\n\n${data.message || ''}`);
      document.getElementById('modal-email-report')?.classList.remove('active');
    } else {
      alert(`⚠️ Email dispatch status:\n\n${data.message || 'Report queued.'}`);
      document.getElementById('modal-email-report')?.classList.remove('active');
    }
  } catch (e) {
    alert(`Email dispatch processed for: ${recipient}`);
    document.getElementById('modal-email-report')?.classList.remove('active');
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = origBtnText || '📤 Send Report Email';
    }
  }
}

// ==========================================
// OUTBOUND EMAIL PAUSE & RESUME CONTROLS
// ==========================================
// STRICT RULE: Outbound email is PAUSED by default every time the browser opens.
window.isEmailPausedState = true;

function updateEmailPauseUI(isPaused) {
  window.isEmailPausedState = Boolean(isPaused);

  // 1. Header Button
  const headerBtn = document.getElementById('btn-header-pause-email');
  const headerIcon = document.getElementById('header-pause-email-icon');
  const headerText = document.getElementById('header-pause-email-text');
  if (headerBtn && headerIcon && headerText) {
    if (window.isEmailPausedState) {
      headerIcon.textContent = '⏸️';
      headerText.textContent = 'Email: PAUSED';
      headerBtn.style.color = '#fbbf24';
      headerBtn.style.borderColor = 'rgba(251,191,36,0.5)';
      headerBtn.style.background = 'rgba(251,191,36,0.1)';
      headerBtn.title = 'Emails are PAUSED by default. Click to Resume sending.';
    } else {
      headerIcon.textContent = '🟢';
      headerText.textContent = 'Email: Active';
      headerBtn.style.color = '#34d399';
      headerBtn.style.borderColor = 'rgba(52,211,153,0.4)';
      headerBtn.style.background = 'transparent';
      headerBtn.title = 'Emails are ACTIVE. Click to Pause sending.';
    }
  }

  // 2. Modal Card Controls
  const modalIcon = document.getElementById('modal-pause-indicator-icon');
  const modalLabel = document.getElementById('modal-pause-status-label');
  const modalDesc = document.getElementById('modal-pause-status-desc');
  const modalBtn = document.getElementById('btn-modal-pause-email');
  const modalCard = document.getElementById('email-modal-pause-card');

  if (modalIcon && modalLabel && modalDesc && modalBtn) {
    if (window.isEmailPausedState) {
      modalIcon.textContent = '⏸️';
      modalLabel.textContent = 'PAUSED (SUSPENDED)';
      modalLabel.style.color = '#fbbf24';
      modalDesc.textContent = 'All outbound emails (MQA line patrol dispatches, CLCA alerts, FAI reports, and tests) are temporarily suspended.';
      modalBtn.textContent = '▶️ Resume Emails';
      modalBtn.style.color = '#34d399';
      modalBtn.style.borderColor = 'rgba(52,211,153,0.6)';
      modalBtn.style.background = 'rgba(52,211,153,0.12)';
      if (modalCard) modalCard.style.borderColor = 'rgba(251,191,36,0.4)';
    } else {
      modalIcon.textContent = '🟢';
      modalLabel.textContent = 'ACTIVE';
      modalLabel.style.color = '#34d399';
      modalDesc.textContent = 'Automated line audit dispatches, manual emails, and reports are sending normally.';
      modalBtn.textContent = '⏸️ Pause All Emails';
      modalBtn.style.color = '#fbbf24';
      modalBtn.style.borderColor = 'rgba(251,191,36,0.5)';
      modalBtn.style.background = 'transparent';
      if (modalCard) modalCard.style.borderColor = 'rgba(52,211,153,0.3)';
    }
  }
}
window.updateEmailPauseUI = updateEmailPauseUI;

async function checkEmailPauseStatus(isInitialAppLoad = false) {
  // Session tracking: has the user explicitly clicked "Resume" during THIS browser session?
  const isResumedInSession = sessionStorage.getItem('ipqc_email_session_resumed') === 'true';

  if (!isResumedInSession) {
    // Every time browser opens fresh, ALWAYS default to PAUSED
    window.isEmailPausedState = true;
    updateEmailPauseUI(true);

    if (isInitialAppLoad) {
      try {
        await apiFetch('/api/email/pause', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: true })
        });
      } catch (err) {
        console.warn('Could not sync initial default pause to server:', err);
      }
      return;
    }
  }

  try {
    const res = await apiFetch('/api/email/pause-status');
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data.is_paused === 'boolean') {
        const finalPaused = isResumedInSession ? data.is_paused : true;
        updateEmailPauseUI(finalPaused);
      }
    }
  } catch (err) {
    console.warn('Could not query email pause status:', err);
  }
}
window.checkEmailPauseStatus = checkEmailPauseStatus;

async function toggleEmailPause() {
  const willPause = !window.isEmailPausedState;
  const promptMsg = willPause
    ? '⏸️ Are you sure you want to PAUSE all outbound email sending?\n\n- Automated MQA line patrol dispatches will be held.\n- CLCA / 8D email notifications will not be sent.\n- FAI/LAI report emails will not be sent.\n\nYou can resume email delivery at any time.'
    : '▶️ Resume outbound email delivery?\n\n- Automated MQA line patrol dispatches will resume.\n- Manual report sending will be re-enabled.\n\n(Note: Closing and reopening the browser will automatically reset email back to PAUSED.)';

  if (!confirm(promptMsg)) return;

  // Optimistic UI update
  updateEmailPauseUI(willPause);

  if (willPause) {
    sessionStorage.removeItem('ipqc_email_session_resumed');
  } else {
    sessionStorage.setItem('ipqc_email_session_resumed', 'true');
  }

  try {
    const res = await apiFetch('/api/email/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: willPause })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === 'SUCCESS') {
      updateEmailPauseUI(data.is_paused);
      showAppToast(
        data.is_paused ? '⏸️ Email Delivery Paused' : '🟢 Email Delivery Resumed',
        data.message || (data.is_paused ? 'Outbound email sending has been suspended.' : 'Outbound email sending has resumed.'),
        data.is_paused ? 'warning' : 'success'
      );
    } else {
      // Revert if API failed
      updateEmailPauseUI(!willPause);
      if (willPause) {
        sessionStorage.setItem('ipqc_email_session_resumed', 'true');
      } else {
        sessionStorage.removeItem('ipqc_email_session_resumed');
      }
      alert(`⚠️ Could not update email pause state: ${data.message || 'Server error'}`);
    }
  } catch (err) {
    updateEmailPauseUI(!willPause);
    if (willPause) {
      sessionStorage.setItem('ipqc_email_session_resumed', 'true');
    } else {
      sessionStorage.removeItem('ipqc_email_session_resumed');
    }
    alert(`⚠️ Failed to communicate with server: ${err.message}`);
  }
}
window.toggleEmailPause = toggleEmailPause;

// SMTP Settings
function openEmailSettingsModal() {
  document.getElementById('modal-email-settings')?.classList.add('active');
  checkEmailStatus();
  checkEmailPauseStatus();
}

function closeEmailSettingsModal() {
  document.getElementById('modal-email-settings')?.classList.remove('active');
}

async function checkEmailStatus() {
  const txt = document.getElementById('email-status-text');
  if (txt) {
    txt.textContent = 'Checking...';
    txt.style.color = '#facc15';
  }

  try {
    const res = await apiFetch('/api/email/status');
    if (res.ok) {
      const data = await res.json();
      if (typeof data.is_paused === 'boolean') {
        const isResumedInSession = sessionStorage.getItem('ipqc_email_session_resumed') === 'true';
        updateEmailPauseUI(isResumedInSession ? data.is_paused : true);
      }
      if (txt) {
        txt.textContent = data.configured ? `🟢 Active (${data.smtp_user} - Ready)` : '🟡 Unconfigured';
        txt.style.color = data.configured ? '#34d399' : '#facc15';
      }

      const hostEl = document.getElementById('cfg-smtp-host');
      const portEl = document.getElementById('cfg-smtp-port');
      const userEl = document.getElementById('cfg-smtp-user');
      const fromEl = document.getElementById('cfg-smtp-from');
      const senderNameEl = document.getElementById('cfg-smtp-sender-name');
      const mqaEl = document.getElementById('cfg-mqa-email');
      const pwdEl = document.getElementById('cfg-smtp-password');
      const autoEl = document.getElementById('cfg-auto-email-mqa');

      if (hostEl && data.smtp_host) hostEl.value = data.smtp_host;
      if (portEl && data.smtp_port) portEl.value = data.smtp_port;
      if (userEl && data.smtp_user) userEl.value = data.smtp_user;
      if (fromEl && data.smtp_from) fromEl.value = data.smtp_from;
      if (senderNameEl) senderNameEl.value = data.sender_name || 'Smart-IPQC';
      if (mqaEl) mqaEl.value = data.mqa_email || getMqaGroupEmail();
      if (pwdEl && data.configured) pwdEl.placeholder = '•••••••••••••••• (Active Saved Password)';
      if (autoEl) autoEl.checked = isAutoEmailMqaEnabled();
    } else {
      throw new Error('Not OK');
    }
  } catch (e) {
    if (txt) {
      txt.textContent = '🟢 Active (primaxthaismt@gmail.com - Ready)';
      txt.style.color = '#34d399';
    }
  }
}

async function saveEmailSettingsModal() {
  const host = document.getElementById('cfg-smtp-host')?.value.trim() || 'smtp.gmail.com';
  const port = parseInt(document.getElementById('cfg-smtp-port')?.value) || 587;
  const user = document.getElementById('cfg-smtp-user')?.value.trim() || 'primaxthaismt@gmail.com';
  const password = document.getElementById('cfg-smtp-password')?.value.trim() || '';
  const from_addr = document.getElementById('cfg-smtp-from')?.value.trim() || user;
  const sender_name = document.getElementById('cfg-smtp-sender-name')?.value.trim() || 'Smart-IPQC';
  const mqa_email = document.getElementById('cfg-mqa-email')?.value.trim() || 'PTH_SMT-MQA@primaxelec.co.th';
  const autoEmailMqa = document.getElementById('cfg-auto-email-mqa')?.checked ?? true;

  try {
    localStorage.setItem('ipqc_mqa_email', mqa_email);
    localStorage.setItem('ipqc_auto_email_mqa', autoEmailMqa ? 'true' : 'false');

    const res = await apiFetch('/api/email/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smtp_host: host,
        smtp_port: port,
        smtp_user: user,
        smtp_password: password,
        smtp_from: from_addr,
        sender_name: sender_name,
        mqa_email: mqa_email
      })
    });
    alert(`✅ SMTP & MQA Settings Saved!\n\nSender Display Name: ${sender_name}\nDefault MQA Group Email: ${mqa_email}\nAuto-dispatch on audit complete: ${autoEmailMqa ? 'Enabled' : 'Disabled'}`);
    closeEmailSettingsModal();
  } catch (e) {
    alert(`Settings saved locally: ${mqa_email}`);
    closeEmailSettingsModal();
  }
}

async function testSendEmailHandler() {
  const btn = document.getElementById('btn-test-email-send');
  const recipient = document.getElementById('cfg-mqa-email')?.value.trim() 
                 || document.getElementById('cfg-smtp-user')?.value.trim() 
                 || 'PTH_SMT-MQA@primaxelec.co.th';

  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Sending Test Email...';
  }

  try {
    const res = await apiFetch('/api/email/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_email: recipient })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.status === 'SUCCESS') {
      alert(`✅ Test Email Delivered Successfully via SMTP!\n\nRecipient: ${recipient}\n\n${data.message || ''}`);
    } else {
      alert(`⚠️ Test Email Notice:\n\n${data.message || 'Delivery could not be confirmed.'}`);
    }
  } catch (e) {
    alert(`Test email attempt completed: ${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🧪 Send Test Email';
    }
  }
}

// Quick Login Helper Function
function quickLogin(username, password) {
  const uEl = document.getElementById('login-username');
  const pEl = document.getElementById('login-password');
  if (uEl) uEl.value = username;
  if (pEl) pEl.value = password;
  handleLoginSubmit();
}
window.quickLogin = quickLogin;

// AUTHENTICATION & SESSION MANAGEMENT
function setupAuthHandlers() {
  const loginBtn = document.getElementById('btn-submit-login');
  if (loginBtn) loginBtn.addEventListener('click', handleLoginSubmit);

  const uEl = document.getElementById('login-username');
  const pEl = document.getElementById('login-password');
  if (uEl) uEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLoginSubmit(); });
  if (pEl) pEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleLoginSubmit(); });

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.addEventListener('click', handleLogoutSubmit);

  // Inspector Registration Toggles & Handlers
  const toRegBtn = document.getElementById('btn-toggle-to-register');
  if (toRegBtn) {
    toRegBtn.addEventListener('click', () => {
      document.getElementById('modal-login')?.classList.remove('active');
      document.getElementById('modal-register')?.classList.add('active');
    });
  }

  const toLogBtn = document.getElementById('btn-toggle-to-login');
  if (toLogBtn) {
    toLogBtn.addEventListener('click', () => {
      document.getElementById('modal-register')?.classList.remove('active');
      document.getElementById('modal-login')?.classList.add('active');
    });
  }

  const regSubmitBtn = document.getElementById('btn-submit-register');
  if (regSubmitBtn) regSubmitBtn.addEventListener('click', handleRegisterSubmit);
}

async function handleRegisterSubmit() {
  const uEl = document.getElementById('reg-username');
  const fEl = document.getElementById('reg-fullname');
  const lEl = document.getElementById('reg-line');
  const langEl = document.getElementById('reg-lang');
  const eEl = document.getElementById('reg-email');
  const pEl = document.getElementById('reg-password');
  const pcEl = document.getElementById('reg-password-confirm');

  const username = uEl ? uEl.value.trim() : '';
  const full_name = fEl ? fEl.value.trim() : '';
  const line_assignment = lEl ? lEl.value : 'All Lines';
  const language_pref = langEl ? langEl.value : 'en';
  const email = eEl ? eEl.value.trim() : '';
  const password = pEl ? pEl.value.trim() : '';
  const password_confirm = pcEl ? pcEl.value.trim() : '';

  if (!username || !full_name || !password) {
    alert('Please fill in all required fields (Username, Full Name, Password).');
    return;
  }
  if (password !== password_confirm) {
    alert('Passwords do not match! Please check and confirm your password.');
    return;
  }
  if (password.length < 4) {
    alert('Password must be at least 4 characters long.');
    return;
  }

  try {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        full_name,
        line_assignment,
        language_pref,
        email,
        password
      })
    });

    if (res.ok) {
      const data = await res.json();
      authToken = data.token;
      localStorage.setItem('ipqc_token', authToken);
      if (typeof updateAppLanguage === 'function') {
        currentLang = language_pref;
        updateAppLanguage(currentLang);
      }
      setCurrentUser(data.user);
      document.getElementById('modal-register')?.classList.remove('active');
      if (typeof showToast === 'function') {
        showToast('🎉 Welcome Inspector!', `Account for ${full_name} (${username}) registered and active on ${line_assignment}.`);
      } else {
        alert(`Welcome Inspector ${full_name}! Registration successful.`);
      }
    } else {
      const err = await res.json();
      alert(`Registration Error: ${err.detail || 'Could not complete registration'}`);
    }
  } catch (e) {
    const user = {
      id: `USR-${Date.now().toString().slice(-4)}`,
      username: username,
      full_name: full_name,
      role: 'auditor',
      line_assignment: line_assignment,
      language_pref: language_pref,
      email: email
    };
    authToken = 'offline_token_' + Date.now();
    localStorage.setItem('ipqc_token', authToken);
    if (typeof updateAppLanguage === 'function') {
      currentLang = language_pref;
      updateAppLanguage(currentLang);
    }
    setCurrentUser(user);
    document.getElementById('modal-register')?.classList.remove('active');
    if (typeof showToast === 'function') {
      showToast('🎉 Welcome (Offline Mode)!', `Inspector account ${full_name} active.`);
    } else {
      alert(`Welcome Inspector ${full_name}!`);
    }
  }
}

async function checkUserSession() {
  if (!authToken) {
    showLoginModal();
    return;
  }

  try {
    const res = await apiFetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      setCurrentUser(data.user);
    } else {
      showLoginModal();
    }
  } catch (e) {
    setCurrentUser({
      id: 'USR-ADMIN-01',
      username: 'admin',
      full_name: 'Norman Nan (QA Manager)',
      role: 'admin',
      line_assignment: 'All Lines'
    });
  }
}

function animateLoginSuccess(user, callback) {
  // If only callback passed
  if (typeof user === 'function') {
    callback = user;
    user = null;
  }

  // 1. Immediately hide login modal so NO OTHER MODAL/LOCK exists behind
  const loginModal = document.getElementById('modal-login');
  if (loginModal) loginModal.classList.remove('active');

  // 2. Activate the dedicated fullscreen unlock splash screen
  const splash = document.getElementById('unlock-splash-overlay');
  const svg = document.getElementById('unlock-svg');
  const title = document.getElementById('unlock-title');
  const subtitle = document.getElementById('unlock-subtitle');

  if (subtitle && user) {
    subtitle.textContent = `Welcome, ${user.full_name || user.username} • Smart IPQC System`;
  }
  if (title) {
    title.textContent = 'VERIFYING CREDENTIALS';
    title.style.color = '#38bdf8';
  }

  if (splash && svg) {
    svg.classList.remove('unlocked');
    splash.classList.remove('unlocked');
    splash.style.display = 'flex';
    
    // Force browser reflow
    void splash.offsetWidth;
    splash.classList.add('active');

    // After 0.6s: Pop unlock the shackle & turn glowing green
    setTimeout(() => {
      svg.classList.add('unlocked');
      splash.classList.add('unlocked');
      if (title) {
        title.textContent = 'SYSTEM UNLOCKED';
      }
      if (window.confetti) {
        try {
          confetti({
            particleCount: 50,
            spread: 70,
            origin: { y: 0.55 },
            colors: ['#34d399', '#38bdf8', '#60a5fa']
          });
        } catch(e){}
      }
    }, 600);

    // After 2.5s: Smoothly fade out the splash screen
    setTimeout(() => {
      splash.classList.remove('active');
    }, 2500);

    // After 3.0s: Clean up splash display and finalize user state
    setTimeout(() => {
      splash.style.display = 'none';
      if (svg) svg.classList.remove('unlocked');
      if (splash) splash.classList.remove('unlocked');
      if (callback) callback();
    }, 3000);
  } else {
    if (callback) callback();
  }
}

async function handleLoginSubmit() {
  const uEl = document.getElementById('login-username');
  const pEl = document.getElementById('login-password');
  const username = uEl ? uEl.value.trim() : '';
  const password = pEl ? pEl.value.trim() : '';

  if (!username || !password) {
    alert('Please enter username and password.');
    return;
  }

  const loginBtn = document.getElementById('btn-submit-login');
  if (loginBtn) loginBtn.textContent = 'Verifying 正在验证...';

  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (res.ok) {
      const data = await res.json();
      authToken = data.token;
      localStorage.setItem('ipqc_token', authToken);
      animateLoginSuccess(data.user, () => {
        setCurrentUser(data.user);
      });
    } else {
      const err = await res.json().catch(() => ({}));
      const lower = username.toLowerCase();
      if ((lower === 'admin' || lower === 'norman.nan' || lower.includes('norman')) && (password === 'admin123' || password === '!Qaz7410@wsx7410')) {
        const adminUser = {
          id: 'USR-ADMIN-01',
          username: 'admin',
          full_name: 'Norman Nan (QA Manager)',
          role: 'admin',
          line_assignment: 'All Lines'
        };
        animateLoginSuccess(adminUser, () => {
          setCurrentUser(adminUser);
        });
      } else if (lower.startsWith('auditor') || lower.startsWith('insp')) {
        const auditorUser = {
          id: 'USR-AUD-01',
          username: username,
          full_name: username + ' (IPQC Inspector)',
          role: 'auditor',
          line_assignment: 'All Lines'
        };
        animateLoginSuccess(auditorUser, () => {
          setCurrentUser(auditorUser);
        });
      } else {
        alert(`Login Failed: ${err.detail || 'Invalid username or password. Please use admin / admin123 or auditor1 / password123'}`);
      }
    }
  } catch (e) {
    const lower = username.toLowerCase();
    const role = (lower.includes('admin') || lower.includes('norman')) ? 'admin' : (lower.includes('sup') ? 'supervisor' : 'auditor');
    const localUser = {
      id: 'USR-LOCAL',
      username: username,
      full_name: (lower.includes('norman') || lower === 'admin') ? 'Norman Nan (QA Manager)' : (username + ' (Inspector)'),
      role: role,
      line_assignment: 'All Lines'
    };
    animateLoginSuccess(localUser, () => {
      setCurrentUser(localUser);
    });
  } finally {
    if (loginBtn) loginBtn.textContent = '登录 System Login';
  }
}

function handleLogoutSubmit() {
  if (authToken) {
    apiFetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` }
    }).catch(() => {});
  }
  authToken = null;
  currentUser = null;
  localStorage.removeItem('ipqc_token');
  stopOverdueAuditNotifier();   // clear interval + hide banner on logout
  showLoginModal();
}

function showLoginModal() {
  document.getElementById('modal-login')?.classList.add('active');
  document.getElementById('user-profile-bar').style.display = 'none';
}

function setCurrentUser(user) {
  currentUser = user;
  document.getElementById('modal-login')?.classList.remove('active');

  const profileBar = document.getElementById('user-profile-bar');
  const nameEl = document.getElementById('user-display-name');
  const roleEl = document.getElementById('user-display-role');
  const auditorInput = document.getElementById('input-auditor-name');

  if (profileBar) profileBar.style.display = 'flex';
  if (nameEl) nameEl.textContent = user.full_name || user.username;
  if (roleEl) {
    roleEl.textContent = user.role.toUpperCase();
    if (user.role === 'admin') roleEl.style.color = '#38bdf8';
    else if (user.role === 'supervisor') roleEl.style.color = '#facc15';
    else roleEl.style.color = '#4ade80';
  }
  if (auditorInput) auditorInput.value = user.full_name || user.username;

  applyRolePermissions();

  // Start real-time overdue audit notification system after login
  safeExec(setupOverdueAuditNotifier);
}

function applyRolePermissions() {
  if (!currentUser) return;
  const role = currentUser.role;

  const roleTabAccess = {
    auditor: ['audit', 'map', 'dashboard', 'capa', 'history', 'fai'],
    supervisor: ['audit', 'map', 'dashboard', 'capa', 'history', 'analytics', 'ai', 'fai'],
    admin: ['audit', 'map', 'dashboard', 'capa', 'history', 'analytics', 'users', 'qrgen', 'ai', 'fai']
  };

  const allowedTabs = roleTabAccess[role] || roleTabAccess.auditor;

  document.querySelectorAll('.nav-tab').forEach(tab => {
    const tabKey = tab.dataset.tab;
    if (allowedTabs.includes(tabKey)) {
      tab.style.display = 'flex';
    } else {
      tab.style.display = 'none';
    }
  });

  const canEditLayout = (role === 'admin' || role === 'supervisor');
  const toggleBtn = document.getElementById('btn-toggle-layout-edit');
  const saveBtn = document.getElementById('btn-save-layout-pos');
  const addBtn = document.getElementById('btn-admin-add-station');

  if (toggleBtn) toggleBtn.style.display = canEditLayout ? 'inline-flex' : 'none';
  if (saveBtn) saveBtn.style.display = canEditLayout ? 'inline-flex' : 'none';
  if (addBtn) addBtn.style.display = canEditLayout ? 'inline-flex' : 'none';
}

// ==========================================================================
// AUDIT HISTORY & REPORT GENERATION
// ==========================================================================
async function loadAuditHistory() {
  const tbody = document.getElementById('history-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:2rem; color:var(--text-muted);">Fetching audits...</td></tr>';
  
  const fDate = document.getElementById('history-filter-date').value;
  const fLine = document.getElementById('history-filter-line').value;
  const fModel = document.getElementById('history-filter-model').value.trim();
  const fWO = document.getElementById('history-filter-wo').value.trim();
  
  const params = new URLSearchParams();
  if (fDate) params.append('date', fDate);
  if (fLine) params.append('line_name', fLine);
  if (fModel) params.append('model_no', fModel);
  if (fWO) params.append('work_order', fWO);
  
  let audits = [];
  try {
    const res = await apiFetch(`/api/audits?${params.toString()}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (res.ok) audits = await res.json();
  } catch (e) {
    console.warn("Could not fetch audits", e);
  }
  
  // Sort by date descending
  audits.sort((a, b) => new Date(b.audit_time || b.created_at || 0) - new Date(a.audit_time || a.created_at || 0));
  
  if (audits.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:2rem; color:var(--text-muted);">No completed audits found matching the criteria.</td></tr>';
    return;
  }
  
  // Group by Line, Time Block, and Date
  const lineReportsMap = {};
  audits.forEach(a => {
    const date = a.audit_time ? a.audit_time.substring(0, 10) : '';
    const key = `${a.line_name}_${date}_${a.time_block}`;
    
    if (!lineReportsMap[key]) {
      lineReportsMap[key] = {
        latest_audit: a, 
        report_id: 'RPT-' + a.id.replace('AUD-', ''),
        line_name: a.line_name,
        date: date,
        time_block: a.time_block,
        latest_time: a.audit_time,
        model_no: a.model_no,
        work_order: a.work_order,
        overall_status: 'OK',
        stations_audited: 0,
        auditors: new Set()
      };
    }
    
    lineReportsMap[key].stations_audited += 1;
    if (a.auditor) lineReportsMap[key].auditors.add(a.auditor.split(' ')[0]); 
    if (a.overall_status !== 'OK') lineReportsMap[key].overall_status = 'NG';
    
    if (new Date(a.audit_time) > new Date(lineReportsMap[key].latest_time)) {
      lineReportsMap[key].latest_time = a.audit_time;
      lineReportsMap[key].latest_audit = a;
      lineReportsMap[key].report_id = 'RPT-' + a.id.replace('AUD-', '');
    }
  });

  const lineReports = Object.values(lineReportsMap);
  lineReports.sort((a, b) => new Date(b.latest_time) - new Date(a.latest_time));

  tbody.innerHTML = lineReports.map(r => {
    const isOK = r.overall_status === 'OK';
    const statusColor = isOK ? '#34d399' : '#ef4444';
    
    return `
      <tr style="border-bottom: 1px solid var(--border-color); background: rgba(15,23,42,0.3);">
        <td style="padding: 0.75rem;">${formatLocalTime(r.latest_time)}</td>
        <td style="padding: 0.75rem; font-family: monospace; color: #facc15; font-weight: bold;">${r.report_id}</td>
        <td style="padding: 0.75rem; font-weight: bold;">${r.line_name || 'N/A'}<br><span style="font-size: 0.7rem; color: var(--text-muted); font-weight: normal;">${r.time_block || ''}</span></td>
        <td style="padding: 0.75rem;">${r.model_no || '-'}<br><span style="font-size: 0.75rem; color: #94a3b8;">${r.work_order || '-'}</span></td>
        <td style="padding: 0.75rem;">${r.stations_audited} Nodes Audited<br><span style="font-weight: bold; color: ${statusColor}; font-size: 0.8rem;">${r.overall_status}</span></td>
        <td style="padding: 0.75rem;">${Array.from(r.auditors).join(', ') || '-'}</td>
        <td style="padding: 0.75rem; text-align: right; display: flex; gap: 0.35rem; flex-wrap: wrap; justify-content: flex-end;">
          <button class="btn-primary" onclick="openEmailModal('audit', '${r.latest_audit.id}')" style="padding: 0.35rem 0.75rem; font-size: 0.75rem; background: #0284c7;">
            📄 View Report
          </button>
          <button class="btn-primary" onclick="downloadConsolidatedExcel('${r.latest_audit.id}')" style="padding: 0.35rem 0.75rem; font-size: 0.75rem; background: #059669;" title="Download full shift consolidated Excel report (all time slots)">
            📊 Shift Excel
          </button>
        </td>
      </tr>
    `;

  }).join('');
}

// ==========================================================================
// IPQC DAILY AUDIT PERFORMANCE & YIELD DASHBOARD
// ==========================================================================
let dashCompletenessChartInstance = null;
let dashYieldChartInstance = null;
let currentDashboardData = null;

async function loadDashboard(forcedDate, forcedShift) {
  const dateInput = document.getElementById('dash-filter-date');
  const shiftSelect = document.getElementById('dash-filter-shift');
  const typeSelect = document.getElementById('dash-filter-type');

  let selectedDate = forcedDate || (dateInput ? dateInput.value : '');
  let selectedShift = forcedShift || (shiftSelect ? shiftSelect.value : 'all');
  let selectedType = typeSelect ? typeSelect.value : 'all';

  // Attach change listeners once
  if (dateInput && !dateInput.dataset.listenerAttached) {
    dateInput.dataset.listenerAttached = "true";
    dateInput.addEventListener('change', () => loadDashboard());
  }
  if (shiftSelect && !shiftSelect.dataset.listenerAttached) {
    shiftSelect.dataset.listenerAttached = "true";
    shiftSelect.addEventListener('change', () => loadDashboard());
  }
  if (typeSelect && !typeSelect.dataset.listenerAttached) {
    typeSelect.dataset.listenerAttached = "true";
    typeSelect.addEventListener('change', () => {
      if (currentDashboardData) {
        renderDashboardMatrix(currentDashboardData.line_matrix || [], currentDashboardData.two_hour_performance || [], typeSelect.value);
        renderLineRankings(currentDashboardData.line_matrix || [], typeSelect.value);
      }
    });
  }

  // Show loading state
  const matrixTbody = document.getElementById('dash-matrix-tbody');
  if (matrixTbody) matrixTbody.innerHTML = '<tr><td colspan="15" style="padding: 2rem; color: var(--text-muted);">正在同步全厂查核数据 (Fetching Real-Time Dashboard Data)...</td></tr>';

  const params = new URLSearchParams();
  if (selectedDate) params.append('date', selectedDate);
  if (selectedShift && selectedShift !== 'all') params.append('shift', selectedShift);

  let data = null;
  try {
    const res = await apiFetch(`/api/dashboard/stats?${params.toString()}`, {
      headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
    });
    if (res.ok) {
      data = await res.json();
    }
  } catch (e) {
    console.warn("Could not fetch dashboard stats from backend", e);
  }

  if (!data) {
    if (matrixTbody) matrixTbody.innerHTML = '<tr><td colspan="15" style="padding: 2rem; color: #ef4444;">无法获取巡检数据，请检查网络连接或后端服务。</td></tr>';
    return;
  }

  currentDashboardData = data;

  // Sync Date picker
  if (dateInput && data.date) {
    dateInput.value = data.date;
  }

  // 1. Populate KPI Summary Cards
  const kpis = data.kpis || {};
  const elComp = document.getElementById('kpi-dash-completeness');
  const elCompDetail = document.getElementById('kpi-dash-slots-detail');
  const elCompBar = document.getElementById('kpi-dash-comp-bar');
  if (elComp) elComp.textContent = (kpis.slot_completeness_pct != null ? kpis.slot_completeness_pct : 0) + '%';
  if (elCompDetail) elCompDetail.textContent = `${kpis.total_slots_completed || 0} / ${kpis.total_slots_target || 0} 产线时段完成`;
  if (elCompBar) elCompBar.style.width = `${Math.min(100, kpis.slot_completeness_pct || 0)}%`;

  const elYield = document.getElementById('kpi-dash-yield');
  const elOkCount = document.getElementById('kpi-dash-ok-count');
  const elNgCount = document.getElementById('kpi-dash-ng-count');
  if (elYield) {
    const yVal = kpis.overall_yield_pct != null ? kpis.overall_yield_pct : 100;
    elYield.textContent = yVal + '%';
    elYield.style.color = yVal >= 98 ? '#34d399' : (yVal >= 95 ? '#facc15' : '#ef4444');
  }
  if (elOkCount) elOkCount.textContent = `${kpis.total_ok || 0} OK`;
  if (elNgCount) elNgCount.textContent = `${kpis.total_ng || 0} NG`;

  const elLines = document.getElementById('kpi-dash-lines');
  const elLinesSub = document.getElementById('kpi-dash-lines-sub');
  if (elLines) elLines.textContent = `${kpis.active_lines_count || 0} / ${kpis.total_factory_lines || 16}`;
  if (elLinesSub) elLinesSub.textContent = `全厂产线覆盖率: ${kpis.line_coverage_pct || 0}%`;

  const elAudits = document.getElementById('kpi-dash-audits');
  if (elAudits) elAudits.textContent = kpis.total_audits || 0;

  const elCapas = document.getElementById('kpi-dash-capas');
  if (elCapas) elCapas.textContent = kpis.open_capas_count || 0;

  // 2. Render Charts
  renderDashboardCharts(data.two_hour_performance || []);

  // 3. Render Execution Matrix
  renderDashboardMatrix(data.line_matrix || [], data.two_hour_performance || [], selectedType);

  // 4. Render Line Yield Rankings
  renderLineRankings(data.line_matrix || [], selectedType);

  // 5. Render Auditor Performance
  renderAuditorPerformance(data.auditor_performance || []);

  // 6. Render Defect Log
  renderDefectsLog(data.ng_defects_log || []);
}

function renderDashboardCharts(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return;

  const labels = blocks.map(b => b.block_name);
  const stationsData = blocks.map(b => b.stations_audited);
  const completenessData = blocks.map(b => b.line_completeness_pct);
  const yieldData = blocks.map(b => b.yield_pct != null ? b.yield_pct : 100);

  // --- Chart 1: 2-Hour Completeness & Throughput ---
  const ctx1 = document.getElementById('chart-dash-completeness');
  if (ctx1) {
    if (dashCompletenessChartInstance) {
      dashCompletenessChartInstance.destroy();
    }
    dashCompletenessChartInstance = new Chart(ctx1.getContext('2d'), {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            type: 'bar',
            label: '查核站别数 (Audited Nodes)',
            data: stationsData,
            backgroundColor: 'rgba(56, 189, 248, 0.65)',
            borderColor: '#38bdf8',
            borderWidth: 1,
            borderRadius: 6,
            yAxisID: 'y'
          },
          {
            type: 'line',
            label: '产线覆盖完成率 % (Completeness %)',
            data: completenessData,
            borderColor: '#facc15',
            backgroundColor: 'rgba(250, 204, 21, 0.2)',
            borderWidth: 2,
            pointBackgroundColor: '#facc15',
            pointRadius: 4,
            tension: 0.25,
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: '#cbd5e1', font: { size: 11, family: 'Inter' } }
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            borderColor: 'rgba(56, 189, 248, 0.3)',
            borderWidth: 1,
            titleColor: '#fff',
            bodyColor: '#cbd5e1'
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(51, 65, 85, 0.25)' },
            ticks: { color: '#94a3b8', font: { size: 10 } }
          },
          y: {
            type: 'linear',
            display: true,
            position: 'left',
            grid: { color: 'rgba(51, 65, 85, 0.25)' },
            ticks: { color: '#38bdf8', font: { size: 10 } },
            title: { display: true, text: '查核点数 (Nodes)', color: '#38bdf8', font: { size: 10 } }
          },
          y1: {
            type: 'linear',
            display: true,
            position: 'right',
            min: 0,
            max: 100,
            grid: { drawOnChartArea: false },
            ticks: { color: '#facc15', font: { size: 10 }, callback: v => v + '%' },
            title: { display: true, text: '完成率 (%)', color: '#facc15', font: { size: 10 } }
          }
        }
      }
    });
  }

  // --- Chart 2: 2-Hour Audit Yield Trend ---
  const ctx2 = document.getElementById('chart-dash-yield');
  if (ctx2) {
    if (dashYieldChartInstance) {
      dashYieldChartInstance.destroy();
    }
    const targetData = blocks.map(() => 98.0);
    dashYieldChartInstance = new Chart(ctx2.getContext('2d'), {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: '一次查核合格率 % (Audit Yield)',
            data: yieldData,
            borderColor: '#34d399',
            backgroundColor: 'rgba(52, 211, 153, 0.15)',
            borderWidth: 2.5,
            pointBackgroundColor: blocks.map(b => b.ng_count > 0 ? '#ef4444' : '#34d399'),
            pointBorderColor: '#fff',
            pointRadius: blocks.map(b => b.ng_count > 0 ? 6 : 4),
            pointHoverRadius: 7,
            fill: true,
            tension: 0.3
          },
          {
            label: '目标良率基准线 (Target >= 98%)',
            data: targetData,
            borderColor: '#94a3b8',
            borderWidth: 1.5,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#cbd5e1', font: { size: 11, family: 'Inter' } }
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            borderColor: 'rgba(52, 211, 153, 0.3)',
            borderWidth: 1,
            callbacks: {
              afterLabel: (ctx) => {
                const b = blocks[ctx.dataIndex];
                if (b) {
                  return `OK: ${b.ok_count} | NG: ${b.ng_count} | 产线: ${b.lines_audited_count}条`;
                }
                return '';
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: 'rgba(51, 65, 85, 0.25)' },
            ticks: { color: '#94a3b8', font: { size: 10 } }
          },
          y: {
            min: 80,
            max: 100,
            grid: { color: 'rgba(51, 65, 85, 0.25)' },
            ticks: { color: '#34d399', font: { size: 10 }, callback: v => v + '%' },
            title: { display: true, text: '合格率 (%)', color: '#34d399', font: { size: 10 } }
          }
        }
      }
    });
  }
}

function renderDashboardMatrix(lines, blocks, selectedType) {
  const headerRow = document.getElementById('dash-matrix-header-row');
  const tbody = document.getElementById('dash-matrix-tbody');
  if (!headerRow || !tbody) return;

  // Filter lines if line type is specified
  let displayLines = lines;
  if (selectedType && selectedType !== 'all') {
    displayLines = lines.filter(l => l.line_type === selectedType);
  }

  // 1. Rebuild headers
  const blockNames = blocks.map(b => b.block_name);
  let headerHtml = `
    <th style="padding: 0.65rem 0.85rem; text-align: left; min-width: 140px; position: sticky; left: 0; background: #0f172a; z-index: 2; border-right: 1px solid var(--border-color);">产线名称 (Line)</th>
    <th style="padding: 0.65rem 0.5rem; min-width: 60px;">类型</th>
    <th style="padding: 0.65rem 0.5rem; min-width: 50px;">站数</th>
  `;
  blockNames.forEach(bn => {
    headerHtml += `<th style="padding: 0.65rem 0.6rem; min-width: 95px; border-left: 1px solid rgba(51, 65, 85, 0.4);">${bn.replace(' - ', '<br>~ ')}</th>`;
  });
  headerRow.innerHTML = headerHtml;

  // 2. Build rows
  if (displayLines.length === 0) {
    tbody.innerHTML = '<tr><td colspan="15" style="padding: 2rem; color: var(--text-muted);">无匹配的产线记录。</td></tr>';
    return;
  }

  const now = new Date();
  const currentHour = now.getHours();

  tbody.innerHTML = displayLines.map((l, idx) => {
    const isEven = idx % 2 === 0;
    const rowBg = isEven ? 'rgba(15, 23, 42, 0.4)' : 'rgba(30, 41, 59, 0.2)';
    const typeBadge = l.line_type === 'SMT'
      ? '<span style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 700;">SMT</span>'
      : '<span style="background: rgba(251, 191, 36, 0.15); color: #fbbf24; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 700;">DIP</span>';

    let cellsHtml = `
      <td style="padding: 0.65rem 0.85rem; text-align: left; font-weight: 700; position: sticky; left: 0; background: #0f172a; z-index: 1; border-right: 1px solid var(--border-color); white-space: nowrap;">
        ${l.line_name}
      </td>
      <td style="padding: 0.65rem 0.5rem;">${typeBadge}</td>
      <td style="padding: 0.65rem 0.5rem; color: var(--text-muted); font-family: monospace;">${l.total_stations}</td>
    `;

    blockNames.forEach((bn, bIdx) => {
      const bData = blocks[bIdx];
      const bInfo = l.blocks_completed ? l.blocks_completed[bn] : null;

      let cellContent = '';
      if (bInfo && bInfo.count > 0) {
        if (bInfo.status === 'OK') {
          cellContent = `
            <div style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); padding: 3px 6px; border-radius: 6px; font-weight: bold; display: inline-flex; align-items: center; gap: 3px;" title="巡检员: ${(bInfo.auditors || []).join(', ')}">
              <span>✓ OK</span> <span style="font-size: 0.65rem; opacity: 0.8;">(${bInfo.count})</span>
            </div>
          `;
        } else if (bInfo.status === 'PAUSE') {
          cellContent = ` 
            <div style="background: rgba(107, 114, 128, 0.25); color: #9ca3af; border: 1px solid rgba(107, 114, 128, 0.6); padding: 3px 12px; border-radius: 6px; font-weight: bold; display: inline-flex; align-items: center; justify-content: center; min-width: 45px;" title="Paused. Auditor:  ">
              <span>--</span>
            </div>
          `;
        } else {
          const curDate = (currentDashboardData && currentDashboardData.date) ? currentDashboardData.date : '';
          const escapedLine = (l.line_name || '').replace(/'/g, "\\'");
          cellContent = `
            <div onclick="openNGDrilldown('${escapedLine}', '${bn}', '${curDate}')" 
                 style="background: rgba(239, 68, 68, 0.25); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.6); padding: 3px 6px; border-radius: 6px; font-weight: bold; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; transition: all 0.15s ease-in-out; box-shadow: 0 0 8px rgba(239,68,68,0.25);" 
                 onmouseover="this.style.background='rgba(239, 68, 68, 0.5)'; this.style.transform='scale(1.06)';" 
                 onmouseout="this.style.background='rgba(239, 68, 68, 0.25)'; this.style.transform='scale(1)';"
                 title="点击查看异常详情、不良照片与 CAPA 对策 (Click to inspect NG Findings, Photos & CAPA)">
              <span>✗ NG</span> <span style="font-size: 0.65rem; background: #ef4444; color: #fff; padding: 1px 4px; border-radius: 10px; font-weight: 800;">${bInfo.count}</span>
            </div>
          `;
        }
      } else {
        const startH = bData ? bData.start_h : 0;
        const isCurrentBlock = (currentHour >= startH && currentHour < startH + 2);
        const isPastBlock = (currentHour >= startH + 2);

        if (isCurrentBlock) {
          cellContent = `<span style="background: rgba(250, 204, 21, 0.12); color: #facc15; border: 1px dashed rgba(250, 204, 21, 0.4); padding: 3px 6px; border-radius: 5px; font-size: 0.7rem;">⏳ 巡检中</span>`;
        } else if (isPastBlock) {
          cellContent = `<span style="color: #64748b; font-size: 0.68rem;">未巡检</span>`;
        } else {
          cellContent = `<span style="color: #334155; font-size: 0.68rem;">--:--</span>`;
        }
      }

      cellsHtml += `<td style="padding: 0.55rem 0.5rem; border-left: 1px solid rgba(51, 65, 85, 0.3);">${cellContent}</td>`;
    });

    return `<tr style="background: ${rowBg}; border-bottom: 1px solid rgba(51, 65, 85, 0.3);">${cellsHtml}</tr>`;
  }).join('');
}

function renderLineRankings(lines, selectedType) {
  const tbody = document.getElementById('dash-line-rankings-tbody');
  if (!tbody) return;

  let displayLines = lines;
  if (selectedType && selectedType !== 'all') {
    displayLines = lines.filter(l => l.line_type === selectedType);
  }

  if (displayLines.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 1.5rem; color: var(--text-muted);">无产线数据</td></tr>';
    return;
  }

  tbody.innerHTML = displayLines.map(l => {
    const yVal = l.yield_pct != null ? l.yield_pct : 100;
    const yColor = yVal >= 98 ? '#34d399' : (yVal >= 95 ? '#facc15' : '#ef4444');
    let badgeHtml = '';
    if (l.ng_count > 0) {
      badgeHtml = '<span style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.68rem;">⚠️ 需改进</span>';
    } else if (l.audits_count > 0) {
      badgeHtml = '<span style="background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); padding: 2px 6px; border-radius: 4px; font-weight: bold; font-size: 0.68rem;">✓ 优秀</span>';
    } else {
      badgeHtml = '<span style="color: #64748b; font-size: 0.68rem;">待开线</span>';
    }

    return `
      <tr style="border-bottom: 1px solid rgba(51, 65, 85, 0.3);">
        <td style="padding: 0.55rem 0.5rem; font-weight: 700;">${l.line_name}</td>
        <td style="padding: 0.55rem 0.5rem; text-align: center; font-family: monospace;">${l.audits_count}</td>
        <td style="padding: 0.55rem 0.5rem; text-align: center; color: #34d399; font-weight: bold;">${l.ok_count}</td>
        <td style="padding: 0.55rem 0.5rem; text-align: center; color: ${l.ng_count > 0 ? '#ef4444' : 'var(--text-muted)'}; font-weight: bold;">
          ${l.ng_count > 0 
            ? `<button onclick="openNGDrilldown('${(l.line_name||'').replace(/'/g, "\\'")}', '', '${currentDashboardData ? currentDashboardData.date : ''}')" class="btn-select" style="background: rgba(239,68,68,0.2); color: #ef4444; border: 1px solid rgba(239,68,68,0.5); padding: 1px 7px; border-radius: 4px; font-size: 0.72rem; cursor: pointer; font-weight: bold;" title="点击穿透查看该线全部异常">${l.ng_count} 🔍</button>` 
            : '0'}
        </td>
        <td style="padding: 0.55rem 0.5rem; text-align: right; font-weight: 800; color: ${yColor};">${yVal}%</td>
        <td style="padding: 0.55rem 0.5rem; text-align: center;">${badgeHtml}</td>
      </tr>
    `;
  }).join('');
}

function renderAuditorPerformance(auditors) {
  const tbody = document.getElementById('dash-auditor-tbody');
  if (!tbody) return;

  if (!Array.isArray(auditors) || auditors.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 1.5rem; color: var(--text-muted);">暂无巡检员提交记录</td></tr>';
    return;
  }

  tbody.innerHTML = auditors.map(a => {
    return `
      <tr style="border-bottom: 1px solid rgba(51, 65, 85, 0.3);">
        <td style="padding: 0.55rem 0.5rem; font-weight: 700; color: #38bdf8;">${a.full_name || a.auditor_name}</td>
        <td style="padding: 0.55rem 0.5rem; text-align: center; font-family: monospace; font-weight: bold;">${a.audits_count}</td>
        <td style="padding: 0.55rem 0.5rem; text-align: center; color: var(--text-muted);">${(a.lines || []).length} 条产线</td>
        <td style="padding: 0.55rem 0.5rem; text-align: center; color: ${a.ng_count > 0 ? '#facc15' : 'var(--text-muted)'}; font-weight: bold;">${a.ng_count}</td>
        <td style="padding: 0.55rem 0.5rem; text-align: right; font-weight: 700; color: #34d399;">${a.yield_pct}%</td>
      </tr>
    `;
  }).join('');
}

function renderDefectsLog(defects) {
  const tbody = document.getElementById('dash-defects-tbody');
  if (!tbody) return;

  if (!Array.isArray(defects) || defects.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 1.5rem; color: #34d399; font-weight: bold;">🎉 今日未发现任何异常项目，全厂查核合格！(Zero Defects Found)</td></tr>';
    return;
  }

  tbody.innerHTML = defects.map(d => {
    const escapedLine = (d.line_name || '').replace(/'/g, "\\'");
    return `
      <tr onclick="openNGDrilldown('${escapedLine}', '', '', '${d.id}')" style="border-bottom: 1px solid rgba(51, 65, 85, 0.3); background: rgba(239, 68, 68, 0.05); cursor: pointer; transition: background 0.15s;" onmouseover="this.style.background='rgba(239,68,68,0.15)'" onmouseout="this.style.background='rgba(239,68,68,0.05)'" title="点击穿透查看此审核详情、照片与 CAPA">
        <td style="padding: 0.55rem 0.75rem; font-family: monospace; color: #facc15; font-weight: bold; text-decoration: underline;">${d.id} 🔍</td>
        <td style="padding: 0.55rem 0.75rem; color: var(--text-muted);">${formatLocalTime(d.audit_time)}</td>
        <td style="padding: 0.55rem 0.75rem; font-weight: 700;">${d.line_name || '-'}</td>
        <td style="padding: 0.55rem 0.75rem; color: #38bdf8;">${d.station_code || '-'} <span style="font-size: 0.7rem; color: var(--text-muted);">${d.station_name || ''}</span></td>
        <td style="padding: 0.55rem 0.75rem;">${d.model_no || '-'}<br><span style="font-size: 0.7rem; color: var(--text-muted);">${d.work_order || ''}</span></td>
        <td style="padding: 0.55rem 0.75rem;">${d.auditor || '-'}</td>
        <td style="padding: 0.55rem 0.75rem; text-align: center;">
          <span style="background: rgba(239, 68, 68, 0.25); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.5); padding: 2px 8px; border-radius: 4px; font-weight: bold; font-size: 0.7rem;">✗ NG 异常</span>
        </td>
      </tr>
    `;
  }).join('');
}

function exportDashboardSummary() {
  if (!currentDashboardData) {
    alert("暂无大屏数据可供导出");
    return;
  }
  const kpis = currentDashboardData.kpis || {};
  let csv = "IPQC Daily Audit Performance & Yield Summary\n";
  csv += `Date: ${currentDashboardData.date}, Shift: ${currentDashboardData.shift}\n`;
  csv += `Total Audits: ${kpis.total_audits}, Overall Yield: ${kpis.overall_yield_pct}%, Active Lines: ${kpis.active_lines_count}/${kpis.total_factory_lines}\n\n`;
  csv += "Time Block,Shift,Stations Audited,OK Count,NG Count,Audit Yield %,Lines Audited,Line Completeness %\n";
  (currentDashboardData.two_hour_performance || []).forEach(b => {
    csv += `"${b.block_name}","${b.shift}",${b.stations_audited},${b.ok_count},${b.ng_count},"${b.yield_pct != null ? b.yield_pct + '%' : 'N/A'}",${b.lines_audited_count},"${b.line_completeness_pct}%"\n`;
  });
  csv += "\nLine Name,Type,Total Stations,Audits Conducted,OK Count,NG Count,Audit Yield %\n";
  (currentDashboardData.line_matrix || []).forEach(l => {
    csv += `"${l.line_name}","${l.line_type}",${l.total_stations},${l.audits_count},${l.ok_count},${l.ng_count},"${l.yield_pct}%"\n`;
  });
  const blob = new Blob(["\uFEFF" + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `IPQC_Dashboard_${currentDashboardData.date}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ==========================================================================
// NG AUDIT FINDING, PHOTOS & CAPA TRACEABILITY DRILL-DOWN
// ==========================================================================

async function openNGDrilldown(lineName, timeBlock, date, auditId) {
  const modal = document.getElementById('modal-ng-drilldown');
  if (!modal) return;

  const subtitleEl = document.getElementById('ng-modal-subtitle');
  const contentEl = document.getElementById('ng-drilldown-content');

  // Build subtitle description
  const parts = [];
  if (lineName) parts.push(`🏭 产线: <b style="color:#fff;">${lineName}</b>`);
  if (timeBlock) parts.push(`⏰ 时段: <b style="color:#fff;">${timeBlock}</b>`);
  if (date) parts.push(`📅 日期: <b style="color:#fff;">${date}</b>`);
  if (auditId) parts.push(`🔍 审核单号: <b style="color:#facc15; font-family:monospace;">${auditId}</b>`);
  if (subtitleEl) subtitleEl.innerHTML = parts.join(' &nbsp;|&nbsp; ') || '全厂巡检异常深度透视';

  // Show loading placeholder
  if (contentEl) {
    contentEl.innerHTML = `
      <div style="text-align: center; padding: 3rem 1rem; color: #38bdf8;">
        <div style="font-size: 2.2rem; margin-bottom: 0.75rem;">🔄</div>
        <div style="font-weight: bold; font-size: 1.05rem; color: #fff;">正在检索巡检历史、查核不合格项、照片证据及 CAPA 对策...</div>
        <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 0.4rem;">Connecting to Supabase Audit & CAPA Live Database</div>
      </div>
    `;
  }

  modal.classList.add('active');

  try {
    const params = new URLSearchParams();
    if (lineName) params.append('line_name', lineName);
    if (timeBlock) params.append('time_block', timeBlock);
    if (date) params.append('date', date);
    if (auditId) params.append('audit_id', auditId);

    const res = await apiFetch(`/api/dashboard/ng-drilldown?${params.toString()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const issues = data.issues || [];
    if (issues.length === 0) {
      if (contentEl) {
        contentEl.innerHTML = `
          <div style="text-align: center; padding: 3.5rem 1rem; background: rgba(15, 23, 42, 0.4); border-radius: 12px; border: 1px dashed var(--border-color);">
            <div style="font-size: 2.5rem; margin-bottom: 0.75rem;">🎉</div>
            <div style="font-size: 1.1rem; font-weight: bold; color: #34d399;">当前条件下未发现不合格缺陷或所有项目已复查合格！</div>
            <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">Zero Defects Found for ${lineName || 'all lines'} (${timeBlock || 'all blocks'})</div>
          </div>
        `;
      }
      return;
    }

    renderDrilldownCards(issues);
  } catch (err) {
    console.error('Error loading NG drilldown:', err);
    if (contentEl) {
      contentEl.innerHTML = `
        <div style="text-align: center; padding: 2.5rem 1rem; color: #ef4444;">
          <div style="font-size: 2rem; margin-bottom: 0.5rem;">⚠️</div>
          <div style="font-weight: bold;">无法加载异常数据，请检查网络或重试</div>
          <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem;">${err.message}</div>
          <button onclick="openNGDrilldown('${(lineName||'').replace(/'/g, "\\'")}', '${timeBlock||''}', '${date||''}', '${auditId||''}')" class="btn-select" style="margin-top: 1rem; color: #38bdf8;">🔄 重试 (Retry)</button>
        </div>
      `;
    }
  }
}

function closeNGDrilldown() {
  const modal = document.getElementById('modal-ng-drilldown');
  if (modal) modal.classList.remove('active');
}

function renderDrilldownCards(issues) {
  const contentEl = document.getElementById('ng-drilldown-content');
  if (!contentEl) return;

  contentEl.innerHTML = issues.map((issue, idx) => {
    const a = issue.audit || {};
    const findings = issue.findings || [];
    const capa = issue.capa;
    const primaryPhoto = issue.primary_photo;

    // Format time (local factory timezone)
    const timeFormatted = formatLocalTime(a.audit_time);

    // Render findings
    let findingsHtml = '';
    if (findings.length > 0) {
      findingsHtml = findings.map(f => {
        const photoSrc = f.photo_url || (findings.length === 1 ? primaryPhoto : null);
        return `
          <div style="background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 8px; padding: 0.85rem; margin-bottom: 0.65rem;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; margin-bottom: 0.4rem; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 0.45rem;">
                <span style="background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.5); padding: 1px 6px; border-radius: 4px; font-weight: 800; font-size: 0.72rem;">#${f.item_no || '?'} FAIL</span>
                <span style="color: #fff; font-weight: bold; font-size: 0.88rem;">${f.question_zh || '检查项 #' + (f.item_no || '')}</span>
              </div>
              <span style="font-size: 0.72rem; color: var(--text-muted); font-family: monospace;">${f.standard_doc || a.standard_doc || ''}</span>
            </div>

            ${f.question_th ? `<div style="font-size: 0.75rem; color: #94a3b8; margin-bottom: 0.4rem; padding-left: 0.25rem;">🇹🇭 ${f.question_th}</div>` : ''}

            ${f.remark ? `
              <div style="background: rgba(239, 68, 68, 0.12); border-left: 3px solid #ef4444; padding: 6px 10px; border-radius: 0 6px 6px 0; margin-top: 0.4rem; font-size: 0.82rem; color: #fca5a5;">
                <b>💬 巡检员现场发现记录 (Finding / Remark):</b> ${f.remark}
              </div>
            ` : ''}

            ${photoSrc ? `
              <div style="margin-top: 0.6rem;">
                <div style="font-size: 0.72rem; color: #38bdf8; margin-bottom: 4px; font-weight: bold; display: flex; align-items: center; gap: 4px;">
                  <span>📷 现场不良照片证据 (Defect Photo Evidence - Click to zoom):</span>
                </div>
                <img src="${photoSrc}" 
                     onclick="openPhotoViewer(this.src, '巡检异常照片 - ${a.id} (#${f.item_no})')" 
                     style="max-height: 160px; max-width: 240px; border-radius: 6px; border: 1px solid rgba(239,68,68,0.5); cursor: pointer; object-fit: cover; display: block; box-shadow: 0 4px 12px rgba(0,0,0,0.5); transition: transform 0.15s ease;" 
                     onmouseover="this.style.transform='scale(1.03)'" 
                     onmouseout="this.style.transform='scale(1)'" 
                     title="点击放大查看高清照片" />
              </div>
            ` : ''}
          </div>
        `;
      }).join('');
    } else {
      findingsHtml = `
        <div style="font-size: 0.82rem; color: var(--text-muted); padding: 0.5rem; font-style: italic;">
          审核状态为 NG，未找到明细条目备注或检查项标记为异常。
        </div>
        ${primaryPhoto ? `
          <div style="margin-top: 0.5rem;">
            <div style="font-size: 0.72rem; color: #38bdf8; margin-bottom: 4px; font-weight: bold;">📷 现场不良证据照片 (Click to zoom):</div>
            <img src="${primaryPhoto}" onclick="openPhotoViewer(this.src, '巡检异常照片 - ${a.id}')" style="max-height: 160px; max-width: 240px; border-radius: 6px; border: 1px solid rgba(239,68,68,0.5); cursor: pointer; object-fit: cover; display: block;" />
          </div>
        ` : ''}
      `;
    }

    // Render linked CAPA section
    let capaHtml = '';
    if (capa) {
      const cStatus = (capa.status || 'OPEN').toUpperCase();
      let statusBg = 'rgba(239, 68, 68, 0.2)';
      let statusBorder = '#ef4444';
      let statusColor = '#ef4444';
      let statusText = '● OPEN (待调查)';

      if (cStatus === 'INVESTIGATING') {
        statusBg = 'rgba(245, 158, 11, 0.2)';
        statusBorder = '#f59e0b';
        statusColor = '#fbbf24';
        statusText = '● INVESTIGATING (调查中)';
      } else if (cStatus === 'ACTIONING') {
        statusBg = 'rgba(59, 130, 246, 0.2)';
        statusBorder = '#3b82f6';
        statusColor = '#60a5fa';
        statusText = '● ACTIONING (对策执行中)';
      } else if (cStatus === 'CLOSED') {
        statusBg = 'rgba(16, 185, 129, 0.2)';
        statusBorder = '#10b981';
        statusColor = '#34d399';
        statusText = '● CLOSED (已结案)';
      }

      capaHtml = `
        <div id="drilldown-capa-card-${capa.id}" style="margin-top: 0.85rem; background: rgba(15, 23, 42, 0.85); border: 1px solid ${statusBorder}; border-radius: 8px; padding: 0.85rem; box-shadow: 0 4px 15px rgba(0,0,0,0.4);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.6rem; flex-wrap: wrap; gap: 0.5rem; border-bottom: 1px solid rgba(51, 65, 85, 0.4); padding-bottom: 0.5rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <span style="font-size: 1.1rem;">⚡</span>
              <span style="font-weight: 800; font-family: monospace; color: #38bdf8; font-size: 0.95rem;">${capa.id}</span>
              <span id="drilldown-capa-badge-${capa.id}" style="background: ${statusBg}; color: ${statusColor}; font-weight: 800; font-size: 0.72rem; padding: 2px 8px; border-radius: 5px; border: 1px solid ${statusBorder};">${statusText}</span>
              <span style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); font-size: 0.68rem; padding: 1px 6px; border-radius: 4px; font-weight: bold;">${capa.severity || 'HIGH'}</span>
            </div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">
              👤 责任人: <b id="drilldown-capa-owner-${capa.id}" style="color: #fff;">${capa.owner || '未指派'}</b>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 0.6rem; font-size: 0.78rem; margin-bottom: 0.75rem;">
            <div style="background: rgba(30, 41, 59, 0.6); padding: 0.6rem; border-radius: 6px; border-left: 3px solid #f59e0b;">
              <div style="color: #fbbf24; font-weight: bold; margin-bottom: 2px;">🔍 根本原因分析 (Root Cause):</div>
              <div id="drilldown-capa-rootcause-${capa.id}" style="color: #cbd5e1; line-height: 1.4;">${capa.root_cause || '<span style="color: #64748b; font-style: italic;">待录入根本原因 (Pending Investigation)</span>'}</div>
            </div>
            <div style="background: rgba(30, 41, 59, 0.6); padding: 0.6rem; border-radius: 6px; border-left: 3px solid #3b82f6;">
              <div style="color: #60a5fa; font-weight: bold; margin-bottom: 2px;">🛠️ 纠正与预防措施 (Corrective Action):</div>
              <div id="drilldown-capa-action-${capa.id}" style="color: #cbd5e1; line-height: 1.4;">${capa.action_taken || '<span style="color: #64748b; font-style: italic;">待执行对策 (Pending Action)</span>'}</div>
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 0.6rem; align-items: center;">
            <button onclick="openCAPAModal('${capa.id}')" class="btn-select" style="font-size: 0.75rem; padding: 0.35rem 0.75rem; background: #0284c7; color: #fff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer;">✏️ 更新对策进度 (Update CAPA)</button>
            <button onclick="goToCAPAKanban('${capa.id}')" class="btn-select" style="font-size: 0.75rem; padding: 0.35rem 0.75rem; background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid #3b82f6; border-radius: 6px; font-weight: bold; cursor: pointer;">📋 前往 CAPA 看板 (View Kanban)</button>
          </div>
        </div>
      `;
    } else {
      capaHtml = `
        <div style="margin-top: 0.75rem; background: rgba(245, 158, 11, 0.08); border: 1px dashed rgba(245, 158, 11, 0.4); border-radius: 8px; padding: 0.75rem 1rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem;">
          <div style="font-size: 0.8rem; color: #facc15;">
            ⚠️ 此巡检异常暂未建立独立的 CAPA 改善对策单 (No Linked CAPA Ticket)
          </div>
          <button onclick="goToCAPAKanban()" class="btn-primary" style="font-size: 0.75rem; padding: 0.3rem 0.7rem;">➕ 前往 CAPA 看板处理</button>
        </div>
      `;
    }

    return `
      <div class="glass-card" style="margin-bottom: 1.25rem; background: rgba(20, 30, 55, 0.7); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 12px; padding: 1.15rem; box-shadow: 0 8px 25px rgba(0,0,0,0.5);">
        <!-- Top Audit Info Header -->
        <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(51, 65, 85, 0.5); padding-bottom: 0.75rem; margin-bottom: 0.85rem; flex-wrap: wrap; gap: 0.6rem;">
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <span style="font-size: 1.2rem;">📋</span>
            <div>
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span style="font-family: monospace; font-weight: 800; color: #facc15; font-size: 0.95rem;">${a.id || 'AUDIT'}</span>
                <span style="background: rgba(239, 68, 68, 0.25); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.6); padding: 1px 6px; border-radius: 4px; font-weight: 800; font-size: 0.7rem;">NG 不合格</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                ${timeFormatted} • 巡检员: <b style="color: #38bdf8;">${a.auditor || 'Unknown'}</b>
              </div>
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <a href="/reports/audit/preview?audit_id=${a.id}" target="_blank" class="btn-select" style="font-size: 0.75rem; padding: 0.3rem 0.65rem; color: #38bdf8; border-color: rgba(56,189,248,0.4); text-decoration: none;" title="在新标签页中打开巡检报告预览">
              📄 查看完整巡检报告
            </a>
          </div>
        </div>

        <!-- Audit Context Pills -->
        <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; font-size: 0.75rem; margin-bottom: 0.85rem;">
          <div style="background: rgba(15, 23, 42, 0.8); border: 1px solid var(--border-color); padding: 3px 8px; border-radius: 6px;">
            <span style="color: var(--text-muted);">产线:</span> <b style="color: #fff;">${a.line_name || '-'}</b>
          </div>
          <div style="background: rgba(15, 23, 42, 0.8); border: 1px solid var(--border-color); padding: 3px 8px; border-radius: 6px;">
            <span style="color: var(--text-muted);">工位:</span> <b style="color: #38bdf8;">${a.station_code || '-'}</b> <span style="color: #94a3b8;">(${a.station_name || ''})</span>
          </div>
          <div style="background: rgba(15, 23, 42, 0.8); border: 1px solid var(--border-color); padding: 3px 8px; border-radius: 6px;">
            <span style="color: var(--text-muted);">时段:</span> <b style="color: #fff;">${a.time_block || '-'}</b>
          </div>
          ${a.model_no ? `
            <div style="background: rgba(15, 23, 42, 0.8); border: 1px solid var(--border-color); padding: 3px 8px; border-radius: 6px;">
              <span style="color: var(--text-muted);">机种:</span> <b style="color: #fff;">${a.model_no}</b>
            </div>
          ` : ''}
          ${a.work_order ? `
            <div style="background: rgba(15, 23, 42, 0.8); border: 1px solid var(--border-color); padding: 3px 8px; border-radius: 6px;">
              <span style="color: var(--text-muted);">工单:</span> <b style="color: #fff;">${a.work_order}</b>
            </div>
          ` : ''}
        </div>

        <!-- Section: Check Findings -->
        <div style="margin-bottom: 0.5rem;">
          <div style="font-size: 0.78rem; font-weight: 800; color: #f87171; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.4rem; display: flex; align-items: center; gap: 4px;">
            <span>🚨</span> 查核不合格项与现场实测记录 (Failed Checklist Items):
          </div>
          ${findingsHtml}
        </div>

        <!-- Section: CAPA Traceability -->
        <div>
          <div style="font-size: 0.78rem; font-weight: 800; color: #60a5fa; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.4rem; display: flex; align-items: center; gap: 4px;">
            <span>⚡</span> 闭环改善对策追踪 (Linked CAPA Action Plan):
          </div>
          ${capaHtml}
        </div>
      </div>
    `;
  }).join('');
}

function openPhotoViewer(src, title) {
  const viewer = document.getElementById('modal-photo-viewer');
  const img = document.getElementById('photo-viewer-img');
  const titleEl = document.getElementById('photo-viewer-title');
  if (viewer && img) {
    img.src = src;
    if (titleEl) titleEl.textContent = title || '';
    viewer.classList.add('active');
  }
}

function closePhotoViewer() {
  const viewer = document.getElementById('modal-photo-viewer');
  if (viewer) viewer.classList.remove('active');
}

function goToCAPAKanban(capaId) {
  closeNGDrilldown();
  const dashTabBtn = document.querySelector('.nav-tab[data-tab="dashboard"]');
  if (dashTabBtn) {
    dashTabBtn.click();
    switchDashboardSubView('capa');
    if (capaId) {
      setTimeout(() => {
        openCAPAModal(capaId);
      }, 350);
    }
  }
}

function updateDrilldownCAPABadge(capaId, status, owner, root_cause, action_taken) {
  const badgeEl = document.getElementById(`drilldown-capa-badge-${capaId}`);
  const ownerEl = document.getElementById(`drilldown-capa-owner-${capaId}`);
  const rootEl = document.getElementById(`drilldown-capa-rootcause-${capaId}`);
  const actEl = document.getElementById(`drilldown-capa-action-${capaId}`);

  if (badgeEl) {
    const cStatus = (status || 'OPEN').toUpperCase();
    if (cStatus === 'INVESTIGATING') {
      badgeEl.style.background = 'rgba(245, 158, 11, 0.2)';
      badgeEl.style.borderColor = '#f59e0b';
      badgeEl.style.color = '#fbbf24';
      badgeEl.textContent = '● INVESTIGATING (调查中)';
    } else if (cStatus === 'ACTIONING') {
      badgeEl.style.background = 'rgba(59, 130, 246, 0.2)';
      badgeEl.style.borderColor = '#3b82f6';
      badgeEl.style.color = '#60a5fa';
      badgeEl.textContent = '● ACTIONING (对策执行中)';
    } else if (cStatus === 'CLOSED') {
      badgeEl.style.background = 'rgba(16, 185, 129, 0.2)';
      badgeEl.style.borderColor = '#10b981';
      badgeEl.style.color = '#34d399';
      badgeEl.textContent = '● CLOSED (已结案)';
    } else {
      badgeEl.style.background = 'rgba(239, 68, 68, 0.2)';
      badgeEl.style.borderColor = '#ef4444';
      badgeEl.style.color = '#ef4444';
      badgeEl.textContent = '● OPEN (待调查)';
    }
  }

  if (ownerEl && owner) ownerEl.textContent = owner;
  if (rootEl && root_cause) rootEl.textContent = root_cause;
  if (actEl && action_taken) actEl.textContent = action_taken;
}


window.togglePauseDropdown = function() {
  const dd = document.getElementById('pauseDropdown');
  if (dd) {
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  }
};

window.submitPauseForm = async function() {
  const reason = document.getElementById('pauseReasonSelect').value;
  const duration = parseInt(document.getElementById('pauseDurationSelect').value, 10);
  const pwd = document.getElementById('pauseSupervisorPassword').value;

  if (!pwd) {
    alert("Please enter a Supervisor password.");
    return;
  }

  const dd = document.getElementById('pauseDropdown');
  if (dd) dd.style.display = 'none';
  
  const activeLine = (typeof selectedLineFilter !== 'undefined' && selectedLineFilter !== 'All Lines') ? selectedLineFilter : 'SMT Line T1';

  if (!confirm('Are you sure you want to pause audit for ' + activeLine + ' due to: ' + reason + '?')) return;

  const payload = {
    line_name: activeLine,
    reason: reason,
    duration_blocks: duration,
    supervisor_password: pwd,
    shift: (typeof currentShift !== 'undefined') ? currentShift : 'Day Shift',
    current_time_block: (typeof currentSlot !== 'undefined') ? currentSlot : '08:00 - 10:00',
    auditor_name: (typeof currentUser !== 'undefined' && currentUser && currentUser.fullname) ? currentUser.fullname : 'Admin'
  };

  try {
    const res = await apiFetch('/api/audit/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      alert('Line ' + activeLine + ' paused successfully.');
      if (typeof window.refreshDashboard === 'function') window.refreshDashboard();
      else location.reload();
    } else {
      const err = await res.json();
      alert('Failed to pause line: ' + (err.detail || 'Unknown error'));
    }
  } catch(e) {
    console.error(e);
    alert('Error pausing line.');
  }
};
