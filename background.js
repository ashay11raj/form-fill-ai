// FormFill AI - service worker. Holds the API key, talks to the LLM, never touches the page.

const DEFAULTS = {
  provider: 'anthropic',      // 'anthropic' | 'openai' (any OpenAI-compatible endpoint)
  model: 'claude-sonnet-5',
  baseUrl: '',
  apiKey: '',
  extra: '',
  showButton: true
};

async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('The model did not return JSON.');
  return JSON.parse(text.slice(s, e + 1));
}

async function callLLM(s, { system, user, pdf, maxTokens = 3000 }) {
  if (!s.apiKey) throw new Error('No API key yet. Open FormFill AI settings and add one.');

  if (s.provider === 'anthropic') {
    const base = (s.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const content = [];
    if (pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } });
    content.push({ type: 'text', text: user });
    const r = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': s.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({ model: s.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    return j.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }

  // OpenAI-compatible (OpenAI, OpenRouter, Ollama, etc.)
  if (pdf) throw new Error('PDF import needs the Anthropic provider. Paste your resume text instead.');
  const base = (s.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const send = jsonMode => fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.apiKey },
    body: JSON.stringify({
      model: s.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_completion_tokens: maxTokens,
      ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
    })
  });
  let r = await send(true);
  if (r.status === 400) {
    const body = await r.text();
    if (/response_format|json/i.test(body)) r = await send(false); // model has no JSON mode; the prompt already demands JSON
    else throw new Error(`API 400: ${body.slice(0, 300)}`);
  }
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    const est = Math.round((system.length + user.length) / 4);
    throw new Error(`API ${r.status}: ${body} [sent about ${est} tokens + up to ${maxTokens} for the reply]`);
  }
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

const FILL_SYSTEM = `You fill out web forms on behalf of the user (job applications, registrations, sign-ups, delivery details, appointment or intake forms, surveys, and so on). You get the user's profile (JSON), context about the page, an optional note from the user, and a list of form fields. Return {"answers": {"<field id>": <value>}} and nothing else.

Rules:
- Use only facts in the profile. Never invent names, dates, addresses, numbers, IDs or links. If a value can't be derived, return null and the user will fill it in.
- The same information is worded differently on every site ("Given name", "Legal first name", "First Name*", "Mobile no."). Infer what each field means from its label, hint (name/id/autocomplete), placeholder and options.
- Fields with "options" (select, radio, combobox, dropdown): the answer must be the EXACT text of one option. Pick the closest semantic match (for example "India" for a country field).
- combobox/dropdown with no options listed, or a "note" saying the list is long: return short natural text such as "India" or "Maharashtra".
- checkbox: true or false. checkbox_group: an array of exact option texts.
- Formats: type=date -> YYYY-MM-DD, type=month -> YYYY-MM, type=number -> digits only, type=tel -> follow the placeholder format and include the country code only if the field seems to want it, type=url -> full URL. Respect maxLength.
- Several addresses or contacts in the profile: choose by context (delivery/shipping -> shipping address, billing or unspecified -> home, employer/office -> work). If the user's note says the form is for someone else, use the matching person in the profile (for example under "family") or return null.
- NEVER tick or accept terms and conditions, privacy consent, marketing opt-ins, declarations, signatures or authorisation checkboxes. Return null so the user does it themselves.
- Eligibility and yes/no questions (work authorisation, age, residency): answer only if the profile says so, otherwise null.
- Sensitive categories (gender, religion, race, disability, health, income): fill only if the profile has a value. If it has none and the field offers a "prefer not to say" style option, choose it; otherwise null.
- Payment card details, passwords, one-time codes and CAPTCHAs: always null.
- Open-ended questions: for job applications (cover letter, why this company) write 2-5 sentences, first person, grounded in the profile and page context. For other forms keep it short and factual, and use profile.custom_answers when a question matches. If nothing in the profile supports an answer, null.
- Years of experience or age: compute from the profile's dates and today's date.
- Ignore fields unrelated to the form's purpose (site search, newsletter boxes, coupon codes): null.
- Output only JSON. Include every field id.`;

function compactProfile(text) {
  const strip = v => {
    if (Array.isArray(v)) { const a = v.map(strip).filter(x => x !== undefined); return a.length ? a : undefined; }
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) { if (k.startsWith('_')) continue; const y = strip(x); if (y !== undefined) o[k] = y; }
      return Object.keys(o).length ? o : undefined;
    }
    if (v === '' || v === null || v === undefined) return undefined;
    if (typeof v === 'string' && /^YYYY/i.test(v.trim())) return undefined; // untouched template placeholder
    return v;
  };
  try { return JSON.stringify(strip(JSON.parse(text)) || {}); } catch (e) { return text; }
}

async function getProfile() {
  const { profiles, activeProfileId, profile = '' } = await chrome.storage.local.get(['profiles', 'activeProfileId', 'profile']);
  if (profiles?.length) return (profiles.find(p => p.id === activeProfileId) || profiles[0]).json || '';
  return profile; // legacy single-profile storage
}

async function mapFields(fields, fullPage) {
  const s = await getSettings();
  const { userNote, ...page } = fullPage;
  const profile = await getProfile();
  if (!profile.trim()) throw new Error('No profile yet. Open FormFill AI settings and add one.');

  const profileJson = compactProfile(profile);
  const system = FILL_SYSTEM + (s.extra ? `\n\nExtra instructions from the candidate:\n${s.extra}` : '');
  const answers = {};
  const ask = async batch => {
    const user =
      `Today: ${new Date().toISOString().slice(0, 10)}\n\n` +
      `Candidate profile:\n${profileJson}\n\n` +
      `Page: ${JSON.stringify(page)}\n\n` +
      (userNote ? `Note from the user for this form: ${userNote}\n\n` : '') +
      `Fields:\n${JSON.stringify(batch)}\n\n` +
      `Return {"answers": {...}} with every field id.`;
    try {
      const out = extractJson(await callLLM(s, { system, user }));
      Object.assign(answers, out.answers || out);
    } catch (e) {
      // Model/provider limit hit: split the batch and try again.
      if (batch.length > 1 && /reduce the length|too long|too large|context|token|413|429/i.test(e.message)) {
        const mid = Math.ceil(batch.length / 2);
        await ask(batch.slice(0, mid));
        await ask(batch.slice(mid));
      } else throw e;
    }
  };
  for (let i = 0; i < fields.length; i += 15) await ask(fields.slice(i, i + 15));
  return answers;
}

async function parseResume({ text, schema }) {
  const s = await getSettings();
  const { resume } = await chrome.storage.local.get('resume');
  const system = 'You turn resumes into structured JSON profiles that are later used to fill web forms. Output only JSON that follows the given schema. Fill only what the resume states, and use empty strings or empty arrays for everything else (addresses, IDs and family details are usually not in a resume). Never invent facts. Dates as YYYY-MM.';
  let pdf;
  let body = text || '';
  if (!body) {
    if (!resume) throw new Error('Upload a resume first, or paste its text.');
    if (resume.type !== 'application/pdf' || s.provider !== 'anthropic') {
      throw new Error('Reading a resume file needs a PDF and the Anthropic provider. Otherwise paste the text.');
    }
    pdf = resume.base64;
    body = '(The resume is attached as a PDF.)';
  }
  const user = `Schema:\n${schema}\n\nResume:\n${body}\n\nReturn the completed profile JSON.`;
  const out = extractJson(await callLLM(s, { system, user, pdf, maxTokens: 4000 }));
  return JSON.stringify(out, null, 2);
}

function fillTab(tabId, overwrite) {
  return chrome.tabs.sendMessage(tabId, { type: 'FILL', overwrite: !!overwrite }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'MAP_FIELDS':
      mapFields(msg.fields, { ...msg.page, tabTitle: sender.tab?.title })
        .then(answers => sendResponse({ answers }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    case 'GET_RESUME':
      chrome.storage.local.get('resume').then(({ resume }) => sendResponse(resume || null));
      return true;
    case 'PARSE_RESUME':
      parseResume(msg)
        .then(profile => sendResponse({ profile }))
        .catch(e => sendResponse({ error: e.message }));
      return true;
    case 'FILL_TAB':
      if (sender.tab?.id != null) fillTab(sender.tab.id, msg.overwrite);
      return false;
  }
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'fill-form') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) fillTab(tab.id, false);
});
