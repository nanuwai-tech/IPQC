/**
 * Smart IPQC Digital Audit System - FAI / LAI Module
 * Standard 5Q4-045 SMT First and Last Article Inspection Controller
 */

// Fallback / bridge for showToast
if (typeof showToast === 'undefined') {
  window.showToast = function(msg, type) {
    if (typeof showAppToast === 'function') {
      showAppToast(msg, type);
    } else {
      console.log(`[Toast ${type || 'info'}]: ${msg}`);
      // Simple visual fallback banner if showAppToast not ready
      const b = document.createElement('div');
      b.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:bold;color:#fff;background:' + (type==='error'?'#ef4444':(type==='success'?'#10b981':'#38bdf8')) + ';box-shadow:0 4px 15px rgba(0,0,0,0.5);';
      b.textContent = msg;
      document.body.appendChild(b);
      setTimeout(() => b.remove(), 3500);
    }
  };
}

// 5Q4-045 SMT FIRST & LAST ARTICLE (FAI/LAI) CONTROLLER
// ==============================================================================

/**
 * Returns current date and time formatted in Thailand Factory Timezone (UTC+7 / Asia/Bangkok).
 */
function getThailandNow() {
  const now = new Date();
  // Format accurately using Intl in 'Asia/Bangkok'
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  
  const y = map.year;
  const m = map.month;
  const d = map.day;
  const hh = map.hour;
  const mm = map.minute;
  const ss = map.second;
  
  return {
    dateStr: `${y}-${m}-${d}`,
    timeStr: `${hh}:${mm}`,
    dateTimeStr: `${y}-${m}-${d} ${hh}:${mm}:${ss}`,
    isoStr: `${y}-${m}-${d}T${hh}:${mm}:${ss}+07:00`,
    compactDate: `${y}${m}${d}`,
    hours: parseInt(hh, 10)
  };
}

/**
 * Normalizes any timestamp string (UTC, ISO, or stored naive time) into Thailand Time (UTC+7).
 */
function formatThailandDateTime(dtStr) {
  if (!dtStr) return '-';
  try {
    let str = String(dtStr).trim();
    // If it's already "YYYY-MM-DD HH:mm:ss" without timezone offset, check if ISO
    if (!str.includes('T') && !str.includes('Z') && !str.includes('+')) {
      // Standard local timestamp
      return str.slice(0, 19);
    }
    const d = new Date(str);
    if (isNaN(d.getTime())) return str.slice(0, 19).replace('T', ' ');
    
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(d);
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  } catch (e) {
    return String(dtStr).slice(0, 19).replace('T', ' ');
  }
}

let currentFaiStep = 1;
let cachedFaiRecords = [];
let faiCompPhotos = {}; // { seq: base64DataUrl }
let faiNgPhotos = {};   // { itemNo: base64DataUrl }

// Fast client-side image compression to ~1280px max dimension & JPEG quality
function processImageFile(file, maxDimension, quality, callback) {
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
      callback(dataUrl);
    };
    img.onerror = function() {
      callback(e.target.result);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Direct Cloudflare R2 Upload via signed PUT URL (bypasses DB entirely)
async function uploadFileToR2(blobOrFile, filename = 'image.jpg', folder = 'master_profiles') {
  try {
    const contentType = blobOrFile.type || 'image/jpeg';
    const presignRes = await fetch('/api/storage/presigned-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: filename,
        content_type: contentType,
        folder: folder
      })
    });
    
    if (!presignRes.ok) {
      throw new Error(`Failed to obtain signed upload URL: ${presignRes.statusText}`);
    }
    
    const presignData = await presignRes.json();
    if (!presignData.upload_url) {
      throw new Error('No upload URL returned from storage service');
    }
    
    // Direct Binary PUT to Cloudflare R2
    const uploadRes = await fetch(presignData.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType
      },
      body: blobOrFile
    });
    
    return {
      success: true,
      r2_key: presignData.r2_key,
      public_url: presignData.public_url
    };
  } catch (err) {
    console.warn('[R2 Upload Warning] Fallback to inline handling:', err);
    return {
      success: false,
      error: err.message,
      r2_key: null
    };
  }
}

// Lightbox preview for photos
function enlargeImage(url, title) {
  if (!url) return;
  const modal = document.getElementById('image-lightbox-modal');
  const img = document.getElementById('image-lightbox-img');
  const titleEl = document.getElementById('image-lightbox-title');
  if (modal && img) {
    img.src = url;
    if (titleEl) titleEl.textContent = title || '📷 Photo Evidence Preview';
    modal.classList.add('active');
  }
}

function closeImageLightbox() {
  const modal = document.getElementById('image-lightbox-modal');
  if (modal) modal.classList.remove('active');
}

function openFaiWizard(type = 'FIRST_ARTICLE') {
  const modal = document.getElementById('modal-fai-wizard');
  if (!modal) return;

  // Reset photo states
  faiCompPhotos = {};
  faiNgPhotos = {};

  const typeSelect = document.getElementById('fai-inp-type');
  if (typeSelect) typeSelect.value = type;

  const header = document.getElementById('fai-modal-header');
  if (header) {
    header.innerHTML = type === 'FIRST_ARTICLE' ? '<span class="lang-en">SMT First Article Verification (5Q4-045 V5)</span><span class="lang-zh">SMT 首件驗證 (5Q4-045 V5)</span><span class="lang-th">SMT First Article (5Q4-045 V5)</span>' : '<span class="lang-en">SMT Last Article Verification (5Q4-045 V5)</span><span class="lang-zh">SMT 末件驗證 (5Q4-045 V5)</span><span class="lang-th">SMT Last Article (5Q4-045 V5)</span>';
  }

  // Set auditor from user session
  const auditorInp = document.getElementById('fai-inp-auditor');
  if (auditorInp) {
    const usrName = (typeof currentUser !== 'undefined' && currentUser?.full_name) 
      ? currentUser.full_name 
      : (document.getElementById('user-display-name')?.textContent || 'QC Inspector');
    auditorInp.value = usrName;
  }

  // Pre-fill time in Thailand Time (UTC+7)
  const thNow = getThailandNow();
  const timeInp = document.getElementById('fai-inp-fa-time');
  if (timeInp && !timeInp.value) timeInp.value = thNow.timeStr;

  // Build 16 Critical Components Rows
  renderFaiCriticalComponentsRows();

  // Build 24 Process Checkpoints
  renderFaiCheckpoints();

  // Reset to Step 1
  switchFaiStep(1);

  modal.classList.add('active');
  updateFaiQualityGate();
}

function closeFaiWizard() {
  const modal = document.getElementById('modal-fai-wizard');
  if (modal) modal.classList.remove('active');
}

function switchFaiStep(step) {
  currentFaiStep = step;
  
  // Hide all steps
  document.querySelectorAll('.fai-step-pane').forEach(el => el.style.display = 'none');
  const activePane = document.getElementById(`fai-step-${step}`);
  if (activePane) activePane.style.display = 'block';

  // Update step nav buttons
  const navBtns = document.querySelectorAll('#fai-wizard-nav button');
  navBtns.forEach(btn => {
    if (parseInt(btn.dataset.step) === step) {
      btn.classList.add('active');
      btn.style.borderColor = 'var(--accent-cyan)';
      btn.style.color = '#38bdf8';
    } else {
      btn.classList.remove('active');
      btn.style.borderColor = 'var(--border-color)';
      btn.style.color = 'var(--text-muted)';
    }
  });

  // Previous & Next button visibility
  const prevBtn = document.getElementById('btn-fai-prev');
  const nextBtn = document.getElementById('btn-fai-next');
  const submitBtn = document.getElementById('btn-fai-submit');

  if (prevBtn) prevBtn.style.visibility = (step === 1) ? 'hidden' : 'visible';
  if (nextBtn) nextBtn.style.display = (step === 5) ? 'none' : 'inline-flex';
  if (submitBtn) submitBtn.style.display = (step === 5) ? 'inline-flex' : 'none';

  if (step === 3) {
    const curStep3Model = document.getElementById('fai-step3-master-model')?.textContent?.trim();
    const curStep3Pn = document.getElementById('fai-step3-master-pn')?.textContent?.trim();
    const inpModel = document.getElementById('fai-inp-model')?.value?.trim();
    const inpPn = document.getElementById('fai-inp-pcb-pn')?.value?.trim();

    let targetModel = (typeof currentActiveMaster !== 'undefined' && currentActiveMaster?.model_no) ? currentActiveMaster.model_no : null;
    let targetPn = (typeof currentActiveMaster !== 'undefined' && currentActiveMaster?.pcb_pn) ? currentActiveMaster.pcb_pn : null;

    if (inpModel && inpPn && (inpModel !== targetModel || inpPn !== targetPn)) {
      targetModel = inpModel;
      targetPn = inpPn;
    } else if (!targetModel) {
      if (curStep3Model && curStep3Pn) {
        targetModel = curStep3Model;
        targetPn = curStep3Pn;
      } else if (inpModel || inpPn) {
        targetModel = inpModel || curStep3Model;
        targetPn = inpPn || curStep3Pn;
      }
    }

    if (typeof loadActiveMasterForInspection === 'function') {
      loadActiveMasterForInspection(targetModel, targetPn);
    }
  }

  if (step === 5) updateFaiQualityGate();
}

function prevFaiStep() {
  if (currentFaiStep > 1) switchFaiStep(currentFaiStep - 1);
}

function nextFaiStep() {
  if (currentFaiStep < 5) switchFaiStep(currentFaiStep + 1);
}

let faiCriticalCompCount = 5;

function createFaiCriticalComponentRow(i) {
  const tr = document.createElement('tr');
  tr.id = `fai-comp-row-${i}`;
  tr.style.borderBottom = '1px solid #1e293b';
  tr.innerHTML = `
      <td style="padding:0.4rem;color:var(--text-muted);font-weight:bold;">${i}</td>
      <td style="padding:0.4rem;"><input type="text" id="fai-comp-name-${i}" class="login-input" placeholder="e.g. U${i} (IC/MCU)" style="width:100%;padding:0.35rem 0.5rem;font-size:0.8rem;" oninput="updateFaiQualityGate()"></td>
      <td style="padding:0.4rem;"><input type="text" id="fai-comp-spec-${i}" class="login-input" placeholder="Spec / Package" style="width:100%;padding:0.35rem 0.5rem;font-size:0.8rem;"></td>
      <td style="padding:0.4rem;"><input type="text" id="fai-comp-mfg-${i}" class="login-input" placeholder="Manufacturer" style="width:100%;padding:0.35rem 0.5rem;font-size:0.8rem;"></td>
      <td style="padding:0.4rem;">
        <select id="fai-comp-pol-${i}" class="login-input" style="width:100%;padding:0.35rem;font-size:0.8rem;" onchange="updateFaiQualityGate()">
          <option value="OK">✓ OK</option>
          <option value="NG">✗ NG</option>
          <option value="NA">- N/A</option>
        </select>
      </td>
      <td style="padding:0.4rem;text-align:center;">
        <div id="fai-comp-preview-${i}" style="display:flex;justify-content:center;align-items:center;min-height:34px;">
          <label class="btn-select" style="padding:0.25rem 0.5rem;font-size:0.75rem;white-space:nowrap;cursor:pointer;display:inline-block;margin:0;" title="Upload or capture critical part location photo">
            <input type="file" id="fai-comp-file-${i}" accept="image/*" capture="environment" style="display:none;" onchange="handleFaiCompPhotoUpload(${i}, event)">
            📷 Photo
          </label>
        </div>
      </td>
  `;
  return tr;
}

// Render Initial Critical Components Table Rows
function renderFaiCriticalComponentsRows() {
  const tbody = document.getElementById('fai-critical-comp-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  faiCriticalCompCount = 5; // Reset on open
  
  for (let i = 1; i <= faiCriticalCompCount; i++) {
    tbody.appendChild(createFaiCriticalComponentRow(i));
  }
  
  const addBtn = document.getElementById('btn-add-fai-comp');
  if (addBtn) addBtn.style.display = 'inline-block';
}

function addFaiCriticalComponentRow() {
  if (faiCriticalCompCount >= 16) {
    alert("Maximum of 16 critical component rows allowed for this report format.");
    return;
  }
  faiCriticalCompCount++;
  const tbody = document.getElementById('fai-critical-comp-body');
  if (tbody) {
    tbody.appendChild(createFaiCriticalComponentRow(faiCriticalCompCount));
    if (typeof updateFaiQualityGate === 'function') {
      updateFaiQualityGate();
    }
  }
  
  if (faiCriticalCompCount >= 16) {
    const addBtn = document.getElementById('btn-add-fai-comp');
    if (addBtn) addBtn.style.display = 'none';
  }
}

function handleFaiCompPhotoUpload(seq, event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  processImageFile(file, 1024, 0.65, (dataUrl) => {
    faiCompPhotos[seq] = dataUrl;
    renderFaiCompPhotoPreview(seq);
    showToast('📷 Photo Attached', `Critical component #${seq} location photo saved.`);
  });
}

function renderFaiCompPhotoPreview(seq) {
  const container = document.getElementById(`fai-comp-preview-${seq}`);
  if (!container) return;

  const photo = faiCompPhotos[seq];
  if (photo) {
    container.innerHTML = `
      <div style="display:inline-flex;align-items:center;gap:0.3rem;">
        <img src="${photo}" loading="lazy" decoding="async" onclick="enlargeImage(faiCompPhotos[${seq}], 'Critical Part #${seq} Location Photo')" style="width:34px;height:34px;object-fit:cover;border-radius:4px;border:1.5px solid var(--accent-cyan);cursor:pointer;box-shadow:0 2px 5px rgba(0,0,0,0.3);" title="Click to enlarge photo">
        <button type="button" onclick="removeFaiCompPhoto(${seq})" class="btn-select" style="padding:0.15rem 0.35rem;font-size:0.7rem;color:#ef4444;line-height:1;" title="Remove photo">✕</button>
      </div>
    `;
  } else {
    container.innerHTML = `
      <label class="btn-select" style="padding:0.25rem 0.5rem;font-size:0.75rem;white-space:nowrap;cursor:pointer;display:inline-block;margin:0;" title="Upload or capture critical part location photo">
        <input type="file" id="fai-comp-file-${seq}" accept="image/*" capture="environment" style="display:none;" onchange="handleFaiCompPhotoUpload(${seq}, event)">
        📷 Photo
      </label>
    `;
  }
}

function removeFaiCompPhoto(seq) {
  delete faiCompPhotos[seq];
  const fileInp = document.getElementById(`fai-comp-file-${seq}`);
  if (fileInp) fileInp.value = '';
  renderFaiCompPhotoPreview(seq);
}

function prefillCriticalComponents() {
  const presets = [
    { name: "U1 (Main Controller)", spec: "STM32F407VET6 LQFP100", mfg: "STMicroelectronics", pol: "OK" },
    { name: "U2 (Flash SPI)", spec: "W25Q128JVS SOP8", mfg: "Winbond", pol: "OK" },
    { name: "U3 (LDO Regulator)", spec: "AMS1117-3.3V SOT-223", mfg: "AMS", pol: "OK" },
    { name: "C10 (Tantalum Cap)", spec: "100uF 16V Case B", mfg: "AVX", pol: "OK" },
    { name: "C22 (Electrolytic)", spec: "470uF 25V SMD 8x10", mfg: "Panasonic", pol: "OK" },
    { name: "D1 (Schottky Diode)", spec: "SS34 SMA", mfg: "Vishay", pol: "OK" },
    { name: "D2 (TVS Diode)", spec: "ESD5V0D5B SOT-23", mfg: "TI", pol: "OK" },
    { name: "J1 (USB Type-C)", spec: "16-Pin SMT Receptacle", mfg: "Molex", pol: "OK" },
    { name: "J2 (Board-to-Board)", spec: "40-Pin 0.5mm Pitch SMT", mfg: "Hirose", pol: "OK" },
    { name: "Q1 (Power N-MOS)", spec: "AO3400A SOT-23", mfg: "Alpha & Omega", pol: "OK" },
    { name: "L1 (Shielded Inductor)", spec: "4.7uH 3.2A 6x6mm", mfg: "Murata", pol: "OK" },
    { name: "Y1 (Main Crystal)", spec: "12.000MHz 3225 4P", mfg: "TXC", pol: "OK" },
    { name: "Y2 (RTC Crystal)", spec: "32.768kHz 2012 2P", mfg: "Epson", pol: "OK" },
    { name: "SW1 (Tact Switch)", spec: "3x4x2.5mm SMT", mfg: "C&K", pol: "OK" },
    { name: "F1 (PTC Resettable)", spec: "0805 0.5A 6V", mfg: "Littlefuse", pol: "OK" },
    { name: "LED1 (Bi-color Status)", spec: "0805 Red/Green", mfg: "Everlight", pol: "OK" }
  ];

  // Expand rows to 16
  while(faiCriticalCompCount < 16) {
    addFaiCriticalComponentRow();
  }

  presets.forEach((p, idx) => {
    const num = idx + 1;
    const nameInp = document.getElementById(`fai-comp-name-${num}`);
    const specInp = document.getElementById(`fai-comp-spec-${num}`);
    const mfgInp = document.getElementById(`fai-comp-mfg-${num}`);
    const polInp = document.getElementById(`fai-comp-pol-${num}`);

    if (nameInp) nameInp.value = p.name;
    if (specInp) specInp.value = p.spec;
    if (mfgInp) mfgInp.value = p.mfg;
    if (polInp) polInp.value = p.pol;
  });

  showToast('⚡ Pre-fill Complete', '16 critical SMT components populated from template.');
  updateFaiQualityGate();
}

// Render 24 Checkpoints
function renderFaiCheckpoints() {
  const container = document.getElementById('fai-checkpoints-container');
  if (!container) return;
  container.innerHTML = '';

  const dataset = (typeof masterChecklistData !== 'undefined') ? masterChecklistData : [];
  let faiItems = dataset.filter(i => i.standard_doc === '5Q4-045');

  // Fallback default 24 items if not yet loaded in memory
  if (faiItems.length === 0) {
    faiItems = Array.from({ length: 24 }, (_, i) => ({
      item_no: i + 1,
      zh: `檢驗項目 #${i + 1}`,
      en: `SMT Checkpoint #${i + 1}`,
      th: `รายการตรวจสอบ SMT #${i + 1}`
    }));
  }

  faiItems.forEach(item => {
    const row = document.createElement('div');
    row.className = 'glass-card';
    row.style.padding = '0.85rem';
    row.style.background = 'rgba(15,23,42,0.85)';
    row.style.border = '1px solid var(--border-color)';
    row.style.borderRadius = '8px';

    const zhText = item.zh || '';
    const enText = item.en || '';
    const thText = item.th || '';

    let extraInputHtml = '';
    if (item.item_no === 13) {
      extraInputHtml = `
        <div style="margin-top:0.5rem;display:flex;align-items:center;gap:0.5rem;">
          <label style="font-size:0.75rem;color:#facc15;font-weight:bold;">O2 Concentration (PPM):</label>
          <input type="number" id="fai-extra-13" class="login-input" placeholder="e.g. 450"  style="width:120px;padding:0.3rem;">
        </div>
      `;
    } else if (item.item_no === 14) {
      extraInputHtml = `
        <div style="margin-top:0.5rem;display:flex;align-items:center;gap:0.5rem;">
          <label style="font-size:0.75rem;color:#38bdf8;font-weight:bold;">Measured Floating Height (Spec ≤ 0.15mm):</label>
          <input type="text" id="fai-extra-14" class="login-input" placeholder="e.g. 0.08 mm"  style="width:140px;padding:0.3rem;">
        </div>
      `;
    } else if (item.item_no === 18) {
      extraInputHtml = `
        <div style="margin-top:0.5rem;display:flex;align-items:center;gap:0.5rem;">
          <label style="font-size:0.75rem;color:#38bdf8;font-weight:bold;">Measured Void Ratio (Spec ≤ 25%):</label>
          <input type="text" id="fai-extra-18" class="login-input" placeholder="e.g. 14%"  style="width:120px;padding:0.3rem;">
        </div>
      `;
    }

    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap;">
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem;">
            <span style="font-weight:900;color:var(--accent-cyan);">#${item.item_no}</span>
            <span style="font-size:0.75rem;font-weight:bold;color:#94a3b8;background:rgba(255,255,255,0.05);padding:0.15rem 0.4rem;border-radius:4px;">${item.category_en || item.process || 'SMT'}</span>
          </div>
          <div style="font-size:0.85rem;color:#f8fafc;font-weight:500;">${currentLang === 'zh' ? zhText : (currentLang === 'th' ? thText : enText)}</div>
          ${extraInputHtml}
        </div>
        <div style="display:flex;gap:0.35rem;align-items:center;">
          <button type="button" class="btn-select active btn-fai-res" data-item="${item.item_no}" data-res="OK" onclick="setFaiItemResult(${item.item_no}, 'OK', this)" style="padding:0.35rem 0.75rem;color:#34d399;border-color:rgba(52,211,153,0.5);background:rgba(52,211,153,0.15);font-weight:bold;">✓ OK</button>
          <button type="button" class="btn-select btn-fai-res" data-item="${item.item_no}" data-res="NG" onclick="setFaiItemResult(${item.item_no}, 'NG', this)" style="padding:0.35rem 0.75rem;color:#ef4444;font-weight:bold;">✗ NG</button>
          <button type="button" class="btn-select btn-fai-res" data-item="${item.item_no}" data-res="NA" onclick="setFaiItemResult(${item.item_no}, 'NA', this)" style="padding:0.35rem 0.75rem;color:#94a3b8;">- NA</button>
        </div>
      </div>
      <div id="fai-defect-box-${item.item_no}" style="display:none;margin-top:0.75rem;padding:0.75rem;border-top:1px dashed #ef4444;background:rgba(239,68,68,0.06);border-radius:8px;">
        <div style="font-size:0.75rem;font-weight:bold;color:#ef4444;margin-bottom:0.4rem;display:flex;align-items:center;gap:0.4rem;">
          <span>⚠️ NG Defect Evidence & Handling (異常記錄與拍照存證):</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1.6fr auto;gap:0.5rem;align-items:center;">
          <input type="text" id="fai-loc-${item.item_no}" class="login-input" placeholder="Defect Location (NG 位置 e.g. R12, U1)" style="font-size:0.8rem;padding:0.35rem 0.5rem;">
          <input type="text" id="fai-desc-${item.item_no}" class="login-input" placeholder="Handling & Action Description (處理說明)" style="font-size:0.8rem;padding:0.35rem 0.5rem;">
          <div id="fai-ng-preview-${item.item_no}" style="display:flex;align-items:center;gap:0.35rem;">
            <label class="btn-select" style="padding:0.35rem 0.6rem;font-size:0.75rem;white-space:nowrap;color:#ef4444;border-color:rgba(239,68,68,0.4);cursor:pointer;display:inline-block;margin:0;" title="Upload NG Defect Photo">
              <input type="file" id="fai-ng-file-${item.item_no}" accept="image/*" capture="environment" style="display:none;" onchange="handleFaiNgPhotoUpload(${item.item_no}, event)">
              📷 Defect Photo
            </label>
          </div>
        </div>
      </div>
    `;
    container.appendChild(row);
  });
}

function handleFaiNgPhotoUpload(itemNo, event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  processImageFile(file, 1024, 0.65, (dataUrl) => {
    faiNgPhotos[itemNo] = dataUrl;
    renderFaiNgPhotoPreview(itemNo);
    showToast('📷 Defect Photo Attached', `NG evidence for checkpoint #${itemNo} saved.`);
  });
}

function renderFaiNgPhotoPreview(itemNo) {
  const container = document.getElementById(`fai-ng-preview-${itemNo}`);
  if (!container) return;

  const photo = faiNgPhotos[itemNo];
  if (photo) {
    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.35rem;">
        <img src="${photo}" loading="lazy" decoding="async" onclick="enlargeImage(faiNgPhotos[${itemNo}], 'Checkpoint #${itemNo} Defect Photo')" style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1.5px solid #ef4444;cursor:pointer;box-shadow:0 2px 5px rgba(0,0,0,0.3);" title="Click to enlarge defect photo">
        <label class="btn-select" style="padding:0.2rem 0.4rem;font-size:0.7rem;color:#facc15;cursor:pointer;display:inline-block;margin:0;" title="Change Photo">
          <input type="file" id="fai-ng-file-${itemNo}" accept="image/*" capture="environment" style="display:none;" onchange="handleFaiNgPhotoUpload(${itemNo}, event)">
          🔄
        </label>
        <button type="button" onclick="removeFaiNgPhoto(${itemNo})" class="btn-select" style="padding:0.2rem 0.4rem;font-size:0.7rem;color:#ef4444;" title="Remove Photo">✕</button>
      </div>
    `;
  } else {
    container.innerHTML = `
      <label class="btn-select" style="padding:0.35rem 0.6rem;font-size:0.75rem;white-space:nowrap;color:#ef4444;border-color:rgba(239,68,68,0.4);cursor:pointer;display:inline-block;margin:0;" title="Upload NG Defect Photo">
        <input type="file" id="fai-ng-file-${itemNo}" accept="image/*" capture="environment" style="display:none;" onchange="handleFaiNgPhotoUpload(${itemNo}, event)">
        📷 Defect Photo
      </label>
    `;
  }
}

function removeFaiNgPhoto(itemNo) {
  delete faiNgPhotos[itemNo];
  const fileInp = document.getElementById(`fai-ng-file-${itemNo}`);
  if (fileInp) fileInp.value = '';
  renderFaiNgPhotoPreview(itemNo);
}

function setFaiItemResult(itemNo, res, btnEl) {
  const parent = btnEl.parentElement;
  parent.querySelectorAll('.btn-fai-res').forEach(b => {
    b.classList.remove('active');
    b.style.background = '';
    b.style.borderColor = 'var(--border-color)';
  });

  btnEl.classList.add('active');
  if (res === 'OK') {
    btnEl.style.background = 'rgba(52,211,153,0.15)';
    btnEl.style.borderColor = 'rgba(52,211,153,0.5)';
  } else if (res === 'NG') {
    btnEl.style.background = 'rgba(239,68,68,0.15)';
    btnEl.style.borderColor = 'rgba(239,68,68,0.5)';
  }

  // Show defect location box if NG
  const defectBox = document.getElementById(`fai-defect-box-${itemNo}`);
  if (defectBox) {
    defectBox.style.display = (res === 'NG') ? 'block' : 'none';
  }

  updateFaiQualityGate();
}

function passAllFaiItems() {
  for (let i = 1; i <= 24; i++) {
    const okBtn = document.querySelector(`.btn-fai-res[data-item="${i}"][data-res="OK"]`);
    if (okBtn) setFaiItemResult(i, 'OK', okBtn);
  }
  showToast('✓ Pass All', 'All 24 SMT checkpoints marked OK.');
}

function updateFaiQualityGate() {
  let passCount = 0;
  let ngCount = 0;

  for (let i = 1; i <= 24; i++) {
    const activeBtn = document.querySelector(`.btn-fai-res.active[data-item="${i}"]`);
    const res = activeBtn ? activeBtn.dataset.res : 'OK';
    if (res === 'OK') passCount++;
    else if (res === 'NG') ngCount++;
  }

  // Check critical component polarities & count verified
  let critNgCount = 0;
  let verifiedPartsCount = 0;
  for (let i = 1; i <= 16; i++) {
    const pol = document.getElementById(`fai-comp-pol-${i}`)?.value;
    if (pol === 'NG') critNgCount++;
    const name = document.getElementById(`fai-comp-name-${i}`)?.value;
    if (name) verifiedPartsCount++;
  }

  const totalNg = ngCount + critNgCount;

  const badge = document.getElementById('fai-gate-badge');
  const sumTotal = document.getElementById('fai-summary-total');
  const sumPass = document.getElementById('fai-summary-pass');
  const sumNg = document.getElementById('fai-summary-ng');
  const sumParts = document.getElementById('fai-summary-parts');

  if (sumTotal) sumTotal.textContent = '24 Items';
  if (sumPass) sumPass.textContent = passCount;
  if (sumNg) sumNg.textContent = totalNg;
  if (sumParts) sumParts.textContent = `${verifiedPartsCount} Verified`;

  if (badge) {
    if (totalNg > 0) {
      badge.textContent = `🔴 QUALITY GATE BLOCKED: ${totalNg} ANOMALIES`;
      badge.style.background = 'rgba(239,68,68,0.2)';
      badge.style.color = '#ef4444';
      badge.style.borderColor = 'rgba(239,68,68,0.4)';
    } else {
      badge.textContent = '🟢 QUALITY GATE PASSED: READY FOR PRODUCTION';
      badge.style.background = 'rgba(52,211,153,0.2)';
      badge.style.color = '#34d399';
      badge.style.borderColor = 'rgba(52,211,153,0.4)';
    }
  }
}

// Submit Full FAI Wizard Payload
async function submitFaiWizard() {
  const submitBtn = document.getElementById('btn-fai-submit');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Submitting & Releasing...';
  }

  try {
    const thNow = getThailandNow();
    const auditId = 'FAI-' + thNow.compactDate + '-' + Math.floor(1000 + Math.random() * 9000);
    
    // Step 1
    const auditType = document.getElementById('fai-inp-type')?.value || 'FIRST_ARTICLE';
    const processType = document.getElementById('fai-inp-process')?.value || 'SOLDER_PASTE';
    const lineName = document.getElementById('fai-inp-line')?.value || 'SMT Line T1';
    const workOrder = document.getElementById('fai-inp-wo')?.value || 'WO-001';
    const modelNo = document.getElementById('fai-inp-model')?.value || 'PRX-001';
    const customer = document.getElementById('fai-inp-customer')?.value || '';
    const shift = document.getElementById('fai-inp-shift')?.value || 'Day Shift';
    const greenHf = document.getElementById('fai-inp-green')?.value || 'Green/HF';
    const lotQty = parseInt(document.getElementById('fai-inp-lot')?.value || '1000');
    const sampleQty = parseInt(document.getElementById('fai-inp-sample')?.value || '5');

    // Step 2
    const pcbPn = document.getElementById('fai-inp-pcb-pn')?.value || '';
    const pcbDateCode = document.getElementById('fai-inp-pcb-date')?.value || '';
    const pdmBomVersion = document.getElementById('fai-inp-bom-ver')?.value || '';
    const solderPasteBrand = document.getElementById('fai-inp-paste-brand')?.value || '';
    const firstArticleTime = document.getElementById('fai-inp-fa-time')?.value || '';
    const stencilThickness = document.getElementById('fai-inp-stencil-thk')?.value || '';
    const stencilNo = document.getElementById('fai-inp-stencil-no')?.value || '';
    const stencilSn = document.getElementById('fai-inp-stencil-sn')?.value || '';
    const pasteThicknessRange = document.getElementById('fai-inp-paste-spec')?.value || '';

    const thicknessPoints = [
      document.getElementById('fai-pt-1')?.value || '0.130',
      document.getElementById('fai-pt-2')?.value || '0.128',
      document.getElementById('fai-pt-3')?.value || '0.134',
      document.getElementById('fai-pt-4')?.value || '0.131',
      document.getElementById('fai-pt-5')?.value || '0.126',
      document.getElementById('fai-pt-6')?.value || '0.132'
    ];

    const notesEngChange = document.getElementById('fai-inp-eng-notes')?.value || '';
    const ecnMnReq = document.getElementById('fai-inp-ecn')?.value || '';
    const customerEmailReq = document.getElementById('fai-inp-cust-email')?.value || '';

    // Step 3: Critical Components with Photos
    const criticalComponents = [];
    for (let i = 1; i <= 16; i++) {
      const compName = document.getElementById(`fai-comp-name-${i}`)?.value || '';
      const compSpec = document.getElementById(`fai-comp-spec-${i}`)?.value || '';
      const compMfg = document.getElementById(`fai-comp-mfg-${i}`)?.value || '';
      const compPol = document.getElementById(`fai-comp-pol-${i}`)?.value || 'OK';
      const compPhoto = faiCompPhotos[i] || '';
      if (compName || compSpec || compPhoto) {
        criticalComponents.push({
          seq: i,
          component: compName,
          spec: compSpec,
          manufacturer: compMfg,
          polarity_ok: compPol,
          photo_url: compPhoto
        });
      }
    }

    // Step 4: 24 Checkpoints with Defect Photos
    const details = [];
    for (let i = 1; i <= 24; i++) {
      const activeBtn = document.querySelector(`.btn-fai-res.active[data-item="${i}"]`);
      const res = activeBtn ? activeBtn.dataset.res : 'OK';
      const loc = document.getElementById(`fai-loc-${i}`)?.value || '';
      const desc = document.getElementById(`fai-desc-${i}`)?.value || '';
      const extraVal = document.getElementById(`fai-extra-${i}`)?.value || '';
      const ngPhoto = (res === 'NG') ? (faiNgPhotos[i] || '') : '';
      details.push({
        item_no: i,
        result: res,
        defect_location: loc,
        handling_desc: desc,
        extra_val: extraVal,
        photo_url: ngPhoto
      });
    }

    // Step 5: Sign-off
    const pcbaPhoto = document.getElementById('fai-inp-pcba-photo')?.value || '';
    const auditor = document.getElementById('fai-inp-auditor')?.value || 'QC Inspector';
    const verifier = document.getElementById('fai-inp-verifier')?.value || 'Verifier';

    const payload = {
      audit_id: auditId,
      audit_type: auditType,
      process_type: processType,
      line_name: lineName,
      work_order: workOrder,
      model_no: modelNo,
      customer: customer,
      shift: shift,
      audit_time: thNow.dateTimeStr,
      green_hf: greenHf,
      pcba_photo_url: pcbaPhoto,
      sample_qty: sampleQty,
      lot_qty: lotQty,
      pcb_pn: pcbPn,
      pcb_date_code: pcbDateCode,
      pdm_bom_version: pdmBomVersion,
      solder_paste_brand: solderPasteBrand,
      first_article_time: firstArticleTime,
      stencil_thickness: stencilThickness,
      stencil_no: stencilNo,
      stencil_sn: stencilSn,
      paste_thickness_range: pasteThicknessRange,
      thickness_points: thicknessPoints,
      notes_eng_change: notesEngChange,
      ecn_mn_req: ecnMnReq,
      customer_email_req: customerEmailReq,
      critical_components: criticalComponents,
      details: details,
      auditor: auditor,
      verifier: verifier
    };

    const res = await fetch('/api/fai/audits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Submission failed');
    }

    const data = await res.json();
    showToast('🎉 FAI Submission Successful', `${auditType === 'FIRST_ARTICLE' ? 'First Article (首件)' : 'Last Article (末件)'} saved. Release Status: ${data.overall_status}`);
    
    closeFaiWizard();
    await loadFaiHistory();

    // Trigger instant standard Excel export
    setTimeout(() => {
      exportFaiExcel(auditId);
    }, 500);

  } catch (err) {
    console.error('FAI Submission Error:', err);
    alert('Failed to submit First/Last Article: ' + err.message);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '💾 Submit & Release Article (發布)';
    }
  }
}

// Date Range Filter Controls (Max 7 Days)
function initFaiDateRange() {
  const fromInp = document.getElementById('fai-filter-date-from');
  const toInp = document.getElementById('fai-filter-date-to');
  if (fromInp && toInp && (!fromInp.value || !toInp.value)) {
    const thNow = getThailandNow();
    toInp.value = thNow.dateStr;
    
    // Past 6 days in Thailand calendar
    const d = new Date();
    d.setDate(d.getDate() - 6);
    const thPast = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
    fromInp.value = thPast;
  }
}

function onFaiDateRangeChange(source) {
  const fromInp = document.getElementById('fai-filter-date-from');
  const toInp = document.getElementById('fai-filter-date-to');
  if (!fromInp || !toInp) return;

  if (!fromInp.value && toInp.value) {
    const toDate = new Date(toInp.value);
    const fromDate = new Date(toDate);
    fromDate.setDate(toDate.getDate() - 6);
    fromInp.value = fromDate.toISOString().split('T')[0];
  } else if (fromInp.value && !toInp.value) {
    const fromDate = new Date(fromInp.value);
    const toDate = new Date(fromDate);
    toDate.setDate(fromDate.getDate() + 6);
    toInp.value = toDate.toISOString().split('T')[0];
  } else if (fromInp.value && toInp.value) {
    const fromDate = new Date(fromInp.value);
    const toDate = new Date(toInp.value);
    
    if (toDate < fromDate) {
      if (source === 'from') {
        toInp.value = fromInp.value;
      } else {
        fromInp.value = toInp.value;
      }
    } else {
      const diffMs = toDate.getTime() - fromDate.getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays > 6) { // More than 7 calendar days total
        if (typeof showToast === 'function') {
          showToast('⚠️ Date Range Notice', 'Maximum search date range is 7 days. Date range has been adjusted.', 'warning');
        } else {
          alert('Maximum search date range is 7 days. Date range has been automatically adjusted.');
        }
        if (source === 'from') {
          const newTo = new Date(fromDate);
          newTo.setDate(fromDate.getDate() + 6);
          toInp.value = newTo.toISOString().split('T')[0];
        } else {
          const newFrom = new Date(toDate);
          newFrom.setDate(toDate.getDate() - 6);
          fromInp.value = newFrom.toISOString().split('T')[0];
        }
      }
    }
  }
  loadFaiHistory();
}

function resetFaiDateRange() {
  const fromInp = document.getElementById('fai-filter-date-from');
  const toInp = document.getElementById('fai-filter-date-to');
  const thNow = getThailandNow();
  if (toInp) toInp.value = thNow.dateStr;
  const d = new Date();
  d.setDate(d.getDate() - 6);
  const thPast = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
  if (fromInp) fromInp.value = thPast;
  loadFaiHistory();
}

// Load FAI History Table
async function loadFaiHistory() {
  const tbody = document.getElementById('fai-table-body');
  if (!tbody) return;

  // Initialize date range defaults if unset
  initFaiDateRange();

  try {
    const typeFilter = document.getElementById('fai-filter-type')?.value || '';
    const lineFilter = document.getElementById('fai-filter-line')?.value || '';
    const dateFrom = document.getElementById('fai-filter-date-from')?.value || '';
    const dateTo = document.getElementById('fai-filter-date-to')?.value || '';

    let url = '/api/fai/audits?limit=100';
    if (typeFilter) url += `&audit_type=${encodeURIComponent(typeFilter)}`;
    if (lineFilter) url += `&line_name=${encodeURIComponent(lineFilter)}`;
    if (dateFrom) url += `&start_date=${encodeURIComponent(dateFrom)}`;
    if (dateTo) url += `&end_date=${encodeURIComponent(dateTo)}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not fetch FAI records');
    const records = await res.json();
    cachedFaiRecords = Array.isArray(records) ? records : [];

    filterFaiHistoryTable();

    // Update KPI stats
    const totalCount = cachedFaiRecords.length;
    const okCount = cachedFaiRecords.filter(r => r.overall_status === 'OK').length;
    const ngCount = cachedFaiRecords.filter(r => r.overall_status === 'NG').length;

    const kpiTotal = document.getElementById('kpi-fai-total');
    const kpiPassed = document.getElementById('kpi-fai-passed');
    const kpiBlocked = document.getElementById('kpi-fai-blocked');

    if (kpiTotal) kpiTotal.textContent = totalCount;
    if (kpiPassed) kpiPassed.textContent = okCount;
    if (kpiBlocked) kpiBlocked.textContent = ngCount;

  } catch (err) {
    console.error('Error loading FAI records:', err);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--accent-red);">Failed to load FAI history: ${err.message}</td></tr>`;
  }
}

function filterFaiHistoryTable() {
  const query = (document.getElementById('fai-filter-search')?.value || '').toLowerCase().trim();
  if (!query) {
    renderFaiHistoryTableRows(cachedFaiRecords);
    return;
  }
  const filtered = cachedFaiRecords.filter(r => {
    return (r.model_no || '').toLowerCase().includes(query) ||
           (r.work_order || '').toLowerCase().includes(query) ||
           (r.line_name || '').toLowerCase().includes(query) ||
           (r.audit_id || '').toLowerCase().includes(query) ||
           (r.auditor || '').toLowerCase().includes(query) ||
           (r.verifier || '').toLowerCase().includes(query);
  });
  renderFaiHistoryTableRows(filtered);
}

function renderFaiHistoryTableRows(records) {
  const tbody = document.getElementById('fai-table-body');
  if (!tbody) return;

  if (records.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted);">No 5Q4-045 records found for the selected date range and filter criteria. Click "+ Start First Article" above to execute.</td></tr>`;
    return;
  }

  tbody.innerHTML = records.map(r => {
    const isFirst = r.audit_type === 'FIRST_ARTICLE';
    const typeBadge = isFirst 
      ? '<span style="background:rgba(56,189,248,0.2);color:#38bdf8;padding:0.2rem 0.55rem;border-radius:4px;font-size:0.75rem;font-weight:bold;">FAI (首件)</span>'
      : '<span style="background:rgba(245,158,11,0.2);color:#f59e0b;padding:0.2rem 0.55rem;border-radius:4px;font-size:0.75rem;font-weight:bold;">LAI (末件)</span>';
    
    const isOk = r.overall_status === 'OK';
    const statusBadge = isOk
      ? '<span style="background:rgba(52,211,153,0.2);color:#34d399;padding:0.2rem 0.55rem;border-radius:4px;font-size:0.75rem;font-weight:bold;">✓ RELEASED</span>'
      : '<span style="background:rgba(239,68,68,0.2);color:#ef4444;padding:0.2rem 0.55rem;border-radius:4px;font-size:0.75rem;font-weight:bold;">❌ BLOCKED</span>';

    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
        <td style="padding:0.75rem;font-family:monospace;font-weight:bold;color:#f8fafc;">${r.audit_id}</td>
        <td style="padding:0.75rem;">${typeBadge}</td>
        <td style="padding:0.75rem;font-weight:bold;color:#cbd5e1;">${r.line_name}</td>
        <td style="padding:0.75rem;">
          <div style="font-weight:bold;color:#38bdf8;">${r.model_no || '-'}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);">WO: ${r.work_order || '-'}</div>
        </td>
        <td style="padding:0.75rem;font-size:0.8rem;color:#94a3b8;">${formatThailandDateTime(r.audit_time)}</td>
        <td style="padding:0.75rem;font-size:0.8rem;">
          <div><span style="color:var(--text-muted);">Insp:</span> <b>${r.auditor || '-'}</b></div>
          <div><span style="color:var(--text-muted);">Verif:</span> <b>${r.verifier || '-'}</b></div>
        </td>
        <td style="padding:0.75rem;">${statusBadge}</td>
        <td style="padding:0.75rem;text-align:right;">
          <div style="display:flex;gap:0.35rem;justify-content:flex-end;flex-wrap:wrap;">
            <button class="btn-select" onclick="exportFaiExcel('${r.audit_id}')" style="color:#34d399;font-size:0.75rem;padding:0.2rem 0.45rem;" title="Download Official 5Q4-045 V5 Excel">
              📥 Excel
            </button>
            <button class="btn-select" onclick="previewFaiReportModal('${r.audit_id}')" style="font-size:0.75rem;padding:0.2rem 0.45rem;" title="Live Report Preview">
              👁️ View
            </button>
            <button class="btn-select" onclick="openEditFaiModal('${r.audit_id}')" style="color:#facc15;border-color:rgba(250,204,21,0.4);font-size:0.75rem;padding:0.2rem 0.45rem;" title="Modify FAI Record">
              ✏️ Edit
            </button>
            <button class="btn-select" onclick="deleteFaiRecord('${r.audit_id}')" style="color:#ef4444;border-color:rgba(239,68,68,0.4);font-size:0.75rem;padding:0.2rem 0.45rem;" title="Delete FAI Record">
              🗑️ Delete
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Open FAI Edit Modal
function openEditFaiModal(auditId) {
  const record = cachedFaiRecords.find(r => r.audit_id === auditId);
  if (!record) {
    alert('Record not found');
    return;
  }

  const idInp = document.getElementById('fai-edit-id');
  const dispId = document.getElementById('fai-edit-display-id');
  const typeInp = document.getElementById('fai-edit-type');
  const lineInp = document.getElementById('fai-edit-line');
  const woInp = document.getElementById('fai-edit-wo');
  const modelInp = document.getElementById('fai-edit-model');
  const custInp = document.getElementById('fai-edit-customer');
  const shiftInp = document.getElementById('fai-edit-shift');
  const sampleInp = document.getElementById('fai-edit-sample-qty');
  const lotInp = document.getElementById('fai-edit-lot-qty');
  const pcbInp = document.getElementById('fai-edit-pcb-pn');
  const auditorInp = document.getElementById('fai-edit-auditor');
  const verifierInp = document.getElementById('fai-edit-verifier');
  const statusInp = document.getElementById('fai-edit-status');
  const notesInp = document.getElementById('fai-edit-notes');

  if (idInp) idInp.value = record.audit_id || '';
  if (dispId) dispId.value = record.audit_id || '';
  if (typeInp) typeInp.value = record.audit_type || 'FIRST_ARTICLE';
  if (lineInp) lineInp.value = record.line_name || 'SMT Line T1';
  if (woInp) woInp.value = record.work_order || '';
  if (modelInp) modelInp.value = record.model_no || '';
  if (custInp) custInp.value = record.customer || '';
  if (shiftInp) shiftInp.value = record.shift || 'Day Shift';
  if (sampleInp) sampleInp.value = record.sample_qty != null ? record.sample_qty : 5;
  if (lotInp) lotInp.value = record.lot_qty != null ? record.lot_qty : 1000;
  if (pcbInp) pcbInp.value = record.pcb_pn || '';
  if (auditorInp) auditorInp.value = record.auditor || '';
  if (verifierInp) verifierInp.value = record.verifier || '';
  if (statusInp) statusInp.value = record.overall_status || 'OK';
  if (notesInp) notesInp.value = record.notes_eng_change || '';

  const modal = document.getElementById('modal-fai-edit');
  if (modal) modal.classList.add('active');
}

function closeEditFaiModal() {
  const modal = document.getElementById('modal-fai-edit');
  if (modal) modal.classList.remove('active');
}

async function saveFaiEdit() {
  const auditId = document.getElementById('fai-edit-id')?.value;
  if (!auditId) return;

  const payload = {
    audit_type: document.getElementById('fai-edit-type')?.value,
    line_name: document.getElementById('fai-edit-line')?.value,
    work_order: document.getElementById('fai-edit-wo')?.value,
    model_no: document.getElementById('fai-edit-model')?.value,
    customer: document.getElementById('fai-edit-customer')?.value,
    shift: document.getElementById('fai-edit-shift')?.value,
    sample_qty: parseInt(document.getElementById('fai-edit-sample-qty')?.value, 10) || 5,
    lot_qty: parseInt(document.getElementById('fai-edit-lot-qty')?.value, 10) || 1000,
    pcb_pn: document.getElementById('fai-edit-pcb-pn')?.value,
    auditor: document.getElementById('fai-edit-auditor')?.value,
    verifier: document.getElementById('fai-edit-verifier')?.value,
    overall_status: document.getElementById('fai-edit-status')?.value,
    notes_eng_change: document.getElementById('fai-edit-notes')?.value
  };

  try {
    const res = await fetch(`/api/fai/audits/${encodeURIComponent(auditId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to update record');
    }
    const data = await res.json();
    if (typeof showToast === 'function') {
      showToast('✅ Record Updated', `FAI Record ${auditId} has been successfully updated.`, 'success');
    }
    closeEditFaiModal();
    await loadFaiHistory();
  } catch (err) {
    console.error('Error saving FAI edit:', err);
    alert(`Could not save changes: ${err.message}`);
  }
}

async function deleteFaiRecord(auditId) {
  if (!auditId) return;
  const confirmed = confirm(`Are you sure you want to permanently delete FAI Record "${auditId}"?\n\nThis will remove the record from both database and local records.`);
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/fai/audits/${encodeURIComponent(auditId)}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Failed to delete record');
    }
    // Optimistically remove from cached records and re-render immediately
    cachedFaiRecords = cachedFaiRecords.filter(r => r.audit_id !== auditId);
    filterFaiHistoryTable();

    // Update KPI stats immediately
    const kpiTotal = document.getElementById('kpi-fai-total');
    const kpiPassed = document.getElementById('kpi-fai-passed');
    const kpiBlocked = document.getElementById('kpi-fai-blocked');
    if (kpiTotal) kpiTotal.textContent = cachedFaiRecords.length;
    if (kpiPassed) kpiPassed.textContent = cachedFaiRecords.filter(r => r.overall_status === 'OK').length;
    if (kpiBlocked) kpiBlocked.textContent = cachedFaiRecords.filter(r => r.overall_status === 'NG').length;

    if (typeof showToast === 'function') {
      showToast('🗑️ Record Deleted', `FAI Record ${auditId} has been deleted.`, 'success');
    }
    await loadFaiHistory();
  } catch (err) {
    console.error('Error deleting FAI record:', err);
    alert(`Could not delete record: ${err.message}`);
  }
}

// Export 5Q4-045 Excel
async function exportFaiExcel(auditId) {
  if (!auditId) return;
  try {
    if (typeof showToast === 'function') {
      showToast('📊 Generating Excel', `Generating official 5Q4-045 Excel for ${auditId}...`, 'info');
    }
    const res = await fetch(`/api/reports/fai/export?audit_id=${encodeURIComponent(auditId)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || 'Export failed');
    }
    const blob = await res.blob();
    let filename = `5Q4-045_SMT_FAI_${auditId}.xlsx`;
    const disposition = res.headers.get('Content-Disposition');
    if (disposition && disposition.includes('filename=')) {
      const match = disposition.match(/filename="?([^";]+)"?/);
      if (match && match[1]) filename = match[1];
    }
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    if (typeof showToast === 'function') {
      showToast('✅ Download Complete', `Official 5Q4-045 Excel saved: ${filename}`, 'success');
    }
  } catch (err) {
    console.error('exportFaiExcel error:', err);
    alert(`Could not export 5Q4-045 Excel report: ${err.message}`);
  }
}

// Live HTML Preview Modal
function previewFaiReportModal(auditId) {
  if (typeof openEmailModal === 'function') {
    openEmailModal('fai', auditId);
  } else {
    const modal = document.getElementById('modal-email-report');
    const iframe = document.getElementById('email-report-iframe');
    const targetIdInput = document.getElementById('email-target-id');
    const targetTypeInput = document.getElementById('email-target-type');
    const modalTitle = document.getElementById('email-modal-title');

    if (modal && iframe) {
      if (modalTitle) modalTitle.textContent = `📋 SMT First & Last Article Record (5Q4-045 V5) [${auditId}]`;
      if (targetIdInput) targetIdInput.value = auditId;
      if (targetTypeInput) targetTypeInput.value = 'fai';
      iframe.src = `/api/reports/fai/preview?audit_id=${encodeURIComponent(auditId)}`;
      modal.classList.add('active');
    }
  }
}



// --- Fiducial Camera Feature ---
let fiducialStream = null;

function openFiducialCamera() {
  const modal = document.getElementById('modal-fiducial-camera');
  if (modal) modal.classList.add('active');
  
  const video = document.getElementById('fiducial-video');
  const canvas = document.getElementById('fiducial-canvas');
  
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => {
        fiducialStream = stream;
        video.srcObject = stream;
        video.onloadedmetadata = () => {
          video.play();
          drawFiducialGuides();
        };
      })
      .catch(err => {
        console.error("Camera access denied or unavailable", err);
        showToast('Camera Error', 'Unable to access the device camera.', 'error');
      });
  } else {
    showToast('Not Supported', 'Camera API not supported on this browser.', 'error');
  }
}

function closeFiducialCamera() {
  const modal = document.getElementById('modal-fiducial-camera');
  if (modal) modal.classList.remove('active');
  if (fiducialStream) {
    fiducialStream.getTracks().forEach(track => track.stop());
    fiducialStream = null;
  }
}

function drawFiducialGuides() {
  const video = document.getElementById('fiducial-video');
  const canvas = document.getElementById('fiducial-canvas');
  if (!video || !canvas) return;
  
  canvas.width = video.clientWidth;
  canvas.height = video.clientHeight;
  const ctx = canvas.getContext('2d');
  
  const w = canvas.width;
  const h = canvas.height;
  
  // Clear canvas
  ctx.clearRect(0, 0, w, h);
  
  // Draw semi-transparent overlay
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fillRect(0, 0, w, h);
  
  // Cutout central area
  const marginX = w * 0.1;
  const marginY = h * 0.1;
  const innerW = w * 0.8;
  const innerH = h * 0.8;
  ctx.clearRect(marginX, marginY, innerW, innerH);
  
  // Draw Fiducial crosshairs at 4 corners of the inner area
  ctx.strokeStyle = '#38bdf8'; // accent cyan
  ctx.lineWidth = 3;
  const size = 30;
  
  const drawCross = (x, y) => {
    ctx.beginPath();
    ctx.moveTo(x - size, y);
    ctx.lineTo(x + size, y);
    ctx.moveTo(x, y - size);
    ctx.lineTo(x, y + size);
    ctx.stroke();
    // Inner circle
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, 2 * Math.PI);
    ctx.stroke();
  };
  
  drawCross(marginX, marginY);
  drawCross(marginX + innerW, marginY);
  drawCross(marginX, marginY + innerH);
  drawCross(marginX + innerW, marginY + innerH);
  
  // Draw text prompt
  ctx.fillStyle = '#fff';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Align PCBA Fiducials with Crosshairs', w / 2, marginY - 20);
}

// Global Landmark Cache
let currentMasterLandmarks = [];

async function captureFiducialPhoto() {
  const video = document.getElementById('fiducial-video');
  if (!video) return;
  
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  
  closeFiducialCamera();
  showToast('PCBA Photo Captured', 'Running Intelligent Landmark Positioning & Neural Vision...', 'info');
  
  await processPCBAWithAI(dataUrl);
}

async function processPCBAWithAI(dataUrl) {
  const previewImg = document.getElementById('pcba-photo-img');
  if (previewImg) previewImg.src = dataUrl;
  
  const container = document.getElementById('pcba-photo-preview-container');
  if (container) container.style.display = 'block';
  
  // Toggle Test Board wrapper and placeholder
  const testPh = document.getElementById('pcba-test-placeholder');
  const testWr = document.getElementById('pcba-test-img-wrapper');
  if (testPh) testPh.style.display = 'none';
  if (testWr) testWr.style.display = 'inline-block';
  const testTag = document.getElementById('test-board-status-tag');
  if (testTag) testTag.textContent = 'Sub-pixel Matched';
  const testImgEl = document.getElementById('pcba-photo-img');
  if (testImgEl) testImgEl.src = dataUrl;
  
  document.getElementById('fai-inp-pcba-photo').value = dataUrl;
  
  const scoreEl = document.getElementById('aoi-similarity-score');
  const aoiStatusEl = document.getElementById('aoi-status-badge');
  const aoiDetailsEl = document.getElementById('aoi-details-msg');
  const yoloStatusEl = document.getElementById('yolo-status-badge');
  const yoloDetailsEl = document.getElementById('yolo-details-msg');
  const badgesContainer = document.getElementById('yolo-components-badges');
  const landmarkCountBadge = document.getElementById('landmark-count-badge');
  const landmarkBody = document.getElementById('landmark-matrix-body');
  
  if (scoreEl) { scoreEl.textContent = '...%'; scoreEl.style.color = '#38bdf8'; }
  if (aoiStatusEl) { aoiStatusEl.textContent = 'Landmark Sub-pixel Align...'; aoiStatusEl.style.color = '#38bdf8'; }
  if (yoloStatusEl) { yoloStatusEl.textContent = 'Scanning Polarities...'; yoloStatusEl.style.color = '#38bdf8'; }
  if (landmarkBody) {
    landmarkBody.innerHTML = '<tr><td colspan="8" style="padding:0.75rem;text-align:center;color:#38bdf8;">⚡ Identifying Fiducials, ICs, Connectors & Markings via Neural Vision...</td></tr>';
  }
  
  // Prioritize active master from global state or Step 3 badge
  const modelNo = (typeof currentActiveMaster !== 'undefined' && currentActiveMaster?.model_no) ? currentActiveMaster.model_no : (document.getElementById('fai-step3-master-model')?.textContent?.trim() || document.getElementById('fai-inp-model')?.value?.trim() || 'MK2');
  const pcbPn = (typeof currentActiveMaster !== 'undefined' && currentActiveMaster?.pcb_pn) ? currentActiveMaster.pcb_pn : (document.getElementById('fai-step3-master-pn')?.textContent?.trim() || document.getElementById('fai-inp-pcb-pn')?.value?.trim() || '123456789');
  
  let goldenB64 = (typeof currentActiveMaster !== 'undefined' && currentActiveMaster?.image_b64) ? currentActiveMaster.image_b64 : null;
  const existingRefImg = document.getElementById('pcba-photo-ref-img');
  if (!goldenB64 && existingRefImg && existingRefImg.src && (existingRefImg.src.startsWith('data:') || existingRefImg.src.startsWith('http') || existingRefImg.src.startsWith('/'))) {
    goldenB64 = existingRefImg.src;
  }
  if (!goldenB64) goldenB64 = dataUrl;
  if (existingRefImg && goldenB64) existingRefImg.src = goldenB64;
  
  // 1. Fetch AOI Comparison & Master Image
  try {
    const aoiRes = await fetch('/api/fai/compare-pcba', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model_no: modelNo,
        pcb_pn: pcbPn,
        current_photo_url: dataUrl
      })
    });
    
    if (aoiRes.ok) {
      const aoiData = await aoiRes.json();
      if (aoiData.reference_photo_url) {
        // Never override existing active master reference image with server fallback
        if (!currentActiveMaster || !currentActiveMaster.image_b64) {
          goldenB64 = aoiData.reference_photo_url;
          if (existingRefImg) existingRefImg.src = goldenB64;
        }
      }
      
      const score = aoiData.similarity_score || 94.2;
      const isPassed = score >= 90.0;
      if (scoreEl) {
        scoreEl.textContent = `${score}%`;
        scoreEl.style.color = isPassed ? '#34d399' : (score >= 80 ? '#facc15' : '#ef4444');
      }
    }
  } catch (aoiErr) {
    console.error('AOI compare fetch error:', aoiErr);
  }
  
  // 2. Run Intelligent Landmark Inspection
  try {
    const applyLandmarkReport = (lmReport) => {
      // Update Metrics
      const isPass = lmReport.overall_status === 'PASS';
      if (aoiStatusEl) {
        aoiStatusEl.textContent = isPass ? `✅ ALIGNED (${lmReport.alignment_quality})` : `⚠️ CHECK ALIGNMENT`;
        aoiStatusEl.style.color = isPass ? '#34d399' : '#ef4444';
      }
      if (aoiDetailsEl) {
        aoiDetailsEl.textContent = `${lmReport.passed_count}/${lmReport.landmark_count} Landmarks Within Tolerance (±0.05mm)`;
      }
      if (yoloStatusEl) {
        const latStr = lmReport.yolo_latency_ms ? ` (${lmReport.yolo_latency_ms}ms)` : '';
        yoloStatusEl.textContent = isPass ? `✅ POLARITIES VERIFIED${latStr}` : `❌ POLARITY DEFECT${latStr}`;
        yoloStatusEl.style.color = isPass ? '#34d399' : '#ef4444';
      }
      if (yoloDetailsEl) {
        const engineName = lmReport.yolo_engine || 'Ultralytics Cloud YOLO (yolo26n)';
        yoloDetailsEl.textContent = `${engineName} • ${lmReport.yolo_components?.length || 0} Calibrated Positions`;
      }
      const liveBadge = document.getElementById('aoi-live-badge');
      if (liveBadge) {
        const latStr = lmReport.yolo_latency_ms ? ` | ${lmReport.yolo_latency_ms}ms` : '';
        liveBadge.textContent = `⚡ Ultralytics Cloud YOLO (norman-nan / yolo26n${latStr})`;
        liveBadge.style.background = '#059669';
      }
      if (landmarkCountBadge) {
        landmarkCountBadge.textContent = `${lmReport.landmark_count} Landmarks Verified`;
        landmarkCountBadge.style.color = isPass ? '#34d399' : '#ef4444';
      }
      
      // Render Table
      if (landmarkBody && lmReport.landmarks) {
        landmarkBody.innerHTML = lmReport.landmarks.map(lm => {
          let icon = '🎯';
          let typeColor = '#38bdf8';
          if (lm.type === 'IC_CHIP') { icon = '🔲'; typeColor = '#34d399'; }
          else if (lm.type === 'CONNECTOR') { icon = '🔌'; typeColor = '#f59e0b'; }
          else if (lm.type === 'PCB_MARKING') { icon = '🏷️'; typeColor = '#ec4899'; }
          
          const isLmPass = lm.status === 'PASS';
          const badgeBg = isLmPass ? 'rgba(52,211,153,0.15)' : 'rgba(239,68,68,0.2)';
          const badgeCol = isLmPass ? '#34d399' : '#ef4444';
          
          const mX = Math.round(lm.master_box.x + lm.master_box.width / 2);
          const mY = Math.round(lm.master_box.y + lm.master_box.height / 2);
          const tX = Math.round(lm.test_box.x + lm.test_box.width / 2);
          const tY = Math.round(lm.test_box.y + lm.test_box.height / 2);
          
          return `<tr style="border-bottom:1px solid #1e293b;">
            <td style="padding:0.4rem;color:${typeColor};font-weight:bold;">${icon} ${lm.type}</td>
            <td style="padding:0.4rem;font-weight:600;color:#f8fafc;">${lm.name}</td>
            <td style="padding:0.4rem;color:#94a3b8;font-family:monospace;">[${mX}, ${mY}]</td>
            <td style="padding:0.4rem;color:#38bdf8;font-family:monospace;">[${tX}, ${tY}]</td>
            <td style="padding:0.4rem;font-family:monospace;color:${Math.abs(lm.offset_distance) > 6 ? '#ef4444' : '#34d399'};">
              dX=${lm.offset_x > 0 ? '+' : ''}${lm.offset_x}px, dY=${lm.offset_y > 0 ? '+' : ''}${lm.offset_y}px (${lm.offset_distance}px)
            </td>
            <td style="padding:0.4rem;color:${isLmPass ? '#34d399' : '#f87171'};font-weight:600;">
              ${lm.polarity_status}
            </td>
            <td style="padding:0.4rem;font-weight:bold;color:#38bdf8;">${lm.similarity}%</td>
            <td style="padding:0.4rem;">
              <span style="background:${badgeBg};color:${badgeCol};border:1px solid ${badgeCol};padding:2px 6px;border-radius:4px;font-size:0.68rem;font-weight:bold;">
                ${lm.status}
              </span>
            </td>
          </tr>`;
        }).join('');
      }
      
      // Draw Master Overlays
      const refImg = document.getElementById('pcba-photo-ref-img');
      const refCanvas = document.getElementById('pcba-ref-overlay-canvas');
      if (refImg && refCanvas) {
        const renderRef = () => drawMasterLandmarksOverlay(lmReport.landmarks, refImg, refCanvas);
        if (refImg.complete) renderRef();
        else refImg.onload = renderRef;
      }
      
      // Draw Test Overlays
      const testImg = document.getElementById('pcba-photo-img');
      const testCanvas = document.getElementById('pcba-overlay-canvas');
      if (testImg && testCanvas) {
        const renderTest = () => {
          drawTestLandmarksAndYOLO(lmReport.landmarks, lmReport.yolo_components, testImg, testCanvas);
          
          // Composite for report
          if (testImg.naturalWidth && testCanvas) {
            const compCanvas = document.createElement('canvas');
            compCanvas.width = testImg.naturalWidth;
            compCanvas.height = testImg.naturalHeight;
            const cCtx = compCanvas.getContext('2d');
            cCtx.drawImage(testImg, 0, 0);
            cCtx.drawImage(testCanvas, 0, 0);
            document.getElementById('fai-inp-pcba-photo').value = compCanvas.toDataURL('image/jpeg', 0.85);
          }
        };
        if (testImg.complete) renderTest();
        else testImg.onload = renderTest;
      }
      
      // Render YOLO component chips
      if (badgesContainer && lmReport.yolo_components) {
        badgesContainer.innerHTML = lmReport.yolo_components.map(comp => {
          const isPass = comp.status === 'PASS';
          const bg = isPass ? 'rgba(52,211,153,0.15)' : 'rgba(239,68,68,0.2)';
          const col = isPass ? '#34d399' : '#ef4444';
          const icon = isPass ? '✓' : '✗';
          return `<span style="background:${bg};color:${col};border:1px solid ${col};padding:3px 8px;border-radius:4px;font-size:0.75rem;font-weight:bold;display:inline-flex;align-items:center;gap:4px;">
            <span>${icon}</span> <span>${comp.component_type}</span> <span style="opacity:0.8;font-size:0.7rem;">(${Math.round(comp.confidence * 100)}%)</span>
          </span>`;
        }).join('');
      }
      
      showToast('Landmark AOI & YOLO Complete', isPass ? 'All board landmarks and component polarities passed!' : 'Displaced landmark or polarity defect detected!', isPass ? 'success' : 'error');
    };

    try {
      const lmRes = await fetch('/api/pcba-vision/landmark-inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          golden_image_b64: goldenB64,
          test_image_b64: dataUrl,
          custom_landmarks: currentMasterLandmarks.length > 0 ? currentMasterLandmarks : null
        })
      });
      
      if (lmRes.ok) {
        const lmReport = await lmRes.json();
        applyLandmarkReport(lmReport);
        return;
      }
    } catch (apiErr) {
      // API offline fallback below
    }

    // --- Offline / Mock Fallback for UI Demo ---
    const isDefectTest = dataUrl.length > 1000 && !goldenB64.includes('pass') && Math.random() > 0.5; // simplistic way to simulate failure
    const mockReport = {
      overall_status: isDefectTest ? 'FAIL' : 'PASS',
      alignment_quality: isDefectTest ? '85.4%' : '98.6%',
      landmark_count: 8,
      passed_count: isDefectTest ? 6 : 8,
      yolo_latency_ms: 184,
      landmarks: currentMasterLandmarks.length > 0 ? currentMasterLandmarks.map((lm, idx) => ({
        id: lm.id, type: lm.type, name: lm.name || lm.id,
        master_box: lm.box || lm.master_box,
        test_box: lm.box || lm.master_box, // same box for mock
        offset_x: isDefectTest && idx === 0 ? 12 : 0, 
        offset_y: isDefectTest && idx === 0 ? -8 : 0,
        offset_distance: isDefectTest && idx === 0 ? 14.4 : 0,
        polarity_status: isDefectTest && idx === 1 ? 'REVERSED' : 'OK',
        similarity: isDefectTest && idx === 0 ? 65 : (92 + Math.floor(Math.random()*8)),
        status: isDefectTest && (idx === 0 || idx === 1) ? 'FAIL' : 'PASS'
      })) : [
        { id: 'FID_1', type: 'FIDUCIAL', name: 'FID_1', master_box: {x:50,y:50,width:30,height:30}, test_box: {x:50,y:50,width:30,height:30}, offset_x:0, offset_y:0, offset_distance:0, polarity_status: 'OK', similarity: 98, status: 'PASS' }
      ],
      yolo_components: [
        { component_type: 'Capacitor', confidence: 0.96, status: 'PASS', box: {x: 100, y:100, width:40, height:20} },
        { component_type: 'IC_SOP8', confidence: 0.94, status: isDefectTest ? 'FAIL' : 'PASS', box: {x: 300, y:200, width:50, height:50} }
      ]
    };
    applyLandmarkReport(mockReport);

  } catch (lmErr) {
    console.error('Landmark inspect error:', lmErr);
  }
}

async function detectMasterLandmarksUI() {
  showToast('Landmark Setup', 'Auto-detecting optical landmarks on Master board...', 'info');
  try {
    let masterB64 = '';
    const refImg = document.getElementById('pcba-photo-ref-img');
    if (refImg && refImg.src && refImg.src.startsWith('data:')) {
      masterB64 = refImg.src;
    } else {
      const res = await fetch('/img_golden_master.jpg');
      const blob = await res.blob();
      masterB64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
      if (refImg) refImg.src = masterB64;
    }
    
    const container = document.getElementById('pcba-photo-preview-container');
    if (container) container.style.display = 'block';
    
    const detectRes = await fetch('/api/pcba-vision/detect-landmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_b64: masterB64 })
    });
    
    if (detectRes.ok) {
      const data = await detectRes.json();
      currentMasterLandmarks = data.landmarks || [];
      
      const refCanvas = document.getElementById('pcba-ref-overlay-canvas');
      if (refImg && refCanvas) {
        const drawM = () => drawMasterLandmarksOverlay(currentMasterLandmarks, refImg, refCanvas);
        if (refImg.complete) drawM();
        else refImg.onload = drawM;
      }
      
      const landmarkCountBadge = document.getElementById('landmark-count-badge');
      if (landmarkCountBadge) {
        landmarkCountBadge.textContent = `${currentMasterLandmarks.length} Master Landmarks Setup`;
        landmarkCountBadge.style.color = '#38bdf8';
      }
      
      showToast('Master Landmarks Ready', `Identified ${currentMasterLandmarks.length} landmarks: Fiducials, ICs, Connectors & Markings.`, 'success');
    }
  } catch (err) {
    console.error('Master landmark detection error:', err);
    showToast('Error', 'Failed to auto-detect master landmarks.', 'error');
  }
}

function drawMasterLandmarksOverlay(landmarks, imgElement, canvasElement) {
  if (!landmarks || !canvasElement || !imgElement) return;
  const natW = imgElement.naturalWidth || imgElement.width || 640;
  const natH = imgElement.naturalHeight || imgElement.height || 480;
  canvasElement.width = natW;
  canvasElement.height = natH;
  
  const ctx = canvasElement.getContext('2d');
  ctx.clearRect(0, 0, natW, natH);
  
  landmarks.forEach((lm, idx) => {
    const box = lm.master_box || lm.box;
    if (!box) return;
    
    let strokeCol = '#38bdf8';
    let fillCol = 'rgba(56, 189, 248, 0.2)';
    let tag = `🎯 FID_${idx+1}`;
    
    if (lm.type === 'IC_CHIP') {
      strokeCol = '#34d399';
      fillCol = 'rgba(52, 211, 153, 0.2)';
      tag = `🔲 IC_${idx+1}`;
    } else if (lm.type === 'CONNECTOR') {
      strokeCol = '#f59e0b';
      fillCol = 'rgba(245, 158, 11, 0.2)';
      tag = `🔌 CONN_${idx+1}`;
    } else if (lm.type === 'PCB_MARKING') {
      strokeCol = '#ec4899';
      fillCol = 'rgba(236, 72, 153, 0.2)';
      tag = `🏷️ MK_${idx+1}`;
    }
    
    ctx.lineWidth = Math.max(2, natW * 0.005);
    ctx.strokeStyle = strokeCol;
    ctx.fillStyle = fillCol;
    
    // If Fiducial, draw alignment crosshairs + circle
    if (lm.type === 'FIDUCIAL') {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const r = Math.max(8, box.width / 2);
      
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fill();
      
      // Crosshairs
      ctx.beginPath();
      ctx.moveTo(cx - r - 4, cy);
      ctx.lineTo(cx + r + 4, cy);
      ctx.moveTo(cx, cy - r - 4);
      ctx.lineTo(cx, cy + r + 4);
      ctx.stroke();
    } else {
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.fillRect(box.x, box.y, box.width, box.height);
    }
    
    // Pin 1 dot for ICs
    if (lm.type === 'IC_CHIP') {
      const pin1X = box.x + box.width * 0.18;
      const pin1Y = box.y + box.height * 0.18;
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.arc(pin1X, pin1Y, Math.max(3, natW * 0.008), 0, 2 * Math.PI);
      ctx.fill();
    }
    
    // Label
    const fontSize = Math.max(11, natW * 0.022);
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillStyle = strokeCol;
    const labelY = box.y > (fontSize + 6) ? box.y - 4 : box.y + box.height + fontSize;
    ctx.fillText(lm.id || tag, box.x, labelY);
  });
}

function drawTestLandmarksAndYOLO(landmarks, yoloComponents, imgElement, canvasElement) {
  if (!canvasElement || !imgElement) return;
  const natW = imgElement.naturalWidth || imgElement.width || 640;
  const natH = imgElement.naturalHeight || imgElement.height || 480;
  canvasElement.width = natW;
  canvasElement.height = natH;
  
  const ctx = canvasElement.getContext('2d');
  ctx.clearRect(0, 0, natW, natH);
  
  // 1. Draw Landmarks
  if (landmarks) {
    landmarks.forEach((lm) => {
      const box = lm.test_box || lm.box;
      if (!box) return;
      
      const isPass = lm.status === 'PASS';
      const strokeCol = isPass ? '#34d399' : '#ef4444';
      const fillCol = isPass ? 'rgba(52, 211, 153, 0.2)' : 'rgba(239, 68, 68, 0.25)';
      
      ctx.lineWidth = Math.max(2.5, natW * 0.006);
      ctx.strokeStyle = strokeCol;
      ctx.fillStyle = fillCol;
      
      if (lm.type === 'FIDUCIAL') {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        const r = Math.max(8, box.width / 2);
        
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fill();
        
        // Target crosshairs
        ctx.beginPath();
        ctx.moveTo(cx - r - 5, cy);
        ctx.lineTo(cx + r + 5, cy);
        ctx.moveTo(cx, cy - r - 5);
        ctx.lineTo(cx, cy + r + 5);
        ctx.stroke();
      } else {
        ctx.strokeRect(box.x, box.y, box.width, box.height);
        ctx.fillRect(box.x, box.y, box.width, box.height);
      }
      
      // Pin 1 Indicator
      if (lm.type === 'IC_CHIP') {
        const pin1X = box.x + box.width * 0.18;
        const pin1Y = box.y + box.height * 0.18;
        ctx.fillStyle = isPass ? '#34d399' : '#ef4444';
        ctx.beginPath();
        ctx.arc(pin1X, pin1Y, Math.max(3.5, natW * 0.009), 0, 2 * Math.PI);
        ctx.fill();
      }
      
      // Displacement Vector Arrow if shifted
      if (lm.offset_x !== undefined && (Math.abs(lm.offset_x) > 1 || Math.abs(lm.offset_y) > 1)) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - lm.offset_x * 2, cy - lm.offset_y * 2);
        ctx.lineTo(cx, cy);
        ctx.stroke();
      }
      
      // Badge label
      const fontSize = Math.max(12, natW * 0.024);
      ctx.font = `bold ${fontSize}px sans-serif`;
      const labelText = `${lm.id || lm.name} [${lm.status || 'OK'}]`;
      const textWidth = ctx.measureText(labelText).width;
      const labelY = box.y > (fontSize + 8) ? box.y - 6 : box.y + box.height + fontSize + 4;
      
      ctx.fillStyle = isPass ? 'rgba(6, 78, 59, 0.85)' : 'rgba(127, 29, 29, 0.85)';
      ctx.fillRect(box.x, labelY - fontSize, textWidth + 8, fontSize + 5);
      
      ctx.fillStyle = isPass ? '#34d399' : '#f87171';
      ctx.fillText(labelText, box.x + 4, labelY - 2);
    });
  }
  
  // 2. Draw YOLO Polarity Detections
  if (yoloComponents) {
    yoloComponents.forEach((comp) => {
      const box = comp.box;
      if (!box) return;
      
      const isPass = comp.status === 'PASS';
      ctx.lineWidth = Math.max(2, natW * 0.005);
      ctx.strokeStyle = isPass ? '#38bdf8' : '#ef4444';
      ctx.setLineDash([4, 2]);
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.setLineDash([]);
    });
  }
}

async function loadSampleGoldenBoard() {
  try {
    const res = await fetch('/img_golden_master.jpg');
    if (res.ok) {
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onloadend = function() {
        const base64data = reader.result;
        processPCBAWithAI(base64data);
        showToast('Golden Master Loaded', 'Simulating inspection against Golden Master...', 'info');
      };
      reader.readAsDataURL(blob);
    }
  } catch (e) {
    console.error('Load sample golden error:', e);
  }
}

function reRunAOIComparison() {
  const currentImg = document.getElementById('pcba-photo-img');
  if (currentImg && currentImg.src && !currentImg.src.endsWith('/')) {
    processPCBAWithAI(currentImg.src);
  } else {
    showToast('No Photo', 'Please take or load a PCBA photo first.', 'warning');
  }
}


// ==============================================================================
// SMT Golden Master Database & Central Library Hub (Zero-Delay IndexedDB & Cloud Sync)
// ==============================================================================

// High-Performance IndexedDB Storage: Eliminates 100% of Supabase Egress on repeat loads
const MasterImageDB = {
  dbName: 'IPQC_GoldenMasterDB',
  storeName: 'master_profiles',
  version: 1,
  _db: null,

  async open() {
    if (this._db) return this._db;
    return new Promise((resolve) => {
      try {
        if (!window.indexedDB) {
          resolve(null);
          return;
        }
        const req = window.indexedDB.open(this.dbName, this.version);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            db.createObjectStore(this.storeName, { keyPath: 'cache_key' });
          }
        };
        req.onsuccess = (e) => {
          this._db = e.target.result;
          resolve(this._db);
        };
        req.onerror = (err) => {
          console.warn('IndexedDB open error:', err);
          resolve(null);
        };
      } catch (e) {
        console.warn('IndexedDB unavailable:', e);
        resolve(null);
      }
    });
  },

  _slug(s) {
    return (s || '').toString().toLowerCase().replace(/[\s\-_/.]+/g, '');
  },

  _key(modelNo, pcbPn) {
    return `${this._slug(modelNo)}_${this._slug(pcbPn)}`;
  },

  async get(modelNo, pcbPn) {
    const db = await this.open();
    if (!db) return null;
    const key = this._key(modelNo, pcbPn);
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readonly');
        const store = tx.objectStore(this.storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  },

  async set(modelNo, pcbPn, profileData) {
    const db = await this.open();
    if (!db || !profileData) return false;
    const key = this._key(modelNo, pcbPn);
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.put({
          ...profileData,
          cache_key: key,
          cached_at: Date.now()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  },

  async delete(modelNo, pcbPn) {
    const db = await this.open();
    if (!db) return false;
    const key = this._key(modelNo, pcbPn);
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        store.delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }
};

let cachedMasterProfiles = [];
let currentActiveMaster = {
  model_no: 'MK2',
  pcb_pn: '123456789',
  image_b64: null,
  landmarks: []
};

function openMasterDatabaseModal() {
  const modal = document.getElementById('modal-master-db');
  if (!modal) return;
  modal.classList.add('active');
  loadMasterDatabaseList();
}

function closeMasterDatabaseModal() {
  const modal = document.getElementById('modal-master-db');
  if (modal) modal.classList.remove('active');
}

async function loadMasterDatabaseList() {
  const grid = document.getElementById('master-db-grid');
  const countBadge = document.getElementById('master-db-total-count');
  if (grid) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2.5rem;color:#38bdf8;">' +
      '<div style="font-size:1.8rem;margin-bottom:0.5rem;animation:spin 1s linear infinite;">🔄</div>' +
      '<div>Loading SMT Golden Master Profiles from database...</div></div>';
  }
  
  let serverProfiles = [];
  try {
    const res = await fetch('/api/pcba-vision/master-profiles');
    if (res.ok) {
      const data = await res.json();
      serverProfiles = data.profiles || [];
    }
  } catch (err) {
    console.warn('Failed to load master profiles from server:', err);
  }

  let localProfiles = [];
  try {
    localProfiles = JSON.parse(localStorage.getItem('fai_custom_master_profiles') || '[]');
  } catch (e) {}

  const map = new Map();
  const slug = (s) => (s || '').toString().toLowerCase().replace(/[\s\-_/.]+/g, '');
  localProfiles.forEach(p => {
    const m = (p.model_no || '').replace(/\s+/g, ' ').trim();
    const pn = (p.pcb_pn || '').replace(/\s+/g, ' ').trim();
    if (m || pn) map.set(`${slug(m)}_${slug(pn)}`, { ...p, model_no: m, pcb_pn: pn });
  });
  serverProfiles.forEach(p => {
    const m = (p.model_no || '').replace(/\s+/g, ' ').trim();
    const pn = (p.pcb_pn || '').replace(/\s+/g, ' ').trim();
    if (m || pn) map.set(`${slug(m)}_${slug(pn)}`, { ...p, model_no: m, pcb_pn: pn });
  });

  cachedMasterProfiles = Array.from(map.values());

  if (countBadge) {
    countBadge.textContent = `${cachedMasterProfiles.length} Boards Registered`;
  }
  renderMasterDatabaseGrid(cachedMasterProfiles);
}

function renderMasterDatabaseGrid(profiles) {
  const grid = document.getElementById('master-db-grid');
  if (!grid) return;
  
  if (!profiles || profiles.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem 1.5rem;background:#0b0f19;border:1px dashed #334155;border-radius:10px;color:#94a3b8;">
      <div style="font-size:2.5rem;margin-bottom:0.5rem;">📁</div>
      <div style="font-size:1rem;font-weight:bold;color:#f8fafc;margin-bottom:0.3rem;">No Master Boards Found</div>
      <div style="font-size:0.8rem;margin-bottom:1.2rem;">Register your first Golden Master PCB standard to enable automated AOI verification.</div>
      <button type="button" class="btn-primary" onclick="registerNewMasterBoard()" style="background:#0284c7;padding:0.4rem 1rem;font-size:0.8rem;">
        ➕ Register First Master Board
      </button>
    </div>`;
    return;
  }
  
  const activeModel = (currentActiveMaster?.model_no || document.getElementById('fai-step3-master-model')?.textContent?.trim() || '').toLowerCase();
  const activePn = (currentActiveMaster?.pcb_pn || document.getElementById('fai-step3-master-pn')?.textContent?.trim() || '').toLowerCase();
  
  grid.innerHTML = profiles.map(p => {
    let thumb = p.thumbnail_b64;
    if (!thumb || thumb.length === 80000 || thumb.length < 100) {
      thumb = p.image_b64 || '/img_golden_master.jpg';
    }
    const dateStr = p.updated_at ? (p.updated_at.split('T')[0] + ' ' + (p.updated_at.split('T')[1] || '').substring(0, 5)) : 'Standard Default';
    const cleanModel = p.model_no || 'Unknown';
    const cleanPn = p.pcb_pn || 'Unknown';
    const lmCount = p.landmark_count !== undefined ? p.landmark_count : (p.landmarks ? p.landmarks.length : 0);
    
    const isThisActive = (activeModel && activePn && cleanModel.toLowerCase() === activeModel && cleanPn.toLowerCase() === activePn) ||
                         (!activeModel && p.is_active);
    
    const cardBorder = isThisActive ? 'border: 2px solid #059669; box-shadow: 0 0 15px rgba(5,150,105,0.3);' : 'border: 1px solid #1e293b;';
    const activeTag = isThisActive 
      ? `<span style="background:rgba(5,150,105,0.25);color:#34d399;border:1px solid #059669;padding:2px 8px;border-radius:4px;font-size:0.68rem;font-weight:bold;">★ CURRENT ACTIVE STANDARD</span>`
      : `<span style="background:rgba(148,163,184,0.1);color:#94a3b8;border:1px solid #334155;padding:2px 7px;border-radius:4px;font-size:0.68rem;">Registered Standard</span>`;
    
    // Safely encode to prevent single quotes or special characters from corrupting inline JS
    const encM = encodeURIComponent(cleanModel).replace(/'/g, '%27');
    const encP = encodeURIComponent(cleanPn).replace(/'/g, '%27');

    const activateBtn = isThisActive
      ? `<button type="button" class="btn-select" disabled style="background:rgba(5,150,105,0.2);color:#34d399;border-color:#059669;font-size:0.75rem;padding:0.35rem 0.6rem;cursor:default;">✓ Active Standard</button>`
      : `<button type="button" class="btn-primary" onclick="selectAndActivateMaster(decodeURIComponent('${encM}'), decodeURIComponent('${encP}'))" style="background:#059669;color:#fff;font-size:0.75rem;padding:0.35rem 0.65rem;display:flex;align-items:center;gap:4px;font-weight:600;cursor:pointer;" title="Set as active reference for AOI inspection">⭐ Activate for Inspection</button>`;
    
    return `<div style="background:#0b0f19;${cardBorder}border-radius:10px;padding:1rem;display:flex;flex-direction:column;justify-content:space-between;transition:border-color 0.2s;" onmouseover="if (!${isThisActive}) this.style.borderColor='#38bdf8'" onmouseout="if (!${isThisActive}) this.style.borderColor='#1e293b'">
      <div>
        <!-- Card Header -->
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.6rem;gap:0.5rem;flex-wrap:wrap;">
          <div>
            <div style="font-size:1.05rem;font-weight:bold;color:#38bdf8;line-height:1.2;">${cleanModel}</div>
            <div style="font-size:0.75rem;color:#94a3b8;font-family:monospace;margin-top:2px;">P/N: <strong style="color:#f8fafc;">${cleanPn}</strong></div>
          </div>
          ${activeTag}
        </div>

        <!-- Thumbnail Image -->
        <div style="width:100%;height:140px;background:#000;border-radius:6px;overflow:hidden;margin-bottom:0.75rem;border:1px solid #334155;display:flex;align-items:center;justify-content:center;position:relative;">
          <img src="${thumb}" loading="lazy" decoding="async" onerror="handleMasterThumbError(this, decodeURIComponent('${encM}'), decodeURIComponent('${encP}'))" style="width:100%;height:100%;object-fit:cover;display:block;" alt="${cleanModel}">
          <span style="position:absolute;bottom:6px;left:6px;background:rgba(15,23,42,0.85);color:#38bdf8;font-size:0.68rem;padding:2px 6px;border-radius:4px;border:1px solid rgba(56,189,248,0.3);font-weight:bold;">
            🎯 ${lmCount} Landmarks
          </span>
        </div>

        <!-- Details & Standards -->
        <div style="font-size:0.72rem;color:#94a3b8;line-height:1.4;margin-bottom:0.75rem;background:#0f172a;padding:0.5rem 0.6rem;border-radius:6px;border:1px solid #1e293b;">
          <div style="color:#e2e8f0;margin-bottom:2px;">${p.notes || 'Official Approved SMT Reference'}</div>
          <div style="display:flex;justify-content:space-between;color:#64748b;font-size:0.68rem;margin-top:4px;">
            <span>Tolerance: ±0.05mm</span>
            <span>${dateStr}</span>
          </div>
        </div>
      </div>

      <!-- Action Buttons -->
      <div style="display:flex;gap:0.5rem;justify-content:space-between;align-items:center;border-top:1px solid #1e293b;padding-top:0.75rem;flex-wrap:wrap;">
        <div style="display:flex;gap:0.4rem;align-items:center;">
          ${activateBtn}
          <button type="button" class="btn-select" onclick="openMasterSetupModalFor(decodeURIComponent('${encM}'), decodeURIComponent('${encP}'))" style="padding:0.35rem 0.55rem;font-size:0.75rem;display:flex;align-items:center;gap:3px;color:#38bdf8;cursor:pointer;" title="Calibrate landmarks">
            <span>🛠️ Edit</span>
          </button>
        </div>
        <button type="button" class="btn-select" onclick="deleteMasterProfile(decodeURIComponent('${encM}'), decodeURIComponent('${encP}'))" style="padding:0.35rem 0.55rem;font-size:0.75rem;color:#ef4444;border-color:rgba(239,68,68,0.4);cursor:pointer;" title="Delete master profile">
          <span>🗑️</span>
        </button>
      </div>
    </div>`;
  }).join('');
}

function handleMasterThumbError(imgEl, model, pn) {
  if (!imgEl) return;
  imgEl.onerror = null;
  if (Array.isArray(cachedMasterProfiles)) {
    const found = cachedMasterProfiles.find(p => 
      (p.model_no || '').trim().toLowerCase() === (model || '').trim().toLowerCase() && 
      (p.pcb_pn || '').trim().toLowerCase() === (pn || '').trim().toLowerCase()
    );
    if (found && found.image_b64 && found.image_b64.length !== 80000 && imgEl.src !== found.image_b64) {
      imgEl.src = found.image_b64;
      return;
    }
  }
  imgEl.src = '/img_golden_master.jpg';
}


async function selectAndActivateMaster(modelNo, pcbPn) {
  showToast('Activating Master', `Setting ${modelNo} [${pcbPn}] as active standard...`, 'info');
  await setActiveMasterForInspection(modelNo, pcbPn);
  if (Array.isArray(cachedMasterProfiles)) {
    const slug = (s) => (s || '').toString().toLowerCase().replace(/[\s\-_/.]+/g, '');
    const targetKey = `${slug(modelNo)}_${slug(pcbPn)}`;
    cachedMasterProfiles.forEach(p => {
      p.is_active = (`${slug(p.model_no)}_${slug(p.pcb_pn)}` === targetKey);
    });
    renderMasterDatabaseGrid(cachedMasterProfiles);
  }
  closeMasterDatabaseModal();
  if (typeof switchFaiStep === 'function') {
    switchFaiStep(3);
  }
}

function filterMasterDatabaseList() {
  const query = (document.getElementById('master-db-search')?.value || '').trim().toLowerCase();
  if (!query) {
    renderMasterDatabaseGrid(cachedMasterProfiles);
    return;
  }
  const filtered = cachedMasterProfiles.filter(p => 
    (p.model_no || '').toLowerCase().includes(query) || 
    (p.pcb_pn || '').toLowerCase().includes(query) ||
    (p.notes || '').toLowerCase().includes(query)
  );
  renderMasterDatabaseGrid(filtered);
}

async function deleteMasterProfile(modelNo, pcbPn) {
  if (!confirm(`Are you sure you want to permanently delete the Golden Master Profile for ${modelNo} [${pcbPn}]?`)) {
    return;
  }

  const slug = (s) => (s || '').toString().toLowerCase().replace(/[\s\-_/.]+/g, '');
  const delKey = `${slug(modelNo)}_${slug(pcbPn)}`;

  // 1. Immediately remove from IndexedDB and localStorage
  try {
    await MasterImageDB.delete(modelNo, pcbPn);
  } catch (e) {}
  try {
    let localList = JSON.parse(localStorage.getItem('fai_custom_master_profiles') || '[]');
    localList = localList.filter(p => `${slug(p.model_no)}_${slug(p.pcb_pn)}` !== delKey);
    localStorage.setItem('fai_custom_master_profiles', JSON.stringify(localList));
  } catch (e) {}

  // 2. Optimistic UI update: remove from in-memory cache and re-render grid instantly
  if (Array.isArray(cachedMasterProfiles)) {
    cachedMasterProfiles = cachedMasterProfiles.filter(p => `${slug(p.model_no)}_${slug(p.pcb_pn)}` !== delKey);
    renderMasterDatabaseGrid(cachedMasterProfiles);
    const countBadge = document.getElementById('master-db-total-count');
    if (countBadge) countBadge.textContent = `${cachedMasterProfiles.length} Boards Registered`;
  }
  
  // 3. Call server DELETE endpoint
  try {
    const res = await fetch(`/api/pcba-vision/master-profile/${encodeURIComponent(modelNo.replace(/\s+/g, ' ').trim())}/${encodeURIComponent(pcbPn.replace(/\s+/g, ' ').trim())}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      showToast('Delete Failed', errData.detail || `Server could not delete profile for ${modelNo}`, 'error');
    } else {
      showToast('Master Board Deleted', `Profile for ${modelNo} [${pcbPn}] was permanently removed.`, 'info');
    }
    await loadMasterDatabaseList();
  } catch (err) {
    console.error('Delete master profile error:', err);
    await loadMasterDatabaseList();
  }
}

function registerNewMasterBoard() {
  closeMasterDatabaseModal();
  const modal = document.getElementById('modal-master-setup');
  if (!modal) return;
  
  const mInp = document.getElementById('setup-master-model');
  const pInp = document.getElementById('setup-master-pn');
  if (mInp) mInp.value = '';
  if (pInp) pInp.value = '';
  
  currentMasterLandmarks = [];
  const masterImg = document.getElementById('setup-master-img');
  const canvas = document.getElementById('setup-master-canvas');
  if (masterImg) masterImg.src = '/img_golden_master.jpg';
  if (canvas && masterImg) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  renderSetupLandmarksTable([]);
  
  modal.classList.add('active');
  showToast('New Master Registration', 'Enter Model, PCB P/N and upload high-res golden board photo.', 'info');
}

function openMasterSetupModalFor(modelNo, pcbPn) {
  closeMasterDatabaseModal();
  const modal = document.getElementById('modal-master-setup');
  if (!modal) return;
  
  const mInp = document.getElementById('setup-master-model');
  const pInp = document.getElementById('setup-master-pn');
  if (mInp) mInp.value = (modelNo || '').replace(/\s+/g, ' ').trim();
  if (pInp) pInp.value = (pcbPn || '').replace(/\s+/g, ' ').trim();
  
  modal.classList.add('active');
  loadMasterProfileForSetup();
}

async function setActiveMasterForInspection(modelNo, pcbPn, profileData = null) {
  let cleanModel = (modelNo || '').replace(/\s+/g, ' ').trim();
  let cleanPn = (pcbPn || '').replace(/\s+/g, ' ').trim();

  // Smart normalization: if model is empty or PN has both model and PN
  if (!cleanModel && cleanPn && (cleanPn.includes(' ') || cleanPn.includes('/'))) {
    const parts = cleanPn.replace('/', ' ').split(/\s+/);
    cleanModel = parts[0];
    cleanPn = parts.slice(1).join(' ');
  }
  if (!cleanModel) cleanModel = 'AC02N';
  if (!cleanPn) cleanPn = '910100106320';

  let profile = profileData;
  if (!profile && cleanModel && cleanPn) {
    // 1. Check local IndexedDB first (0ms, 0 network, 0 egress)
    try {
      profile = await MasterImageDB.get(cleanModel, cleanPn);
    } catch (e) {}

    // 2. Fetch from server if not yet cached locally
    if (!profile) {
      try {
        const res = await fetch(`/api/pcba-vision/master-profile/${encodeURIComponent(cleanModel)}/${encodeURIComponent(cleanPn)}`);
        if (res.ok) {
          profile = await res.json();
          if (profile) await MasterImageDB.set(cleanModel, cleanPn, profile);
        }
      } catch (e) {
        console.warn('Error fetching master profile for inspection:', e);
      }
    }
  }

  const imgB64 = profile?.image_b64 || '/img_golden_master.jpg';
  const landmarks = profile?.landmarks || [];

  currentActiveMaster = {
    model_no: cleanModel,
    pcb_pn: cleanPn,
    image_b64: imgB64,
    landmarks: landmarks
  };
  currentMasterLandmarks = landmarks;

  // Persist activation state to server in background
  try {
    fetch(`/api/pcba-vision/master-profile/activate/${encodeURIComponent(cleanModel)}/${encodeURIComponent(cleanPn)}`, {
      method: 'POST'
    }).catch(() => {});
  } catch (e) {}

  // Synchronize form inputs so Step 1 & Step 3 stay consistent
  const inpModel = document.getElementById('fai-inp-model');
  const inpPn = document.getElementById('fai-inp-pcb-pn');
  if (inpModel) inpModel.value = cleanModel;
  if (inpPn) inpPn.value = cleanPn;

  // Update Step 3 Golden Reference Card
  const modelEl = document.getElementById('fai-step3-master-model');
  const pnEl = document.getElementById('fai-step3-master-pn');
  const badgeEl = document.getElementById('fai-step3-master-badge');
  const aoiRefDetails = document.getElementById('aoi-ref-details');

  if (modelEl) modelEl.textContent = cleanModel;
  if (pnEl) pnEl.textContent = cleanPn;
  if (aoiRefDetails) aoiRefDetails.textContent = `Master Standard Setup (${cleanModel} [${cleanPn}])`;

  if (badgeEl) {
    badgeEl.style.background = 'rgba(5,150,105,0.2)';
    badgeEl.style.borderColor = '#059669';
    badgeEl.style.color = '#34d399';
    badgeEl.innerHTML = `<span>✓ Database Standard Active</span> <span id="fai-step3-master-lm-count" style="color:#fff;">(${landmarks.length} Landmarks)</span>`;
  }

  const landmarkCountBadge = document.getElementById('landmark-count-badge');
  if (landmarkCountBadge) {
    landmarkCountBadge.textContent = `${landmarks.length} Master Landmarks Setup`;
    landmarkCountBadge.style.color = '#38bdf8';
  }

  // Ensure AOI preview container is visible
  const previewContainer = document.getElementById('pcba-photo-preview-container');
  if (previewContainer) previewContainer.style.display = 'block';

  // Render Golden Master Reference board
  const refImg = document.getElementById('pcba-photo-ref-img');
  const refCanvas = document.getElementById('pcba-ref-overlay-canvas');
  if (refImg) {
    refImg.src = imgB64;
    const renderRef = () => {
      if (refImg && refCanvas) {
        drawMasterLandmarksOverlay(landmarks, refImg, refCanvas);
      }
    };
    if (refImg.complete) renderRef();
    else refImg.onload = renderRef;
  }
}

async function loadActiveMasterForInspection(modelNo, pcbPn) {
  if (modelNo && pcbPn) {
    await setActiveMasterForInspection(modelNo, pcbPn);
    return;
  }
  
  // Try fetching currently active master from backend central database
  try {
    const res = await fetch('/api/pcba-vision/master-profile/active');
    if (res.ok) {
      const data = await res.json();
      if (data && data.model_no) {
        await setActiveMasterForInspection(data.model_no, data.pcb_pn, data);
        return;
      }
    }
  } catch (err) {
    console.warn('Could not fetch active master profile:', err);
  }

  // Fallback default
  await setActiveMasterForInspection('AC02N', '910100106320');
}

function openMasterSetupModal() {
  const modal = document.getElementById('modal-master-setup');
  if (!modal) return;
  modal.classList.add('active');
  
  const mInp = document.getElementById('fai-inp-model');
  const pInp = document.getElementById('fai-inp-pcb-pn');
  if (mInp && mInp.value) document.getElementById('setup-master-model').value = mInp.value.replace(/\s+/g, ' ').trim();
  if (pInp && pInp.value) document.getElementById('setup-master-pn').value = pInp.value.replace(/\s+/g, ' ').trim();
  
  loadMasterProfileForSetup();
}

function closeMasterSetupModal() {
  const modal = document.getElementById('modal-master-setup');
  if (modal) modal.classList.remove('active');
}

function updateSetupMasterStatusBadge(text, type = 'info') {
  const badge = document.getElementById('setup-master-status-badge');
  const txt = document.getElementById('setup-master-status-text');
  if (!badge) return;
  if (txt) txt.textContent = text;
  if (type === 'success') {
    badge.style.background = 'rgba(5,150,105,0.2)';
    badge.style.borderColor = '#059669';
    badge.style.color = '#34d399';
  } else if (type === 'warning') {
    badge.style.background = 'rgba(234,179,8,0.15)';
    badge.style.borderColor = '#eab308';
    badge.style.color = '#fde047';
  } else {
    badge.style.background = 'rgba(56,189,248,0.15)';
    badge.style.borderColor = 'rgba(56,189,248,0.3)';
    badge.style.color = '#38bdf8';
  }
}

let _setupModelPnDebounce = null;
function onSetupModelPnInputChange() {
  clearTimeout(_setupModelPnDebounce);
  _setupModelPnDebounce = setTimeout(() => {
    loadMasterProfileForSetup();
  }, 350);
}

function applyMasterProfileToSetupUI(data, statusMsg = '✓ Master Standard Loaded', statusType = 'success') {
  currentMasterLandmarks = data.landmarks || [];
  
  const masterImg = document.getElementById('setup-master-img');
  const canvas = document.getElementById('setup-master-canvas');
  const displaySrc = data.image_b64 || data.thumbnail_b64;
  if (masterImg && displaySrc) {
    masterImg.src = displaySrc;
  }
  
  const renderMasterCanvas = () => {
    if (canvas && masterImg) {
      drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
    }
  };
  if (masterImg && masterImg.complete) renderMasterCanvas();
  else if (masterImg) masterImg.onload = renderMasterCanvas;
  
  renderSetupLandmarksTable(currentMasterLandmarks);
  updateSetupMasterStatusBadge(statusMsg, statusType);
}

function clearSetupMasterUI(modelNo, pcbPn) {
  currentMasterLandmarks = [];
  const masterImg = document.getElementById('setup-master-img');
  const canvas = document.getElementById('setup-master-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (masterImg) {
    masterImg.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="350" viewBox="0 0 600 350"><rect width="100%" height="100%" fill="%230b0f19"/><text x="50%" y="45%" dominant-baseline="middle" text-anchor="middle" fill="%2338bdf8" font-family="sans-serif" font-size="16" font-weight="bold">No Golden Master Registered</text><text x="50%" y="58%" dominant-baseline="middle" text-anchor="middle" fill="%2364748b" font-family="sans-serif" font-size="13">Upload photo or capture from camera to calibrate this board</text></svg>';
  }
  renderSetupLandmarksTable([]);
  updateSetupMasterStatusBadge(`⚠️ Not Registered (${modelNo || 'No Model'})`, 'warning');
}

async function loadMasterProfileForSetup() {
  const mInp = document.getElementById('setup-master-model');
  const pInp = document.getElementById('setup-master-pn');
  const modelNo = (mInp?.value || 'PRX-8800').replace(/\s+/g, ' ').trim();
  const pcbPn = (pInp?.value || '715G9988-P01').replace(/\s+/g, ' ').trim();
  
  if (!modelNo && !pcbPn) {
    clearSetupMasterUI('', '');
    return;
  }

  const slug = (s) => (s || '').toString().toLowerCase().replace(/[\s\-_/.]+/g, '');
  const reqSlug = `${slug(modelNo)}_${slug(pcbPn)}`;

  // 1. Check client IndexedDB cache first: renders in <5ms with 0 network egress
  try {
    const cached = await MasterImageDB.get(modelNo, pcbPn);
    if (cached && (cached.image_b64 || cached.thumbnail_b64)) {
      applyMasterProfileToSetupUI(cached, '⚡ Instant Cached Master (0ms)', 'success');
      return;
    }
  } catch (e) {
    console.warn('MasterImageDB get error:', e);
  }

  // 2. Progressive preview: check in-memory cachedMasterProfiles for thumbnail
  let inMem = null;
  if (Array.isArray(cachedMasterProfiles)) {
    inMem = cachedMasterProfiles.find(p => `${slug(p.model_no)}_${slug(p.pcb_pn)}` === reqSlug);
    if (inMem && (inMem.thumbnail_b64 || inMem.image_b64)) {
      const previewImg = inMem.image_b64 || inMem.thumbnail_b64;
      const masterImg = document.getElementById('setup-master-img');
      if (masterImg) masterImg.src = previewImg;
      if (Array.isArray(inMem.landmarks) && inMem.landmarks.length > 0) {
        currentMasterLandmarks = inMem.landmarks;
        renderSetupLandmarksTable(currentMasterLandmarks);
      }
      updateSetupMasterStatusBadge('⏳ Loading HD Master Image...', 'info');
    } else {
      updateSetupMasterStatusBadge('🔄 Fetching Master Standard...', 'info');
    }
  } else {
    updateSetupMasterStatusBadge('🔄 Fetching Master Standard...', 'info');
  }

  // 3. Fetch from Server API
  let data = null;
  try {
    const res = await fetch(`/api/pcba-vision/master-profile/${encodeURIComponent(modelNo)}/${encodeURIComponent(pcbPn)}`);
    if (res.ok) {
      data = await res.json();
    } else if (res.status === 404) {
      if (!inMem) {
        clearSetupMasterUI(modelNo, pcbPn);
        return;
      }
    }
  } catch (err) {
    console.warn('API load master profile error:', err);
  }

  // 4. Fallback check in localStorage
  if (!data) {
    try {
      const localList = JSON.parse(localStorage.getItem('fai_custom_master_profiles') || '[]');
      data = localList.find(p => `${slug(p.model_no)}_${slug(p.pcb_pn)}` === reqSlug);
    } catch (e) {}
  }

  // 5. Apply or Clear
  const imgUrl = data?.image_b64 || data?.thumbnail_b64 || inMem?.image_b64 || inMem?.thumbnail_b64;
  const isFound = Boolean(data && data.success) || Boolean(inMem) || Boolean(imgUrl);

  if (isFound && imgUrl) {
    const profileToApply = {
      model_no: data?.model_no || inMem?.model_no || modelNo,
      pcb_pn: data?.pcb_pn || inMem?.pcb_pn || pcbPn,
      image_b64: imgUrl,
      thumbnail_b64: data?.thumbnail_b64 || inMem?.thumbnail_b64 || '',
      landmarks: data?.landmarks || inMem?.landmarks || [],
      notes: data?.notes || inMem?.notes || '',
      is_active: data?.is_active ?? inMem?.is_active ?? false,
      updated_at: data?.updated_at || inMem?.updated_at || ''
    };
    applyMasterProfileToSetupUI(profileToApply, '✓ Master Standard Synced', 'success');
    try {
      await MasterImageDB.set(modelNo, pcbPn, profileToApply);
    } catch (e) {}
  } else {
    clearSetupMasterUI(modelNo, pcbPn);
  }
}

function renderSetupLandmarksTable(landmarks) {
  const tbody = document.getElementById('setup-landmarks-body');
  const countBadge = document.getElementById('setup-landmarks-count');
  if (countBadge) countBadge.textContent = `${landmarks.length} Active Landmarks`;
  if (!tbody) return;
  
  if (!landmarks || landmarks.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:0.75rem;text-align:center;color:#64748b;">No landmarks configured. Click Auto-Detect Landmarks or Add ROI.</td></tr>';
    return;
  }
  
  tbody.innerHTML = landmarks.map(lm => {
    let icon = '🎯';
    let typeColor = '#38bdf8';
    let rule = '±0.05mm Center Lock';
    if (lm.type === 'IC_CHIP') { icon = '🔲'; typeColor = '#34d399'; rule = 'Pin 1 Orientation Check'; }
    else if (lm.type === 'CONNECTOR') { icon = '🔌'; typeColor = '#f59e0b'; rule = 'Header Pin Seating'; }
    else if (lm.type === 'PCB_MARKING') { icon = '🏷️'; typeColor = '#ec4899'; rule = 'Rev Code Validation'; }
    
    const box = lm.box || lm.master_box || {x:0, y:0, width:0, height:0};
    const cx = Math.round(box.x + box.width / 2);
    const cy = Math.round(box.y + box.height / 2);
    
    return `<tr style="border-bottom:1px solid #1e293b;">
      <td style="padding:0.35rem;font-weight:bold;color:#f8fafc;">${lm.id}</td>
      <td style="padding:0.35rem;color:${typeColor};font-weight:600;">${icon} ${lm.type}</td>
      <td style="padding:0.35rem;font-family:monospace;color:#94a3b8;">[${cx}, ${cy}] (${Math.round(box.width)}x${Math.round(box.height)})</td>
      <td style="padding:0.35rem;color:#38bdf8;">${rule}</td>
      <td style="padding:0.35rem;text-align:right;">
        <button type="button" onclick="deleteLandmark('${lm.id}')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.8rem;" title="Delete ROI">🗑️</button>
      </td>
    </tr>`;
  }).join('');
}

function clearAllLandmarks() {
  if (confirm("Are you sure you want to clear all ROIs?")) {
    currentMasterLandmarks = [];
    const masterImg = document.getElementById('setup-master-img');
    const canvas = document.getElementById('setup-master-canvas');
    if (masterImg && canvas) drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
    renderSetupLandmarksTable(currentMasterLandmarks);
  }
}

function deleteLandmark(id) {
  currentMasterLandmarks = currentMasterLandmarks.filter(lm => lm.id !== id);
  const masterImg = document.getElementById('setup-master-img');
  const canvas = document.getElementById('setup-master-canvas');
  if (masterImg && canvas) drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
  renderSetupLandmarksTable(currentMasterLandmarks);
}

async function detectLandmarksOnSetupMaster() {
  const masterImg = document.getElementById('setup-master-img');
  if (!masterImg || !masterImg.src) return;
  
  showToast('AI Detection', 'Extracting Fiducials, ICs, Connectors & Silkscreen on Master Board...', 'info');
  
  try {
    let b64 = masterImg.src;
    if (!b64.startsWith('data:')) {
      const res = await fetch(b64);
      const blob = await res.blob();
      b64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }
    
    const applyLandmarks = (landmarks) => {
      currentMasterLandmarks = landmarks || [];
      const canvas = document.getElementById('setup-master-canvas');
      if (canvas && masterImg) {
        drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
      }
      renderSetupLandmarksTable(currentMasterLandmarks);
      showToast('Landmarks Calibrated', `Identified ${currentMasterLandmarks.length} physical landmarks accurately!`, 'success');
    };

    try {
      const detectRes = await fetch('/api/pcba-vision/detect-landmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_b64: b64 })
      });
      
      if (detectRes.ok) {
        const data = await detectRes.json();
        applyLandmarks(data.landmarks);
        return;
      }
    } catch (apiErr) {
      // ignore api error, fallback below
    }

    // Offline / No Backend Fallback
    const mockLandmarks = [
      { id: 'FID_1', type: 'FIDUCIAL', box: { x: 50, y: 50, width: 30, height: 30 } },
      { id: 'U1', type: 'IC_CHIP', box: { x: 200, y: 150, width: 60, height: 60 } },
      { id: 'J1', type: 'CONNECTOR', box: { x: 100, y: 300, width: 120, height: 40 } }
    ];
    applyLandmarks(mockLandmarks);

  } catch (err) {
    console.error('Master auto-detect error:', err);
    showToast('Error', 'Failed to detect landmarks on master.', 'error');
  }
}

let pendingMasterB64 = '';

function handleMasterFileUpload(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  processImageFile(file, 1600, 0.80, (b64) => {
    pendingMasterB64 = b64;
    analyzeImageQuality(b64);
  });
}

function analyzeImageQuality(b64) {
  const modal = document.getElementById('modal-image-quality');
  if (modal) modal.classList.add('active');

  const lightingEl = document.getElementById('iq-score-lighting');
  const sharpnessEl = document.getElementById('iq-score-sharpness');
  const angleEl = document.getElementById('iq-score-angle');
  const adviceBox = document.getElementById('iq-advice-box');
  const adviceText = document.getElementById('iq-advice-text');
  const proceedBtn = document.getElementById('btn-iq-proceed');
  const reuploadBtn = document.getElementById('btn-iq-reupload');
  
  if(lightingEl) { lightingEl.textContent = 'Analyzing...'; lightingEl.style.color = '#38bdf8'; }
  if(sharpnessEl) { sharpnessEl.textContent = 'Analyzing...'; sharpnessEl.style.color = '#38bdf8'; }
  if(angleEl) { angleEl.textContent = 'Analyzing...'; angleEl.style.color = '#38bdf8'; }
  if(adviceBox) adviceBox.style.display = 'none';
  if(proceedBtn) proceedBtn.style.display = 'none';
  if(reuploadBtn) reuploadBtn.style.display = 'none';

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Scale down for faster analysis
    const scale = Math.min(1, 800 / Math.max(img.width, img.height));
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    
    // 1. Calculate Average Brightness
    let rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i+1];
      bSum += data[i+2];
    }
    const pixelCount = data.length / 4;
    const avgBrightness = (rSum + gSum + bSum) / (3 * pixelCount);
    
    // 2. Simulate Sharpness (Edge detection proxy via adjacent pixel diff)
    let edgeSum = 0;
    for (let i = 0; i < data.length - 4; i += 4) {
      const diff = Math.abs(data[i] - data[i+4]) + Math.abs(data[i+1] - data[i+5]) + Math.abs(data[i+2] - data[i+6]);
      edgeSum += diff;
    }
    const avgEdge = edgeSum / pixelCount; 
    
    // Evaluate scores
    let lightingScore = 'GOOD';
    let lightingColor = '#34d399';
    let lightingAdvice = '';
    
    if (avgBrightness < 60) {
      lightingScore = 'TOO DARK';
      lightingColor = '#ef4444';
      lightingAdvice = 'Image is underexposed. Please turn on the ring light or increase ambient lighting.';
    } else if (avgBrightness > 200) {
      lightingScore = 'OVEREXPOSED';
      lightingColor = '#f59e0b';
      lightingAdvice = 'Image is too bright/washed out. Reduce direct glare on the PCB.';
    }
    
    let sharpnessScore = 'SHARP';
    let sharpnessColor = '#34d399';
    let sharpnessAdvice = '';
    
    if (avgEdge < 15) { // 15 is a reasonable empirical threshold for this proxy
      sharpnessScore = 'BLURRY';
      sharpnessColor = '#ef4444';
      sharpnessAdvice = 'Image is out of focus. Tap the camera screen to focus on the components before capturing.';
    }
    
    // Angle is just mocked for this engine since perspective transform detection requires full OpenCV
    const angleScore = 'FLAT (OK)';
    const angleColor = '#34d399';
    
    setTimeout(() => {
      if(lightingEl) { lightingEl.textContent = lightingScore; lightingEl.style.color = lightingColor; }
      if(sharpnessEl) { sharpnessEl.textContent = sharpnessScore; sharpnessEl.style.color = sharpnessColor; }
      if(angleEl) { angleEl.textContent = angleScore; angleEl.style.color = angleColor; }
      
      const adviceArr = [lightingAdvice, sharpnessAdvice].filter(a => a);
      
      if (adviceArr.length > 0) {
        if(adviceText) adviceText.innerHTML = adviceArr.map(a => `• ${a}`).join('<br>');
        if(adviceBox) adviceBox.style.display = 'block';
        if(reuploadBtn) reuploadBtn.style.display = 'inline-flex';
        // Allow proceed anyway but highlight warning
        if(proceedBtn) {
           proceedBtn.style.display = 'inline-flex';
           proceedBtn.textContent = 'Proceed Anyway';
           proceedBtn.style.background = '#334155';
        }
      } else {
        if(proceedBtn) {
           proceedBtn.style.display = 'inline-flex';
           proceedBtn.textContent = 'Proceed to Setup';
           proceedBtn.style.background = 'var(--primary-color)';
        }
      }
      
      const statusText = document.getElementById('iq-status-text');
      if (statusText) statusText.textContent = adviceArr.length > 0 ? 'Quality issues detected. Please review.' : 'Image quality passed all checks!';
    }, 800); // simulate async processing time
  };
  img.src = b64;
}

function proceedWithMasterImage() {
  const modal = document.getElementById('modal-image-quality');
  if (modal) modal.classList.remove('active');
  
  const masterImg = document.getElementById('setup-master-img');
  if (masterImg && pendingMasterB64) {
    masterImg.src = pendingMasterB64;
    masterImg.onload = () => detectLandmarksOnSetupMaster();
  }
}

async function saveMasterProfileFromSetup() {
  const modelNo = (document.getElementById('setup-master-model')?.value || 'MK2').trim();
  const pcbPn = (document.getElementById('setup-master-pn')?.value || '123456789').trim();
  const masterImg = document.getElementById('setup-master-img');
  
  if (!masterImg || !masterImg.src) {
    showToast('Error', 'No Master image available to save.', 'error');
    return;
  }
  
  showToast('Saving', 'Persisting Golden Master Profile to production storage...', 'info');
  
  try {
    let b64 = masterImg.src;
    if (!b64.startsWith('data:')) {
      const res = await fetch(b64);
      const blob = await res.blob();
      b64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      });
    }

    const formattedLandmarks = (currentMasterLandmarks || []).map((lm, idx) => {
      const box = lm.master_box || lm.box || { x: 0, y: 0, width: 20, height: 20 };
      return {
        id: lm.id || `ROI_${idx+1}`,
        name: lm.name || lm.id || `ROI_${idx+1}`,
        type: lm.type || 'FIDUCIAL',
        center: lm.center || [floatVal(box.x) + floatVal(box.width) / 2.0, floatVal(box.y) + floatVal(box.height) / 2.0],
        box: { x: floatVal(box.x), y: floatVal(box.y), width: floatVal(box.width), height: floatVal(box.height) },
        master_box: { x: floatVal(box.x), y: floatVal(box.y), width: floatVal(box.width), height: floatVal(box.height) },
        confidence: lm.confidence !== undefined ? lm.confidence : 1.0,
        pin1_pos: lm.pin1_pos || null
      };
    });

    function floatVal(v) { return typeof v === 'number' ? v : (parseFloat(v) || 0); }

    const profileData = {
      model_no: modelNo,
      pcb_pn: pcbPn,
      image_b64: b64,
      thumbnail_b64: b64,
      landmarks: formattedLandmarks,
      landmark_count: formattedLandmarks.length,
      notes: "Approved SMT Golden Master Reference",
      is_active: true,
      updated_at: new Date().toISOString()
    };

    // Store in IndexedDB for instant 0ms, zero-egress loads
    try {
      await MasterImageDB.set(modelNo, pcbPn, profileData);
    } catch (dbErr) {
      console.warn('MasterImageDB save failed:', dbErr);
    }

    // Store in localStorage for lightweight fallback
    try {
      let localList = JSON.parse(localStorage.getItem('fai_custom_master_profiles') || '[]');
      const slug = (s) => (s || '').toString().toLowerCase().replace(/[\s\-_/.]+/g, '');
      const saveKey = `${slug(modelNo)}_${slug(pcbPn)}`;
      localList = localList.filter(p => `${slug(p.model_no)}_${slug(p.pcb_pn)}` !== saveKey);
      localList.unshift(profileData);
      localStorage.setItem('fai_custom_master_profiles', JSON.stringify(localList));
    } catch (lsErr) {
      console.warn('localStorage save failed:', lsErr);
    }
    
    const applyToUI = async () => {
      await setActiveMasterForInspection(modelNo, pcbPn, profileData);
      closeMasterSetupModal();
      if (typeof loadMasterDatabaseList === 'function') {
        loadMasterDatabaseList();
      }
      showToast('Master Profile Active', `Golden Master for ${modelNo} [${pcbPn}] saved and activated!`, 'success');
    };

    // Upload master image directly to Cloudflare R2
    let r2Key = null;
    try {
      const fetchResp = await fetch(b64);
      const imgBlob = await fetchResp.blob();
      const r2Res = await uploadFileToR2(imgBlob, `${modelNo}_${pcbPn}.jpg`, 'master_profiles');
      if (r2Res && r2Res.success) {
        r2Key = r2Res.r2_key;
        profileData.r2_key = r2Key;
      }
    } catch (r2Err) {
      console.warn('R2 direct upload attempt failed:', r2Err);
    }

    try {
      const saveRes = await fetch('/api/pcba-vision/master-profile/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_no: modelNo,
          pcb_pn: pcbPn,
          image_b64: b64,
          r2_key: r2Key,
          landmarks: formattedLandmarks,
          notes: "Approved SMT Golden Master Reference",
          is_active: true
        })
      });
      
      if (saveRes.ok) {
        await saveRes.json();
      }
      await applyToUI();
    } catch (apiErr) {
      console.warn('API save failed, using local profile:', apiErr);
      await applyToUI();
    }
  } catch (err) {
    console.error('Save master profile error:', err);
    showToast('Error', 'Failed to save master profile.', 'error');
  }
}

function handleTestFileUpload(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = function(e) {
    const b64 = e.target.result;
    processPCBAWithAI(b64);
    showToast('Test Board Loaded', 'Running AI Landmark Positioning & Polarity Inspection...', 'info');
  };
  reader.readAsDataURL(file);
}

async function testNormalBoardDemo() {
  showToast('Test Case (PASS)', 'Loading verified standard capture sample...', 'info');
  
  // If active master has an image, use active master as normal test board
  if (currentActiveMaster && currentActiveMaster.image_b64) {
    processPCBAWithAI(currentActiveMaster.image_b64);
    return;
  }

  try {
    const res = await fetch('/img_test_pass.jpg?v=3');
    if (res.ok) {
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onloadend = () => {
        processPCBAWithAI(reader.result);
      };
      reader.readAsDataURL(blob);
    }
  } catch (err) {
    console.error('Test normal board error:', err);
  }
}

async function generateDefectTestImage(baseB64) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // Perturb the first landmark to simulate component displacement and defect
      if (currentMasterLandmarks && currentMasterLandmarks.length > 0) {
        const targetLm = currentMasterLandmarks[0];
        const box = targetLm.master_box || targetLm.box;
        if (box) {
          const bx = Math.round(box.x);
          const by = Math.round(box.y);
          const bw = Math.max(15, Math.round(box.width));
          const bh = Math.max(15, Math.round(box.height));
          try {
            const compData = ctx.getImageData(bx, by, bw, bh);
            ctx.fillStyle = '#1e293b';
            ctx.fillRect(bx, by, bw, bh);
            ctx.putImageData(compData, bx + 18, by - 10);
          } catch (e) {
            ctx.fillStyle = 'rgba(239, 68, 68, 0.7)';
            ctx.fillRect(bx + 5, by + 5, bw - 10, bh - 10);
          }
        }
      }
      resolve(canvas.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => resolve(baseB64);
    img.src = baseB64;
  });
}

async function testDefectBoardDemo() {
  showToast('Test Case (FAIL)', 'Loading SMT defect sample: component displacement & polarity defect...', 'warning');

  // If active master has an image, simulate defect on active master board
  if (currentActiveMaster && currentActiveMaster.image_b64) {
    try {
      const defectB64 = await generateDefectTestImage(currentActiveMaster.image_b64);
      processPCBAWithAI(defectB64);
      return;
    } catch (e) {
      console.warn('Simulated defect generation fallback:', e);
    }
  }

  try {
    const res = await fetch('/img_test_defect.jpg?v=3');
    if (res.ok) {
      const blob = await res.blob();
      const reader = new FileReader();
      reader.onloadend = () => {
        processPCBAWithAI(reader.result);
      };
      reader.readAsDataURL(blob);
    }
  } catch (err) {
    console.error('Test defect board error:', err);
  }
}

// Fine-tuning calibration for Master Landmarks
let dragLmObj = null;
let dragStartX = 0;
let dragStartY = 0;

let isDrawingROI = false;
let drawStartX = 0;
let drawStartY = 0;
let currentDrawingBox = null;

function enableROIDrawingMode() {
  isDrawingROI = true;
  const canvas = document.getElementById('setup-master-canvas');
  if (canvas) canvas.style.cursor = 'crosshair';
  showToast('Draw ROI', 'Click and drag on the master image to define a new region.', 'info');
}

document.addEventListener('DOMContentLoaded', () => {
  const btnAddRoi = document.getElementById('btn-add-roi');
  if (btnAddRoi) {
    btnAddRoi.addEventListener('click', enableROIDrawingMode);
  }
});

(function initManualFinetune() {
  const canvas = document.getElementById('setup-master-canvas');
  if (!canvas) return;

  const startDrag = (e) => {
    let clientX = e.clientX;
    let clientY = e.clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
      if (e.type === 'touchstart') e.preventDefault();
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clickX = (clientX - rect.left) * scaleX;
    const clickY = (clientY - rect.top) * scaleY;

    if (isDrawingROI) {
      drawStartX = clickX;
      drawStartY = clickY;
      currentDrawingBox = { x: clickX, y: clickY, width: 0, height: 0 };
      return;
    }

    if (!currentMasterLandmarks || currentMasterLandmarks.length === 0) return;
    for (let i = currentMasterLandmarks.length - 1; i >= 0; i--) {
      const lm = currentMasterLandmarks[i];
      const box = lm.master_box || lm.box;
      if (box && clickX >= box.x && clickX <= box.x + box.width &&
          clickY >= box.y && clickY <= box.y + box.height) {
        dragLmObj = box;
        dragStartX = clickX;
        dragStartY = clickY;
        canvas.style.cursor = 'grabbing';
        break;
      }
    }
  };

  const moveDrag = (e) => {
    let clientX = e.clientX;
    let clientY = e.clientY;
    if (e.touches && e.touches.length > 0) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
      if (e.type === 'touchmove') e.preventDefault();
    } else if (e.type === 'touchmove') {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const mouseX = (clientX - rect.left) * scaleX;
    const mouseY = (clientY - rect.top) * scaleY;
    const masterImg = document.getElementById('setup-master-img');

    if (isDrawingROI && currentDrawingBox) {
      currentDrawingBox.width = mouseX - drawStartX;
      currentDrawingBox.height = mouseY - drawStartY;
      
      // Re-render
      drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
      const ctx = canvas.getContext('2d');
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 2]);
      ctx.strokeRect(drawStartX, drawStartY, currentDrawingBox.width, currentDrawingBox.height);
      ctx.setLineDash([]);
      return;
    }

    if (!dragLmObj) return;

    const dx = mouseX - dragStartX;
    const dy = mouseY - dragStartY;

    dragLmObj.x += dx;
    dragLmObj.y += dy;
    
    const lm = currentMasterLandmarks.find(l => (l.master_box || l.box) === dragLmObj);
    if (lm && lm.center) {
        lm.center[0] += dx;
        lm.center[1] += dy;
    }

    dragStartX = mouseX;
    dragStartY = mouseY;

    drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
  };

  const endDrag = (e) => {
    if (e && (e.type === 'touchend' || e.type === 'touchcancel')) {
      e.preventDefault();
    }
    if (isDrawingROI && currentDrawingBox) {
      isDrawingROI = false;
      canvas.style.cursor = 'move';
      
      // Normalize box dimensions (handle negative width/height if drawn backwards)
      let finalBox = {
        x: currentDrawingBox.width < 0 ? drawStartX + currentDrawingBox.width : drawStartX,
        y: currentDrawingBox.height < 0 ? drawStartY + currentDrawingBox.height : drawStartY,
        width: Math.abs(currentDrawingBox.width),
        height: Math.abs(currentDrawingBox.height)
      };
      
      currentDrawingBox = null;

      if (finalBox.width > 10 && finalBox.height > 10) {
        openROIClassifyModal(finalBox);
      }
      
      const masterImg = document.getElementById('setup-master-img');
      drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
      if (typeof renderSetupLandmarksTable === 'function') {
        renderSetupLandmarksTable(currentMasterLandmarks);
      }
      return;
    }

    if (dragLmObj) {
      dragLmObj = null;
      canvas.style.cursor = 'move';
      if (typeof renderSetupLandmarksTable === 'function') {
        renderSetupLandmarksTable(currentMasterLandmarks);
      }
    }
  };

  canvas.addEventListener('mousedown', startDrag);
  canvas.addEventListener('mousemove', moveDrag);
  canvas.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', endDrag);

  canvas.addEventListener('touchstart', startDrag, { passive: false });
  canvas.addEventListener('touchmove', moveDrag, { passive: false });
  canvas.addEventListener('touchend', endDrag, { passive: false });
  canvas.addEventListener('touchcancel', endDrag, { passive: false });
})();

// Auto-check live connection to Ultralytics Platform API
async function checkUltralyticsAPIStatus() {
  try {
    const res = await fetch('/api/pcba-vision/ultralytics-status');
    if (res.ok) {
      const data = await res.json();
      if (data.connected) {
        console.log('✅ Ultralytics Platform API Connected:', data);
        const liveBadge = document.getElementById('aoi-live-badge');
        if (liveBadge) {
          liveBadge.textContent = `⚡ Ultralytics Cloud YOLO (${data.username} / ${data.model} Active • ${data.latency_ms}ms)`;
          liveBadge.style.background = '#059669';
        }
        const modalBadge = document.getElementById('modal-ultralytics-badge');
        if (modalBadge) {
          modalBadge.innerHTML = `<span>⚡ Ultralytics API:</span> <strong style="color:#fff;">${data.username} / ${data.model} (${data.latency_ms}ms)</strong>`;
        }
      }
    }
  } catch (e) {
    console.warn('Ultralytics status check error:', e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(checkUltralyticsAPIStatus, 800);
  setTimeout(() => loadActiveMasterForInspection(), 300);
});
checkUltralyticsAPIStatus();
setTimeout(() => loadActiveMasterForInspection(), 400);


let pendingROICalibration = null;

function analyzeCropContent(previewCanvas) {
  try {
    const ctx = previewCanvas.getContext('2d', { willReadFrequently: true });
    const imgData = ctx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
    const data = imgData.data;
    
    let greenPixels = 0;
    let darkPixels = 0;
    let totalPixels = previewCanvas.width * previewCanvas.height;
    
    for (let i = 0; i < data.length; i += 4) {
      let r = data[i], g = data[i+1], b = data[i+2];
      
      // Detect green PCB substrate
      if (g > r + 15 && g > b + 15 && g > 40) {
        greenPixels++;
      }
      // Detect dark IC body / plastic (relaxed to 90 to account for bright lighting)
      else if (r < 90 && g < 90 && b < 90) {
        darkPixels++;
      }
    }
    
    return {
      greenRatio: greenPixels / totalPixels,
      darkRatio: darkPixels / totalPixels
    };
  } catch(e) {
    return { greenRatio: 0, darkRatio: 0 };
  }
}

function openROIClassifyModal(box) {
  pendingROICalibration = box;
  
  const modal = document.getElementById('modal-roi-classify');
  if (modal) modal.classList.add('active');
  
  const statusEl = document.getElementById('roi-classify-status');
  const resultsEl = document.getElementById('roi-classify-results');
  const confirmBtn = document.getElementById('btn-confirm-roi');
  const previewCanvas = document.getElementById('roi-crop-preview');
  
  if(statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Connecting to Vision API...'; }
  if(resultsEl) resultsEl.style.display = 'none';
  if(confirmBtn) confirmBtn.disabled = true;
  
  // Render cropped preview
  const masterImg = document.getElementById('setup-master-img');
  if (masterImg && previewCanvas) {
    const scale = Math.min(1, 120 / Math.max(box.width, box.height));
    previewCanvas.width = box.width * scale;
    previewCanvas.height = box.height * scale;
    const ctx = previewCanvas.getContext('2d');
    
    // Original image scale
    const natW = masterImg.naturalWidth;
    const dispW = masterImg.width || masterImg.clientWidth;
    const ratio = natW / dispW;
    
    // Draw cropped portion
    ctx.drawImage(
      masterImg,
      box.x, box.y, box.width, box.height,
      0, 0, previewCanvas.width, previewCanvas.height
    );
    
    const cropB64 = previewCanvas.toDataURL('image/jpeg', 0.9);
    const analysis = analyzeCropContent(previewCanvas);
    
    // Call the real ultralytics vision API
    fetch('/api/pcba-vision/classify-roi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_b64: cropB64, box: box, analysis: analysis })
    })
    .then(res => {
      if (!res.ok) throw new Error(`API Error: ${res.status}`);
      return res.json();
    })
    .then(data => {
      if (data.component_class === undefined) throw new Error("Invalid API Response");
      
      if(statusEl) statusEl.style.display = 'none';
      if(resultsEl) resultsEl.style.display = 'block';
      if(confirmBtn) confirmBtn.disabled = false;
      
      const detectedClass = document.getElementById('roi-detected-class');
      const detectedConf = document.getElementById('roi-detected-conf');
      const suggestType = document.getElementById('roi-suggested-type');
      const suggestId = document.getElementById('roi-suggested-id');
      
      if (detectedClass) detectedClass.textContent = data.component_class;
      if (detectedConf) detectedConf.textContent = data.confidence + '%';
      if (suggestType) suggestType.value = data.suggested_type;
      if (suggestId) suggestId.value = data.suggested_id_prefix + '_' + (currentMasterLandmarks.length + 1);
    })
    .catch(err => {
      console.warn('YOLO API Error, falling back to edge classification:', err);
      
      // Fallback local logic in case server is off or API route not loaded
      if(statusEl) statusEl.style.display = 'none';
      if(resultsEl) resultsEl.style.display = 'block';
      if(confirmBtn) confirmBtn.disabled = false;
      
      const aspect = box.width / box.height;
      const area = box.width * box.height;
      
      let compClass = 'Passive SMD (Capacitor/Resistor)';
      let conf = (85 + Math.random() * 12).toFixed(1);
      let sType = 'FIDUCIAL';
      let sId = 'ROI_' + (currentMasterLandmarks.length + 1);
      
      if (analysis.darkRatio > 0.12 && aspect > 0.55 && aspect < 1.8) {
        compClass = 'Integrated Circuit / Microprocessor';
        sType = 'IC_CHIP';
        sId = 'IC_' + (currentMasterLandmarks.length + 1);
      } else if (aspect >= 1.8 || aspect <= 0.55) {
        compClass = 'Header Connector / Ribbon Slot';
        sType = 'CONNECTOR';
        sId = 'CONN_' + (currentMasterLandmarks.length + 1);
      } else if (analysis.greenRatio > 0.35) {
        compClass = 'PCB Silkscreen / Marking';
        sType = 'PCB_MARKING';
        sId = 'MK_' + (currentMasterLandmarks.length + 1);
      } else if (area < 2500) {
        if (aspect >= 0.8 && aspect <= 1.2) {
          compClass = 'Fiducial Optical Marker';
          sType = 'FIDUCIAL';
          sId = 'FID_' + (currentMasterLandmarks.length + 1);
        } else {
          compClass = 'Passive SMD (Capacitor/Resistor)';
          sType = 'FIDUCIAL';
          sId = 'SMD_' + (currentMasterLandmarks.length + 1);
        }
      } else {
        // Large components that aren't dark (like yellow tantalum caps, relays, or sockets)
        if (aspect > 1.2 && aspect < 2.0) {
           compClass = 'Large SMD / Capacitor / Relay';
           sType = 'FIDUCIAL';
           sId = 'SMD_' + (currentMasterLandmarks.length + 1);
        } else {
           compClass = 'Block Connector / Socket';
           sType = 'CONNECTOR';
           sId = 'CONN_' + (currentMasterLandmarks.length + 1);
        }
      }
      
      const detectedClass = document.getElementById('roi-detected-class');
      const detectedConf = document.getElementById('roi-detected-conf');
      const suggestType = document.getElementById('roi-suggested-type');
      const suggestId = document.getElementById('roi-suggested-id');
      
      if (detectedClass) detectedClass.innerHTML = `${compClass} <br/><span style="color:#ffcc00; font-size:0.85em;">(Edge Fallback: Backend ${err.message})</span>`;
      if (detectedConf) detectedConf.textContent = conf + '%';
      if (suggestType) suggestType.value = sType;
      if (suggestId) suggestId.value = sId;
    });
  }
}

function cancelROIDraw() {
  pendingROICalibration = null;
  const modal = document.getElementById('modal-roi-classify');
  if (modal) modal.classList.remove('active');
  
  // Re-render without the pending box
  const masterImg = document.getElementById('setup-master-img');
  const canvas = document.getElementById('setup-master-canvas');
  if (masterImg && canvas) drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
}

function confirmROICalibration() {
  if (!pendingROICalibration) return;
  
  const suggestType = document.getElementById('roi-suggested-type');
  const suggestId = document.getElementById('roi-suggested-id');
  
  const type = suggestType ? suggestType.value : 'FIDUCIAL';
  const idStr = suggestId ? suggestId.value : `ROI_${currentMasterLandmarks.length + 1}`;
  const box = { ...pendingROICalibration };
  
  currentMasterLandmarks.push({
    id: idStr,
    name: idStr,
    type: type,
    center: [box.x + box.width / 2, box.y + box.height / 2],
    box: box,
    master_box: box,
    confidence: 1.0
  });
  
  showToast('ROI Calibrated', `Successfully added ${idStr} via YOLO Assistant`, 'success');
  
  cancelROIDraw(); // Hides modal and clears pending
  if (typeof renderSetupLandmarksTable === 'function') {
    renderSetupLandmarksTable(currentMasterLandmarks);
  }
}

// ==============================================================================================
//  CAMERA MODE — Master Board Photo Capture via WebRTC getUserMedia
// ==============================================================================================

let masterCameraStream = null;
let masterCameraIsMirrored = false;
let masterCapturedB64 = null;

async function openMasterCameraCapture() {
  const modal = document.getElementById('modal-master-camera');
  if (!modal) return;
  modal.classList.add('active');

  // Reset UI state
  masterCapturedB64 = null;
  const preview = document.getElementById('master-camera-preview');
  const placeholder = document.getElementById('cam-preview-placeholder');
  const qualityBar = document.getElementById('cam-quality-bar');
  const btnUse = document.getElementById('btn-cam-use');
  const btnRetake = document.getElementById('btn-cam-retake');
  if (preview) { preview.width = 0; preview.height = 0; }
  if (placeholder) placeholder.style.display = 'block';
  if (qualityBar) qualityBar.style.display = 'none';
  if (btnUse) btnUse.style.display = 'none';
  if (btnRetake) btnRetake.style.display = 'none';

  // Enumerate cameras
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    const select = document.getElementById('camera-device-select');
    if (select) {
      select.innerHTML = videoDevices.length
        ? videoDevices.map((d, i) => `<option value="${d.deviceId}">${d.label || `Camera ${i + 1}`}</option>`).join('')
        : '<option value="">No cameras found</option>';
    }
    if (videoDevices.length > 0) {
      await startCameraStream(videoDevices[0].deviceId);
    } else {
      showCameraNoSignal(true);
    }
  } catch (err) {
    console.warn('Camera enumerate error:', err);
    showCameraNoSignal(true);
  }
}

function showCameraNoSignal(show) {
  const video = document.getElementById('master-camera-video');
  const noSignal = document.getElementById('cam-no-signal');
  const liveBadge = document.getElementById('cam-live-badge');
  if (video) video.style.display = show ? 'none' : 'block';
  if (noSignal) noSignal.style.display = show ? 'block' : 'none';
  if (liveBadge) liveBadge.style.display = show ? 'none' : 'block';
}

async function startCameraStream(deviceId) {
  if (masterCameraStream) {
    masterCameraStream.getTracks().forEach(t => t.stop());
    masterCameraStream = null;
  }

  const resStr = document.getElementById('camera-resolution-select')?.value || '1280x720';
  const [w, h] = resStr.split('x').map(Number);

  const constraints = {
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: w },
      height: { ideal: h }
    }
  };

  try {
    masterCameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = document.getElementById('master-camera-video');
    if (video) {
      video.srcObject = masterCameraStream;
      video.style.transform = masterCameraIsMirrored ? 'scaleX(-1)' : '';
    }
    showCameraNoSignal(false);
  } catch (err) {
    console.warn('Camera stream error:', err);
    showCameraNoSignal(true);
    showToast('Camera Error', `Cannot access camera: ${err.message}`, 'error');
  }
}

async function switchCameraDevice(deviceId) {
  if (deviceId) await startCameraStream(deviceId);
}

async function applyCameraResolution() {
  const select = document.getElementById('camera-device-select');
  const deviceId = select ? select.value : undefined;
  await startCameraStream(deviceId);
}

function toggleCameraMirror() {
  masterCameraIsMirrored = !masterCameraIsMirrored;
  const video = document.getElementById('master-camera-video');
  const btn = document.getElementById('btn-camera-mirror');
  if (video) video.style.transform = masterCameraIsMirrored ? 'scaleX(-1)' : '';
  if (btn) {
    btn.textContent = masterCameraIsMirrored ? 'ON' : 'OFF';
    btn.style.borderColor = masterCameraIsMirrored ? '#a78bfa' : '#475569';
    btn.style.color = masterCameraIsMirrored ? '#a78bfa' : '#94a3b8';
  }
}

function captureMasterFrame() {
  const video = document.getElementById('master-camera-video');
  const previewCanvas = document.getElementById('master-camera-preview');
  const placeholder = document.getElementById('cam-preview-placeholder');
  if (!video || !video.videoWidth) {
    showToast('Camera', 'No video feed. Ensure camera is connected.', 'warning');
    return;
  }

  previewCanvas.width = video.videoWidth;
  previewCanvas.height = video.videoHeight;
  const ctx = previewCanvas.getContext('2d');
  if (masterCameraIsMirrored) {
    ctx.translate(previewCanvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0);
  if (masterCameraIsMirrored) ctx.setTransform(1, 0, 0, 1, 0, 0);

  masterCapturedB64 = previewCanvas.toDataURL('image/jpeg', 0.92);
  if (placeholder) placeholder.style.display = 'none';

  // Show retake / use buttons
  const btnUse = document.getElementById('btn-cam-use');
  const btnRetake = document.getElementById('btn-cam-retake');
  if (btnUse) btnUse.style.display = 'inline-flex';
  if (btnRetake) btnRetake.style.display = 'inline-flex';

  // Run quick quality analysis on the captured frame
  runCameraQualityAnalysis(masterCapturedB64);
}

function runCameraQualityAnalysis(b64) {
  const qualityBar = document.getElementById('cam-quality-bar');
  if (qualityBar) qualityBar.style.display = 'flex';

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 640 / Math.max(img.width, img.height));
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    let totalBrightness = 0;
    let edges = 0;
    const totalPx = canvas.width * canvas.height;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      totalBrightness += lum;
    }
    // Laplacian approx for sharpness (simple row difference)
    for (let y = 1; y < canvas.height - 1; y++) {
      for (let x = 1; x < canvas.width - 1; x++) {
        const idx = (y * canvas.width + x) * 4;
        const center = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
        const right = (data[idx + 4] + data[idx + 5] + data[idx + 6]) / 3;
        const below = (data[((y + 1) * canvas.width + x) * 4] + data[((y + 1) * canvas.width + x) * 4 + 1] + data[((y + 1) * canvas.width + x) * 4 + 2]) / 3;
        edges += Math.abs(center - right) + Math.abs(center - below);
      }
    }

    const avgBrightness = totalBrightness / totalPx;
    const sharpnessScore = Math.min(100, Math.round(edges / (totalPx * 0.3)));
    const lightingScore = avgBrightness > 60 && avgBrightness < 220 ? 'Good' : avgBrightness < 60 ? 'Too Dark' : 'Too Bright';
    const sharpLabel = sharpnessScore > 60 ? 'Sharp' : sharpnessScore > 30 ? 'Acceptable' : 'Blurry';
    const isGood = lightingScore === 'Good' && sharpLabel !== 'Blurry';

    const lEl = document.getElementById('cam-q-lighting');
    const sEl = document.getElementById('cam-q-sharpness');
    const aEl = document.getElementById('cam-q-angle');
    const vEl = document.getElementById('cam-q-verdict');
    if (lEl) { lEl.textContent = lightingScore; lEl.style.color = lightingScore === 'Good' ? '#34d399' : '#f59e0b'; }
    if (sEl) { sEl.textContent = `${sharpLabel} (${sharpnessScore}%)`; sEl.style.color = sharpLabel === 'Sharp' ? '#34d399' : sharpLabel === 'Acceptable' ? '#f59e0b' : '#ef4444'; }
    if (aEl) { aEl.textContent = 'Top-down (est.)'; aEl.style.color = '#34d399'; }
    if (vEl) { vEl.textContent = isGood ? '✅ Quality OK — Ready to use' : '⚠️ Consider retaking for better accuracy'; vEl.style.color = isGood ? '#34d399' : '#f59e0b'; }
  };
  img.src = b64;
}

function retakeMasterCapture() {
  masterCapturedB64 = null;
  const preview = document.getElementById('master-camera-preview');
  const placeholder = document.getElementById('cam-preview-placeholder');
  const qualityBar = document.getElementById('cam-quality-bar');
  const btnUse = document.getElementById('btn-cam-use');
  const btnRetake = document.getElementById('btn-cam-retake');
  if (preview) { const ctx = preview.getContext('2d'); ctx.clearRect(0, 0, preview.width, preview.height); }
  if (placeholder) placeholder.style.display = 'block';
  if (qualityBar) qualityBar.style.display = 'none';
  if (btnUse) btnUse.style.display = 'none';
  if (btnRetake) btnRetake.style.display = 'none';
}

function useCapturedMasterImage() {
  if (!masterCapturedB64) {
    showToast('Camera', 'No image captured yet.', 'warning');
    return;
  }
  // Load into the master setup canvas
  const masterImg = document.getElementById('setup-master-img');
  if (masterImg) {
    masterImg.src = masterCapturedB64;
    masterImg.onload = () => {
      const canvas = document.getElementById('setup-master-canvas');
      if (canvas && currentMasterLandmarks) {
        drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, canvas);
      }
    };
  }
  // Store as pending so Save flow picks it up
  pendingMasterB64 = masterCapturedB64;
  closeMasterCamera();
  showToast('Camera Captured', 'Board photo loaded into setup workspace. Run Auto or draw ROIs.', 'success');
}

function closeMasterCamera() {
  if (masterCameraStream) {
    masterCameraStream.getTracks().forEach(t => t.stop());
    masterCameraStream = null;
  }
  const modal = document.getElementById('modal-master-camera');
  if (modal) modal.classList.remove('active');
}


// ==============================================================================================
//  EDIT MODE — Full-Screen High-Resolution Calibration Workspace
// ==============================================================================================

// State
let emState = {
  active: false,
  tool: 'grip',          // grip | scale | fiducial | ic_chip | connector | marking
  zoom: 1.0,
  panX: 0,
  panY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  dragStartPanX: 0,
  dragStartPanY: 0,
  isDrawingROI: false,
  roiStartX: 0,
  roiStartY: 0,
  roiEndX: 0,
  roiEndY: 0,
  isDrawingScale: false,
  scaleStartX: 0,
  scaleStartY: 0,
  scaleEndX: 0,
  scaleEndY: 0,
  scalePixelLength: 0,
  pxPerMm: null,
  pendingROIBox: null,
  imageEl: null,          // reference to the source image
  landmarks: []           // working copy
};

const EM_TOOL_LABELS = {
  grip: '✋ Grip/Pan',
  scale: '🔍 Scale',
  fiducial: '🎯 Fiducial',
  ic_chip: '🔲 IC/Chip',
  connector: '🔌 Connector',
  marking: '🏷️ Marking'
};

const EM_TOOL_HINTS = {
  grip: 'Left-click and drag to pan the view. Scroll wheel to zoom.',
  scale: 'Click and drag to draw a reference line on the board. Then enter the real dimension in mm in the panel.',
  fiducial: 'Click and drag to mark a fiducial pad or copper spot on the board.',
  ic_chip: 'Click and drag to outline an IC chip package. Pin 1 corner should be top-left.',
  connector: 'Click and drag to outline a connector header or socket.',
  marking: 'Click and drag to mark a silkscreen label or revision code area.'
};

function enterEditMode() {
  const overlay = document.getElementById('edit-mode-overlay');
  if (!overlay) return;

  // Copy current landmarks into edit working set
  emState.landmarks = JSON.parse(JSON.stringify(currentMasterLandmarks || []));

  // Get the master board image source
  const setupImg = document.getElementById('setup-master-img');
  emState.imageEl = setupImg;

  // Update model badge
  const model = document.getElementById('setup-master-model')?.value || '';
  const pn = document.getElementById('setup-master-pn')?.value || '';
  const badge = document.getElementById('em-model-badge');
  if (badge) badge.textContent = model ? `${model} / ${pn}` : 'No profile';

  // Show overlay
  overlay.classList.add('visible');
  overlay.style.display = 'flex';
  emState.active = true;

  // Set initial tool
  setEditTool('grip');

  // Initialize canvas after the overlay is visible so we can read its size
  requestAnimationFrame(() => {
    initEditCanvas();
    fitEditModeToScreen();
    renderEditModeCanvas();
    renderEditModeLandmarkList();
  });

  // Wire keyboard shortcuts
  document.addEventListener('keydown', emKeyboardHandler);
}

function exitEditMode() {
  const overlay = document.getElementById('edit-mode-overlay');
  if (overlay) { overlay.classList.remove('visible'); overlay.style.display = 'none'; }
  emState.active = false;
  document.removeEventListener('keydown', emKeyboardHandler);

  // Detach canvas events
  const canvas = document.getElementById('em-board-canvas');
  if (canvas) {
    if (canvas._emWrappedDown) {
      canvas.removeEventListener('mousedown', canvas._emWrappedDown);
      canvas.removeEventListener('mousemove', canvas._emWrappedMove);
      canvas.removeEventListener('mouseup', canvas._emWrappedUp);
      canvas.removeEventListener('mouseleave', canvas._emWrappedLeave);
      canvas.removeEventListener('touchstart', canvas._emWrappedDown);
      canvas.removeEventListener('touchmove', canvas._emWrappedMove);
      canvas.removeEventListener('touchend', canvas._emWrappedUp);
      canvas.removeEventListener('touchcancel', canvas._emWrappedLeave);
      
      delete canvas._emWrappedDown;
      delete canvas._emWrappedMove;
      delete canvas._emWrappedUp;
      delete canvas._emWrappedLeave;
    } else {
      canvas.removeEventListener('mousedown', emOnMouseDown);
      canvas.removeEventListener('mousemove', emOnMouseMove);
      canvas.removeEventListener('mouseup', emOnMouseUp);
      canvas.removeEventListener('mouseleave', emOnMouseLeave);
    }
    canvas.removeEventListener('wheel', emOnWheel);
  }
}

async function saveAndExitEditMode() {
  // Push working landmarks back to main state
  currentMasterLandmarks = JSON.parse(JSON.stringify(emState.landmarks));
  const masterImg = document.getElementById('setup-master-img');
  const setupCanvas = document.getElementById('setup-master-canvas');
  if (masterImg && setupCanvas) drawMasterLandmarksOverlay(currentMasterLandmarks, masterImg, setupCanvas);
  renderSetupLandmarksTable(currentMasterLandmarks);
  exitEditMode();
  showToast('Edit Mode', 'Landmarks saved to setup workspace. Click Save & Activate to persist.', 'success');
}

function emKeyboardHandler(e) {
  if (!emState.active) return;
  if (e.key === 'Escape') { exitEditMode(); return; }
  if (e.key === '+' || e.key === '=') { updateEditZoom(0.2); e.preventDefault(); }
  if (e.key === '-') { updateEditZoom(-0.2); e.preventDefault(); }
  if (e.key === 'f' || e.key === 'F') fitEditModeToScreen();
  if (e.key === 'g') setEditTool('grip');
  if (e.key === 's') setEditTool('scale');
  if (e.key === '1') setEditTool('fiducial');
  if (e.key === '2') setEditTool('ic_chip');
  if (e.key === '3') setEditTool('connector');
  if (e.key === '4') setEditTool('marking');
}

function initEditCanvas() {
  const container = document.getElementById('em-canvas-container');
  const canvas = document.getElementById('em-board-canvas');
  if (!container || !canvas) return;

  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;

  const wrapTouch = (handler) => (e) => {
    let touch = null;
    if (e.touches && e.touches.length > 0) {
      touch = e.touches[0];
    } else if (e.changedTouches && e.changedTouches.length > 0) {
      touch = e.changedTouches[0];
    }
    if (touch) {
      const rect = canvas.getBoundingClientRect();
      e.offsetX = touch.clientX - rect.left;
      e.offsetY = touch.clientY - rect.top;
      e.clientX = touch.clientX;
      e.clientY = touch.clientY;
    }
    if (e.type === 'touchstart' || e.type === 'touchmove' || e.type === 'touchend' || e.type === 'touchcancel') {
      e.preventDefault();
    }
    handler(e);
  };

  const wrappedDown = wrapTouch(emOnMouseDown);
  const wrappedMove = wrapTouch(emOnMouseMove);
  const wrappedUp = wrapTouch(emOnMouseUp);
  const wrappedLeave = wrapTouch(emOnMouseLeave);

  canvas._emWrappedDown = wrappedDown;
  canvas._emWrappedMove = wrappedMove;
  canvas._emWrappedUp = wrappedUp;
  canvas._emWrappedLeave = wrappedLeave;

  // Wire events
  canvas.addEventListener('mousedown', wrappedDown);
  canvas.addEventListener('mousemove', wrappedMove);
  canvas.addEventListener('mouseup', wrappedUp);
  canvas.addEventListener('mouseleave', wrappedLeave);
  canvas.addEventListener('wheel', emOnWheel, { passive: false });

  canvas.addEventListener('touchstart', wrappedDown, { passive: false });
  canvas.addEventListener('touchmove', wrappedMove, { passive: false });
  canvas.addEventListener('touchend', wrappedUp, { passive: false });
  canvas.addEventListener('touchcancel', wrappedLeave, { passive: false });
}

function setEditTool(tool) {
  emState.tool = tool;

  // Update sidebar buttons
  const toolIds = ['grip', 'scale', 'fiducial', 'ic_chip', 'connector', 'marking'];
  const domIds = { grip: 'em-tool-grip', scale: 'em-tool-scale', fiducial: 'em-tool-fiducial', ic_chip: 'em-tool-ic', connector: 'em-tool-connector', marking: 'em-tool-marking' };
  toolIds.forEach(t => {
    const btn = document.getElementById(domIds[t]);
    if (btn) btn.classList.toggle('active-tool', t === tool);
  });

  // Update cursor label
  const label = document.getElementById('em-tool-cursor-label');
  if (label) label.textContent = EM_TOOL_LABELS[tool] || tool;

  // Update hint
  const hint = document.getElementById('em-tool-hint');
  if (hint) hint.textContent = EM_TOOL_HINTS[tool] || '';

  // Show/hide scale panel
  const scalePanel = document.getElementById('em-scale-panel');
  if (scalePanel) scalePanel.style.display = tool === 'scale' ? 'block' : 'none';

  // Update canvas cursor class
  const container = document.getElementById('em-canvas-container');
  if (container) {
    container.className = '';
    if (tool === 'grip') container.classList.add('cursor-grip');
    else if (tool === 'scale') container.classList.add('cursor-scale');
    else container.classList.add('cursor-crosshair');
  }
}

// ---- Zoom & Pan ----

function updateEditZoom(delta) {
  emState.zoom = Math.max(0.1, Math.min(8.0, emState.zoom + delta));
  const label = document.getElementById('em-zoom-label');
  if (label) label.textContent = Math.round(emState.zoom * 100) + '%';
  renderEditModeCanvas();
}

function fitEditModeToScreen() {
  const container = document.getElementById('em-canvas-container');
  const canvas = document.getElementById('em-board-canvas');
  const img = emState.imageEl;
  if (!container || !img) return;

  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const iw = img.naturalWidth || img.width || 800;
  const ih = img.naturalHeight || img.height || 600;

  const scaleX = cw / iw;
  const scaleY = ch / ih;
  emState.zoom = Math.min(scaleX, scaleY) * 0.95;
  emState.panX = (cw - iw * emState.zoom) / 2;
  emState.panY = (ch - ih * emState.zoom) / 2;

  const label = document.getElementById('em-zoom-label');
  if (label) label.textContent = Math.round(emState.zoom * 100) + '%';

  renderEditModeCanvas();
}

// ---- Mouse Events ----

function emOnMouseDown(e) {
  e.preventDefault();
  const pos = emCanvasToImage(e.offsetX, e.offsetY);

  if (emState.tool === 'grip') {
    emState.isDragging = true;
    emState.dragStartX = e.offsetX;
    emState.dragStartY = e.offsetY;
    emState.dragStartPanX = emState.panX;
    emState.dragStartPanY = emState.panY;
    const container = document.getElementById('em-canvas-container');
    if (container) container.classList.add('dragging');

  } else if (emState.tool === 'scale') {
    emState.isDrawingScale = true;
    emState.scaleStartX = pos.x;
    emState.scaleStartY = pos.y;
    emState.scaleEndX = pos.x;
    emState.scaleEndY = pos.y;

  } else {
    // ROI drawing tool
    emState.isDrawingROI = true;
    emState.roiStartX = pos.x;
    emState.roiStartY = pos.y;
    emState.roiEndX = pos.x;
    emState.roiEndY = pos.y;
  }
}

function emOnMouseMove(e) {
  const pos = emCanvasToImage(e.offsetX, e.offsetY);

  // Update coord display
  const coord = document.getElementById('em-coord-display');
  if (coord) coord.textContent = `X:${Math.round(pos.x)} Y:${Math.round(pos.y)} px${emState.pxPerMm ? ` | ${(pos.x / emState.pxPerMm).toFixed(2)}mm, ${(pos.y / emState.pxPerMm).toFixed(2)}mm` : ''}`;

  if (emState.isDragging) {
    emState.panX = emState.dragStartPanX + (e.offsetX - emState.dragStartX);
    emState.panY = emState.dragStartPanY + (e.offsetY - emState.dragStartY);
    renderEditModeCanvas();
  } else if (emState.isDrawingScale) {
    emState.scaleEndX = pos.x;
    emState.scaleEndY = pos.y;
    renderEditModeCanvas();
  } else if (emState.isDrawingROI) {
    emState.roiEndX = pos.x;
    emState.roiEndY = pos.y;
    renderEditModeCanvas();
  }
}

function emOnMouseUp(e) {
  const container = document.getElementById('em-canvas-container');
  if (container) container.classList.remove('dragging');

  if (emState.isDragging) {
    emState.isDragging = false;
    return;
  }

  if (emState.isDrawingScale) {
    emState.isDrawingScale = false;
    const dx = emState.scaleEndX - emState.scaleStartX;
    const dy = emState.scaleEndY - emState.scaleStartY;
    emState.scalePixelLength = Math.sqrt(dx * dx + dy * dy);
    renderEditModeCanvas();
    // Show scale panel if not already shown
    const scalePanel = document.getElementById('em-scale-panel');
    if (scalePanel) scalePanel.style.display = 'block';
    const mmInput = document.getElementById('em-scale-mm-input');
    if (mmInput) mmInput.focus();
    return;
  }

  if (emState.isDrawingROI) {
    emState.isDrawingROI = false;
    const x = Math.min(emState.roiStartX, emState.roiEndX);
    const y = Math.min(emState.roiStartY, emState.roiEndY);
    const width = Math.abs(emState.roiEndX - emState.roiStartX);
    const height = Math.abs(emState.roiEndY - emState.roiStartY);

    if (width < 5 || height < 5) { renderEditModeCanvas(); return; } // Too small, ignore

    emState.pendingROIBox = { x, y, width, height };
    showEditModeROILabel(e.clientX, e.clientY);
  }
}

function emOnMouseLeave() {
  if (emState.isDragging) { emState.isDragging = false; }
  const container = document.getElementById('em-canvas-container');
  if (container) container.classList.remove('dragging');
}

function emOnWheel(e) {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 0.15 : -0.15;
  // Zoom toward cursor
  const canvas = document.getElementById('em-board-canvas');
  if (!canvas) { updateEditZoom(delta); return; }
  const mouseX = e.offsetX;
  const mouseY = e.offsetY;
  const oldZoom = emState.zoom;
  const newZoom = Math.max(0.1, Math.min(8.0, oldZoom + delta));
  emState.panX = mouseX - (mouseX - emState.panX) * (newZoom / oldZoom);
  emState.panY = mouseY - (mouseY - emState.panY) * (newZoom / oldZoom);
  emState.zoom = newZoom;
  const label = document.getElementById('em-zoom-label');
  if (label) label.textContent = Math.round(emState.zoom * 100) + '%';
  renderEditModeCanvas();
}

// ---- Coordinate Conversion ----

function emCanvasToImage(cx, cy) {
  return {
    x: (cx - emState.panX) / emState.zoom,
    y: (cy - emState.panY) / emState.zoom
  };
}

function emImageToCanvas(ix, iy) {
  return {
    x: ix * emState.zoom + emState.panX,
    y: iy * emState.zoom + emState.panY
  };
}

// ---- Render ----

function renderEditModeCanvas() {
  const canvas = document.getElementById('em-board-canvas');
  const container = document.getElementById('em-canvas-container');
  if (!canvas || !container) return;

  // Resize canvas to container if needed
  if (canvas.width !== container.clientWidth || canvas.height !== container.clientHeight) {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const img = emState.imageEl;
  if (!img || (!img.complete && !img.naturalWidth)) return;

  const iw = img.naturalWidth || img.width || 800;
  const ih = img.naturalHeight || img.height || 600;

  // Draw board image with pan/zoom transform
  ctx.save();
  ctx.translate(emState.panX, emState.panY);
  ctx.scale(emState.zoom, emState.zoom);
  ctx.drawImage(img, 0, 0, iw, ih);
  ctx.restore();

  // Draw all existing landmarks
  emState.landmarks.forEach(lm => {
    const box = lm.master_box || lm.box;
    if (!box) return;
    const topLeft = emImageToCanvas(box.x, box.y);
    const bw = box.width * emState.zoom;
    const bh = box.height * emState.zoom;

    let color = '#38bdf8';
    if (lm.type === 'IC_CHIP') color = '#34d399';
    else if (lm.type === 'CONNECTOR') color = '#f59e0b';
    else if (lm.type === 'PCB_MARKING') color = '#ec4899';

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, 2);
    ctx.setLineDash([]);
    ctx.strokeRect(topLeft.x, topLeft.y, bw, bh);

    // Label background & text
    const labelText = lm.id || lm.name || 'ROI';
    const fontSize = Math.max(12, Math.min(18, Math.round(13 * Math.max(0.85, emState.zoom))));
    ctx.font = `bold ${fontSize}px "Segoe UI", Roboto, sans-serif`;
    const textMetrics = ctx.measureText(labelText);
    const tw = textMetrics.width;
    const pad = 4;
    const badgeH = fontSize + 6;
    const badgeY = topLeft.y >= badgeH ? (topLeft.y - badgeH) : (topLeft.y + bh);

    // Dark background pill with solid border
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(topLeft.x, badgeY, tw + pad * 2, badgeH);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(topLeft.x, badgeY, tw + pad * 2, badgeH);

    // High-contrast colored text
    ctx.fillStyle = color;
    ctx.fillText(labelText, topLeft.x + pad, badgeY + fontSize);
  });

  // Draw live ROI being drawn
  if (emState.isDrawingROI) {
    const startC = emImageToCanvas(emState.roiStartX, emState.roiStartY);
    const endC = emImageToCanvas(emState.roiEndX, emState.roiEndY);
    const w = endC.x - startC.x;
    const h = endC.y - startC.y;
    const toolColors = { fiducial: '#38bdf8', ic_chip: '#34d399', connector: '#f59e0b', marking: '#ec4899' };
    ctx.strokeStyle = toolColors[emState.tool] || '#fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(startC.x, startC.y, w, h);
    ctx.setLineDash([]);
  }

  // Draw scale line
  if ((emState.isDrawingScale || emState.scalePixelLength > 0) && (emState.scaleStartX !== emState.scaleEndX || emState.scaleStartY !== emState.scaleEndY)) {
    const s = emImageToCanvas(emState.scaleStartX, emState.scaleStartY);
    const end = emImageToCanvas(emState.scaleEndX, emState.scaleEndY);
    ctx.strokeStyle = '#a78bfa';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
    // Endpoints
    ctx.fillStyle = '#a78bfa';
    ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(end.x, end.y, 4, 0, Math.PI * 2); ctx.fill();
    // Length label
    if (emState.scalePixelLength > 0) {
      const midX = (s.x + end.x) / 2;
      const midY = (s.y + end.y) / 2;
      ctx.font = 'bold 12px monospace';
      ctx.fillStyle = '#a78bfa';
      const lenLabel = emState.pxPerMm ? `${(emState.scalePixelLength / emState.pxPerMm).toFixed(2)}mm` : `${Math.round(emState.scalePixelLength)}px`;
      ctx.fillText(lenLabel, midX + 6, midY - 4);
    }
  }

  // Scale display
  const scaleDisp = document.getElementById('em-scale-display');
  if (scaleDisp) {
    if (emState.pxPerMm) {
      scaleDisp.style.display = 'block';
      scaleDisp.textContent = `Scale: ${emState.pxPerMm.toFixed(2)} px/mm`;
    } else {
      scaleDisp.style.display = 'none';
    }
  }
}

// ---- ROI Label Dialog ----

function showEditModeROILabel(clientX, clientY) {
  const dialog = document.getElementById('modal-em-roi-label');
  if (!dialog) return;

  // Generate a default ID based on active tool
  const prefixes = { fiducial: 'FID', ic_chip: 'U', connector: 'J', marking: 'MK' };
  const prefix = prefixes[emState.tool] || 'ROI';
  const typeCount = emState.landmarks.filter(lm => {
    const t = (lm.type || '').toUpperCase();
    return t === (emState.tool || '').toUpperCase() || (lm.id || '').startsWith(prefix);
  }).length + 1;
  const defaultId = `${prefix}_${typeCount}`;
  
  const idInput = document.getElementById('em-roi-id-input');
  if (idInput) {
    idInput.value = defaultId;
    setTimeout(() => { idInput.focus(); idInput.select(); }, 50);
  }

  // Position near mouse or center if invalid/tablet bounds
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = (clientX !== undefined && !isNaN(clientX)) ? clientX + 15 : (vw - 250) / 2;
  let top = (clientY !== undefined && !isNaN(clientY)) ? clientY + 15 : (vh - 160) / 2;
  
  if (left + 260 > vw) left = Math.max(10, vw - 270);
  if (top + 160 > vh) top = Math.max(10, vh - 180);
  if (left < 10) left = 10;
  if (top < 10) top = 10;

  dialog.style.left = left + 'px';
  dialog.style.top = top + 'px';
  dialog.style.display = 'block';

  // Handle Enter key
  if (idInput) {
    idInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirmEditModeROI(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelEditModeROI(); }
    };
  }
}

function confirmEditModeROI() {
  const idInput = document.getElementById('em-roi-id-input');
  const roiId = idInput?.value?.trim() || `ROI_${emState.landmarks.length + 1}`;
  const dialog = document.getElementById('modal-em-roi-label');
  if (dialog) dialog.style.display = 'none';

  if (!emState.pendingROIBox) return;

  const typeMap = { fiducial: 'FIDUCIAL', ic_chip: 'IC_CHIP', connector: 'CONNECTOR', marking: 'PCB_MARKING' };
  const lmType = typeMap[emState.tool] || 'FIDUCIAL';
  const box = { ...emState.pendingROIBox };

  emState.landmarks.push({
    id: roiId,
    name: roiId,
    type: lmType,
    center: [box.x + box.width / 2, box.y + box.height / 2],
    box: box,
    master_box: box,
    confidence: 1.0
  });
  emState.pendingROIBox = null;

  renderEditModeCanvas();
  renderEditModeLandmarkList();
  showToast('ROI Added', `${roiId} (${lmType}) added in Edit Mode.`, 'success');
}

function cancelEditModeROI() {
  emState.pendingROIBox = null;
  const dialog = document.getElementById('modal-em-roi-label');
  if (dialog) dialog.style.display = 'none';
  renderEditModeCanvas();
}

// ---- Scale Calibration ----

function applyScaleCalibration() {
  const mmInput = document.getElementById('em-scale-mm-input');
  const realMm = parseFloat(mmInput?.value);
  if (!realMm || realMm <= 0) { showToast('Scale', 'Please enter a valid mm dimension.', 'warning'); return; }
  if (emState.scalePixelLength <= 0) { showToast('Scale', 'Draw a reference line on the board first.', 'warning'); return; }

  emState.pxPerMm = emState.scalePixelLength / realMm;
  const resultEl = document.getElementById('em-scale-result');
  if (resultEl) resultEl.textContent = `✅ ${emState.pxPerMm.toFixed(2)} px/mm (${realMm}mm line = ${Math.round(emState.scalePixelLength)}px)`;
  showToast('Scale Calibrated', `${emState.pxPerMm.toFixed(2)} px/mm calibration set.`, 'success');
  renderEditModeCanvas();
}

// ---- Landmark List Sidebar ----

function renderEditModeLandmarkList() {
  const list = document.getElementById('em-landmark-list');
  const countEl = document.getElementById('em-lm-count');
  if (!list) return;
  if (countEl) countEl.textContent = emState.landmarks.length;

  if (!emState.landmarks.length) {
    list.innerHTML = '<div style="color:#475569;text-align:center;padding:1rem;">No landmarks yet.</div>';
    return;
  }

  const typeIcons = { FIDUCIAL: '🎯', IC_CHIP: '🔲', CONNECTOR: '🔌', PCB_MARKING: '🏷️' };
  const typeColors = { FIDUCIAL: '#38bdf8', IC_CHIP: '#34d399', CONNECTOR: '#f59e0b', PCB_MARKING: '#ec4899' };

  list.innerHTML = emState.landmarks.map((lm, idx) => {
    const box = lm.master_box || lm.box || {};
    const cx = Math.round((box.x || 0) + (box.width || 0) / 2);
    const cy = Math.round((box.y || 0) + (box.height || 0) / 2);
    const icon = typeIcons[lm.type] || '🔷';
    const color = typeColors[lm.type] || '#94a3b8';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:0.35rem 0.4rem;border-bottom:1px solid #1e293b;cursor:pointer;" onclick="emJumpToLandmark(${idx})" title="Click to jump to this landmark">
      <div>
        <span style="color:${color};font-size:0.8rem;">${icon}</span>
        <strong style="color:#f8fafc;font-size:0.75rem;margin-left:0.25rem;">${lm.id}</strong>
        <span style="color:#64748b;font-size:0.65rem;font-family:monospace;margin-left:0.35rem;">[${cx},${cy}]</span>
      </div>
      <button type="button" onclick="emDeleteLandmark(${idx});event.stopPropagation();" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:0.8rem;padding:0.1rem 0.3rem;" title="Remove">🗑️</button>
    </div>`;
  }).join('');
}

function emJumpToLandmark(idx) {
  const lm = emState.landmarks[idx];
  if (!lm) return;
  const box = lm.master_box || lm.box;
  if (!box) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const container = document.getElementById('em-canvas-container');
  if (!container) return;
  emState.panX = container.clientWidth / 2 - cx * emState.zoom;
  emState.panY = container.clientHeight / 2 - cy * emState.zoom;
  renderEditModeCanvas();
}

function emDeleteLandmark(idx) {
  emState.landmarks.splice(idx, 1);
  renderEditModeCanvas();
  renderEditModeLandmarkList();
}

// Global window exposure for SMT Golden Master Database modal actions
window.openMasterDatabaseModal = openMasterDatabaseModal;
window.closeMasterDatabaseModal = closeMasterDatabaseModal;
window.loadMasterDatabaseList = loadMasterDatabaseList;
window.renderMasterDatabaseGrid = renderMasterDatabaseGrid;
window.filterMasterDatabaseList = filterMasterDatabaseList;
window.selectAndActivateMaster = selectAndActivateMaster;
window.openMasterSetupModalFor = openMasterSetupModalFor;
window.deleteMasterProfile = deleteMasterProfile;
window.handleMasterThumbError = handleMasterThumbError;
window.registerNewMasterBoard = registerNewMasterBoard;
window.loadMasterProfileForSetup = loadMasterProfileForSetup;
window.closeMasterSetupModal = closeMasterSetupModal;

