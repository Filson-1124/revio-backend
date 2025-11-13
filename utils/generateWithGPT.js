import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export async function generateWithGPT({
  userPrompt,
  systemPrompt,
  temperature = 0,
  model = 'gpt-4.1-mini',
  max_tokens
}) {
const MAX_CONTEXT_TOKENS = 128_000;
const MAX_OUTPUT_TOKENS = 16_000;
const RESERVED_TOKENS = 8_000;

// disables the GPT functionality if the environment variable is set to true on .env
 if (process.env.DISABLE_GPT === 'true') {
    console.log('[generateWithGPT] DISABLE_GPT=true... returning mock output');
// returns mock putput.
    return JSON.stringify({
      title: "Mock Title",
      acronymGroups: [
        {
          id: "q1",
          keyPhrase: "Mock Mnemonic",
          title: "Mock Acronym Group",
          contents: [
            { letter: "M", word: "Mock" },
            { letter: "O", word: "Output" },
            { letter: "C", word: "Created" },
            { letter: "K", word: "Knowledge" }
          ]
        }
      ]
    });
  }
//ends here.


// For testing, turn this into a constant number like 100.
// THis is the default, MAX_CONTEXT_TOKENS - MAX_OUTPUT_TOKENS - RESERVED_TOKENS
const MAX_INPUT_TOKENS = MAX_CONTEXT_TOKENS - MAX_OUTPUT_TOKENS - RESERVED_TOKENS;

// Rough token estimate (1 token ≈ 4 characters)
let promptTokens = Math.ceil((userPrompt.length + systemPrompt.length) / 4);
console.log('Estimated prompt tokens:', promptTokens); // For vieweing the estimated or counted characters.


if (promptTokens >= MAX_INPUT_TOKENS) {
  throw new Error(
    `The text content is too long. Please shorten it and try again.`
  );
}

  if (!max_tokens) {
    max_tokens = Math.max(
      1,
      Math.min(MAX_OUTPUT_TOKENS, MAX_CONTEXT_TOKENS - promptTokens - RESERVED_TOKENS)
    );
  }

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature,
      max_completion_tokens: max_tokens
    });

    return response.choices[0]?.message?.content?.trim() || '';
  } catch (error) {
    console.error('[GPT ERROR]', error);
    throw new Error(`[GPT ERROR] ${error?.message || 'Failed to generate content with AI.'}`);

  }
}

