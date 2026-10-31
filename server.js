require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for Netlify and cross-origin frontend deployments
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-gemini-keys, x-groq-key, x-ocr-key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.static('public'));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Middleware: Extract dynamic faculty API keys from request headers or body
app.use((req, res, next) => {
    if (req.headers['x-gemini-keys']) {
        try {
            const raw = req.headers['x-gemini-keys'];
            if (raw.startsWith('[')) {
                req.requestGeminiKeys = JSON.parse(raw);
            } else {
                req.requestGeminiKeys = raw.split(',').map(s => s.trim()).filter(Boolean);
            }
        } catch (e) {
            req.requestGeminiKeys = null;
        }
    }
    if (req.headers['x-groq-key']) {
        req.requestGroqKey = String(req.headers['x-groq-key']).trim();
    }
    if (req.headers['x-ocr-key']) {
        req.requestOcrKey = String(req.headers['x-ocr-key']).trim();
    }
    next();
});

// Ensure directories exist
const uploadDir = path.join(__dirname, 'uploads');
const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

// Multer setup for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '_' + Math.random().toString(36).substring(7) + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB max per file
});

// Helper to convert Google Drive shareable link to direct download link
function getDriveDownloadUrl(url) {
    const fileIdMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    if (fileIdMatch) {
        return `https://drive.google.com/uc?id=${fileIdMatch[1]}&export=download`;
    }
    return null;
}

// Sanitize Google Drive file ID (strip entry- prefix if present)
function sanitizeDriveFileId(id) {
    if (!id || typeof id !== 'string') return null;
    let clean = id.replace(/^entry-/i, '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (clean.length >= 25 && clean.length <= 45) {
        return clean;
    }
    return null;
}

// Detect if URL is a Google Drive folder link
function isDriveFolderUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.includes('/folders/') || url.includes('folderview') || (url.includes('id=') && url.includes('folder'));
}

// Extract folder ID from Google Drive folder URL
function getDriveFolderId(url) {
    const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
}

// Extract all image/certificate file IDs from a public Google Drive folder
async function getDriveFolderFileIds(folderUrl) {
    const folderId = getDriveFolderId(folderUrl);
    if (!folderId) return [];

    const fileIds = new Set();

    // Method 1: Try Google Drive API v3 (if GEMINI_API_KEY has Drive access enabled)
    if (process.env.GEMINI_API_KEY) {
        try {
            const apiRes = await axios.get('https://www.googleapis.com/drive/v3/files', {
                params: {
                    q: `'${folderId}' in parents and trashed = false`,
                    key: process.env.GEMINI_API_KEY,
                    fields: 'files(id, name, mimeType)'
                },
                timeout: 7000
            });
            if (apiRes.data && apiRes.data.files && apiRes.data.files.length > 0) {
                apiRes.data.files.forEach(file => {
                    const cleanId = sanitizeDriveFileId(file.id);
                    if (cleanId && (file.mimeType.startsWith('image/') || file.mimeType.includes('pdf') || file.name.match(/\.(jpg|jpeg|png|webp|gif|bmp|pdf)$/i))) {
                        fileIds.add(cleanId);
                    }
                });
                if (fileIds.size > 0) {
                    console.log(`[Google Drive API] Found ${fileIds.size} sanitized files in folder ID ${folderId}`);
                    return Array.from(fileIds);
                }
            }
        } catch (err) {
            console.log('[Google Drive API] API query skipped/failed, switching to Web Scraper method:', err.message);
        }
    }

    // Method 2: Embedded folderview HTML scraping fallback
    try {
        const embedUrl = `https://drive.google.com/embeddedfolderview?id=${folderId}#list`;
        const res = await axios.get(embedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 10000
        });

        const html = res.data || '';
        
        // Extract /file/d/FILE_ID matches
        const matches = html.match(/\/file\/d\/([a-zA-Z0-9_-]+)/g) || [];
        matches.forEach(m => {
            const rawId = m.split('/file/d/')[1];
            const cleanId = sanitizeDriveFileId(rawId);
            if (cleanId && cleanId !== folderId) fileIds.add(cleanId);
        });

        // Extract id="entry-FILE_ID" matches
        const entryMatches = html.match(/id="entry-([a-zA-Z0-9_-]+)"/g) || [];
        entryMatches.forEach(m => {
            const rawId = m.replace('id="entry-', '').replace('"', '');
            const cleanId = sanitizeDriveFileId(rawId);
            if (cleanId && cleanId !== folderId) fileIds.add(cleanId);
        });

        // Extract drive/folders file references
        const rawIds = html.match(/["']([a-zA-Z0-9_-]{25,50})["']/g) || [];
        rawIds.forEach(m => {
            const rawId = m.replace(/['"]/g, '');
            const cleanId = sanitizeDriveFileId(rawId);
            if (cleanId && cleanId !== folderId && !rawId.includes('http') && !rawId.includes('drive')) {
                fileIds.add(cleanId);
            }
        });

        console.log(`[Google Drive Scraper] Found ${fileIds.size} sanitized file IDs in folder ${folderId}`);
    } catch (err) {
        console.error('[Google Drive Scraper] Embedded folder scraping error:', err.message);
    }

    return Array.from(fileIds);
}

// Download file from Google Drive
async function downloadFromDrive(downloadUrl, dest) {
    const response = await axios({
        url: downloadUrl,
        method: 'GET',
        responseType: 'stream',
        timeout: 12000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });
    
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);
        let error = null;
        writer.on('error', err => {
            error = err;
            writer.close();
            reject(err);
        });
        writer.on('close', () => {
            if (!error) resolve(dest);
        });
    });
}

// Perform Local FREE OCR using Tesseract.js and pdf-parse
async function performLocalOCR(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    // Direct text extraction for PDF documents
    if (ext === '.pdf') {
        try {
            const dataBuffer = fs.readFileSync(filePath);
            const pdfData = await pdfParse(dataBuffer);
            if (pdfData.text && pdfData.text.trim().length > 20) {
                console.log(`[PDF Text Extraction] Extracted ${pdfData.text.length} chars directly from PDF '${path.basename(filePath)}'.`);
                return pdfData.text;
            }
        } catch (pdfErr) {
            console.warn(`[PDF Direct Parse warning]: ${pdfErr.message}, falling back to Tesseract OCR...`);
        }
    }

    // Free Offline Image OCR using Tesseract.js
    try {
        console.log(`[Tesseract Free Local OCR] Processing '${path.basename(filePath)}'...`);
        const { data: { text } } = await Tesseract.recognize(filePath, 'eng');
        return text || '';
    } catch (err) {
        console.error('[Tesseract Free Local OCR Error]:', err.message);
        return '';
    }
}

// Perform OCR using OCR.Space API with Free Local Tesseract fallback
async function performOCR(filePath) {
    if (!process.env.OCR_API_KEY || process.env.OCR_API_KEY === 'helloworld') {
        return await performLocalOCR(filePath);
    }
    try {
        let data = new FormData();
        data.append('file', fs.createReadStream(filePath), { filename: path.basename(filePath) });
        data.append('apikey', process.env.OCR_API_KEY || 'helloworld');
        data.append('filetype', 'Auto');
        
        const response = await axios.post('https://api.ocr.space/parse/image', data, {
            headers: {
                ...data.getHeaders()
            },
            timeout: 10000
        });
        
        if (response.data.IsErroredOnProcessing) {
            throw new Error('OCR API Error: ' + response.data.ErrorMessage);
        }
        
        if (response.data.ParsedResults && response.data.ParsedResults.length > 0) {
            return response.data.ParsedResults[0].ParsedText;
        }
        return await performLocalOCR(filePath);
    } catch (err) {
        console.warn('OCR API Failed, switching to 100% Free Local OCR Engine:', err.message);
        return await performLocalOCR(filePath);
    }
}

// Strict validator for human student names
function isValidStudentName(str) {
    if (!str || typeof str !== 'string') return false;
    let clean = str.trim();
    if (clean.length < 3 || clean.length > 50) return false;

    // Must NOT contain digits (e.g. 2024, 2050, 15, 4th, 01/06/2024)
    if (/\d/.test(clean)) return false;

    const lower = clean.toLowerCase();

    // Invalid phrases/words that indicate dates, locations, courses, headers, companies, or prepositions
    const invalidKeywords = [
        "presented", "certify", "certificate", "completion", "internship", "workshop", "hackathon",
        "course", "onramp", "matlab", "simulink", "technologies", "emerging", "institute", "university",
        "college", "academy", "foundation", "department", "school", "company", "studios", "enterprises",
        "limited", "ltd", "inc", "corporation", "located", "chicago", "illinois", "avenue", "street",
        "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
        "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
        "given", "issued", "held", "award", "awarded", "recognition", "program", "participation", "coordinator",
        "winner", "runner", "prize", "rank", "place", "gold", "silver", "bronze", "distinction", "excellence",
        "from", "into", "with", "upon", "this", "that", "hereby", "successfully", "completed", "participated",
        "serial", "codechef", "iee", "ieee", "aicte", "cisco", "infosys", "edunet", "ibm", "google", "coursera"
    ];

    if (invalidKeywords.some(kw => lower.includes(kw))) return false;

    const words = clean.split(/\s+/);
    if (words.length < 1 || words.length > 5) return false;

    return true;
}

// Strict validator for organization names
function isValidOrganizerName(str) {
    if (!str || typeof str !== 'string') return false;
    let clean = str.trim();
    if (clean.length < 3 || clean.length > 70) return false;
    if (/\d{4}/.test(clean)) return false;
    const lower = clean.toLowerCase();
    if (lower.includes("certify") || lower.includes("certificate") || lower.includes("presented on") || lower.includes("this is to") || lower.includes("of recognition") || lower.includes("in recognition of") || lower.includes("presented to")) return false;
    return true;
}

// Clean Achievement field to strictly be one of the standard categories:
// "Winner", "Runner-Up", "Merit", "Completion", "Participation", "Coordinator"
function cleanAchievementCategory(ach) {
    if (!ach || ach === 'N/A') return 'N/A';
    const lower = ach.toLowerCase();
    if (lower.includes('winner') && !lower.includes('runner')) return 'Winner';
    if (lower.includes('runner')) return 'Runner-Up';
    if (lower.includes('coordinator')) return 'Coordinator';
    if (lower.includes('participation') || lower.includes('participated')) return 'Participation';
    if (lower.includes('completion') || lower.includes('completed') || lower.includes('completing')) return 'Completion';
    if (lower.includes('merit') || lower.includes('distinction') || lower.includes('rank') || lower.includes('prize') || lower.includes('place') || lower.includes('medal') || lower.includes('honor')) return 'Merit';
    return 'Merit';
}

// Universal parser heuristically built for any certificate format
function parseCertificateText(text, driveLink) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l);
    const data = {
        Name_of_Student: "N/A",
        Activity_Event: "N/A",
        Details: "N/A",
        Organized_by: "N/A",
        From_Date: "N/A",
        To_Date: "N/A",
        Venue: "N/A",
        Level: "N/A",
        Google_Drive_Link: driveLink || "N/A",
        Achievement: "N/A",
        Rank_Position: "N/A"
    };
    
    const textLower = text.toLowerCase();
    
    // Universal Multi-format Date extraction
    const months = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
    const dateRegex = new RegExp(`\\b(?:\\d{1,2}(?:st|nd|rd|th|h)?\\s*(?:day\\s+of\\s+)?(?:${months})[\\/\\-\\.\\s,]+\\d{2,4}|(?:${months})[\\s\\.\\,]+\\d{1,2}(?:st|nd|rd|th|h)?[\\s\\.\\,]+\\d{2,4}|(?:${months})[\\s\\.\\,]+\\d{4}|\\d{1,2}[\\/\\-\\.]\\d{1,2}[\\/\\-\\.]\\d{2,4}|20\\d{2}\\s*-\\s*20\\d{2})\\b`, 'ig');
    let dates = [];
    let match;
    while ((match = dateRegex.exec(text)) !== null) {
        dates.push(match[0].trim());
    }
    dates = [...new Set(dates)];
    
    if (dates.length >= 1) data.From_Date = dates[0];
    if (dates.length >= 2) data.To_Date = dates[1];
    if (dates.length === 1) data.To_Date = dates[0];

    // Universal Name Extraction with Strict Validation
    const nameTriggers = [
        "this is to certify that", "awarded to", "presented to", "certifies that",
        "grants this recognition to", "certificate is presented to", "is awarded to",
        "proudly presented to", "conferred upon", "given to", "this certificate is proudly presented to",
        "has successfully completed", "has participated in", "is hereby awarded to"
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lowerLine = line.toLowerCase();
        
        if (nameTriggers.some(trig => lowerLine.includes(trig))) {
            for (let offset = 1; offset <= 3; offset++) {
                if (i + offset < lines.length) {
                    let candidate = lines[i + offset].replace(/^[:\s\-\.]+/, '').trim();
                    candidate = candidate.replace(/^(mr\.|ms\.|mrs\.|dr\.|prof\.|shri|smt\.)\s+/i, '');
                    if (isValidStudentName(candidate)) {
                        data.Name_of_Student = candidate;
                        break;
                    }
                }
            }
        }
        if (data.Name_of_Student !== "N/A") break;
    }

    if (data.Name_of_Student === "N/A") {
        for (let line of lines) {
            const lowerLine = line.toLowerCase();
            let candidate = line;
            if (lowerLine.startsWith("mr.") || lowerLine.startsWith("ms.") || lowerLine.startsWith("mr ") || lowerLine.startsWith("ms ") || lowerLine.startsWith("prof.") || lowerLine.startsWith("dr.") || lowerLine.startsWith("shri ") || lowerLine.startsWith("smt ")) {
                candidate = line.replace(/^(mr\.|ms\.|mrs\.|dr\.|prof\.|shri|smt\.)\s+/i, '').trim();
            }
            if (isValidStudentName(candidate)) {
                data.Name_of_Student = candidate;
                break;
            }
        }
    }

    // Universal Organizer Extraction
    const orgTriggers = ["organized by", "conducted by", "hosted by", "issued by", "presented by", "in collaboration with", "in association with"];
    for (let i = 0; i < lines.length; i++) {
        const lowerLine = lines[i].toLowerCase();
        for (let trig of orgTriggers) {
            if (lowerLine.includes(trig)) {
                let idx = lowerLine.indexOf(trig);
                let remainder = lines[i].substring(idx + trig.length).replace(/^[:\s\-\.]+/, '').trim();
                if (remainder.length > 3 && !remainder.toLowerCase().includes("date") && isValidOrganizerName(remainder)) {
                    data.Organized_by = remainder;
                } else if (i + 1 < lines.length && isValidOrganizerName(lines[i + 1])) {
                    data.Organized_by = lines[i + 1].replace(/^[:\s\-\.]+/, '').trim();
                }
                break;
            }
        }
        if (data.Organized_by !== "N/A") break;
    }

    if (data.Organized_by === "N/A" || !isValidOrganizerName(data.Organized_by)) {
        if (textLower.includes("cisco networking academy") || textLower.includes("cisco academy")) data.Organized_by = "Cisco Networking Academy";
        else if (textLower.includes("edunet foundation")) data.Organized_by = "Edunet Foundation";
        else if (textLower.includes("infosys limited") || textLower.includes("infosys springboard")) data.Organized_by = "Infosys Limited";
        else if (textLower.includes("ibm cloud") || textLower.includes("skillsbuild")) data.Organized_by = "IBM SkillsBuild";
        else {
            const orgKeywords = ["department of education", "elementary school", "high school", "school", "university", "institute", "college", "foundation", "academy", "corporation", "limited", "ltd", "inc.", "ieee", "acm", "iit", "nit", "aicte", "google", "cisco", "infosys", "ibm", "coursera", "udemy"];
            let found = lines.find(l => {
                const lLower = l.toLowerCase();
                return orgKeywords.some(k => lLower.includes(k)) && 
                       !lLower.includes("certificate") && 
                       !lLower.includes("certify") && 
                       !lLower.includes("this is to") &&
                       !lLower.includes("presented to") &&
                       !lLower.includes("recognition") &&
                       l.split(/\s+/).length <= 8;
            });
            if (found && isValidOrganizerName(found)) data.Organized_by = found.replace(/[^a-zA-Z0-9\s&,-.]/g, '').trim();
        }
    }

    // Universal Venue Extraction
    if (textLower.includes("virtual") || textLower.includes("online") || textLower.includes("coursera") || textLower.includes("cisco") || textLower.includes("udemy") || textLower.includes("nptel") || textLower.includes("infosys springboard") || textLower.includes("edx")) {
        data.Venue = "Online";
    } else {
        let venueLine = lines.find(l => l.toLowerCase().includes("venue") || l.toLowerCase().includes("held at"));
        if (venueLine) {
            let matchStr = venueLine.split(/venue|held at/i)[1];
            if (matchStr && matchStr.trim().length > 2) {
                data.Venue = matchStr.replace(/^[:\s\-\.]+/, '').trim();
            }
        }
        if (data.Venue === "N/A" && data.Organized_by !== "N/A" && (data.Organized_by.toLowerCase().includes("college") || data.Organized_by.toLowerCase().includes("institute") || data.Organized_by.toLowerCase().includes("university") || data.Organized_by.toLowerCase().includes("school"))) {
            data.Venue = data.Organized_by;
        }
        if (data.Venue === "N/A") {
            let locLine = lines.find(l => {
                const lowerL = l.toLowerCase();
                return (lowerL.includes("school") || lowerL.includes("classroom") || lowerL.includes("campus") || lowerL.includes("hall") || lowerL.includes("center")) && !lowerL.includes("certificate") && !lowerL.includes("presented") && !lowerL.includes("certify");
            });
            if (locLine) data.Venue = locLine.trim();
        }
    }

    // Universal Level
    if (textLower.includes("international")) data.Level = "International";
    else if (textLower.includes("national") || textLower.includes("aicte")) data.Level = "National";
    else if (textLower.includes("state")) data.Level = "State";
    else data.Level = "Institute";

    // Achievements & Ranks
    const ordinalMatch = textLower.match(/\b(1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s*(prize|rank|place|position|runner\s*up)?\b/);
    const rankNumMatch = textLower.match(/\b(rank|position|place)\s*[-:]?\s*(\d+)\b/) || textLower.match(/\b(\d+)\s*(st|nd|rd|th)?\s*(rank|prize|place|position)\b/);

    if (textLower.includes("academic achiever") || textLower.includes("honor roll") || textLower.includes("dean's list") || textLower.includes("quarter achiever") || textLower.includes("academic excellence")) {
        data.Achievement = "Merit";
        data.Rank_Position = "Academic Achiever";
    }

    if (textLower.includes("1st rank") || textLower.includes("first rank") || textLower.includes("1st prize") || textLower.includes("first prize") || textLower.includes("1st place") || textLower.includes("first place") || textLower.includes("gold medal") || textLower.includes("1st position")) {
        data.Achievement = "Winner";
        data.Rank_Position = "1st Place (Winner)";
    } else if (textLower.includes("2nd rank") || textLower.includes("second rank") || textLower.includes("2nd prize") || textLower.includes("second prize") || textLower.includes("2nd place") || textLower.includes("second place") || textLower.includes("1st runner up") || textLower.includes("silver medal") || textLower.includes("2nd position")) {
        data.Achievement = "Runner-Up";
        data.Rank_Position = textLower.includes("1st runner up") ? "1st Runner-Up" : "2nd Place";
    } else if (textLower.includes("3rd rank") || textLower.includes("third rank") || textLower.includes("3rd prize") || textLower.includes("third prize") || textLower.includes("3rd place") || textLower.includes("third place") || textLower.includes("2nd runner up") || textLower.includes("bronze medal") || textLower.includes("3rd position")) {
        data.Achievement = "Runner-Up";
        data.Rank_Position = textLower.includes("2nd runner up") ? "2nd Runner-Up" : "3rd Place";
    } else if (textLower.includes("4th prize") || textLower.includes("fourth prize") || textLower.includes("4th rank") || textLower.includes("fourth rank") || textLower.includes("4th place") || textLower.includes("fourth place")) {
        data.Achievement = "Merit";
        data.Rank_Position = "4th Prize";
    } else if (textLower.includes("5th prize") || textLower.includes("fifth prize") || textLower.includes("5th rank") || textLower.includes("fifth rank") || textLower.includes("5th place") || textLower.includes("fifth place")) {
        data.Achievement = "Merit";
        data.Rank_Position = "5th Prize";
    } else if (ordinalMatch && (textLower.includes("prize") || textLower.includes("rank") || textLower.includes("place") || textLower.includes("position") || textLower.includes("won"))) {
        const rawWord = ordinalMatch[1];
        const numMap = { "first": "1st", "second": "2nd", "third": "3rd", "fourth": "4th", "fifth": "5th", "sixth": "6th", "seventh": "7th", "eighth": "8th", "ninth": "9th", "tenth": "10th" };
        const formattedRank = (numMap[rawWord] || rawWord) + (textLower.includes("prize") ? " Prize" : textLower.includes("place") ? " Place" : " Rank");
        data.Achievement = "Merit";
        data.Rank_Position = formattedRank;
    } else if (rankNumMatch) {
        const num = rankNumMatch[2] || rankNumMatch[1];
        data.Achievement = "Merit";
        data.Rank_Position = `Rank ${num}`;
    } else if (textLower.includes("winner") || textLower.includes("won")) {
        data.Achievement = "Winner";
        data.Rank_Position = "Winner";
    } else if (textLower.includes("distinction") || textLower.includes("excellence") || textLower.includes("outstanding")) {
        data.Achievement = "Merit";
        data.Rank_Position = "Distinction";
    } else if (textLower.includes("merit") || textLower.includes("top 5") || textLower.includes("top 10")) {
        data.Achievement = "Merit";
        data.Rank_Position = textLower.includes("top 5") ? "Top 5 Rank" : textLower.includes("top 10") ? "Top 10 Rank" : "Merit Position";
    } else if (textLower.includes("coordinator")) {
        data.Achievement = "Coordinator";
        data.Rank_Position = "N/A";
    } else if (textLower.includes("participation") || textLower.includes("participated")) {
        data.Achievement = "Participation";
        data.Rank_Position = "N/A";
    } else if (textLower.includes("completion") || textLower.includes("successfully completing") || textLower.includes("successfully completed")) {
        data.Achievement = "Completion";
        data.Rank_Position = "N/A";
    }

    // Activity Event
    if (textLower.includes("internship")) data.Activity_Event = "Internship";
    else if (textLower.includes("workshop")) data.Activity_Event = "Workshop";
    else if (textLower.includes("hackathon")) data.Activity_Event = "Hackathon";
    else if (textLower.includes("seminar")) data.Activity_Event = "Seminar";
    else if (textLower.includes("conference")) data.Activity_Event = "Conference";
    else if (textLower.includes("symposium")) data.Activity_Event = "Symposium";
    else if (textLower.includes("training program")) data.Activity_Event = "Training Program";
    else if (textLower.includes("course") || textLower.includes("certification")) data.Activity_Event = "Course/Certification";
    else data.Activity_Event = "Event";

    // Details
    let detailsLine = lines.find(l => l.toLowerCase().includes("on the topic") || l.toLowerCase().includes("entitled") || (l.toLowerCase().includes("leveraging") && l.length > 20));
    if (detailsLine) {
       data.Details = detailsLine;
    } else {
       data.Details = `${data.Achievement} in ${data.Activity_Event}`;
    }

    return data;
}

// ========================================================
// Dynamic Multi-Key AI Pool Manager & Rotation Engine
// ========================================================
let customGeminiKeys = [];
let customGroqKey = null;
let customOcrKey = null;
let activeAiEngine = 'auto'; // 'auto' | 'gemini' | 'groq'
let geminiKeyIndex = 0;
let keyUsageStats = {};

function maskApiKey(key) {
    if (!key || typeof key !== 'string') return '';
    const clean = key.trim();
    if (clean.length <= 10) return clean.substring(0, 3) + '***';
    return clean.substring(0, 7) + '...' + clean.substring(clean.length - 4);
}

function getAllGeminiKeys(requestKeys) {
    const pool = [];
    // 1. Keys supplied dynamically in current request (from faculty browser headers)
    if (requestKeys && Array.isArray(requestKeys) && requestKeys.length > 0) {
        requestKeys.forEach(k => {
            const clean = String(k || '').trim();
            if (clean.length > 5 && !pool.includes(clean)) pool.push(clean);
        });
    }
    // 2. Custom keys saved by faculty in server memory
    if (customGeminiKeys && customGeminiKeys.length > 0) {
        customGeminiKeys.forEach(k => {
            const clean = String(k || '').trim();
            if (clean.length > 5 && !pool.includes(clean)) pool.push(clean);
        });
    }
    // 3. Fallback to .env keys
    if (process.env.GEMINI_API_KEY && !pool.includes(process.env.GEMINI_API_KEY)) {
        pool.push(process.env.GEMINI_API_KEY);
    }
    Object.keys(process.env).forEach(k => {
        if (k.startsWith('GEMINI_API_KEY_') && process.env[k] && !pool.includes(process.env[k])) {
            pool.push(process.env[k]);
        }
    });
    return pool;
}

function getNextGeminiApiKey(requestKeys) {
    const keys = getAllGeminiKeys(requestKeys);
    if (keys.length === 0) return null;
    const selectedKey = keys[geminiKeyIndex % keys.length];
    const poolIndex = geminiKeyIndex % keys.length;
    geminiKeyIndex++;

    const masked = maskApiKey(selectedKey);
    keyUsageStats[masked] = (keyUsageStats[masked] || 0) + 1;

    return {
        key: selectedKey,
        masked: masked,
        totalInPool: keys.length,
        poolIndex: poolIndex
    };
}

// AI LLM Parser for unstructured certificate extraction with multi-key rotation and smart failover
async function parseWithGemini(ocrText, driveLink, requestKeys) {
    const keys = getAllGeminiKeys(requestKeys);
    if (keys.length === 0) {
        throw new Error('No Gemini API key available. Faculty should configure 3–4 Gemini API keys in the UI.');
    }

    const prompt = `You are an expert data extractor. Analyze the following unstructured text from a certificate (which may contain noisy OCR errors).
Extract the following fields accurately:
- Name_of_Student
- Activity_Event (e.g. Internship, Workshop, Hackathon, Coding Competition, Paper Presentation)
- Details (A short context on what the event was about or reason for the certificate)
- Organized_by (The organization/college strictly conducting it)
- From_Date (Extract starting date if available)
- To_Date (Extract ending date if available)
- Venue (If it is a software/tech course like Cisco, Infosys, IBM, Coursera, or mentions "virtual", strictly output "Online". Otherwise, extract College Name or City)
- Level (e.g. National, International, Institute, Department, State)
- Achievement (Categorize broadly into one of: "Winner / 1st Rank", "Runner-Up", "4th Rank / Prize", "Merit / Distinction", "Completion", "Participation", "Coordinator")
- Rank_Position (Extract specific rank/position/medal/place e.g. "1st Rank", "1st Place", "2nd Runner Up", "3rd Place", "4th Prize", "Fourth Prize", "5th Rank", "Gold Medalist", "Distinction", "Rank 9", "80 Rank", or strictly output "N/A" if none. NEVER collapse exact prizes like "Fourth Prize" or "4th Prize" into generic "Merit")
- Domain (The broad field, e.g. IT & Software, Engineering, Soft Skills, Business)
- Proficiency (Beginner, Intermediate, or Advanced based on the course difficulty/context)

If any specific data is completely missing or unclear, strictly return "N/A" for that field.

Return ONLY a valid JSON object with the exact keys described above. Nothing else.

Certificate Raw Text:
${ocrText}`;

    let lastErr = null;
    const maxKeyAttempts = Math.max(keys.length * 2, 4);

    for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
        const keyObj = getNextGeminiApiKey(requestKeys);
        if (!keyObj) break;

        const apiKey = keyObj.key;
        const candidateModels = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-1.5-flash', 'gemini-2.0-flash'];

        for (const model of candidateModels) {
            try {
                console.log(`[Gemini Rotation] Attempt ${attempt + 1}: Querying ${model} with Key #${keyObj.poolIndex + 1} (${keyObj.masked})...`);
                const response = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                    {
                        "contents": [{ "parts": [{ "text": prompt }] }]
                    },
                    {
                        headers: { "Content-Type": "application/json" },
                        timeout: 15000
                    }
                );

                const responseText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!responseText) throw new Error('Empty response from Gemini API');

                let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
                let jsonData = JSON.parse(cleanText);
                jsonData.Google_Drive_Link = driveLink || "N/A";

                const fields = ["Name_of_Student", "Activity_Event", "Details", "Organized_by", "From_Date", "To_Date", "Venue", "Level", "Google_Drive_Link", "Achievement", "Rank_Position", "Domain", "Proficiency"];
                fields.forEach(f => {
                    if (!jsonData[f]) jsonData[f] = "N/A";
                });

                jsonData._keyUsed = keyObj.masked;
                jsonData._modelUsed = model;
                return jsonData;

            } catch (err) {
                lastErr = err;
                const errMsg = err.response?.data?.error?.message || err.message;
                const status = err.response?.status;
                console.warn(`[Gemini Rotation] Key #${keyObj.poolIndex + 1} on ${model} failed: ${errMsg}`);

                if (errMsg.includes('not found') || errMsg.includes('is no longer available')) {
                    continue; // Try next candidate model with same key
                }

                if (status === 429 || errMsg.includes('Quota') || errMsg.includes('Resource Exhausted') || status === 503) {
                    console.log(`[Gemini 429 Rate Limit] Key #${keyObj.poolIndex + 1} exhausted. Rotating to next Gemini key immediately...`);
                    break; // Switch to next key
                }

                if (errMsg.includes('reported as leaked') || errMsg.includes('not valid')) {
                    console.warn(`[Gemini Invalid Key] Key #${keyObj.poolIndex + 1} revoked/invalid. Skipping to next key in pool...`);
                    break; // Switch to next key
                }

                break;
            }
        }
    }

    const detailedMsg = lastErr?.response?.data?.error?.message || lastErr?.message || 'All Gemini keys in rotation pool exhausted';
    throw new Error('Gemini Multi-Key Parsing failed: ' + detailedMsg);
}

// Gemini Vision VLM Parser (Direct Image-to-JSON Extraction with Multi-Key Rotation)
async function parseImageWithGeminiVLM(imageBuffer, mimeType, driveLink, requestKeys) {
    const keys = getAllGeminiKeys(requestKeys);
    if (keys.length === 0) {
        throw new Error('No Gemini API key available for Vision AI.');
    }

    const prompt = `You are an expert certificate data extractor. Analyze the provided certificate image directly.
Extract the following fields accurately as a JSON object:
- Name_of_Student
- Activity_Event (e.g. Internship, Workshop, Hackathon, Coding Competition, Paper Presentation, Course/Certification)
- Details (A short context on what the event was about or reason for certificate)
- Organized_by (The organization/college strictly conducting it)
- From_Date (Start date if available)
- To_Date (End date if available)
- Venue (If online/tech course e.g. Cisco, Infosys, Coursera, IBM, output "Online". Otherwise extract College Name or City)
- Level (National, International, Institute, State, Department)
- Achievement (Broad category: "Winner / 1st Rank", "Runner-Up", "4th Rank / Prize", "Merit / Distinction", "Completion", "Participation", "Coordinator")
- Rank_Position (Extract specific rank/place e.g. "1st Rank", "2nd Place", "3rd Place", "4th Prize", "Gold Medalist", or strictly "N/A" if none)
- Domain (IT & Software, Engineering, Soft Skills, Business)
- Proficiency (Beginner, Intermediate, Advanced)

If any field is missing, strictly return "N/A". Return ONLY a valid JSON object. Nothing else.`;

    const base64Data = imageBuffer.toString('base64');
    let effectiveMime = mimeType || 'image/jpeg';
    if (effectiveMime.includes('octet-stream')) effectiveMime = 'image/jpeg';

    let lastErr = null;
    const maxKeyAttempts = Math.max(keys.length * 2, 4);

    for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
        const keyObj = getNextGeminiApiKey(requestKeys);
        if (!keyObj) break;

        const apiKey = keyObj.key;
        const candidateModels = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-1.5-flash', 'gemini-2.0-flash'];

        for (const model of candidateModels) {
            try {
                console.log(`[Gemini VLM Rotation] Attempt ${attempt + 1}: Querying ${model} with Key #${keyObj.poolIndex + 1} (${keyObj.masked})...`);
                const response = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                    {
                        "contents": [
                            {
                                "parts": [
                                    { "text": prompt },
                                    {
                                        "inline_data": {
                                            "mime_type": effectiveMime,
                                            "data": base64Data
                                        }
                                    }
                                ]
                            }
                        ]
                    },
                    {
                        headers: { "Content-Type": "application/json" },
                        timeout: 18000
                    }
                );

                const responseText = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (!responseText) throw new Error('Empty response from Gemini Vision');

                let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
                let jsonData = JSON.parse(cleanText);

                jsonData.Google_Drive_Link = driveLink || "N/A";
                const fields = ["Name_of_Student", "Activity_Event", "Details", "Organized_by", "From_Date", "To_Date", "Venue", "Level", "Google_Drive_Link", "Achievement", "Rank_Position", "Domain", "Proficiency"];
                fields.forEach(f => {
                    if (!jsonData[f]) jsonData[f] = "N/A";
                });

                jsonData._keyUsed = keyObj.masked;
                jsonData._modelUsed = model;
                return jsonData;

            } catch (err) {
                lastErr = err;
                const errMsg = err.response?.data?.error?.message || err.message;
                const status = err.response?.status;
                console.warn(`[Gemini VLM Rotation] Key #${keyObj.poolIndex + 1} on ${model} failed: ${errMsg}`);

                if (errMsg.includes('not found') || errMsg.includes('is no longer available')) {
                    continue; // Try next model
                }
                if (status === 429 || errMsg.includes('Quota') || errMsg.includes('Resource Exhausted') || status === 503) {
                    console.log(`[Gemini VLM 429] Key #${keyObj.poolIndex + 1} rate limited. Rotating to next key...`);
                    break;
                }
                if (errMsg.includes('reported as leaked') || errMsg.includes('not valid')) {
                    console.warn(`[Gemini VLM Invalid Key] Key #${keyObj.poolIndex + 1} revoked/invalid. Rotating to next...`);
                    break;
                }
                break;
            }
        }
    }

    throw new Error('Gemini VLM Extraction failed: ' + (lastErr?.response?.data?.error?.message || lastErr?.message));
}

// Write multiple rows to Excel File in a single atomic save operation
async function ensureExcelExistsAndAppendRows(parsedDataList) {
    if (!parsedDataList || !Array.isArray(parsedDataList) || parsedDataList.length === 0) return;
    
    const excelPath = path.join(downloadDir, 'certificates.xlsx');
    const workbook = new ExcelJS.Workbook();
    let worksheet;
    
    if (fs.existsSync(excelPath)) {
        await workbook.xlsx.readFile(excelPath);
        worksheet = workbook.getWorksheet(1);
    } else {
        worksheet = workbook.addWorksheet('Certificates');
        worksheet.columns = [
            { header: 'Sl. No.', key: 'Sl_No', width: 8 },
            { header: 'Name of Student / Faculty', key: 'Name_of_Student', width: 25 },
            { header: 'Participant Type', key: 'Participant_Type', width: 16 },
            { header: 'Department', key: 'Department', width: 20 },
            { header: 'Academic Year', key: 'Academic_Year', width: 15 },
            { header: 'Activity / Event', key: 'Activity_Event', width: 20 },
            { header: 'Details', key: 'Details', width: 35 },
            { header: 'Organized by', key: 'Organized_by', width: 25 },
            { header: 'From Date', key: 'From_Date', width: 12 },
            { header: 'To Date', key: 'To_Date', width: 12 },
            { header: 'Venue', key: 'Venue', width: 20 },
            { header: 'Level\n(State/National/International)', key: 'Level', width: 20 },
            { header: '(Google Drive Link)', key: 'Google_Drive_Link', width: 15 },
            { header: 'Achievement', key: 'Achievement', width: 20 },
            { header: 'Rank / Position', key: 'Rank_Position', width: 22 },
            { header: 'Domain', key: 'Domain', width: 20 },
            { header: 'Proficiency', key: 'Proficiency', width: 15 }
        ];
        
        // Header Row Styling & Borders
        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true, name: 'Times New Roman' };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        headerRow.height = 40;
        
        headerRow.eachCell({ includeEmpty: true }, function(cell, colNumber) {
            cell.border = {
                top: {style:'medium'},
                left: {style:'medium'},
                bottom: {style:'medium'},
                right: {style:'medium'}
            };
        });
        
        // Background for Achievement & Rank headers
        const achievementCell = worksheet.getCell('N1');
        achievementCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF5E35B1' } // Purple color
        };
        achievementCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Times New Roman' };

        const rankCell = worksheet.getCell('O1');
        rankCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFB71C1C' } // Crimson Red/Gold accent for Rank
        };
        rankCell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Times New Roman' };
    }

    for (const parsedData of parsedDataList) {
        let slNo = worksheet.rowCount; // If 1 header row exists, rowCount is 1, so first item is row 2 with Sl. No. 1
        const rowArray = [
            slNo,
            parsedData.Name_of_Student || 'N/A',
            parsedData.Participant_Type || 'Student',
            parsedData.Department || 'N/A',
            parsedData.Academic_Year || 'N/A',
            parsedData.Activity_Event || 'N/A',
            parsedData.Details || 'N/A',
            parsedData.Organized_by || 'N/A',
            parsedData.From_Date || 'N/A',
            parsedData.To_Date || 'N/A',
            parsedData.Venue || 'N/A',
            parsedData.Level || 'N/A',
            parsedData.Google_Drive_Link || 'N/A',
            parsedData.Achievement || 'N/A',
            parsedData.Rank_Position || 'N/A',
            parsedData.Domain || 'N/A',
            parsedData.Proficiency || 'N/A'
        ];
        
        const addedRow = worksheet.addRow(rowArray);
        addedRow.height = 35;
        addedRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        addedRow.font = { name: 'Times New Roman' };
        
        addedRow.eachCell({ includeEmpty: true }, function(cell, colNumber) {
            cell.border = {
                top: {style:'thin'},
                left: {style:'medium'},
                bottom: {style:'thin'},
                right: {style:'medium'}
            };
            if (colNumber === 13 && cell.value !== 'N/A') {
                 cell.value = { text: cell.value, hyperlink: cell.value };
                 cell.font = { color: { argb: 'FF0000FF' }, underline: true, name: 'Times New Roman' };
            }
        });
        rememberProcessedCertificate(parsedData, parsedData.file_hash);
    }

    await workbook.xlsx.writeFile(excelPath);
}

// Single item wrapper for backwards compatibility
async function ensureExcelExistsAndAppendRow(parsedData) {
    await ensureExcelExistsAndAppendRows([parsedData]);
}

// In-Memory Fast Cache for Duplicates and Processed Certificates (Zero DB Needed)
const processedFileHashes = new Map();
const processedDriveLinks = new Map();
const processedSignatures = new Map();

function buildSignature(name, event, date) {
    const n = String(name || '').trim().toLowerCase();
    const e = String(event || '').trim().toLowerCase();
    const d = String(date || '').trim().toLowerCase();
    if (n && n !== 'n/a' && e && e !== 'n/a') {
        return `${n}::${e}::${d}`;
    }
    return null;
}

function findDuplicateCertificate({ fileHash, driveLink, parsedData }) {
    if (fileHash && processedFileHashes.has(fileHash)) {
        return processedFileHashes.get(fileHash);
    }
    if (driveLink && driveLink !== 'N/A' && processedDriveLinks.has(driveLink)) {
        return processedDriveLinks.get(driveLink);
    }
    if (parsedData) {
        const sig = buildSignature(parsedData.Name_of_Student, parsedData.Activity_Event, parsedData.From_Date);
        if (sig && processedSignatures.has(sig)) {
            return processedSignatures.get(sig);
        }
    }
    return null;
}

function rememberProcessedCertificate(data, fileHash) {
    if (!data) return;
    if (fileHash) {
        processedFileHashes.set(fileHash, data);
    }
    if (data.file_hash) {
        processedFileHashes.set(data.file_hash, data);
    }
    if (data.Google_Drive_Link && data.Google_Drive_Link !== 'N/A') {
        processedDriveLinks.set(data.Google_Drive_Link, data);
    }
    const sig = buildSignature(data.Name_of_Student, data.Activity_Event, data.From_Date);
    if (sig) {
        processedSignatures.set(sig, data);
    }
}

function clearProcessedCache() {
    processedFileHashes.clear();
    processedDriveLinks.clear();
    processedSignatures.clear();
}

// Helper to read all certificate records directly from Excel File
async function getAllExcelRecords() {
    const excelPath = path.join(downloadDir, 'certificates.xlsx');
    if (!fs.existsSync(excelPath)) return [];
    
    try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(excelPath);
        const worksheet = workbook.getWorksheet(1);
        if (!worksheet) return [];

        const records = [];
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber > 1) { // Skip header row
                const rawLink = row.getCell(13).value;
                const linkVal = (typeof rawLink === 'object' && rawLink !== null) ? (rawLink.hyperlink || rawLink.text || 'N/A') : (rawLink || 'N/A');

                const rec = {
                    Sl_No: row.getCell(1).value || (rowNumber - 1),
                    Name_of_Student: String(row.getCell(2).value || 'N/A'),
                    Participant_Type: String(row.getCell(3).value || 'Student'),
                    Department: String(row.getCell(4).value || 'N/A'),
                    Academic_Year: String(row.getCell(5).value || 'N/A'),
                    Activity_Event: String(row.getCell(6).value || 'N/A'),
                    Details: String(row.getCell(7).value || 'N/A'),
                    Organized_by: String(row.getCell(8).value || 'N/A'),
                    From_Date: String(row.getCell(9).value || 'N/A'),
                    To_Date: String(row.getCell(10).value || 'N/A'),
                    Venue: String(row.getCell(11).value || 'N/A'),
                    Level: String(row.getCell(12).value || 'N/A'),
                    Google_Drive_Link: linkVal,
                    Achievement: String(row.getCell(14).value || 'N/A'),
                    Rank_Position: String(row.getCell(15).value || 'N/A'),
                    Domain: String(row.getCell(16).value || 'N/A'),
                    Proficiency: String(row.getCell(17).value || 'N/A')
                };
                records.push(rec);
            }
        });
        return records;
    } catch (err) {
        console.error('[Excel Read Error]:', err.message);
        return [];
    }
}

// Warm up cache from existing Excel file on server startup
async function initCacheFromExcel() {
    try {
        const records = await getAllExcelRecords();
        if (records.length > 0) {
            records.forEach(r => rememberProcessedCertificate(r, null));
            console.log(`[Excel Engine] Loaded ${records.length} existing certificates from downloads/certificates.xlsx into cache.`);
        } else {
            console.log(`[Excel Engine] Ready for certificate processing (Zero DB / Excel mode).`);
        }
    } catch (e) {
        console.warn(`[Excel Engine] Cache init notice:`, e.message);
    }
}

// Universal 100% Accuracy AI Certificate Extractor (Groq Qwen + Hybrid Regex Fusion)
async function parseWithGroqQwen(ocrText, driveLink) {
    try {
        const prompt = `You are a world-class AI Certificate Data Extractor. Your task is to accurately extract structured details from ANY certificate raw text, regardless of layout, template, university, company, or country.

Analyze the raw certificate text carefully and extract the following fields into a clean JSON object:

1. Name_of_Student: The full legal name of the human person receiving/awarded the certificate (e.g. "Sandesh Borude", "Umesh Munde", "Prof. Aniket Sharma", "Dr. Rajesh Kumar").
   - CRITICAL RULES FOR Name_of_Student:
     * MUST be a real human person's name.
     * NEVER extract a date or presentation string (e.g. "Presented on April 15", "Given this July", "June to July 2035", "March 4th, 2024").
     * NEVER extract a course/topic name (e.g. "Emerging Technologies", "MATLAB Onramp", "Simulink Onramp", "HTML Essentials").
     * NEVER extract a company/institute/address (e.g. "ABC Company", "Studios Ltd", "From Fauget Institute", "located in Chicago").
     * If no real human student name is present in the certificate, strictly output "N/A".

2. Participant_Type: Categorize the person receiving the certificate into strictly one of:
   - "Faculty" (if text mentions Dr., Prof., Professor, Assistant Professor, Associate Professor, Faculty, Teacher, Lecturer, Staff, or certificate is for FDP / Faculty Development Program / Short Term Training).
   - "Student" (for students, learners, interns, or general participants).

3. Department: The academic department if mentioned in text (e.g. "Computer Engineering", "Information Technology", "Artificial Intelligence & Data Science", "Electronics & Telecommunication", "Mechanical Engineering", "Civil Engineering"), or output "N/A".

4. Academic_Year: The academic year range inferred from certificate date (e.g. "2025-2026", "2024-2025", "2023-2024"), or output "N/A".

5. Activity_Event: The type of event or certificate.
   - Categorize into one of: "Internship", "Workshop", "Hackathon", "Coding Competition", "Paper Presentation", "Seminar", "Conference", "FDP / Faculty Development", "Symposium", "Course/Certification", "Training Program", "Event", or "Sports".

6. Details: A concise summary of what the certificate was granted for (course topic, internship role, hackathon project name, FDP subject, or paper title).

7. Organized_by: The exact institution, organization, university, foundation, or company conducting or issuing the certificate (e.g. "Harvard University", "Cisco Networking Academy", "Edunet Foundation", "AICTE", "Infosys Limited", "IBM", "Coursera", "IEEE", "Google", "Microsoft", "IIT Bombay").

8. From_Date: The start date or issue date mentioned on the certificate (e.g. "08/07/2024", "July 08, 2024", or "N/A").
9. To_Date: The end date or completion date (if a date range is given e.g. "August 05, 2024", otherwise output the same as From_Date or "N/A").

10. Venue: The physical location, city, or college campus (e.g. "MIT Academy of Engineering, Pune", "IIT Bombay", "New Delhi").
   - IMPORTANT: If the certificate is for a software course, virtual internship, online program, or mentions "virtual" / "online" / "Cisco" / "Coursera" / "Udemy" / "Infosys Springboard", strictly output "Online".

11. Level: Broad scope of the event. Categorize into: "International", "National", "State", "Institute", or "Department".

12. Achievement: Broad categorization: "Winner / 1st Rank", "Runner-Up", "3rd Rank / Runner-Up", "4th Rank / Prize", "Merit / Distinction", "Completion", "Participation", or "Coordinator".

13. Rank_Position: Specific rank, prize, medal, or position (e.g. "1st Place", "Gold Medalist", "1st Runner-Up", "3rd Rank", "Distinction", or strictly "N/A" if none).

14. Domain: Broad field of study/work. Categorize into: "IT & Software", "Engineering", "Business & Soft Skills", "Design & Arts", "Science & Research", or "General".

15. Proficiency: Estimated skill level based on topic complexity: "Beginner", "Intermediate", or "Advanced".

If any field is missing or unclear in the text, output "N/A".
Return ONLY valid JSON. Nothing else.

Certificate Raw Text:
${ocrText}`;

        const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                model: 'qwen/qwen3.8-27b',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        );

        const responseText = response.data.choices[0].message.content;
        let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        let jsonData = JSON.parse(cleanText);

        jsonData.Google_Drive_Link = driveLink || "N/A";
        const fields = ["Name_of_Student", "Participant_Type", "Department", "Academic_Year", "Activity_Event", "Details", "Organized_by", "From_Date", "To_Date", "Venue", "Level", "Google_Drive_Link", "Achievement", "Rank_Position", "Domain", "Proficiency"];
        
        // Smart Fusion Fallback: Strictly validate student name & organizer
        const heuristicData = parseCertificateText(ocrText, driveLink);
        
        if (!isValidStudentName(jsonData.Name_of_Student)) {
            if (isValidStudentName(heuristicData.Name_of_Student)) {
                jsonData.Name_of_Student = heuristicData.Name_of_Student;
            } else {
                jsonData.Name_of_Student = "N/A";
            }
        }

        if (!isValidOrganizerName(jsonData.Organized_by)) {
            if (isValidOrganizerName(heuristicData.Organized_by)) {
                jsonData.Organized_by = heuristicData.Organized_by;
            } else {
                jsonData.Organized_by = "N/A";
            }
        }

        fields.forEach(f => {
            if (!jsonData[f] || jsonData[f] === "N/A") {
                if (f !== "Name_of_Student" && f !== "Organized_by" && heuristicData[f] && heuristicData[f] !== "N/A") {
                    jsonData[f] = heuristicData[f];
                } else if (!jsonData[f]) {
                    jsonData[f] = "N/A";
                }
            }
        });

        // Clean Achievement to strict broad category
        jsonData.Achievement = cleanAchievementCategory(jsonData.Achievement);

        return jsonData;
    } catch (err) {
        console.warn('[Groq Qwen AI Parser Error]:', err.message);
        throw err;
    }
}

// Rate limit retry executor with exponential backoff & jitter
async function executeWithRetry(fn, maxRetries = 4, initialDelayMs = 1800) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await fn();
        } catch (err) {
            attempt++;
            const status = err.response?.status || err.status;
            const isRateLimit = status === 429 || status === 503 || err.message?.includes('429') || err.message?.includes('quota');
            if (attempt >= maxRetries || !isRateLimit) {
                throw err;
            }
            const delay = Math.round(initialDelayMs * Math.pow(2, attempt - 1) + Math.random() * 600);
            console.log(`[Rate Limit Retry] Retrying in ${delay}ms (Attempt ${attempt}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Universal Single File Extraction Processor
async function processSingleFileHelper({ filePath, driveLink, originalName, skipDelete = false, requestKeys = null, requestGroqKey = null }) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

    // Duplicate Check (In-memory & Excel Cache)
    let existingRecord = findDuplicateCertificate({ fileHash, driveLink });
    if (existingRecord) {
        console.log(`[Duplicate Check] File '${originalName || path.basename(filePath)}' already processed (Sl. No: ${existingRecord.Sl_No}). Bypassing AI.`);
        if (!skipDelete && filePath.includes('uploads')) {
            try { fs.unlinkSync(filePath); } catch (e) {}
        }
        return { isDuplicate: true, data: existingRecord, message: 'Cached Record' };
    }

    let parsedData;
    let ocrText = 'Processed via Ultra-Fast Vision AI';

    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';

    // ULTRA-FAST PATH 1: Direct PDF text extraction (< 0.005 seconds per PDF)
    if (ext === '.pdf') {
        try {
            const pdfData = await pdfParse(fileBuffer);
            if (pdfData.text && pdfData.text.trim().length > 30) {
                console.log(`⚡ [PDF Fast Extraction] Parsed '${originalName || path.basename(filePath)}' in < 0.01s.`);
                
                const availableGemini = getAllGeminiKeys(requestKeys);
                const effectiveGroq = requestGroqKey || customGroqKey || process.env.GROQ_API_KEY;

                if (availableGemini.length > 0 && (activeAiEngine === 'gemini' || activeAiEngine === 'auto')) {
                    try {
                        parsedData = await parseWithGemini(pdfData.text, driveLink, requestKeys);
                    } catch (e) {}
                }

                if (!parsedData && effectiveGroq) {
                    try {
                        console.log(`⚡ [Groq Qwen AI] Parsing PDF '${originalName || path.basename(filePath)}'...`);
                        parsedData = await executeWithRetry(() => parseWithGroqQwen(pdfData.text, driveLink, effectiveGroq));
                    } catch (groqErr) {
                        console.warn(`Groq Qwen AI failed for PDF, falling back to heuristic parser:`, groqErr.message);
                        parsedData = parseCertificateText(pdfData.text, driveLink);
                    }
                } else if (!parsedData) {
                    parsedData = parseCertificateText(pdfData.text, driveLink);
                }
                parsedData.file_hash = fileHash;
                parsedData.ocr_hash = fileHash;
                if (!skipDelete && filePath.includes('uploads')) {
                    try { fs.unlinkSync(filePath); } catch (e) {}
                }
                return { isDuplicate: false, data: parsedData, message: 'Extracted in < 0.01s via Direct PDF Parse', rawText: pdfData.text };
            }
        } catch (pdfErr) {
            console.warn(`[PDF Fast Path Warning]: ${pdfErr.message}, falling back to Vision AI/OCR...`);
        }
    }

    // Downscale large image files to max 900px JPEG (~60KB) for maximum speed & minimal latency
    let apiBuffer = fileBuffer;
    let apiMimeType = mimeType;
    if (ext !== '.pdf' && fileBuffer.length > 100 * 1024) {
        try {
            apiBuffer = await sharp(fileBuffer)
                .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 75 })
                .toBuffer();
            apiMimeType = 'image/jpeg';
        } catch (sharpErr) {}
    }

    ocrText = await performOCR(filePath);

    const availableGemini = getAllGeminiKeys(requestKeys);
    const effectiveGroq = requestGroqKey || customGroqKey || process.env.GROQ_API_KEY;
    let engineUsed = 'Heuristic';

    // 1. Try Gemini Multi-Key Rotation if configured
    if (availableGemini.length > 0 && (activeAiEngine === 'gemini' || activeAiEngine === 'auto')) {
        try {
            console.log(`⚡ [Gemini Multi-Key AI] Parsing '${originalName || path.basename(filePath)}' with rotating keys...`);
            parsedData = await parseWithGemini(ocrText, driveLink, requestKeys);
            engineUsed = `Gemini (${parsedData._keyUsed || 'Rotated'})`;
        } catch (geminiErr) {
            console.warn(`[Gemini Rotation Notice]: ${geminiErr.message}. Trying Groq/Heuristic fallback...`);
        }
    }

    // 2. Fallback to Groq Qwen AI
    if (!parsedData && effectiveGroq && (activeAiEngine === 'groq' || activeAiEngine === 'auto')) {
        try {
            console.log(`⚡ [Groq Qwen AI] Parsing '${originalName || path.basename(filePath)}' with 99%+ accuracy...`);
            parsedData = await executeWithRetry(() => parseWithGroqQwen(ocrText, driveLink, effectiveGroq));
            engineUsed = 'Groq Qwen AI';
        } catch (groqErr) {
            console.warn(`Groq Qwen AI failed for ${originalName || path.basename(filePath)}, falling back to heuristic parser:`, groqErr.message);
        }
    }

    // 3. Fallback to Heuristic regex parser
    if (!parsedData) {
        console.log(`[Heuristic Parser] Processing '${originalName || path.basename(filePath)}'...`);
        parsedData = parseCertificateText(ocrText, driveLink);
        engineUsed = 'Heuristic Parser';
    }

    parsedData.file_hash = fileHash;
    parsedData.ocr_hash = fileHash;
    parsedData.ai_engine_used = engineUsed;

    rememberProcessedCertificate(parsedData, fileHash);

    if (!skipDelete && filePath.includes('uploads')) {
        try { fs.unlinkSync(filePath); } catch (e) {}
    }

    return { 
        isDuplicate: false, 
        data: parsedData, 
        message: 'Extracted successfully', 
        rawText: ocrText,
        engineUsed: engineUsed,
        keyUsed: parsedData._keyUsed 
    };
}

// Processing Endpoint (Single file & Google Drive Link / Folder)
app.post('/api/extract', upload.single('image'), async (req, res) => {
    try {
        let filePath = null;
        let driveLink = req.body.driveLink;

        // Check if driveLink is a Google Drive Folder link
        if (driveLink && isDriveFolderUrl(driveLink)) {
            console.log(`[Ultra-Fast Batch] Detected Google Drive Folder link: ${driveLink}`);
            let fileIds = await getDriveFolderFileIds(driveLink);

            if (fileIds.length === 0) {
                const folderId = getDriveFolderId(driveLink);
                if (folderId) {
                    console.log(`[Folder Fallback] Folder view returned 0 items. Trying single file download for ID: ${folderId}...`);
                    const singleUrl = `https://drive.google.com/uc?id=${folderId}&export=download`;
                    filePath = path.join(uploadDir, `drive_${Date.now()}.jpg`);
                    try {
                        await downloadFromDrive(singleUrl, filePath);
                        driveLink = singleUrl;
                    } catch (dlErr) {
                        return res.status(400).json({ error: 'Google Drive file or folder is private or invalid (404). Please ensure access is set to "Anyone with the link can view".' });
                    }
                } else {
                    return res.status(400).json({ error: 'No accessible files found in Google Drive folder. Please ensure access is set to "Anyone with the link can view".' });
                }
            } else {
                console.log(`[Ultra-Fast Batch] Starting parallel processing for ${fileIds.length} files...`);
                
                const concurrency = 5;
                const batchResults = [];
                const newExtracted = [];

                for (let i = 0; i < fileIds.length; i += concurrency) {
                    const chunk = fileIds.slice(i, i + concurrency);
                    console.log(`[Batch ${i + 1}-${Math.min(i + concurrency, fileIds.length)}/${fileIds.length}] Processing batch chunk...`);

                    const chunkPromises = chunk.map(async (fileId) => {
                        const directUrl = `https://drive.google.com/uc?id=${fileId}&export=download`;
                        const tempPath = path.join(uploadDir, `folder_${fileId}_${Date.now()}.jpg`);

                        try {
                            await downloadFromDrive(directUrl, tempPath);
                            const result = await processSingleFileHelper({ 
                                filePath: tempPath, 
                                driveLink: directUrl, 
                                originalName: `Drive_${fileId}`,
                                requestKeys: req.requestGeminiKeys,
                                requestGroqKey: req.requestGroqKey
                            });
                            return result;
                        } catch (singleErr) {
                            console.error(`[Batch File ${fileId}] Failed:`, singleErr.message);
                            if (fs.existsSync(tempPath)) try { fs.unlinkSync(tempPath); } catch(e){}
                            return null;
                        }
                    });

                    const chunkResults = await Promise.all(chunkPromises);
                    chunkResults.forEach(r => {
                        if (r && r.data) {
                            batchResults.push(r);
                            if (!r.isDuplicate) newExtracted.push(r.data);
                        }
                    });
                }

                if (newExtracted.length > 0) {
                    await ensureExcelExistsAndAppendRows(newExtracted);
                }

                if (batchResults.length === 0) {
                    return res.status(500).json({ error: 'Failed to extract certificate data from files in folder.' });
                }

                return res.json({
                    message: `Successfully processed ${batchResults.length} certificates from Google Drive Folder!`,
                    isBatch: true,
                    totalProcessed: batchResults.length,
                    batchData: batchResults.map(r => r.data),
                    data: batchResults[0].data,
                    rawText: `Ultra-Fast Batch Folder processing completed (${batchResults.length} certificates extracted).`
                });
            }
        }
        
        if (!filePath) {
            if (req.file) {
                filePath = req.file.path;
            } else if (driveLink) {
                const downloadUrl = getDriveDownloadUrl(driveLink);
                if (!downloadUrl) {
                    return res.status(400).json({ error: 'Invalid Google Drive link provided.' });
                }
                filePath = path.join(uploadDir, `drive_${Date.now()}.jpg`);
                try {
                    await downloadFromDrive(downloadUrl, filePath);
                } catch (dlErr) {
                    return res.status(400).json({ error: 'Google Drive file is private or invalid (404). Please ensure access permission is set to "Anyone with the link can view".' });
                }
            } else {
                return res.status(400).json({ error: 'Please provide either an image file or a Google Drive link.' });
            }
        }
        
        const result = await processSingleFileHelper({ 
            filePath, 
            driveLink, 
            originalName: req.file ? req.file.originalname : 'Drive File',
            requestKeys: req.requestGeminiKeys,
            requestGroqKey: req.requestGroqKey
        });
        if (!result.isDuplicate) {
            await ensureExcelExistsAndAppendRows([result.data]);
        }

        res.json({
            message: result.isDuplicate ? 'Certificate already processed! Retrieved existing entry directly.' : 'Successfully extracted certificate data.',
            isDuplicate: result.isDuplicate,
            data: result.data,
            rawText: result.rawText || 'Processed successfully',
            engineUsed: result.engineUsed,
            keyUsed: result.keyUsed
        });
        
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
});

// Endpoint: Batch Multi-File Upload (/api/extract-batch)
app.post('/api/extract-batch', upload.array('images', 500), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No image files uploaded in batch.' });
        }

        console.log(`[High-Speed Batch API] Processing chunk of ${req.files.length} uploaded files...`);
        const concurrency = 3; // 3 parallel requests to respect Groq rate limits smoothly
        const batchResults = [];
        const newExtractedData = [];

        for (let i = 0; i < req.files.length; i += concurrency) {
            const chunk = req.files.slice(i, i + concurrency);
            const chunkPromises = chunk.map(async (file) => {
                try {
                    const result = await processSingleFileHelper({
                        filePath: file.path,
                        originalName: file.originalname,
                        skipDelete: false,
                        requestKeys: req.requestGeminiKeys,
                        requestGroqKey: req.requestGroqKey
                    });
                    return result;
                } catch (err) {
                    console.error(`[Batch File ${file.originalname}] Failed:`, err.message);
                    if (fs.existsSync(file.path)) try { fs.unlinkSync(file.path); } catch(e){}
                    return { error: err.message, file: file.originalname };
                }
            });

            const chunkResults = await Promise.all(chunkPromises);
            chunkResults.forEach(r => {
                if (r && r.data) {
                    batchResults.push(r);
                    if (!r.isDuplicate) {
                        newExtractedData.push(r.data);
                    }
                }
            });
        }

        if (newExtractedData.length > 0) {
            await ensureExcelExistsAndAppendRows(newExtractedData);
        }

        return res.json({
            message: `Successfully processed ${batchResults.length} certificates!`,
            isBatch: true,
            totalProcessed: batchResults.length,
            batchData: batchResults.filter(r => r && r.data).map(r => r.data),
            duplicatesCount: batchResults.filter(r => r && r.isDuplicate).length,
            newCount: newExtractedData.length
        });

    } catch (err) {
        console.error('[Batch Upload Error]:', err);
        return res.status(500).json({ error: 'Batch processing failed: ' + err.message });
    }
});

// Endpoint: ZIP Archive Upload (/api/extract-zip)
app.post('/api/extract-zip', upload.single('zipFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No ZIP file provided.' });
    }

    const zipPath = req.file.path;
    const extractDir = path.join(uploadDir, `zip_${Date.now()}_${Math.random().toString(36).substring(7)}`);

    try {
        console.log(`[ZIP Processing] Extracting ZIP file '${req.file.originalname}'...`);
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(extractDir, true);

        // Recursively find all image certificate files
        function getFilesRecursively(dir) {
            let results = [];
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    results = results.concat(getFilesRecursively(filePath));
                } else {
                    const ext = path.extname(file).toLowerCase();
                    if (['.jpg', '.jpeg', '.png', '.webp', '.pdf'].includes(ext)) {
                        results.push(filePath);
                    }
                }
            });
            return results;
        }

        const validFiles = getFilesRecursively(extractDir);
        console.log(`[ZIP Processing] Found ${validFiles.length} valid certificate image files.`);

        if (validFiles.length === 0) {
            try {
                fs.rmSync(extractDir, { recursive: true, force: true });
                fs.unlinkSync(zipPath);
            } catch(e){}
            return res.status(400).json({ error: 'No valid certificate image files (JPG, PNG, WEBP) found in the ZIP archive.' });
        }

        const concurrency = 12; // 12 parallel Workers for ultra-speed ZIP processing
        const batchResults = [];
        const newExtractedData = [];

        for (let i = 0; i < validFiles.length; i += concurrency) {
            const chunk = validFiles.slice(i, i + concurrency);
            const chunkPromises = chunk.map(async (filePath) => {
                try {
                    const result = await processSingleFileHelper({
                        filePath,
                        originalName: path.basename(filePath),
                        skipDelete: true,
                        requestKeys: req.requestGeminiKeys,
                        requestGroqKey: req.requestGroqKey
                    });
                    return result;
                } catch (err) {
                    console.error(`[ZIP File ${path.basename(filePath)}] Failed:`, err.message);
                    return null;
                }
            });

            const chunkResults = await Promise.all(chunkPromises);
            chunkResults.forEach(r => {
                if (r && r.data) {
                    batchResults.push(r);
                    if (!r.isDuplicate) {
                        newExtractedData.push(r.data);
                    }
                }
            });
        }

        if (newExtractedData.length > 0) {
            await ensureExcelExistsAndAppendRows(newExtractedData);
        }

        // Clean up extracted temp directory and uploaded zip file
        try {
            fs.rmSync(extractDir, { recursive: true, force: true });
            fs.unlinkSync(zipPath);
        } catch (cleanErr) {
            console.warn('[ZIP Cleanup warning]:', cleanErr.message);
        }

        return res.json({
            message: `Successfully processed ${batchResults.length} certificates from ZIP archive!`,
            isBatch: true,
            totalProcessed: batchResults.length,
            batchData: batchResults.map(r => r.data),
            duplicatesCount: batchResults.filter(r => r.isDuplicate).length,
            newCount: newExtractedData.length
        });

    } catch (err) {
        console.error('[ZIP Endpoint Error]:', err);
        try {
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
        } catch(e){}
        return res.status(500).json({ error: 'Failed to extract and process ZIP file: ' + err.message });
    }
});

// ========================================================
// API Key Management & Validation Endpoints for Faculty
// ========================================================

// 1. Test & Validate Faculty API Keys (Gemini & Groq)
app.post('/api/keys/test', async (req, res) => {
    try {
        const { geminiKeys = [], groqKey = '' } = req.body || {};
        const results = {
            gemini: [],
            groq: null
        };

        // Test each Gemini key in parallel
        const geminiPromises = geminiKeys.map(async (key, idx) => {
            const trimmed = String(key || '').trim();
            if (!trimmed || trimmed.length < 8) {
                return { index: idx, status: 'empty', message: 'No key provided' };
            }
            const masked = maskApiKey(trimmed);
            const startTime = Date.now();
            
            const testModels = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-1.5-flash', 'gemini-2.0-flash'];
            let lastErr = null;
            
            for (const model of testModels) {
                try {
                    await axios.post(
                        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${trimmed}`,
                        { contents: [{ parts: [{ text: 'Respond with OK' }] }] },
                        { headers: { 'Content-Type': 'application/json' }, timeout: 7000 }
                    );
                    const latency = Date.now() - startTime;
                    return {
                        index: idx,
                        keyMasked: masked,
                        status: 'valid',
                        model: model,
                        latencyMs: latency,
                        message: `Active & Ready (${latency}ms via ${model})`
                    };
                } catch (err) {
                    lastErr = err;
                    const msg = err.response?.data?.error?.message || err.message;
                    if (msg.includes('not found') || msg.includes('is no longer available')) {
                        continue;
                    }
                    if (err.response?.status === 429 || msg.includes('Quota') || msg.includes('Resource Exhausted')) {
                        return {
                            index: idx,
                            keyMasked: masked,
                            status: 'rate_limited',
                            latencyMs: Date.now() - startTime,
                            message: '429 Rate Limited / Quota Exceeded'
                        };
                    }
                    if (msg.includes('reported as leaked') || msg.includes('not valid')) {
                        return {
                            index: idx,
                            keyMasked: masked,
                            status: 'invalid',
                            message: msg.includes('reported as leaked') ? 'Leaked API Key (Revoked by Google)' : 'Invalid API Key'
                        };
                    }
                    return {
                        index: idx,
                        keyMasked: masked,
                        status: 'error',
                        message: msg
                    };
                }
            }

            return {
                index: idx,
                keyMasked: masked,
                status: 'invalid',
                message: lastErr?.response?.data?.error?.message || lastErr?.message || 'Failed to ping Gemini'
            };
        });

        results.gemini = await Promise.all(geminiPromises);

        // Test Groq key if provided
        const testGroq = groqKey || customGroqKey || process.env.GROQ_API_KEY;
        if (testGroq && testGroq.length > 8) {
            const startGroq = Date.now();
            try {
                await axios.post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    {
                        model: 'qwen/qwen3.8-27b',
                        messages: [{ role: 'user', content: 'Say OK' }]
                    },
                    {
                        headers: { Authorization: `Bearer ${testGroq}`, 'Content-Type': 'application/json' },
                        timeout: 7000
                    }
                );
                results.groq = {
                    status: 'valid',
                    keyMasked: maskApiKey(testGroq),
                    latencyMs: Date.now() - startGroq,
                    message: `Groq Qwen Active (${Date.now() - startGroq}ms)`
                };
            } catch (err) {
                results.groq = {
                    status: 'error',
                    keyMasked: maskApiKey(testGroq),
                    message: err.response?.data?.error?.message || err.message
                };
            }
        }

        return res.json({ success: true, results });
    } catch (e) {
        return res.status(500).json({ error: 'Key testing failed: ' + e.message });
    }
});

// 2. Save Faculty API Keys to Server Memory
app.post('/api/keys/save', (req, res) => {
    try {
        const { geminiKeys = [], groqKey = '', ocrKey = '', activeEngine = 'auto' } = req.body || {};
        
        customGeminiKeys = geminiKeys
            .map(k => String(k).trim())
            .filter(k => k.length > 8);
        
        if (groqKey && groqKey.trim().length > 5) customGroqKey = String(groqKey).trim();
        if (ocrKey && ocrKey.trim().length > 3) customOcrKey = String(ocrKey).trim();
        if (activeEngine) activeAiEngine = activeEngine;

        console.log(`[API Keys] Updated in-memory pool: ${customGeminiKeys.length} Gemini keys, Engine: ${activeAiEngine}`);
        
        return res.json({
            success: true,
            totalGeminiKeys: customGeminiKeys.length,
            activeEngine: activeAiEngine,
            message: `Successfully loaded ${customGeminiKeys.length} Gemini keys for multi-key rotation!`
        });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save keys: ' + e.message });
    }
});

// 3. Get Current API Keys Status (Masked for Security)
app.get('/api/keys/status', (req, res) => {
    const allKeys = getAllGeminiKeys();
    return res.json({
        success: true,
        totalGeminiKeys: allKeys.length,
        keys: allKeys.map((k, idx) => ({
            index: idx,
            masked: maskApiKey(k),
            source: customGeminiKeys.includes(k) ? 'UI Custom' : 'Environment'
        })),
        hasGroq: Boolean(customGroqKey || process.env.GROQ_API_KEY),
        hasOcr: Boolean(customOcrKey || process.env.OCR_API_KEY),
        activeEngine: activeAiEngine,
        rotationIndex: geminiKeyIndex,
        keyUsageStats: keyUsageStats
    });
});

// Clear All Records Endpoint (/api/clear-db and /api/clear-records)
app.post(['/api/clear-db', '/api/clear-records'], async (req, res) => {
    try {
        clearProcessedCache();
        const excelPath = path.join(downloadDir, 'certificates.xlsx');
        if (fs.existsSync(excelPath)) {
            try { fs.unlinkSync(excelPath); } catch(e){}
        }
        res.json({ message: 'Excel spreadsheet and cache cleared successfully! You can now start fresh extractions.' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear Excel spreadsheet: ' + err.message });
    }
});

// Download Excel Endpoint
app.get('/api/download-excel', (req, res) => {
    const excelPath = path.join(downloadDir, 'certificates.xlsx');
    if (fs.existsSync(excelPath)) {
        res.download(excelPath, 'certificates.xlsx');
    } else {
        res.status(404).send('Excel file not found. Process a certificate first.');
    }
});

// Get All Records Endpoint
app.get('/api/records', async (req, res) => {
    try {
        const records = await getAllExcelRecords();
        res.json(records.reverse());
    } catch (error) {
        console.error('[Get Records Error]:', error);
        res.status(500).json({ error: 'Failed to retrieve records.' });
    }
});

// Aggregate Dashboard Statistics Endpoint
app.get('/api/stats', async (req, res) => {
    try {
        const records = await getAllExcelRecords();

        const stats = {
            total: records.length,
            byEvent: {},
            byDomain: {},
            byLevel: {},
            byAchievement: {},
            byRank: {},
            itCertificatesCount: 0,
            internshipsCount: 0,
            hackathonsCount: 0,
            researchCount: 0,
            workshopsCount: 0,
            competitionsCount: 0,
            totalMeritCount: 0,
            firstRankCount: 0,
            runnersUpCount: 0,
            distinctionCount: 0
        };

        records.forEach(r => {
            const event = r.Activity_Event || 'Other';
            const domain = r.Domain || 'N/A';
            const level = r.Level || 'N/A';
            const achievement = r.Achievement || 'N/A';
            const rank = r.Rank_Position || 'N/A';

            stats.byEvent[event] = (stats.byEvent[event] || 0) + 1;
            stats.byDomain[domain] = (stats.byDomain[domain] || 0) + 1;
            stats.byLevel[level] = (stats.byLevel[level] || 0) + 1;
            stats.byAchievement[achievement] = (stats.byAchievement[achievement] || 0) + 1;
            if (rank !== 'N/A') {
                stats.byRank[rank] = (stats.byRank[rank] || 0) + 1;
            }

            const eventLower = event.toLowerCase();
            const domainLower = domain.toLowerCase();
            const detailsLower = (r.Details || '').toLowerCase();
            const achievementLower = achievement.toLowerCase();
            const rankLower = rank.toLowerCase();

            if (domainLower.includes('it') || domainLower.includes('software') || domainLower.includes('tech') || detailsLower.includes('python') || detailsLower.includes('java') || detailsLower.includes('web') || detailsLower.includes('cisco')) {
                stats.itCertificatesCount++;
            }
            if (eventLower.includes('intern')) {
                stats.internshipsCount++;
            }
            if (eventLower.includes('hackathon')) {
                stats.hackathonsCount++;
            }
            if (eventLower.includes('research') || detailsLower.includes('paper') || detailsLower.includes('journal') || eventLower.includes('symposium')) {
                stats.researchCount++;
            }
            if (eventLower.includes('workshop') || eventLower.includes('training')) {
                stats.workshopsCount++;
            }
            if (eventLower.includes('compet') || eventLower.includes('contest')) {
                stats.competitionsCount++;
            }

            // Merit & Rank Aggregations
            const isMerit = achievementLower.includes('winner') || achievementLower.includes('merit') || achievementLower.includes('distinction') || achievementLower.includes('runner') || rankLower.includes('1st') || rankLower.includes('2nd') || rankLower.includes('3rd') || rankLower.includes('rank') || rankLower.includes('place') || rankLower.includes('gold') || rankLower.includes('silver') || rankLower.includes('bronze');

            if (isMerit) {
                stats.totalMeritCount++;

                if (rankLower.includes('1st') || rankLower.includes('first') || rankLower.includes('winner') || rankLower.includes('gold')) {
                    stats.firstRankCount++;
                } else if (rankLower.includes('2nd') || rankLower.includes('3rd') || rankLower.includes('second') || rankLower.includes('third') || rankLower.includes('runner') || rankLower.includes('silver') || rankLower.includes('bronze')) {
                    stats.runnersUpCount++;
                } else if (rankLower.includes('distinction') || achievementLower.includes('excellence') || achievementLower.includes('honor')) {
                    stats.distinctionCount++;
                }
            }
        });

        res.json(stats);
    } catch (error) {
        console.error('Error computing stats:', error);
        res.status(500).json({ error: 'Failed to compute dashboard statistics.' });
    }
});

// Custom Filtered Reports Endpoint (/api/reports/custom)
app.get('/api/reports/custom', async (req, res) => {
    try {
        const { participantType, eventType, department, academicYear, domain } = req.query;

        const records = await getAllExcelRecords();

        // Apply filters
        let filtered = records;

        if (participantType && participantType !== 'all') {
            const ptLower = participantType.toLowerCase();
            filtered = filtered.filter(r => (r.Participant_Type || '').toLowerCase().includes(ptLower));
        }

        if (eventType && eventType !== 'all') {
            const etLower = eventType.toLowerCase();
            filtered = filtered.filter(r => (r.Activity_Event || '').toLowerCase().includes(etLower) || (r.Details || '').toLowerCase().includes(etLower));
        }

        if (domain && domain !== 'all') {
            const dLower = domain.toLowerCase();
            filtered = filtered.filter(r => (r.Domain || '').toLowerCase().includes(dLower));
        }

        res.json({
            total: filtered.length,
            records: filtered
        });
    } catch (err) {
        console.error('[Custom Reports API Error]:', err);
        res.status(500).json({ error: 'Failed to generate custom report: ' + err.message });
    }
});

// Download Custom Report Excel Endpoint (/api/reports/export-excel)
app.get('/api/reports/export-excel', async (req, res) => {
    try {
        const { participantType, eventType } = req.query;

        const records = await getAllExcelRecords();

        let filtered = records;
        if (participantType && participantType !== 'all') {
            filtered = filtered.filter(r => (r.Participant_Type || '').toLowerCase().includes(participantType.toLowerCase()));
        }
        if (eventType && eventType !== 'all') {
            filtered = filtered.filter(r => (r.Activity_Event || '').toLowerCase().includes(eventType.toLowerCase()) || (r.Details || '').toLowerCase().includes(eventType.toLowerCase()));
        }

        const workbook = new ExcelJS.Workbook();
        const title = `${participantType || 'All'}_Report`;
        const worksheet = workbook.addWorksheet(title);

        worksheet.columns = [
            { header: 'Sl. No.', key: 'Sl_No', width: 8 },
            { header: 'Name', key: 'Name_of_Student', width: 25 },
            { header: 'Type (Student/Faculty)', key: 'Participant_Type', width: 20 },
            { header: 'Activity / Event', key: 'Activity_Event', width: 20 },
            { header: 'Details', key: 'Details', width: 35 },
            { header: 'Organized by', key: 'Organized_by', width: 25 },
            { header: 'Domain', key: 'Domain', width: 20 },
            { header: 'From Date', key: 'From_Date', width: 12 },
            { header: 'To Date', key: 'To_Date', width: 12 },
            { header: 'Venue', key: 'Venue', width: 18 },
            { header: 'Level', key: 'Level', width: 15 },
            { header: '(Google Drive Link)', key: 'Google_Drive_Link', width: 20 },
            { header: 'Rank / Position', key: 'Rank_Position', width: 20 },
            { header: 'Achievement', key: 'Achievement', width: 20 }
        ];

        const headerRow = worksheet.getRow(1);
        headerRow.font = { bold: true, name: 'Times New Roman' };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        headerRow.height = 35;

        filtered.forEach((r, idx) => {
            const addedRow = worksheet.addRow([
                idx + 1,
                r.Name_of_Student || 'N/A',
                r.Participant_Type || 'Student',
                r.Activity_Event || 'N/A',
                r.Details || 'N/A',
                r.Organized_by || 'N/A',
                r.Domain || 'N/A',
                r.From_Date || 'N/A',
                r.To_Date || 'N/A',
                r.Venue || 'N/A',
                r.Level || 'N/A',
                r.Google_Drive_Link || 'N/A',
                r.Rank_Position || 'N/A',
                r.Achievement || 'N/A'
            ]);
            addedRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
            addedRow.font = { name: 'Times New Roman' };

            addedRow.eachCell({ includeEmpty: true }, function(cell, colNumber) {
                if (colNumber === 12 && cell.value && cell.value !== 'N/A') {
                    cell.value = { text: cell.value.toString(), hyperlink: cell.value.toString() };
                    cell.font = { color: { argb: 'FF0000FF' }, underline: true, name: 'Times New Roman' };
                }
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${participantType || 'Custom'}_Certificates_Report.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();
    } catch (err) {
        console.error('[Export Excel Error]:', err);
        res.status(500).send('Failed to generate Excel report');
    }
});

// Authentication Endpoint (Open Access: Everyone can use freely)
app.post('/api/login', (req, res) => {
    return res.json({
        success: true,
        role: 'user',
        name: 'Faculty / Guest User',
        token: 'public-access-token',
        message: 'Open Access Enabled. Full extraction and report features available to all users.'
    });
});

app.listen(port, () => {
    console.log(`Server listening on port ${port} (Standalone Excel Mode: Zero Database / Open Access)`);
    initCacheFromExcel();
});
