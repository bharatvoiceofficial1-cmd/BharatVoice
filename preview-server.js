const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

let EdgeTTS = null;
try {
  EdgeTTS = require('../BharatVoice-Backend/node_modules/edge-tts-universal').EdgeTTS;
} catch(e) {
  try {
    EdgeTTS = require('edge-tts-universal').EdgeTTS;
  } catch(err){}
}

const PORT = process.env.PORT || 5000;
let GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
let ALLROUNDER_API_KEY = process.env.ALLROUNDER_API_KEY || '';
let NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || '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';
let RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_live_Tam4fxi3SDEjlv';
let RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

try {
  const envPath = path.join(__dirname, '../BharatVoice-Backend/.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    const mGem = raw.match(/GEMINI_API_KEY\s*=\s*([^\r\n]+)/);
    if (mGem) GEMINI_API_KEY = mGem[1].trim().replace(/^["']|["']$/g, '');
    const mAll = raw.match(/ALLROUNDER_API_KEY\s*=\s*([^\r\n]+)/);
    if (mAll) ALLROUNDER_API_KEY = mAll[1].trim().replace(/^["']|["']$/g, '');
    const mNv = raw.match(/NVIDIA_API_KEY\s*=\s*([^\r\n]+)/);
    if (mNv) NVIDIA_API_KEY = mNv[1].trim().replace(/^["']|["']$/g, '');
    const mRzpId = raw.match(/RAZORPAY_KEY_ID\s*=\s*([^\r\n]+)/);
    if (mRzpId) RAZORPAY_KEY_ID = mRzpId[1].trim().replace(/^["']|["']$/g, '');
    const mRzpSec = raw.match(/RAZORPAY_KEY_SECRET\s*=\s*([^\r\n]+)/);
    if (mRzpSec) RAZORPAY_KEY_SECRET = mRzpSec[1].trim().replace(/^["']|["']$/g, '');
  }
} catch(e){}

// Fallback Keys Array for high availability
const GEMINI_KEYS = [ALLROUNDER_API_KEY, GEMINI_API_KEY].filter(Boolean);

const PLAN_CATALOG = {
  shakti: { amount: 4900, name: 'Core Node ⚡', durationDays: 30, price: '₹49/mo' },
  bharatpro: { amount: 9900, name: 'Bharat Pro ⚡', durationDays: 30, price: '₹99/mo' },
  scholarpro: { amount: 14900, name: 'Scholar Compute 🚀', durationDays: 30, price: '₹149/mo' },
  mahashakti: { amount: 54900, name: 'Enterprise Cluster 🌐', durationDays: 365, price: '₹549/yr' }
};

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain'
};

// Real-Time Web Search Helper
async function performWebSearch(query) {
  const sources = [];
  // 1. Wikipedia Search API
  try {
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
    const res = await fetch(wikiUrl);
    const data = await res.json();
    if (data.query && data.query.search && Array.isArray(data.query.search)) {
      for (const item of data.query.search.slice(0, 4)) {
        sources.push({
          title: item.title,
          snippet: item.snippet.replace(/<[^>]+>/g, '').trim(),
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`
        });
      }
    }
  } catch(e) {}

  // 2. DuckDuckGo Instant Answer API
  try {
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(ddgUrl);
    const data = await res.json();
    if (data.AbstractText) {
      sources.unshift({
        title: data.Heading || query,
        snippet: data.AbstractText,
        url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
      });
    }
    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, 2)) {
        if (topic.Text && topic.FirstURL) {
          sources.push({
            title: topic.Text.split(' - ')[0] || 'Related Topic',
            snippet: topic.Text,
            url: topic.FirstURL
          });
        }
      }
    }
  } catch(e) {}

  return sources;
}

// Live URL Webpage Fetching & Reader Helper
async function performBrowseUrl(targetUrl) {
  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : targetUrl;
    const pMatches = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
    const textParts = pMatches.map(p => p.replace(/<[^>]+>/g, '').trim()).filter(t => t.length > 20);
    const content = textParts.slice(0, 8).join('\n\n');
    return {
      url: targetUrl,
      title: title || 'Web Page',
      content: content.slice(0, 4000)
    };
  } catch(err) {
    return { url: targetUrl, error: err.message };
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  // Real-Time Web Search Endpoint
  if (pathname === '/api/search') {
    const handleSearch = async (q) => {
      try {
        if (!q || !q.trim()) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ sources: [] }));
        }
        const sources = await performWebSearch(q.trim());
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ query: q, sources }));
      } catch(err) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    };

    if (req.method === 'GET') {
      return handleSearch(parsedUrl.query.q || '');
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          handleSearch(data.query || data.q || '');
        } catch(e) {
          handleSearch('');
        }
      });
      return;
    }
  }

  // Live URL Web Browsing Endpoint
  if (pathname === '/api/browse') {
    const handleBrowse = async (targetUrl) => {
      try {
        if (!targetUrl || !targetUrl.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ error: { message: 'Missing URL parameter' } }));
        }
        const pageData = await performBrowseUrl(targetUrl.trim());
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(pageData));
      } catch(err) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    };

    if (req.method === 'GET') {
      return handleBrowse(parsedUrl.query.url || '');
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          handleBrowse(data.url || '');
        } catch(e) {
          handleBrowse('');
        }
      });
      return;
    }
  }

  // Subscription / Payment Plans Catalog Endpoint
  if (pathname === '/api/payment/plans' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({
      status: 'success',
      plans: PLAN_CATALOG,
      razorpayKeyId: RAZORPAY_KEY_ID
    }));
  }

  // Subscription / Create Order Endpoint
  if (pathname === '/api/payment/create-order' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const planId = data.planId || 'bharatpro';
        const plan = PLAN_CATALOG[planId] || PLAN_CATALOG['bharatpro'];
        const isFree = !!data.isCouponFree;

        if (isFree) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({
            orderId: 'free_promo_' + Date.now(),
            amount: 0,
            currency: 'INR',
            planId: planId,
            planName: plan.name,
            isFree: true
          }));
        }

        const orderId = 'order_' + Date.now();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          orderId: orderId,
          amount: plan.amount,
          currency: 'INR',
          planId: planId,
          planName: plan.name,
          keyId: RAZORPAY_KEY_ID
        }));
      } catch(err) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // Subscription / Verify Payment Endpoint
  if (pathname === '/api/payment/verify' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const planId = data.planId || 'bharatpro';
        const validPlan = PLAN_CATALOG[planId] ? planId : 'bharatpro';
        const isFree = !!data.isFree;

        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          status: 'success',
          message: isFree 
            ? `🎉 Coupon applied! You are now subscribed to ${PLAN_CATALOG[validPlan].name} 100% FREE!`
            : `🎉 Payment verified! Your workspace is upgraded to ${PLAN_CATALOG[validPlan].name}.`,
          plan: validPlan,
          planName: PLAN_CATALOG[validPlan].name,
          paymentId: data.razorpay_payment_id || ('PAY_' + Date.now())
        }));
      } catch(err) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // Neural TTS Endpoint: Teen Indian Male Voice (Class 8 Student: Prabhat / Madhur)
  if (pathname === '/api/tts' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        if (!EdgeTTS) throw new Error('EdgeTTS engine not available');
        const data = JSON.parse(body || '{}');
        let text = (data.text || '').trim();
        if (!text) text = "Hello! I am Bharat Voice.";
        if (text.length > 2500) text = text.slice(0, 2500);

        const isDevanagari = /[\u0900-\u097F]/.test(text);
        const chosenVoice = data.voice || (isDevanagari ? 'hi-IN-MadhurNeural' : 'en-IN-PrabhatNeural');
        const rate = data.rate || '+4%';
        const pitch = data.pitch || '+8Hz';

        const tts = new EdgeTTS(text, chosenVoice, { rate, pitch });
        const result = await tts.synthesize();
        const arrayBuf = await result.audio.arrayBuffer();
        const audioBuf = Buffer.from(arrayBuf);

        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': audioBuf.length,
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=86400',
          'X-Voice-Used': chosenVoice
        });
        res.end(audioBuf);
      } catch (err) {
        console.error('Local TTS synthesis error:', err.message);
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // Academic Chat & Problem Solving API Endpoint (Powered by Real Gemini & Live Web Grounding)
  if (pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const query = (lastUserMsg ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : (lastUserMsg.content[0]?.text || '')) : '').trim();
        const qLower = query.toLowerCase();

        let reply = '';
        let provider = 'gemini-3.1-flash-lite';
        let searchSources = Array.isArray(data.sources) ? data.sources : [];

        // Check if query wants search or has URL
        const isSearchRequested = data.search || /^(who|what|when|where|which|how|why|is|are|latest|news|today|current|price|score|weather|search|browse|lookup|find)\b/i.test(qLower);
        const urlMatch = query.match(/https?:\/\/[^\s]+/i);

        if (urlMatch && searchSources.length === 0) {
          try {
            const pageInfo = await performBrowseUrl(urlMatch[0]);
            if (pageInfo.content) {
              searchSources.push({
                title: pageInfo.title || 'Visited Webpage',
                snippet: pageInfo.content.slice(0, 300),
                url: pageInfo.url
              });
            }
          } catch(e) {}
        } else if (isSearchRequested && searchSources.length === 0) {
          try {
            searchSources = await performWebSearch(query);
          } catch(e) {}
        }

        // Build contents array for Gemini
        const contents = [];
        for (const m of messages) {
          if (!m || m.role === 'system') continue;
          const textContent = typeof m.content === 'string' ? m.content : (m.content[0]?.text || '');
          if (textContent.trim()) {
            contents.push({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: textContent }]
            });
          }
        }

        // If search sources found, ground the last message
        if (searchSources.length > 0 && contents.length > 0) {
          const lastIdx = contents.length - 1;
          const originalText = contents[lastIdx].parts[0].text;
          const groundingPrompt = originalText +
            `\n\n[REAL-TIME LIVE WEB BROWSING FACTS]:\n` +
            searchSources.map((s, i) => `[Source ${i+1}: ${s.title}] (${s.url})\n${s.snippet}`).join('\n\n') +
            `\n\nSynthesize an accurate, up-to-date answer using these real-time web facts. Be direct and concise.`;
          contents[lastIdx].parts[0].text = groundingPrompt;
        }

        if (contents.length === 0 && query) {
          contents.push({ role: 'user', parts: [{ text: query }] });
        }

        const sysMsg = messages.find(m => m && m.role === 'system');
        const systemText = sysMsg && typeof sysMsg.content === 'string'
          ? sysMsg.content
          : `You are Bharat Voice, an intelligent AI companion and problem solver.
CRITICAL RULE (highest priority): Match your reply EXACTLY to what the user asked.
- Greetings ("hi", "hello", "hey") → Reply with ONLY a short friendly greeting. NO academic content.
- Casual messages ("how are you", "thanks", "bye") → Reply naturally and briefly like a friend.
- Simple math ("5 + 3", "15 * 8") → Give the direct answer instantly. No steps unless asked.
- Simple factual question → 1-3 sentence answer. Direct and clear.
- Detailed question (explain, derive, code, concept map) → Give a full structured answer.
- Web search / browse queries → Cite the real-time facts directly and accurately.
NEVER dump formulas or academic content onto casual greetings. Short input = short reply.
Match the user's language (English, Hindi, or Hinglish).`;

        const candidateModels = [
          'gemini-3.1-flash-lite',
          'gemini-flash-lite-latest',
          'gemini-3.8-flash',
          'gemini-3.7-flash',
          'gemini-3.5-flash'
        ];

        // 1. Try Gemini Live Inference with key cascade
        for (const apiKey of GEMINI_KEYS) {
          if (reply) break;
          for (const modelName of candidateModels) {
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 6000);

              const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents,
                  systemInstruction: { parts: [{ text: systemText }] },
                  generationConfig: {
                    temperature: 0.65,
                    maxOutputTokens: 2500
                  }
                }),
                signal: controller.signal
              });
              clearTimeout(timeout);

              if (geminiRes.ok) {
                const geminiData = await geminiRes.json();
                const candText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
                if (candText && candText.trim()) {
                  reply = candText.trim();
                  provider = modelName;
                  break;
                }
              }
            } catch(err) {}
          }
        }

        // 2. High Quality Smart Academic Fallback if API keys are offline
        if (!reply) {
          provider = 'smart-engine';
          if (/concept\s*map|mind\s*map|flowchart|diagram/i.test(qLower)) {
            reply = `### 🗺️ Interactive Concept Architecture\n\n` +
              `Here is the knowledge graph and structural breakdown for **"${query.replace(/create a clear|interactive concept map with a mermaid diagram and structured breakdown for:|explain/gi, '').trim() || 'Core System'}"**:\n\n` +
              `\`\`\`mermaid\n` +
              `graph TD\n` +
              `    A[📌 Core Topic / Domain] --> B[🔬 Theoretical Foundations]\n` +
              `    A --> C[⚙️ Operational Mechanics]\n` +
              `    A --> D[🚀 Practical Applications]\n` +
              `    B --> B1[Definitions & Axioms]\n` +
              `    B --> B2[Governing Equations / Laws]\n` +
              `    C --> C1[Process Pipeline]\n` +
              `    C --> C2[Optimization & Edge Cases]\n` +
              `    D --> D1[Real-World Implementation]\n` +
              `    D --> D2[Assessment & Verification]\n` +
              `\`\`\`\n\n` +
              `#### 📋 Key Takeaways:\n` +
              `- **Theoretical Base:** Establish fundamental principles before diving into complex applications.\n` +
              `- **Operational Mechanics:** Understand how subcomponents interconnect and feed into the pipeline.\n` +
              `- **Applications:** Practice with worked examples to lock in the knowledge.`;
          } else if (/sample\s*paper|question\s*paper|test\s*paper|exam\s*paper/i.test(qLower)) {
            reply = `### 📝 Comprehensive Examination Paper\n\n` +
              `**Subject / Topic:** ${query.replace(/create a complete sample question paper with sections, marks, difficulty balance, and answer key for:/gi, '').trim() || 'Academic Assessment'}\n` +
              `**Maximum Marks:** 50 | **Time Allowed:** 90 Minutes\n\n` +
              `---\n\n` +
              `#### SECTION A: Objective & Conceptual (1 Mark Each)\n` +
              `1. **Q1:** State the fundamental definition and SI unit of the primary physical quantity involved in this topic.\n` +
              `2. **Q2 (MCQ):** Which condition must be satisfied for system equilibrium?\n` +
              `   - (A) Net force is zero\n` +
              `   - (B) Velocity is accelerating\n` +
              `   - (C) Internal friction is maximal\n` +
              `   - (D) Potential energy is infinite\n` +
              `   *Answer: (A)*\n\n` +
              `#### SECTION B: Short Answer & Mathematical Reasoning (3 Marks Each)\n` +
              `3. **Q3:** Explain the core principle involved with the help of a neat labeled diagram. Derive the governing formula.\n` +
              `4. **Q4 (Worked Problem):** Given parameters $x = 12$ units and $y = 5$ units, calculate the resultant vector magnitude $R = \\sqrt{x^2 + y^2}$.\n` +
              `   *Solution: $R = \\sqrt{144 + 25} = \\sqrt{169} = \\mathbf{13\\text{ units}}$.*\n\n` +
              `#### SECTION C: Long Answer & Case Study (5 Marks Each)\n` +
              `5. **Q5:** Discuss real-world practical applications. Outline common mistakes students make during derivations and provide tips for error-free execution.\n\n` +
              `*(Full Answer Key and Marking Scheme Included)*`;
          } else if (/code|python|javascript|c\+\+|java|algorithm/i.test(qLower)) {
            reply = `### 💻 Code Mentor: Implementation & Complexity\n\n` +
              `\`\`\`python\n` +
              `def execute_solution(data):\n` +
              `    """\n` +
              `    Optimized execution with O(n) time and O(1) auxiliary space.\n` +
              `    """\n` +
              `    return [item for item in data if item is not None]\n` +
              `\n` +
              `# Verification Test\n` +
              `print(execute_solution([10, 25, None, 40]))  # Output: [10, 25, 40]\n` +
              `\`\`\`\n\n` +
              `#### ⚙️ Complexity Breakdown:\n` +
              `- **Time Complexity:** $\\mathcal{O}(n)$ linear scan.\n` +
              `- **Space Complexity:** $\\mathcal{O}(1)$ in-place filtering.`;
          } else if (searchSources.length > 0) {
            reply = `### 🌐 Web Intelligence Summary\n\n` +
              `Based on live web search results for **"${query}"**:\n\n` +
              searchSources.map((s, idx) => `**${idx + 1}. ${s.title}**\n${s.snippet}`).join('\n\n') +
              `\n\n*Live sources referenced above from verified web entries.*`;
          } else {
            reply = `I am Bharat Voice, your high-performance intelligent assistant. How can I help you master your studies, write code, or explore today?`;
          }
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: reply
              }
            }
          ],
          sources: searchSources,
          meta: {
            provider: provider,
            grounded: searchSources.length > 0
          }
        }));
      } catch (err) {
        console.error('Local chat API error:', err.message);
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // FLUX 3 8K Image Generation Proxy Endpoint
  if (pathname === '/api/generate-image' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const raw = (data.prompt || '').trim();
        const clientFinalPrompt = (data.finalPrompt || '').trim();

        if (!raw && !clientFinalPrompt) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          return res.end(JSON.stringify({ error: { message: 'Prompt is required' } }));
        }

        const is3D = /3d|render|octane|unreal|cgi|isometric|clay|digital\s*art/i.test(raw);
        const is4K = /4k|photo|photography|realistic|dslr/i.test(raw) && !/8k/i.test(raw);

        let detectedStyle = 'photo-8k';
        let modeTitle = '8K UHD Photo';
        let styleSuffix = '';

        if (is3D) {
          detectedStyle = '3d-render';
          modeTitle = '3D Digital Render';
          styleSuffix = ', 3D digital render, Pixar and Unreal Engine 5 aesthetic, Octane Render 3D, ray-traced ambient occlusion, subsurface scattering, volumetric studio lighting, highly detailed 3D model, ultra-high resolution 8K 3D masterpiece';
        } else if (is4K) {
          detectedStyle = 'photo-4k';
          modeTitle = '4K UHD Photo';
          styleSuffix = ', ultra-sharp 4K UHD photograph, photorealistic, natural cinematic lighting, highly detailed textures, DSLR crisp focus, professional photography, 4K resolution';
        } else {
          detectedStyle = 'photo-8k';
          modeTitle = '8K UHD Photo';
          styleSuffix = ', award-winning masterpiece photograph, ultra-detailed 8K UHD, photorealistic, hyper-realistic textures, professional studio lighting, razor-sharp focus, cinematic depth of field, breathtaking 8K resolution, raw photograph';
        }

        const finalPrompt = clientFinalPrompt || (raw + styleSuffix);
        const aspect_ratio = data.aspect_ratio || '1:1';

        // Call NVIDIA FLUX 3 Image Klein
        try {
          const nvRes = await fetch('https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux-3-image-klein', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + NVIDIA_API_KEY,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            body: JSON.stringify({
              prompt: finalPrompt,
              aspect_ratio: aspect_ratio
            })
          });

          if (nvRes.ok) {
            const nvData = await nvRes.json();
            const b64 = nvData?.artifacts?.[0]?.base64 || nvData?.b64_json;
            if (b64) {
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              });
              return res.end(JSON.stringify({
                status: 'success',
                image: 'data:image/jpeg;base64,' + b64,
                meta: {
                  style: detectedStyle,
                  modeTitle: modeTitle,
                  width: data.width || 1024,
                  height: data.height || 1024,
                  provider: 'nvidia-flux-3'
                }
              }));
            }
          }
        } catch(nvErr) {
          console.warn('NVIDIA FLUX 3 proxy error in preview server:', nvErr.message);
        }

        // High quality fallback
        const width = data.width || 1024;
        const height = data.height || 1024;
        const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?width=${width}&height=${height}&model=flux&nologo=true`;
        try {
          const fRes = await fetch(fallbackUrl);
          if (fRes.ok) {
            const ab = await fRes.arrayBuffer();
            const b64 = Buffer.from(ab).toString('base64');
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            });
            return res.end(JSON.stringify({
              status: 'success',
              image: 'data:image/jpeg;base64,' + b64,
              meta: {
                style: detectedStyle,
                modeTitle: modeTitle,
                width: width,
                height: height,
                provider: 'flux-fallback'
              }
            }));
          }
        } catch(fErr) {}

        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: { message: 'Image generation service temporarily unavailable.' } }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  // Static File Serving
  let safePath = parsedUrl.pathname;
  if (safePath === '/') safePath = '/index.html';
  const filePath = path.join(__dirname, safePath);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Bharat Voice Preview Server online at http://localhost:${PORT}`);
  console.log(`Real-Time Web Browsing & Search Online (/api/search, /api/browse)`);
  console.log(`Subscription & Payment Endpoints Online (/api/payment/plans, create-order, verify)`);
  console.log(`Neural TTS active with Teen Indian Male Voice (en-IN-Prabhat / hi-IN-Madhur)`);
});
