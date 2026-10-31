# 🚀 CertiAI — Complete Netlify & Cloud Deployment Guide

This guide explains how to deploy **CertiAI** to **Netlify** and set up the **Faculty Multi-Key Rotation Engine**.

---

## 📌 Architecture Overview

CertiAI consists of:
1. **Frontend**: Static Web UI (HTML5, Vanilla CSS3, JavaScript, Chart.js, ExcelJS) in `public/`.
2. **Backend**: Express.js server (`server.js`) with image compression (`sharp`), OCR (`tesseract.js`), ZIP extraction (`adm-zip`), and Excel generation & export (`exceljs`).

### Why Frontend on Netlify + Backend on Render?
- **Netlify** is a Jamstack / CDN host. Its serverless functions have a **10-second execution timeout** and an ephemeral filesystem (no persistent uploads folder).
- Processing **200–400 certificates** in a bulk batch can take 30–90 seconds, which will timeout on standard Netlify serverless functions.
- **The Best Practice Solution**:
  - Deploy the **Frontend to Netlify** (Free global CDN, ultra-fast load times).
  - Deploy the **Backend to Render.com** (Free continuous Node.js service, handles long batches without timeouts).
  - Netlify automatically proxies `/api/*` requests to your Render backend via `netlify.toml` with **zero CORS issues**!
  - **Zero Database Required**: Pure Excel mode! All records are formatted into downloadable `.xlsx` spreadsheets without needing MySQL.

---

## 🌐 Method 1: Netlify + Render (Recommended)

### Step 1: Deploy Backend to Render (5 minutes)
1. Push this project to your GitHub account:
   ```bash
   git init
   git add .
   git commit -m "CertiAI Multi-Key and Netlify ready"
   git remote add origin https://github.com/YOUR_USERNAME/CertAI.git
   git push -u origin main
   ```
2. Go to [dashboard.render.com](https://dashboard.render.com) and click **New +** -> **Web Service**.
3. Select your GitHub repository.
4. Configure the settings:
   - **Name**: `certai-backend`
   - **Language**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
5. Click **Create Web Service**.
6. Once deployed, Render will provide a live URL like:
   `https://certai-backend.onrender.com`

---

### Step 2: Deploy Frontend to Netlify (3 minutes)

#### Option A: Via GitHub (Continuous Deployment)
1. Log in to [app.netlify.com](https://app.netlify.com).
2. Click **Add new site** -> **Import an existing project** -> Select **GitHub**.
3. Pick your repository.
4. Configure:
   - **Base directory**: Leave blank
   - **Publish directory**: `public`
5. Open `netlify.toml` in your repository and update the redirect rule:
   ```toml
   [[redirects]]
     from = "/api/*"
     to = "https://YOUR-RENDER-BACKEND.onrender.com/api/:splat"
     status = 200
     force = false
   ```
6. Click **Deploy Site**. Netlify will give you a domain like `https://certai-portal.netlify.app`.

#### Option B: Instant Netlify Drag & Drop (No Git required)
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Drag and drop the `public` folder from this project into the box.
3. Your frontend is live in 10 seconds!
4. Open your live Netlify site -> Click **🔑 API Keys** in the navbar -> In "Advanced Settings", paste your Render backend URL into **Custom Backend API URL** and click **Save**.

---

## 📊 Step 3: Zero-Database Architecture (Standalone Excel Mode)

CertiAI is designed for faculty independence:
- **No MySQL Server Required**: No local MySQL installation, cloud databases, port forwarding, or connection credentials needed.
- **Direct Excel Spreadsheet Generation**: All extracted records are automatically structured, styled with department-standard typography, and saved directly to `downloads/certificates.xlsx`.
- **Open Faculty Access**: No login barriers or admin credentials needed. Any faculty member can open the application, configure their API keys, upload certificates, and download the resulting Excel file immediately.

---

## 🔑 Step 4: Faculty Multi-Key AI Setup (UI Guide)

Faculty members do **NOT** need to edit `.env` or restart servers:

1. Open your live CertiAI site (`https://your-site.netlify.app` or `http://localhost:3000`).
2. Click **🔑 API Keys** in the top navbar.
3. Enter **3 to 4 Google Gemini API keys**:
   - Get free keys at: [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
   - Paste Key 1 in Slot 1
   - Paste Key 2 in Slot 2
   - Paste Key 3 in Slot 3
   - Paste Key 4 in Slot 4
4. Click **🧪 Test & Validate Keys**:
   - CertiAI tests all 4 keys in parallel with Google Gemini API.
   - Shows green badge `🟢 Active (210ms)` for working keys.
   - Flags revoked, leaked, or rate-limited keys instantly.
5. Click **💾 Save & Apply Keys**:
   - Keys are stored in the faculty browser session (`localStorage`) and synced to the server.
   - The navbar badge turns to `⚡ 4 Active`.
6. Start batch extraction:
   - When faculty uploads 200–400 certificates or folder, CertiAI automatically rotates through Key 1 -> Key 2 -> Key 3 -> Key 4 sequentially.
   - If any key encounters a rate limit (HTTP 429), it automatically fails over to the next key without halting the batch!

---

## 🛠️ Testing Locally

To run and test the complete app locally before deploying:
```bash
npm start
```
Open [http://localhost:3000](http://localhost:3000) in your browser.
