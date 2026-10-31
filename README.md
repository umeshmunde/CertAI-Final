# CertiAI: AI Certificate Extraction & Automation System

## 🌟 Project Overview
**CertiAI** is an intelligent web application designed to eliminate the tedious, manual data-entry process required for logging student or employee certificates. 

By utilizing advanced **Optical Character Recognition (OCR)** and the **Google Gemini 2.5 Flash AI** model, CertiAI effortlessly visually parses unstructured certificate images (or Google Drive links) and structures key details into highly-organized, downloadable Excel reports. Furthermore, it operates as a full **Digital Credentials Management System** by providing Learner Analytics and automated top-performer tracking.

---

## 🛠 Tech Stack
* **Frontend:** HTML5, CSS3 (Glassmorphism Next-Gen UI), Vanilla JavaScript.
* **Backend:** Node.js, Express.js
* **AI & APIs:** Google Gemini 2.5 Flash API (LLM Parser), OCR.Space API (Image-to-Text).
* **Data & File System:** Multer (File Upload Handling), ExcelJS (Spreadsheet Management).

---

## 🎨 1. Concept Diagram
*This high-level diagram visualizes the overarching goal of the project: turning messy visual data into actionable intelligence.*

```mermaid
graph TD
    A[Unstructured Data<br/>Certificate Images / Links] --> |Upload / Submit| B((CertiAI Platform))
    
    B --> C[Structured Database<br/>Excel Spreadsheets]
    B --> D[Learner Analytics<br/>Student Profiles & Timeline]
    B --> E[Merit Tracking<br/>Top Achievers Report]
    
    style A fill:#f8fafc,stroke:#a5b4fc,stroke-width:2px;
    style B fill:#6366f1,stroke:#ffffff,stroke-width:3px,color:#fff;
    style C fill:#10b981,stroke:#059669,stroke-width:2px,color:#fff;
    style D fill:#ec4899,stroke:#be185d,stroke-width:2px,color:#fff;
    style E fill:#8b5cf6,stroke:#6d28d9,stroke-width:2px,color:#fff;
```

---

## 🏗 2. Block Diagram (Architecture)
*This diagram shows the system architecture, detailing the specific components within the frontend, the backend server, and the external cloud APIs.*

```mermaid
graph LR
    subgraph Frontend Client
        U[User Interface]
        S[Single Page Router]
        F[File/Drive Uploader]
    end

    subgraph Backend Server Node.js
        API[Express.js Endpoints]
        Storage[Local Uploads/Downloads]
        Excel[ExcelJS Engine]
        Fallback[Heuristics Fallback Parser]
    end

    subgraph External Cloud APIs
        OCR[OCR.Space API]
        LLM[Google Gemini 2.5 Flash]
    end

    U -->|POST /api/extract| API
    S -->|GET /api/records| API
    F -->|Multipart File| API
    
    API -->|Save temporarily| Storage
    API -->|Image File| OCR
    OCR -->|Raw Unstructured Text| API
    
    API -->|Prompt + Text| LLM
    LLM -->|Formatted JSON| API
    
    API -->|Parsed User Data| Excel
    Excel -->|Append Rows| Storage
```

---

## 🔄 3. Process Flow Diagram
*This Sequence Diagram outlines the step-by-step logic that happens when a user clicks the "Extract Data Now" button.*

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant F as Frontend App
    participant B as Node Express Backend
    participant O as OCR API
    participant G as Gemini AI API
    participant E as Excel File
    
    U->>F: Uploads Certificate (JPG/PNG) or Drive URL
    F->>B: Sends API Request (POST)
    
    alt is Google Drive Link
        B->>B: Convert Drive Link to Direct Download
        B->>B: Download & Save JPG locally
    end

    B->>O: Streams image for OCR parsing
    O-->>B: Returns raw noisy string/text
    
    B->>G: Crafts Prompt with raw text requesting JSON rules
    G-->>B: Returns highly structured JSON (Name, Event, Dates, etc.)
    
    alt AI Network Fails
        B->>B: Falls back to built-in Regex matchers
    end
    
    B->>E: Opens "certificates.xlsx" & Adds New Row
    B-->>F: Responds with Success Message & Extracted Data
    
    F->>F: Identifies if "Top Performer" & Updates Stats
    F-->>U: Renders new table row and Analytics Dashboard
```

---

## 🚀 Key Features

1. **Intelligent Data Parsing:** Understands unstructured, messy formats natively relying on cognitive AI contexts rather than rigid templates.
2. **Auto-Identify Top Performers:** Recognizes "Winner", "Merit", "1st Prize", etc., and dynamically pulls these individuals into special achievement reports.
3. **Learner Analytics Dashboard:** Allows administrators to search for any individual and instantly populate a timeline of their digital credentials, calculating their dominant "Skill Domain" and proficiency automatically.
4. **Resilient Local Fallback:** In cases where internet/AI constraints drop, relies on a custom-built Regex certificate parser to ensure operations don't freeze.
5. **No Config DB:** Opts for direct-to-Excel append writing, meaning the data exported is immediately ready for institutional reporting without requiring database extraction.

---

## 💻 Installation & Setup Instructions

To run this project locally on your machine, follow these steps:

### Prerequisites
* Node.js (v16.x or newer)
* npm (Node Package Manager)

### 1. Clone the repository
Move into the project folder:
```bash
cd finalmajor
```

### 2. Install Dependencies
Install all the required Node packages (Express, Multer, ExcelJS, Axios, dotenv, etc.):
```bash
npm install
```

### 3. Environment Variables (.env)
You must create a `.env` file in the root directory and add your API keys. Without these, the application will not be able to parse text or extract data.
```env
PORT=3000
OCR_API_KEY=your_ocr_space_api_key
GEMINI_API_KEY=your_google_gemini_api_key
```
*Note: You can get a free OCR key from [OCR.space](https://ocr.space/ocrapi) and a free Gemini key from [Google AI Studio](https://aistudio.google.com/).*

### 4. Start the Application
Run the start script to launch the Node Express server:
```bash
npm start
```
*Alternatively, you can just run `node server.js` directly.*

### 5. Open in Browser
Once the server is running, you can access the completely functional UI at:
**[http://localhost:3000](http://localhost:3000)**
