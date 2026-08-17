# node-3tradingapp

[Edit in StackBlitz next generation editor ⚡️](https://stackblitz.com/~/github.com/branagh88/node-3tradingapp)

## CORS & Tickerbot API

Live browser calls from StackBlitz to https://api.tickerbot.io are subject to CORS and could not be verified from this offline tree. The app surfaces network/CORS failures gracefully (NETWORK OR CORS ERROR / UNAVAILABLE states) and deliberately includes NO fake proxy or mock. A local dev proxy pass-through (e.g. a Vite devServer proxy or a tiny Node server forwarding to api.tickerbot.io) is the intended workaround — it is not part of this repo.