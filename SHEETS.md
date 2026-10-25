# Google Sheets flavor (this fork)

This fork adds a server-less build of openGym that syncs with a Google Sheet instead of an
openGym server. It is published to GitHub Pages by .github/workflows/sheets-pages.yml.

- Build: cd frontend && npm run build:sheets (sets VITE_SHEETS=1).
- The app runs in guest mode (data on the device) and syncs through the sheet's Apps Script web
  app, using the Lift Log sheet layout (Workouts, Sets, Cardio, Body, Templates tabs).
- Workouts logged in openGym are written as source = opengym rows. Everything else in the sheet
  (Strong history, Strava cardio, smart-scale weigh-ins) shows up in openGym as read-only history.
- Code: frontend/src/lib/sheets-sync.js (+ tests), the Sheets section in views/Settings.jsx,
  and the SHEETS branches in store/useStore.js.
- Connect: in the sheet, Lift Log menu -> Connect openGym... makes a link; paste it in openGym ->
  Settings -> Google Sheets. Never commit a real link: it works like a password.

Passkey sign-in, push notifications and the admin dashboard need the openGym server and are not
part of this build. openGym is AGPL-3.0-or-later; this fork keeps that license.
