# LECTOR TRANSLATE KUCHKAROV — 6.0 boshqaruv tekshiruvi

© 2026 Kuchkarov M.A. All rights reserved. Proprietary software; no license is granted to copy, rebrand, redistribute or host this software without written permission.

## Run
Install Node.js 18+, open this folder and run `npm start`. Open http://localhost:3000. To use on phones, deploy this **entire Node.js server** to a hosting provider supporting Node (e.g. Render), and access the HTTPS domain. A static Netlify upload alone **cannot run the backend**.

Set `ALLOWED_HOSTS` to your actual domain names (comma-separated, omit protocol), only after verifying the live domain. Configure `LIBRETRANSLATE_URL` and optional `LIBRETRANSLATE_API_KEY` as **server environment variables**, never in JavaScript/HTML. The translation provider must support the selected language pair; not all ten languages are supported by every provider. Without a configured provider, translation will show an error, not a fake result.

## Protection implemented
- Explicit public-file allowlist: `server.js`, `.env`, README and backend files are never served.
- Teacher secret required for publishing and monitoring; student-specific random token required to read live events and update presence.
- Origin validation, optional host allowlist, content security policy, anti-framing and browser security headers.
- Basic per-IP request limits, input validation, size caps, expiry of sessions and presence.
- Provider API key stored on the server only. No public source maps. Branding and proprietary copyright notice.

## Important limitations
This does **not** make browser HTML/CSS/JS impossible to copy; no website can do that. Host private server code and keys yourself. CORS, minification, disabled right-click, and obfuscation alone do not prevent copying. For stronger legal protection, register the relevant trademark and publish a clear usage/license policy.

## Deployment checklist
1. Upload only this project to a trusted Node hosting account; keep the Git repository private.
2. Set HTTPS and `ALLOWED_HOSTS` to your real hostnames; configure a real translation provider.
3. Verify teacher create, join, student language selection, live text, monitoring, PDF, and error handling on actual devices.
4. For production at scale, replace in-memory sessions and per-process rate limits with Redis or a database, add login/authentication, durable transcripts, reverse-proxy IP rate limits and monitoring.
5. Zoom/Telegram direct audio integrations, camera OCR and full 10-language speech support are not implemented in this release.

## 6.0 tekshiruvi
- Brauzerda O‘qituvchi/Talaba almashishi, interfeys tili, nutq tili, matn qo‘shish tekshirildi.
- Sessiya va tarjima serverga bog‘liq; server ishlamasa tugma xato xabarini ko‘rsatadi.
- Tarjima provayderi ulanmaguncha avtomatik tarjima ishlamaydi.
- `LECTOR_KUCHKAROV_KORISH.html` faqat interfeysni ko‘rish uchun; jonli xizmatlar uchun `npm start` va HTTPS kerak.


## 7.0 dizayn yangilanishi
Qora fon, tiniq kontrast, moslashuvchan panellar. dark.css faylini style.css va app.js bilan birga joylashtiring. Funksional tarjima serveri sozlanishi alohida talab.
