# HRS Draft Invoice Hub

Node.js endpoint emulator and live dashboard for receiving, inspecting, grouping, and deleting HRS draft invoice payloads.

## Run locally

```powershell
npm ci
npm start
```

Open `http://localhost:9090`.

## Live deployment

https://hrseinvoice.onrender.com

## Endpoints

- `POST /connect/token`
- `POST /api/InvoiceHub/ImportInvoiceJsonData`
- `GET /`
- `GET /invoice/:billNo`
- `GET /invoice/:billNo/cheques`
- `GET /health`

## Deploy

The included `render.yaml` defines a Render Node.js web service. Create a Render Blueprint from this repository to deploy it.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/kynguyentani/hrs-draft-invoice-hub)

## Operational notes

- Invoice data is stored in memory and is cleared whenever the server restarts.
- The emulator endpoints have no production authentication or persistent storage.
- Do not send sensitive or production guest data to a public deployment.
