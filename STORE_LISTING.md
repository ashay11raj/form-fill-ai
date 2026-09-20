# Chrome Web Store listing kit

**Name:** FormFill AI
**Category:** Productivity
**Summary (max 132 chars):** An AI agent that reads any web form and fills it from your saved profile. You review and submit.

## Description
Tired of typing the same personal details into every form? FormFill AI reads the form in front of you, works out what each question is really asking, and fills it from your own saved profile.

- Understands differently worded questions ("Given name", "Legal first name", "First Name*")
- Handles text fields, dropdowns, radio buttons, checkboxes, comboboxes and longer answers
- Multiple profiles (personal, work, family) and an optional note per form, like "use work address"
- Attaches your resume to resume/CV upload fields
- Green outline = filled. Orange outline = please check
- Never submits for you, and never ticks terms or consent boxes
- Never fills card numbers, CVV, passwords or one-time codes. ID numbers only if you allow it
- Bring your own AI: Claude, Gemini, Groq, OpenAI, OpenRouter or a local Ollama model
- Your profile and API key stay in your browser. Data goes only to the provider you choose, only when you click fill

Custom widgets on some sites may need a manual touch.

## Single purpose
Fill web forms with the user's own saved information using an AI model chosen by the user.

## Permission justifications
- **storage / unlimitedStorage:** saves the API key, profiles and an optional resume file locally. The resume file can be several MB.
- **activeTab:** lets the toolbar popup and keyboard shortcut trigger a fill on the current tab.
- **Content script on all URLs (all frames):** forms exist on any website and are often inside embedded iframes. The script reads form fields only when the user triggers a fill, and shows a small floating button on pages that contain forms.
- **Host permissions (api.anthropic.com, api.openai.com):** sends the user's fill requests to the AI provider they configured. Optional host permissions are requested only for a custom provider URL the user enters.
- **Remote code:** none. All code ships in the package.

## Privacy practices tab
- Data handled: personally identifiable information (the user's own profiles), authentication information (the user's own API key), website content (form fields on the active page).
- Purpose: app functionality only. Not sold, not used for unrelated purposes, not used for creditworthiness or lending.
- Privacy policy URL: link to PRIVACY.md in the GitHub repo.

## Assets to prepare
- 128x128 icon (included at icons/128.png)
- At least 1 screenshot, 1280x800 (or 640x400): the popup after a fill, and a form with green/orange outlines
- Small promo tile 440x280 (optional but recommended)
