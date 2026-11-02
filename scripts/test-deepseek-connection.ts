import * as fs from 'fs';
import * as path from 'path';

// Minimal preflight verification script for DeepSeek API
async function verifyDeepSeekConnection() {
  console.log('================================================================');
  console.log('   DeepSeek API Preflight & Minimal Verification Check          ');
  console.log('================================================================\n');

  // 1. Safely inspect environment
  const envPath = path.resolve(process.cwd(), '.env');
  let apiKey = process.env.DEEPSEEK_API_KEY || '';
  let baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
  let model = process.env.LLM_MODEL || 'deepseek-flash';

  if (!apiKey && fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const match = envContent.match(/^DEEPSEEK_API_KEY=(.*)$/m);
    if (match && match[1].trim()) {
      apiKey = match[1].trim();
    }
  }

  if (!apiKey || apiKey.includes('your_') || apiKey.length < 10) {
    console.error('❌ ERROR: DEEPSEEK_API_KEY is not configured or is invalid in .env.');
    process.exit(1);
  }

  console.log(`Endpoint:    ${baseUrl}/chat/completions`);
  console.log(`Model:       ${model}`);
  console.log(`API Key:     CONFIGURED (Length: ${apiKey.length}, Prefix: ${apiKey.substring(0, 3)}...) [REDACTED]`);
  console.log(`Mode:        Non-thinking (thinking: { type: "disabled" })`);
  console.log(`Token Bound: max_tokens = 5\n`);

  const startTime = Date.now();

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: 'You are a test assistant. Respond in one word.' },
          { role: 'user', content: 'Respond with Pong.' },
        ],
        thinking: { type: 'disabled' },
        max_tokens: 5,
        temperature: 0.1,
      }),
    });

    const latencyMs = Date.now() - startTime;

    if (!res.ok) {
      const errText = await res.text();
      console.error(`❌ API Request Failed with HTTP ${res.status}: ${res.statusText}`);
      console.error(`Response Body: ${errText}`);
      process.exit(1);
    }

    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim();
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    const totalTokens = data.usage?.total_tokens ?? 0;

    // Pricing calculation for deepseek-flash: $0.15/1M input, $0.60/1M output
    const costUsd = (promptTokens * 0.00000015) + (completionTokens * 0.00000060);

    console.log('✅ DeepSeek API Connection Test SUCCEEDED!');
    console.log(`Response:          "${reply}"`);
    console.log(`Model Used:        ${data.model || model}`);
    console.log(`Latency:           ${latencyMs} ms`);
    console.log(`Tokens Consumed:   Prompt: ${promptTokens}, Completion: ${completionTokens}, Total: ${totalTokens}`);
    console.log(`Estimated Cost:    $${costUsd.toFixed(8)} USD\n`);
    console.log('================================================================');
  } catch (error: any) {
    console.error('❌ Network / Connection Error:', error?.message || error);
    process.exit(1);
  }
}

verifyDeepSeekConnection();

