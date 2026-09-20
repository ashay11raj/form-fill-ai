const $ = s => document.querySelector(s);
let reports = [];
let waiting = null;

const openSettings = () => chrome.runtime.openOptionsPage();
$('#settings').onclick = openSettings;
$('#open-setup').onclick = e => { e.preventDefault(); openSettings(); };

(async () => {
  const { settings = {}, profiles, activeProfileId, profile = '' } = await chrome.storage.local.get(['settings', 'profiles', 'activeProfileId', 'profile']);
  const list = profiles?.length ? profiles : (profile.trim() ? [{ id: 'default', name: 'Default', json: profile }] : []);
  if (!settings.apiKey || !list.some(p => (p.json || '').trim())) $('#setup').hidden = false;
  const sel = $('#profile');
  list.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
  if (list.length) sel.value = list.some(p => p.id === activeProfileId) ? activeProfileId : list[0].id;
  sel.onchange = () => chrome.storage.local.set({ activeProfileId: sel.value });
})();

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type !== 'REPORT') return;
  reports.push(msg);
  clearTimeout(waiting);
  render();
});

function render() {
  const err = reports.find(r => r.error);
  if (err) { $('#status').innerHTML = `<span class="bad"></span>`; $('#status span').textContent = err.error; $('#results').textContent = ''; return; }
  const filled = reports.reduce((a, r) => a + r.filled, 0);
  const files = reports.reduce((a, r) => a + r.files, 0);
  const review = reports.flatMap(r => r.review);
  const missing = reports.flatMap(r => r.missing);
  $('#status').innerHTML = `<span class="ok"></span>`;
  $('#status span').textContent = `Filled ${filled} field${filled === 1 ? '' : 's'}${files ? ' and attached your resume' : ''}.`;
  const box = $('#results');
  box.textContent = '';
  const list = (title, items, cls) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = cls; h.textContent = title;
    const ul = document.createElement('ul');
    items.slice(0, 12).forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    box.append(h, ul);
  };
  if (reports.some(r => r.resumeMissing)) {
    const d = document.createElement('div');
    d.className = 'warn';
    d.textContent = 'This page has a resume upload, but no resume is stored. Add your file in settings.';
    box.appendChild(d);
  }
  const dbg = reports.flatMap(r => r.fileDebug || []);
  list('Resume upload:', dbg, 'note');
  const guarded = reports.reduce((a, r) => a + (r.guarded || 0), 0);
  if (guarded) {
    const d = document.createElement('div');
    d.className = 'note';
    d.textContent = `Left ${guarded} sensitive field${guarded === 1 ? '' : 's'} (payment, password, ID) for you.`;
    box.appendChild(d);
  }
  list('Check these (orange on the page):', review, 'warn');
  list('Required, no answer in your profile:', missing, 'warn');
}

$('#fill').onclick = async () => {
  reports = [];
  $('#results').textContent = '';
  $('#status').textContent = 'Reading the form…';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'FILL', overwrite: $('#overwrite').checked, note: $('#note').value.trim() });
  } catch (e) {
    $('#status').innerHTML = '<span class="bad"></span>';
    $('#status span').textContent = "Can't run here. Reload the page, or open a normal web page.";
    return;
  }
  waiting = setTimeout(() => {
    if (!reports.length) $('#status').textContent = 'No form fields found. Scroll to the form, or click into it, then try again.';
  }, 15000);
};
