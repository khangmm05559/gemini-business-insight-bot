// File: netlify/functions/rag-analysis.js
// Đọc JSON tự động + xử lý AI

const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

// Lấy API Key từ Netlify
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

function excelSerialToISO(serial) {
  if (typeof serial !== "number") return null;

  const excelEpoch = Date.UTC(1899, 11, 30);
  const utc = excelEpoch + serial * 24 * 60 * 60 * 1000;
  const date = new Date(utc);

  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().split("T")[0];
}

function formatValueByKey(key, value) {
  const lowerKey = key.toLowerCase();

  if (
    typeof value === "number" &&
    (lowerKey.includes("date") || lowerKey.includes("deadline"))
  ) {
    const iso = excelSerialToISO(value);
    if (iso) {
      return `${iso} (serial: ${value})`;
    }
  }

  return value === undefined || value === null || value === "" ? "N/A" : value;
}

function loadJsonFile(fileName) {
  const filePath = path.join(__dirname, fileName);

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Lỗi đọc ${fileName}:`, err);
    return [];
  }
}

function formatMarketingLogs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "## MARKETING EMAIL LOGS ##\nNo marketing logs loaded.\n\n";
  }

  let text = "## MARKETING EMAIL LOGS ##\n\n";

  rows.forEach((item, idx) => {
    text += `- Email #${idx + 1}\n`;
    text += `  - Subject: "${item["Subject"]}"\n`;
    text += `  - Responsible: ${item["Responsible"]}\n`;
    text += `  - Sent: ${item["Sent"]}\n`;
    text += `  - Received Ratio: ${item["Received Ratio"]}%\n`;
    text += `  - Opened Ratio: ${item["Opened Ratio"]}%\n`;
    text += `  - Click Ratio: ${item["Number of Clicks"]}%\n`;
    text += `  - Replied Ratio: ${item["Replied Ratio"]}%\n`;
    text += `  - Status: ${item["Status"]}\n\n`;
  });

  return text;
}

function formatPurchaseOrders(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "## PURCHASE ORDERS ##\nNo purchase order data loaded.\n\n";
  }

  let text = "## PURCHASE ORDERS ##\n\n";

  rows.forEach((item, idx) => {
    text += `- Purchase Order #${idx + 1}\n`;
    text += `  - Reference: ${formatValueByKey("Order Reference", item["Order Reference"])}\n`;
    text += `  - Priority: ${formatValueByKey("Priority", item["Priority"])}\n`;
    text += `  - Vendor: ${formatValueByKey("Vendor", item["Vendor"])}\n`;
    text += `  - Buyer: ${formatValueByKey("Buyer", item["Buyer"])}\n`;
    text += `  - Order Deadline: ${formatValueByKey("Order Deadline", item["Order Deadline"])}\n`;
    text += `  - Activities: ${formatValueByKey("Activities", item["Activities"])}\n`;
    text += `  - Source Document: ${formatValueByKey("Source Document", item["Source Document"])}\n`;
    text += `  - Total: ${formatValueByKey("Total", item["Total"])}\n`;
    text += `  - Status: ${formatValueByKey("Status", item["Status"])}\n\n`;
  });

  return text;
}

function formatSalesOrders(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "## SALES ORDERS ##\nNo sales order data loaded.\n\n";
  }

  let text = "## SALES ORDERS ##\n\n";

  rows.forEach((item, idx) => {
    text += `- Sales Order #${idx + 1}\n`;
    text += `  - Reference: ${formatValueByKey("Order Reference", item["Order Reference"])}\n`;
    text += `  - Creation Date: ${formatValueByKey("Creation Date", item["Creation Date"])}\n`;
    text += `  - Customer: ${formatValueByKey("Customer", item["Customer"])}\n`;
    text += `  - Salesperson: ${formatValueByKey("Salesperson", item["Salesperson"])}\n`;
    text += `  - Activities: ${formatValueByKey("Activities", item["Activities"])}\n`;
    text += `  - Total: ${formatValueByKey("Total", item["Total"])}\n`;
    text += `  - Status: ${formatValueByKey("Status", item["Status"])}\n\n`;
  });

  return text;
}

function buildKnowledgeBase() {
  const marketingLogs = loadJsonFile("data.json");
  const purchaseOrders = loadJsonFile("purchase_orders.json");
  const salesOrders = loadJsonFile("sales_orders.json");

  let text = "[START BUSINESS DATA]\n";
  text += formatMarketingLogs(marketingLogs);
  text += formatPurchaseOrders(purchaseOrders);
  text += formatSalesOrders(salesOrders);
  text += "[END BUSINESS DATA]\n";

  return text;
}

// Load data files mỗi lần function được gọi
const BUSINESS_DATA = buildKnowledgeBase();

async function generateWithRetry(full_prompt) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [{ text: full_prompt }],
          },
        ],
        config: { temperature: 0.2 },
      });
    } catch (err) {
      const status = err?.status || err?.error?.status || err?.error?.code;
      const isOverloaded = status === 503 || status === "UNAVAILABLE";

      if (isOverloaded && attempt < maxAttempts) {
        const backoffMs = attempt * 500;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      throw err;
    }
  }

  throw new Error("Gemini request failed");
}

exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400"
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { user_query } = JSON.parse(event.body || "{}");

    const system_prompt = `
You are a Senior Business Analyst. You analyze marketing emails, purchase orders, and sales orders to extract insights.
Use only the provided data. Provide trends, root-cause analysis, and actionable suggestions grounded in the dataset.
    `.trim();

    const full_prompt = `${system_prompt}\n\n${BUSINESS_DATA}\n\nUser Question: ${user_query}`;

    const response = await generateWithRetry(full_prompt);

    const bot_answer = (response.text || "No AI answer returned.").trim();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ answer: bot_answer }),
    };
  } catch (error) {
    console.error("Gemini Error:", error);

    const status = error?.status || error?.error?.status || error?.error?.code;
    const isOverloaded = status === 503 || status === "UNAVAILABLE";
    const message = isOverloaded
      ? "Gemini model is busy. Please try again in a moment."
      : "Gemini API Error";

    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ error: message }),
    };
  }
};
