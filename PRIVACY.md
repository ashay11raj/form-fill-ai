# FormFill AI privacy policy

Last updated: 2026-09-20

FormFill AI is a browser extension that fills web forms using an AI model you choose. It has no server of its own and no analytics.

## What it stores (on your device only)
Stored in your browser's extension storage (`chrome.storage.local`):
- the API key you enter
- your profiles (JSON with the personal information you choose to add) and, optionally, a resume file
- your settings (provider, model, base URL, extra instructions, preferences)

None of this is sent to the developer of this extension.

## What it sends, and when
Only when you trigger a fill (button, popup or keyboard shortcut), the extension sends this to the AI provider you configured (for example Anthropic, Google, Groq, OpenAI, OpenRouter, or a local Ollama server):
- your active profile (empty values removed)
- a description of the form fields on the current page (labels, hints, options) and short page context such as the page title, headline and, for long-answer questions, a short excerpt of the page text
- the optional note you typed in the popup
- when you use "Fill from my resume": your resume file (Anthropic only) or the resume text you pasted

The extension does not read text you have already typed into fields, except to skip fields that already have a value.

## Sensitive fields
Payment card fields, passwords, one-time codes and CAPTCHAs are never read, sent or filled. ID-number fields (such as Aadhaar, PAN, SSN or passport) are skipped unless you turn on the setting that allows them; if you do, ID numbers in your profile are sent to your AI provider when a form asks for them.

## Third-party providers
The provider's own terms and privacy policy apply to data sent to it. Some free tiers may use submitted content to improve their products, so check your provider's terms before using real personal data.

## What it does not do
- It does not submit forms.
- It does not sell or share your data, and does not use it for advertising, profiling or credit decisions.
- It does not collect browsing history or run on its own in the background. It acts on a page only when you ask it to.

## Deleting your data
Remove the extension, or clear the fields and profiles in its settings page, to delete everything it stores.

## Contact
YOUR EMAIL OR GITHUB ISSUES URL
