// FormFill AI - content script (runs in every frame).
// 1) describes the fillable fields, 2) asks the background worker (LLM) what to put in each, 3) fills them.
// It never submits a form.

(() => {
  if (window.__jobfillLoaded) return;
  window.__jobfillLoaded = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = t => (t || '').replace(/\s+/g, ' ').trim();
  const norm = t => clean(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

  // ---------- DOM helpers ----------

  function queryAllDeep(root, selector, out = []) {
    root.querySelectorAll(selector).forEach(e => out.push(e));
    root.querySelectorAll('*').forEach(e => {
      if (e.shadowRoot) queryAllDeep(e.shadowRoot, selector, out);
    });
    return out;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  }

  function textFromIds(el, ids) {
    const root = el.getRootNode();
    return ids
      .split(/\s+/)
      .map(id => (root.getElementById ? root.getElementById(id) : document.getElementById(id))?.textContent)
      .filter(Boolean)
      .map(clean)
      .join(' ');
  }

  function labelText(el) {
    const parts = [];
    const lb = el.getAttribute('aria-labelledby');
    if (lb) parts.push(textFromIds(el, lb));
    if (el.labels) for (const l of el.labels) parts.push(clean(l.textContent));
    const al = el.getAttribute('aria-label');
    if (al) parts.push(clean(al));
    let text = parts.filter(Boolean).join(' ');
    if (text) return text.slice(0, 400);

    // Fall back to the nearest label-like element in an ancestor that holds few inputs.
    let node = el.parentElement;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      if (node.querySelectorAll('input, select, textarea').length > 2) break;
      const cands = node.querySelectorAll('label, legend, [class*="label" i], [role="heading"], h1, h2, h3, h4, h5, h6');
      for (const c of cands) {
        if (c.contains(el)) continue;
        const t = clean(c.textContent);
        if (t && t.length < 300) return t;
      }
    }
    const prev = el.previousElementSibling || el.parentElement?.previousElementSibling;
    if (prev) {
      const t = clean(prev.textContent);
      if (t && t.length < 200) return t;
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || '');
  }

  function choiceText(el) {
    if (el.labels && el.labels.length) return clean(el.labels[0].textContent);
    const direct = el.getAttribute('aria-label') || el.getAttribute('data-value');
    if (direct) return clean(direct);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = textFromIds(el, lb);
      if (t) return t;
    }
    const wrap = el.closest('label');
    if (wrap) return clean(wrap.textContent);
    const sib = el.nextElementSibling?.textContent || el.nextSibling?.textContent;
    if (clean(sib)) return clean(sib);
    return clean(el.parentElement?.textContent) || el.value || '';
  }

  function groupLabel(els) {
    const first = els[0];
    const fs = first.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (fs) {
      const lb = fs.getAttribute('aria-labelledby');
      if (lb) {
        const t = textFromIds(fs, lb);
        if (t) return t;
      }
      const al = fs.getAttribute('aria-label');
      if (al) return clean(al);
      const lg = fs.querySelector('legend');
      if (lg) return clean(lg.textContent);
    }
    let node = first.parentElement;
    while (node && !els.every(e => node.contains(e))) node = node.parentElement;
    const optTexts = els.map(e => norm(choiceText(e)));
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const cands = node.querySelectorAll('legend, label, [class*="label" i], [role="heading"], h1, h2, h3, h4, h5, h6, p');
      for (const c of cands) {
        if (els.some(e => c.contains(e) || (e.labels && [...e.labels].includes(c)))) continue;
        const t = clean(c.textContent);
        if (t && t.length < 400 && !optTexts.includes(norm(t))) return t;
      }
      const prev = node.previousElementSibling;
      if (prev) {
        const t = clean(prev.textContent);
        if (t && t.length < 300) return t;
      }
    }
    return '';
  }

  const isChecked = el => (typeof el.checked === 'boolean' ? el.checked : el.getAttribute('aria-checked') === 'true');
  const isRequired = (el, label) => !!(el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\(required\)/i.test(label || ''));

  // ---------- field collection ----------

  let cfg = { fillIdNumbers: false };
  let guardedCount = 0;
  const PAY_RE = /card\s*(number|no\b|holder)|\bcc[-_ ]?(num|number|csc|exp|name)|\bcvv\b|\bcvc\b|security code|expir(y|ation) date|\biban\b|routing number|account number|sort code|\bswift\b|\bifsc\b|\bupi\b|\botp\b|one[- ]time|verification code|captcha|password/i;
  const ID_RE = /\bssn\b|social security|aadhaar|aadhar|\bpan\b|passport|driver'?s? licen[cs]e|driving licen[cs]e|national (id|identity)|tax (id|identification)|\bnin\b|voter id|\bitin\b|\bein\b|\bgstin\b/i;

  // Payment, password and one-time-code fields are never read or filled. ID numbers only if enabled in settings.
  function blocked(el, label) {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const text = [label, el.name, el.id, ac, el.getAttribute('data-automation-id')].filter(Boolean).join(' ');
    if (/(^|\s)cc-|one-time-code|current-password|new-password/.test(ac) || PAY_RE.test(text)) { guardedCount++; return true; }
    if (!cfg.fillIdNumbers && ID_RE.test(text)) { guardedCount++; return true; }
    return false;
  }

  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search', 'range', 'color']);
  const PLACEHOLDER_OPT = /^(select|choose|please select|pick|--|—|none selected)/i;

  function collect(overwrite) {
    guardedCount = 0;
    const registry = new Map();
    const fields = [];
    const fileInputs = [];
    let n = 0;
    const add = (entry, desc) => {
      const id = 'f' + ++n;
      registry.set(id, entry);
      fields.push({ id, ...desc });
    };

    const nodes = queryAllDeep(
      document,
      'input, textarea, select, button[aria-haspopup="listbox"], [role="radiogroup"], [role="listbox"], [role="checkbox"]'
    );
    const radios = new Map();
    const checks = new Map();
    let uniq = 0;

    for (const el of nodes) {
      if (el.closest('[role="search"], nav')) continue;
      const tag = el.tagName;
      const role = el.getAttribute('role');

      if (tag === 'INPUT') {
        const type = (el.type || 'text').toLowerCase();
        if (SKIP_TYPES.has(type) || el.disabled || el.readOnly) continue;
        if (type === 'file') { fileInputs.push(el); continue; }
        if (type === 'radio') {
          if (!isVisible(el) && !isVisible(el.parentElement)) continue;
          const key = (el.form ? 'f' : 'd') + '|' + (el.name || 'r' + uniq++);
          (radios.get(key) || radios.set(key, []).get(key)).push(el);
          continue;
        }
        if (type === 'checkbox') {
          if (!isVisible(el) && !isVisible(el.parentElement)) continue;
          const key = el.name ? (el.form ? 'f' : 'd') + '|' + el.name : 'c' + uniq++;
          (checks.get(key) || checks.set(key, []).get(key)).push(el);
          continue;
        }
        if (!isVisible(el)) continue;
        const isCombo = role === 'combobox' || el.getAttribute('aria-autocomplete') || el.getAttribute('aria-haspopup') === 'listbox';
        if (isCombo) {
          const box = el.closest('[class*="container" i], [class*="control" i]') || el.parentElement;
          if (!overwrite && box?.querySelector('[class*="single-value" i], [class*="singleValue" i]')) continue;
        } else if (!overwrite && el.value) continue;
        const label = labelText(el);
        if (blocked(el, label)) continue;
        add({ kind: isCombo ? 'combobox' : 'text', el }, {
          kind: isCombo ? 'combobox' : 'text',
          type,
          label,
          hint: clean([el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('data-automation-id')].filter(Boolean).join(' | ')),
          placeholder: el.placeholder || undefined,
          required: isRequired(el, label),
          maxLength: el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : undefined
        });
        continue;
      }

      if (tag === 'TEXTAREA') {
        if (el.disabled || el.readOnly || !isVisible(el)) continue;
        if (!overwrite && el.value) continue;
        const label = labelText(el);
        if (blocked(el, label)) continue;
        add({ kind: 'text', el }, {
          kind: 'textarea',
          label,
          hint: clean([el.name, el.id].filter(Boolean).join(' | ')),
          placeholder: el.placeholder || undefined,
          required: isRequired(el, label),
          maxLength: el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : undefined
        });
        continue;
      }

      if (tag === 'SELECT') {
        if (el.disabled || !isVisible(el)) continue;
        const opts = [...el.options].filter(o => (o.value !== '' || clean(o.text)) && !PLACEHOLDER_OPT.test(clean(o.text)));
        if (!opts.length) continue;
        const first = el.options[0];
        const hasPlaceholder = first && (first.value === '' || PLACEHOLDER_OPT.test(clean(first.text)));
        if (!overwrite && el.selectedIndex > 0 && el.value !== '' ) continue;
        if (!overwrite && !hasPlaceholder && el.selectedIndex === 0 && el.options.length > 1 && el.dataset.jfTouched) continue;
        const label = labelText(el);
        if (blocked(el, label)) continue;
        add({ kind: 'select', el }, {
          kind: 'select',
          label,
          hint: clean([el.name, el.id, el.getAttribute('autocomplete')].filter(Boolean).join(' | ')),
          ...(opts.length <= 40
            ? { options: opts.map(o => clean(o.text).slice(0, 80)) }
            : { note: `long list of ${opts.length} options; answer with the plain value (e.g. "India")` }),
          required: isRequired(el, label)
        });
        continue;
      }

      if (tag === 'BUTTON' || role === 'listbox') {
        if (!isVisible(el)) continue;
        if (role === 'listbox' && [...el.querySelectorAll('[role="option"]')].some(isVisible)) continue; // an open popup, not a trigger
        const shown = clean(el.textContent);
        if (!overwrite && shown && !PLACEHOLDER_OPT.test(shown) && !/^select one$/i.test(shown)) continue;
        const label = labelText(el);
        if (blocked(el, label)) continue;
        if (!label) continue;
        add({ kind: 'dropdown', el }, { kind: 'dropdown', label, required: isRequired(el, label) });
        continue;
      }

      if (role === 'radiogroup') {
        if (el.querySelector('input[type="radio"]')) continue; // native radios handled above
        const choices = [...el.querySelectorAll('[role="radio"]')].filter(isVisible);
        if (!choices.length) continue;
        if (!overwrite && choices.some(isChecked)) continue;
        const texts = choices.map(choiceText);
        const label = groupLabel(choices);
        add({ kind: 'radio', els: choices, texts }, { kind: 'radio', label, options: texts, required: isRequired(el, label) });
        continue;
      }

      if (role === 'checkbox' && tag !== 'INPUT') {
        if (!isVisible(el)) continue;
        const box = el.closest('[role="group"], [role="list"], [role="listitem"]') || el.parentElement;
        const key = 'a|' + (box ? (box.__jfk ||= 'g' + uniq++) : 'x' + uniq++);
        (checks.get(key) || checks.set(key, []).get(key)).push(el);
      }
    }

    for (const els of radios.values()) {
      if (!overwrite && els.some(isChecked)) continue;
      const texts = els.map(choiceText);
      const label = groupLabel(els);
      add({ kind: 'radio', els, texts }, { kind: 'radio', label, options: texts, required: els.some(e => isRequired(e, label)) });
    }

    for (const els of checks.values()) {
      if (els.length === 1) {
        const el = els[0];
        if (isChecked(el)) continue;
        const label = choiceText(el) || labelText(el);
        add({ kind: 'checkbox', el }, { kind: 'checkbox', label, required: isRequired(el, label) });
      } else {
        if (!overwrite && els.some(isChecked)) continue;
        const texts = els.map(choiceText);
        const label = groupLabel(els);
        add({ kind: 'checkbox_group', els, texts }, { kind: 'checkbox_group', label, options: texts, required: els.some(e => isRequired(e, label)) });
      }
    }

    return { registry, fields, fileInputs, guarded: guardedCount };
  }

  // ---------- matching ----------

  function score(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.includes(b) || b.includes(a)) return 60 + 30 * Math.min(a.length, b.length) / Math.max(a.length, b.length);
    const ta = new Set(a.split(' ')), tb = new Set(b.split(' '));
    let inter = 0;
    ta.forEach(t => tb.has(t) && inter++);
    return 60 * inter / Math.max(ta.size, tb.size);
  }

  function bestMatch(items, target, getText = x => x) {
    let best = null, bs = 0;
    for (const it of items) {
      const s = score(getText(it), target);
      if (s > bs) { bs = s; best = it; }
    }
    return bs >= 45 ? best : null;
  }

  // ---------- low-level input simulation ----------

  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus?.();
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function blurEl(el) {
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.blur?.();
  }

  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, opts));
    }
  }

  async function waitForOptions(timeout = 1500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const opts = queryAllDeep(document, '[role="option"], .pac-item').filter(isVisible);
      if (opts.length) return opts;
      await sleep(100);
    }
    return [];
  }

  // ---------- applying answers ----------

  const truthy = v => v === true || /^(true|yes|y|1|checked|agree)$/i.test(String(v));

  async function fillCombobox(el, value) {
    const text = String(value);
    const attempts = [text];
    const short = text.split(/[,(]/)[0].trim();
    if (short && short !== text) attempts.push(short);
    for (const t of attempts) {
      el.focus();
      realClick(el);
      setValue(el, '');
      setValue(el, t);
      const opts = await waitForOptions();
      const pick = bestMatch(opts, t, o => o.textContent);
      if (pick) {
        realClick(pick);
        await sleep(150);
        return 'ok';
      }
    }
    return 'review'; // text stays typed; the user should confirm it
  }

  async function fillDropdown(el, value) {
    realClick(el);
    const opts = await waitForOptions();
    const pick = bestMatch(opts, String(value), o => o.textContent);
    if (pick) {
      realClick(pick);
      await sleep(150);
      return 'ok';
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'review';
  }

  function formatDate(value, type) {
    const s = String(value).trim();
    if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(s);
      return isNaN(d) ? s : d.toISOString().slice(0, 10);
    }
    if (type === 'month' && !/^\d{4}-\d{2}$/.test(s)) {
      const d = new Date(s);
      return isNaN(d) ? s : d.toISOString().slice(0, 7);
    }
    return s;
  }

  async function applyAnswer(entry, desc, value) {
    const { kind, el } = entry;
    if (kind === 'text') {
      let v = Array.isArray(value) ? value.join(', ') : String(value);
      if (desc.type === 'number') v = v.replace(/[^0-9.\-]/g, '');
      if (desc.type === 'date' || desc.type === 'month') v = formatDate(v, desc.type);
      if (desc.maxLength) v = v.slice(0, desc.maxLength);
      setValue(el, v);
      blurEl(el);
      return 'ok';
    }
    if (kind === 'select') {
      const opts = [...el.options];
      const pick = bestMatch(opts, String(value), o => o.text) || bestMatch(opts, String(value), o => o.value);
      if (!pick) return 'review';
      el.selectedIndex = pick.index;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dataset.jfTouched = '1';
      return 'ok';
    }
    if (kind === 'radio') {
      const idx = entry.texts.findIndex(t => norm(t) === norm(String(value)));
      const target = idx >= 0 ? entry.els[idx] : bestMatch(entry.els, String(value), e => choiceText(e));
      if (!target) return 'review';
      if (!isChecked(target)) target.tagName === 'INPUT' ? target.click() : realClick(target);
      return 'ok';
    }
    if (kind === 'checkbox') {
      if (isChecked(el) !== truthy(value)) el.tagName === 'INPUT' ? el.click() : realClick(el);
      return 'ok';
    }
    if (kind === 'checkbox_group') {
      const wanted = Array.isArray(value) ? value : [value];
      let hit = 0;
      for (const w of wanted) {
        const target = bestMatch(entry.els, String(w), e => choiceText(e));
        if (target) {
          if (!isChecked(target)) target.tagName === 'INPUT' ? target.click() : realClick(target);
          hit++;
        }
      }
      return hit ? 'ok' : 'review';
    }
    if (kind === 'combobox') return fillCombobox(el, value);
    if (kind === 'dropdown') return fillDropdown(el, value);
    return 'review';
  }

  function mark(el, color) {
    if (!el) return;
    el.style.setProperty('outline', `2px solid ${color}`, 'important');
    el.style.setProperty('outline-offset', '2px', 'important');
  }

  const primaryEl = entry => entry.el || entry.els?.[0]?.closest('fieldset, [role="radiogroup"], [role="group"]') || entry.els?.[0]?.parentElement;

  // Text that describes ONE file input: its own label/name/id plus the nearest wrapper
  // that does not also contain another file input (so "Cover letter" next door can't leak in).
  function fileContext(input, all) {
    const own = [labelText(input), input.name, input.id, input.getAttribute('data-automation-id'), input.getAttribute('aria-label'), input.getAttribute('data-testid')]
      .filter(Boolean).join(' ');
    let node = input.parentElement, near = '';
    for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
      if (all.some(o => o !== input && node.contains(o))) break;
      near = clean(node.textContent).slice(0, 300);
    }
    return { own, near };
  }

  async function attachResume(inputs, overwrite) {
    const out = { done: 0, missing: false, debug: [], candidates: 0 };
    if (!inputs.length) return out;
    const resume = await chrome.runtime.sendMessage({ type: 'GET_RESUME' });
    if (!resume?.base64) {
      out.missing = inputs.some(i => { const c = fileContext(i, inputs); return /resume|\bcv\b|curriculum/i.test(c.own + ' ' + c.near); });
      return out;
    }
    const ext = (resume.name || '').split('.').pop().toLowerCase();

    for (const input of inputs) {
      const { own, near } = fileContext(input, inputs);
      const text = own + ' ' + near;
      const tag = clean(own || near).slice(0, 60) || 'file input';
      if (input.disabled) { out.debug.push(`${tag}: disabled`); continue; }
      if (input.files?.length && !overwrite) { out.debug.push(`${tag}: already has a file`); continue; }
      const isResume = /resume|\bcv\b|curriculum/i.test(text);
      const isCover = /cover/i.test(text);
      if (isCover && !isResume) { out.debug.push(`${tag}: looks like a cover letter, skipped`); continue; }
      if (!isResume && inputs.length > 1) { out.debug.push(`${tag}: unclear which upload this is, skipped`); continue; }
      out.candidates++;
      const accept = (input.accept || '').toLowerCase();
      if (accept && !accept.includes('*') && !accept.includes(ext) && !accept.includes((resume.type || '').toLowerCase())) {
        out.debug.push(`${tag}: accepts ${accept}, your file is .${ext}`);
        continue;
      }
      try {
        const bin = atob(resume.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], resume.name || 'resume.pdf', { type: resume.type || 'application/pdf', lastModified: Date.now() }));
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        out.done++;
        out.debug.push(`${tag}: attached ${resume.name}`);
      } catch (e) {
        out.debug.push(`${tag}: error ${e.message}`);
      }
    }
    return out;
  }

  function pageContext(fields, note) {
    const hasLong = fields.some(f => f.kind === 'textarea');
    const h1 = clean(document.querySelector('h1')?.textContent || '').slice(0, 200);
    let text = '';
    if (hasLong) text = clean((document.querySelector('main') || document.body).innerText).slice(0, 1200);
    return { host: location.hostname, path: location.pathname, h1, text, userNote: note || undefined };
  }

  // ---------- orchestration ----------

  let running = false;

  async function fillPage({ overwrite, note }) {
    if (running) return;
    running = true;
    try {
      const { settings } = await chrome.storage.local.get('settings');
      cfg = { fillIdNumbers: !!settings?.fillIdNumbers };
      const { registry, fields, fileInputs, guarded } = collect(!!overwrite);
      if (!fields.length && !fileInputs.length) return;

      toast('Reading the form…', 'busy');
      const report = { type: 'REPORT', frame: location.hostname, filled: 0, review: [], missing: [], files: 0, guarded, error: null };

      let answers = {};
      if (fields.length) {
        const res = await chrome.runtime.sendMessage({ type: 'MAP_FIELDS', fields, page: pageContext(fields, note) });
        if (res?.error) report.error = res.error;
        else answers = res?.answers || {};
      }

      if (!report.error) {
        toast('Filling…', 'busy');
        for (const desc of fields) {
          const entry = registry.get(desc.id);
          const v = answers[desc.id];
          const label = (desc.label || desc.hint || desc.kind).slice(0, 80);
          if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) {
            if (desc.required) { report.missing.push(label); mark(primaryEl(entry), '#d97706'); }
            continue;
          }
          try {
            const state = await applyAnswer(entry, desc, v);
            if (state === 'ok') { report.filled++; mark(primaryEl(entry), '#16a34a'); }
            else { report.review.push(label); mark(primaryEl(entry), '#d97706'); }
          } catch (e) {
            report.review.push(label);
          }
          await sleep(60);
        }
      }

      const att = await attachResume(fileInputs, !!overwrite);
      report.files = att.done;
      report.resumeMissing = att.missing;
      report.fileInputs = att.candidates;
      report.fileDebug = att.debug;

      chrome.runtime.sendMessage(report).catch(() => {});
      if (report.error) toast(report.error, 'error');
      else toast(`Filled ${report.filled}${report.files ? ' + resume' : ''}.${report.resumeMissing ? ' No resume stored: add one in settings.' : report.fileInputs && !report.files ? ` Found ${report.fileInputs} upload field(s) but attached none; open the popup for details.` : ''}${report.review.length + report.missing.length ? ` ${report.review.length + report.missing.length} need a look (orange).` : ''} ${report.guarded ? ` Left ${report.guarded} sensitive field(s) (payment, password, ID) for you.` : ''} Review, then submit.`, 'ok');
    } catch (e) {
      toast(String(e.message || e), 'error');
    } finally {
      running = false;
    }
  }

  // ---------- in-page button + toast (shadow DOM so site CSS can't touch it) ----------

  let ui = null;
  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .wrap{display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
        button{all:unset;cursor:pointer;background:#14213d;color:#fff;padding:9px 14px;border-radius:999px;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.25)}
        button:hover{background:#1f3363} button:focus-visible{outline:2px solid #fca311;outline-offset:2px}
        .toast{max-width:280px;background:#fff;color:#14213d;border:1px solid #d5d9e2;padding:8px 12px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,.15);display:none}
        .toast.error{border-color:#dc2626;color:#991b1b}.toast.ok{border-color:#16a34a}
        .hidden{display:none}
      </style>
      <div class="wrap"><div class="toast" role="status"></div><button class="hidden" type="button">Fill with FormFill AI</button></div>`;
    document.documentElement.appendChild(host);
    const btn = root.querySelector('button');
    btn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'FILL_TAB', overwrite: false }));
    ui = { btn, toastEl: root.querySelector('.toast'), timer: null };
    return ui;
  }

  function toast(msg, kind = 'ok') {
    const u = ensureUI();
    u.toastEl.textContent = msg;
    u.toastEl.className = 'toast ' + kind;
    u.toastEl.style.display = 'block';
    clearTimeout(u.timer);
    if (kind !== 'busy') u.timer = setTimeout(() => (u.toastEl.style.display = 'none'), 9000);
  }

  let showButton = true;
  function refreshButton() {
    if (!showButton) { if (ui) ui.btn.classList.add('hidden'); return; }
    const count = document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select').length;
    if (count >= 3) ensureUI().btn.classList.remove('hidden');
    else if (ui) ui.btn.classList.add('hidden');
  }

  try {
    chrome.storage.local.get('settings').then(({ settings }) => {
      showButton = settings?.showButton !== false;
      refreshButton();
    });
    let debounce;
    new MutationObserver(() => { clearTimeout(debounce); debounce = setTimeout(refreshButton, 1200); })
      .observe(document.documentElement, { childList: true, subtree: true });

    chrome.runtime.onMessage.addListener(msg => {
      if (msg?.type === 'FILL') fillPage(msg);
    });
  } catch (e) { /* extension was reloaded; reload the page */ }
})();
