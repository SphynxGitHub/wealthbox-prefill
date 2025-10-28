/* global JFCustomWidget */
let SETTINGS = {};
let OAUTH_STATE = null; // set after login
let BACKEND = '';
let AUTHMODE = 'oauth';
let APIKEY = '';
let RECORD_TYPE = 'contacts';

const els = {};
function $(id){ return document.getElementById(id); }
function uiMsg(txt, ok=false){ const m=$('msg'); m.textContent = txt || ''; m.className = 'msg' + (ok ? ' ok' : ''); }

async function post(path, body){
  const res = await fetch(`${BACKEND}?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body || {})
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function renderAuth() {
  const box = $('authArea');
  box.innerHTML = '';

  if (AUTHMODE === 'apikey') {
    if (!APIKEY) {
      const i = document.createElement('input');
      i.type = 'password'; i.placeholder = 'Wealthbox API Key';
      const b = document.createElement('button'); b.textContent = 'Save';
      b.onclick = ()=>{ APIKEY = i.value.trim(); uiMsg('API key saved.', true); };
      box.append(i, b);
    } else {
      box.textContent = 'API Key connected';
    }
    return;
  }

  // OAuth mode
  const b = document.createElement('button'); b.textContent = 'Connect Wealthbox';
  b.onclick = ()=>{
    const oauthStart = `${BACKEND}?path=oauth/start`;
    const w = window.open(oauthStart, 'wbOauth', 'width=600,height=700');
    const t = setInterval(()=>{
      if (w.closed) clearInterval(t);
    }, 500);
  };
  box.appendChild(b);
}

// receive state back from popup
window.addEventListener('message', (e)=>{
  if (e.data && e.data.wbOAuthState) {
    OAUTH_STATE = e.data.wbOAuthState;
    $('authArea').textContent = 'Connected to Wealthbox';
    uiMsg('Connected.', true);
  }
});

async function loadList(page=1) {
  $('list').innerHTML = 'Loading…';
  const q = $('search').value.trim();
  const typeSel = $('recordType');
  RECORD_TYPE = typeSel.value;

  const body = {
    path: 'contacts',
    page, per_page: 50, q,
    type: RECORD_TYPE
  };
  if (AUTHMODE === 'apikey') body.apiKey = APIKEY; else body.stateId = OAUTH_STATE;

  const data = await post('contacts', body);
  const items = data[RECORD_TYPE] || data.items || data.data || [];
  const meta = data.meta || {};

  $('list').innerHTML = '';
  items.forEach(item=>{
    const div = document.createElement('div'); div.className = 'row';
    const label = item.name || `${item.first_name || ''} ${item.last_name || ''}`.trim();
    const email = (item.emails && item.emails[0] && item.emails[0].address) || item.email || '';
    div.innerHTML = `<div><div class="label">${label}</div><div class="mini">${email || '(no email)'} • id: ${item.id}</div></div>`;
    div.addEventListener('click', ()=> loadDetails(item.id));
    $('list').appendChild(div);
  });

  // pager
  const totalPages = meta.total_pages || (items.length < 50 ? page : page+1);
  const pager = $('pager'); pager.innerHTML = '';
  if (page > 1) {
    const p = document.createElement('button'); p.textContent = 'Prev'; p.onclick = ()=>loadList(page-1); pager.appendChild(p);
  }
  if (page < totalPages) {
    const n = document.createElement('button'); n.textContent = 'Next'; n.onclick = ()=>loadList(page+1); pager.appendChild(n);
  }
}

async function loadDetails(id){
  $('details').innerHTML = 'Loading…';
  const body = { id, type: RECORD_TYPE };
  if (AUTHMODE === 'apikey') body.apiKey = APIKEY; else body.stateId = OAUTH_STATE;

  const data = await post('contact', body);
  const c = data.contact || data.household || data || {};
  const name = c.name || `${c.first_name || ''} ${c.last_name || ''}`.trim();
  const emails = c.emails || [];
  const phones = c.phones || [];
  const addrs  = c.addresses || c.street_addresses || [];
  const primaryEmail = emails.find(e=>e.principal)?.address || emails[0]?.address || '';
  const primaryPhone = phones.find(p=>p.principal)?.number || phones[0]?.number || '';

  // Save selected record in memory for send
  els.selected = {
    type: RECORD_TYPE,
    id: c.id,
    name,
    first_name: c.first_name || '',
    last_name: c.last_name || '',
    emails, phones, addresses: addrs
  };

  $('details').innerHTML = `
    <div class="card">
      <div class="h">Selected ${RECORD_TYPE.slice(0, -1)}</div>
      <div><b>Name:</b> ${name || '(none)'} </div>
      <div><b>Email:</b> ${primaryEmail || '(none)'} </div>
      <div><b>Phone:</b> ${primaryPhone || '(none)'} </div>
      <div class="mini">ID: ${c.id}</div>
    </div>
  `;
  $('sendToForm').disabled = false;
}

function buildFormValue() {
  // Compact JSON we’ll send to the parent form
  // (Use Jotform "Update/Calculate Field" conditions to copy to specific fields)
  const sel = els.selected || {};
  return JSON.stringify({
    wealthbox: {
      recordType: sel.type,
      id: sel.id,
      name: sel.name,
      first_name: sel.first_name,
      last_name: sel.last_name,
      emails: sel.emails,
      phones: sel.phones,
      addresses: sel.addresses
    }
  });
}

function wireEvents(){
  $('recordType').addEventListener('change', ()=>loadList(1));
  $('search').addEventListener('input', debounce(()=>loadList(1), 400));
  $('sendToForm').addEventListener('click', ()=>{
    if (!els.selected) { uiMsg('Pick a record first.'); return; }
    const value = buildFormValue();
    // send live value (so Conditions can copy into real fields)
    try { JFCustomWidget.sendData({ value }); uiMsg('Sent to form.', true); } catch(e){}
  });
}

function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; }

// Jotform lifecycle
JFCustomWidget.subscribe('ready', function(formData){
  // Read widget settings
  SETTINGS = JFCustomWidget.getWidgetSettings() || {};
  BACKEND  = SETTINGS.BackendUrl || '';
  AUTHMODE = (SETTINGS.AuthMode || 'oauth').toLowerCase();
  APIKEY   = SETTINGS.WealthboxApiKey || '';
  RECORD_TYPE = (SETTINGS.RecordType || 'contacts');

  renderAuth();
  wireEvents();
  if (AUTHMODE === 'apikey' ? !!APIKEY : !!OAUTH_STATE) loadList(1);
});

JFCustomWidget.subscribe('submit', function(){
  // Make the widget pass required validation if a record is present
  const val = buildFormValue();
  const valid = !!(els.selected && els.selected.id);
  JFCustomWidget.sendSubmit({ valid, value: val });
});
