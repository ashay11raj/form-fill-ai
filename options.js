const $ = s => document.querySelector(s);

const SAMPLE = {
  personal: { first_name: '', middle_name: '', last_name: '', preferred_name: '', date_of_birth: 'YYYY-MM-DD', gender: '', nationality: '', marital_status: '', pronouns: '' },
  contact: { email: '', alternate_email: '', phone: '', phone_country_code: '+91', alternate_phone: '' },
  addresses: {
    home: { line1: '', line2: '', city: '', state: '', postal_code: '', country: 'India' },
    work: { line1: '', line2: '', city: '', state: '', postal_code: '', country: '' },
    shipping: { line1: '', line2: '', city: '', state: '', postal_code: '', country: '' }
  },
  identity_documents: { _note: 'Only used if you turn on ID filling in settings', passport_number: '', national_id: '', tax_id: '', driving_licence: '' },
  family: { emergency_contact: { name: '', relationship: '', phone: '' }, spouse_name: '', father_name: '', mother_name: '' },
  links: { linkedin: '', github: '', portfolio: '', website: '' },
  education: [{ institution: '', degree: '', field: '', start_date: 'YYYY-MM', end_date: 'YYYY-MM', gpa: '' }],
  professional: {
    current_employer: '', job_title: '', summary: '', skills: [],
    experience: [{ company: '', title: '', location: '', start_date: 'YYYY-MM', end_date: 'YYYY-MM or Present', description: '' }],
    work_authorization: { authorized_countries: [], requires_sponsorship: null },
    notice_period: '', desired_salary: '', currency: 'INR', willing_to_relocate: null
  },
  preferences: { language: 'English', timezone: '' },
  custom_answers: { 'How did you hear about us?': '', 'Why do you want to join?': '' }
};
const SAMPLE_TEXT = JSON.stringify(SAMPLE, null, 2);
const DEFAULT_MODELS = { anthropic: 'claude-sonnet-5', openai: 'gpt-4.1' };

let profiles = [];
let activeId = null;
const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const current = () => profiles.find(p => p.id === activeId);
function say(el, text, cls = '') { el.textContent = text; el.className = 'note ' + cls; }

function validate() {
  const t = $('#profile').value.trim();
  if (!t) { say($('#profileStatus'), ''); return true; }
  try { JSON.parse(t); say($('#profileStatus'), 'Valid JSON.', 'ok'); return true; }
  catch (e) { say($('#profileStatus'), 'Not valid JSON yet: ' + e.message, 'bad'); return false; }
}
$('#profile').addEventListener('input', validate);

function stash() { const c = current(); if (c) c.json = $('#profile').value; }

function renderProfiles() {
  const sel = $('#profileSelect');
  sel.textContent = '';
  profiles.forEach(p => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); });
  sel.value = activeId;
  $('#profile').value = current()?.json || '';
  validate();
}

async function load() {
  const { settings = {}, profiles: saved, activeProfileId, profile = '', resume } =
    await chrome.storage.local.get(['settings', 'profiles', 'activeProfileId', 'profile', 'resume']);
  $('#provider').value = settings.provider || 'anthropic';
  $('#apiKey').value = settings.apiKey || '';
  $('#model').value = settings.model || DEFAULT_MODELS[$('#provider').value];
  $('#baseUrl').value = settings.baseUrl || '';
  $('#extra').value = settings.extra || '';
  $('#showButton').checked = settings.showButton !== false;
  $('#fillIdNumbers').checked = !!settings.fillIdNumbers;
  profiles = saved?.length ? saved : [{ id: 'default', name: 'Default', json: profile }];
  activeId = profiles.some(p => p.id === activeProfileId) ? activeProfileId : profiles[0].id;
  renderProfiles();
  if (resume) say($('#resumeInfo'), `Stored: ${resume.name} (${Math.round(resume.size / 1024)} KB)`);
}

$('#provider').onchange = () => {
  const cur = $('#model').value;
  if (Object.values(DEFAULT_MODELS).includes(cur) || !cur) $('#model').value = DEFAULT_MODELS[$('#provider').value];
};

$('#profileSelect').onchange = () => {
  if (!validate()) { $('#profileSelect').value = activeId; say($('#profileStatus'), 'Fix the JSON before switching profiles.', 'bad'); return; }
  stash();
  activeId = $('#profileSelect').value;
  renderProfiles();
};
$('#newProfile').onclick = () => {
  const name = (prompt('Name for the new profile (e.g. Personal, Work, Mom)') || '').trim();
  if (!name) return;
  stash();
  const p = { id: uid(), name, json: SAMPLE_TEXT };
  profiles.push(p);
  activeId = p.id;
  renderProfiles();
};
$('#renameProfile').onclick = () => {
  const name = (prompt('New name', current().name) || '').trim();
  if (!name) return;
  current().name = name;
  stash();
  renderProfiles();
};
$('#deleteProfile').onclick = () => {
  if (profiles.length < 2) { say($('#profileStatus'), 'Keep at least one profile.', 'bad'); return; }
  if (!confirm(`Delete profile "${current().name}"?`)) return;
  profiles = profiles.filter(p => p.id !== activeId);
  activeId = profiles[0].id;
  renderProfiles();
};
$('#sample').onclick = () => { $('#profile').value = SAMPLE_TEXT; validate(); };

$('#resumeFile').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { say($('#resumeInfo'), 'File is over 10 MB.', 'bad'); return; }
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  const type = f.type || (f.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
  await chrome.storage.local.set({ resume: { name: f.name, type, size: f.size, base64: btoa(bin) } });
  say($('#resumeInfo'), `Stored: ${f.name} (${Math.round(f.size / 1024)} KB)`, 'ok');
};

async function saveSettingsOnly() {
  const settings = {
    provider: $('#provider').value,
    apiKey: $('#apiKey').value.trim(),
    model: $('#model').value.trim() || DEFAULT_MODELS[$('#provider').value],
    baseUrl: $('#baseUrl').value.trim(),
    extra: $('#extra').value.trim(),
    showButton: $('#showButton').checked,
    fillIdNumbers: $('#fillIdNumbers').checked
  };
  if (settings.baseUrl) {
    try { await chrome.permissions.request({ origins: [new URL(settings.baseUrl).origin + '/*'] }); } catch (e) { /* surfaced when a call fails */ }
  }
  await chrome.storage.local.set({ settings });
}

$('#fromResume').onclick = async () => {
  await saveSettingsOnly();
  const btn = $('#fromResume');
  btn.disabled = true;
  say($('#profileStatus'), 'Reading your resume…');
  const res = await chrome.runtime.sendMessage({ type: 'PARSE_RESUME', text: $('#resumeText').value.trim(), schema: SAMPLE_TEXT });
  btn.disabled = false;
  if (res?.error) { say($('#profileStatus'), res.error, 'bad'); return; }
  $('#profile').value = res.profile;
  validate();
  say($('#profileStatus'), 'Profile drafted from your resume. Check it, add addresses and contacts, then save.', 'ok');
};

$('#save').onclick = async () => {
  if (!validate()) { say($('#saved'), 'Fix the profile JSON first.', 'bad'); return; }
  stash();
  await saveSettingsOnly();
  await chrome.storage.local.set({ profiles, activeProfileId: activeId });
  await chrome.storage.local.remove('profile'); // legacy single-profile key
  say($('#saved'), 'Saved.', 'ok');
  setTimeout(() => say($('#saved'), ''), 2500);
};

load();
