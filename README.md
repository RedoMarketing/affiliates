# Redo Affiliates

Public portal for Redo's Merchant Led Growth program — a single-page app where merchants track their brand wins, earn milestone rewards, run paid campaigns, and watch their payouts.

## Status

Prototype. Static HTML/CSS/JS, no build step. Auth and data persistence currently in `localStorage`; Supabase integration coming.

## Run locally

```
python3 -m http.server 5200
```

Then open http://localhost:5200/

## Files

- `index.html` — landing, sign-in/up modal, merchant portal, admin portal (all in one file)
- `redo-wordmark.svg` — Redo logo
- `fonts.css` — Instrument Serif + Inter
- `rewards/` — product images for milestone tiers (drop PNGs here)

## Routes

- `/` — marketing landing (logged-out)
- After sign-in:
  - Merchants → portal (Campaigns / Wins / Rewards / Share / Earnings)
  - `@redo.com` emails → admin (Overview / Merchants / Campaigns / Payouts / Activity)

## Demo accounts (seeded into localStorage on first load)

- `founder@wildflower.co` — merchant
- `braxton@redo.com` — admin
