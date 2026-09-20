# FormFill AI

A Chrome extension (Manifest V3) where an LLM agent reads the fields on any web form, works out what each one is really asking, and fills it from your saved profile. Job applications, registrations, sign-ups, delivery details, intake forms, surveys. It never clicks Submit.

## Install (developer mode)
1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** and pick this folder.
3. Open the extension's settings:
   - choose a provider (Anthropic, or any OpenAI-style API such as Gemini, Groq, OpenRouter, Ollama) and paste a key
   - create your profile (JSON). "Load blank template" gives a starting point; "Fill from my resume" can draft one
   - Save

## Use
Open a form, then click the floating **Fill with FormFill AI** button, use the toolbar popup, or press **Alt+Shift+F**.
- Pick a profile in the popup (Personal, Work, a family member...). Add an optional note such as "use work address" or "for my mother".
- Green outline: filled. Orange outline: needs your eyes (no answer in the profile, or the option didn't match cleanly).
- Multi-step forms: fill each step, then press the site's Next.
- A resume file stored in settings is attached to resume/CV upload fields.

## Safety defaults
- Never fills or reads card numbers, CVV, passwords, one-time codes or CAPTCHAs. The count of skipped sensitive fields is shown.
- ID numbers (Aadhaar, PAN, SSN, passport...) are skipped unless you switch that on in settings.
- Never ticks terms, consent, marketing or declaration checkboxes. You do that.
- Never submits.

## How it works
- `content.js` (all frames, incl. iframes and open shadow DOM) turns each control into a descriptor: label, aria text, name/id/autocomplete hints, type, options, required, maxLength. Radios and checkboxes are grouped into one question.
- `background.js` sends the active profile plus descriptors to the LLM and gets back `{id: answer}`. Choice fields must be answered with an exact option text.
- The content script fills with native setters and real event sequences (works with React/Angular controlled inputs) and drives combobox/dropdown widgets by opening them and clicking the matching option.

## Privacy
Profiles, resume and API key live in `chrome.storage.local`. The active profile and the field list for the page you are on go to the provider you configured, only when you trigger a fill. See PRIVACY.md.

## Known limits
- Custom widgets (typeahead multi-selects, some date pickers, grids) are best-effort. Unmatched fields are left blank and outlined orange.
- Closed shadow DOM and cross-origin iframes the extension cannot enter are not readable.
- Login, CAPTCHA, payment and final submit stay manual on purpose.
