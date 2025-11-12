import { db } from '../utils/firebaseAdmin.js';
import { simulateRes } from '../utils/simulateRes.js';
import { postprocessMarkdown } from '../utils/postprocessMarkdown.js';
import { generateWithGPT } from '../utils/generateWithGPT.js';

// Counter Meta on Firestore - ID Gen
const updateCounterAndGetId = async (uid, folderId, prefix) => {
  const metaRef = db.collection('users').doc(uid).collection('meta').doc('counters');
  await db.runTransaction(async (transaction) => {
    const metaDoc = await transaction.get(metaRef);
    if (!metaDoc.exists) {
      transaction.set(metaRef, {
        acronymCounter: 0,
        termCounter: 0,
        summarizationCounter: 0,
        aiCounter: 0
      });
    }
  });

  const counterField = {
    AcronymMnemonics: 'acronymCounter',
    TermsAndDefinitions: 'termCounter',
    SummarizedReviewers: 'summarizationCounter',
    SummarizedAIReviewers: 'aiCounter'
  }[folderId];

  const counterRef = db.collection('users').doc(uid).collection('meta').doc('counters');
  const counterSnapshot = await counterRef.get();
  const current = counterSnapshot.data()?.[counterField] || 0;
  const next = current + 1;
  await counterRef.update({ [counterField]: next });
  return `${prefix}${next}`;
};





// Helper: remove ```json or ``` fences from GPT output
function stripFenced(text) {
  if (!text) return '';
  return text.replace(/```json\s*/gi, '')  // remove opening ```json
             .replace(/```/g, '')         // remove closing ```
             .trim();
}



// Feature Prompting
async function processFeature(req, res, featureType) {
  try {
    const uid = req.user.uid;

    let folderId, prefix, systemPrompt, temperature = 0;

    switch (featureType) {
      case 'acronym':
        folderId = 'AcronymMnemonics';
        prefix = 'ac';
        break;

      case 'terms':
        folderId = 'TermsAndDefinitions';
        prefix = 'td';
        break;

      case 'summarize':
        folderId = 'SummarizedReviewers';
        prefix = 'std';
        systemPrompt = `

You are an academic assistant helping students prepare for exams.

Task:
- Read the provided study material.
- Lightly summarize it into a structured study guide using the exact format below.
- “Lightly summarize” remove redundancy while preserving every concept, definition, and example from the original text.
- Do not add new explanations or interpretations.

Output format (strict JSON only):

{
  "title": "<Concise overall title of the content in sentence case.>",
  "sections": [
    {
      "title": "<Section title in all capital letters>",
      "summary": "<Lightly condensed restatement of this section that shortens wording but retains all original concepts, definitions, and examples exactly as presented in the source text>",
      "concepts": [
        {
          "term": "<Key term or phrase from the content>",
          "explanation": "<Exact or minimally rephrased explanation from the text>",
          "example": "<Give examples if explicitly provided in the text; include all given examples>"
        }
      ],
      "keyTakeaways": [
        "<Important fact or point preserved verbatim or near-verbatim>",
        "<Another important fact>",
        "..."
      ]
    }
  ]
}
             
        `;
        break;

      case 'explain':
        folderId = 'SummarizedAIReviewers';
        prefix = 'ai';
        systemPrompt = `    
You are an academic tutor explaining study material to a Grade 10 student.

Task:
1. Read the provided study material carefully.
2. Extract all key ideas, including important concepts, definitions, terms, examples, steps, and reasoning.
3. Apply light summarization: simplify and organize the material for easier understanding, but preserve all essential details, accuracy, and technical meaning.
4. Present the content in a way that is both:
- Accurate and faithful to the original information (no loss of meaning).
- Clear, friendly, and relatable for a Grade 10 student (simple words, logical flow).
5. Each section must include:
- A clear explanation of the concept.
- A relatable analogy that connects the concept to something familiar.
- A mandatory “steps” field that combines:
 - - AI-generated examples or demonstrations (e.g., a short scenario, paragraph, calculation, or code snippet).
 - - Real-world connections or practical uses of the concept.
 - - Reasoning or conceptual breakdowns that help students understand “how” or “why” it works.
- A concise list of key points summarizing the takeaways.
6. The goal is to produce a complete, student-friendly study guide that makes the subject easy to learn, remember, and review.


Formatting Rules:
- Keep technical or subject-specific terms but define them clearly.
- The "steps" field is mandatory and must contain AI-generated examples and real-world or applied insights — not just procedural instructions.
- "steps" should have 3–6 items blending reasoning, applications, and demonstrations.
- Keep tone educational, friendly, and easy to follow.
- Maintain accuracy for all technical or academic content.
- Keep explanations moderately detailed, not too short or too long.

Output format (strict JSON only):
{
  "title": "<Overall title of the material in sentence case.>",
  "sections": [
    {
      "title": "<Section title in all capital letters.>",
      "explanation": "<Detailed but clear explanation of the topic, lightly summarized but comprehensive.>",
      "analogy": "<Simple, relatable comparison or real-world link that helps students understand.>",
      "steps": [
        "<1. Include reasoning, AI-generated demonstration, or real-world example showing the concept in action.>",
        "<2. Continue explaining deeper logic or another applied example.>",
        "<3. Add more insights or applications to reinforce understanding.>",
        "<...>"
      ],
      "keyPoints": [
        "<Main takeaway 1>",
        "<Main takeaway 2>",
        "<Main takeaway 3>"
      ]
    }
  ]
}

     
        `;
        break;
    }

    // Get reviewer ID
    const reviewerId = await updateCounterAndGetId(uid, folderId, prefix);

    //extract markdown
    let markdown = req.body.markdown || '';
    if (!markdown && req.file) markdown = await simulateRes(req.file.path, req.file.mimetype);

    if (!markdown) {
      return res.status(400).send('No content to process. Please try again.');
    }

    // Added error handling if text content is too short.
    const cleanedText = markdown.trim();

    const wordCount = cleanedText.split(/\s+/).length;
    if (wordCount < 20) {  
      return res.status(400).send('The text content is too short or meaningless for this feature.');
    }

    const letters = cleanedText.replace(/[^a-zA-Z]/g, '');
    if (letters.length < 50) {
      return res.status(400).send('The text content is too short or meaningless for this feature.');
    }
    // ends here

    // Postprocess onli for summarize/explain
    if (['summarize', 'explain'].includes(featureType)) {
      markdown = postprocessMarkdown(markdown, req.file?.mimetype || req.body.sourceType);
    }

    // Debugging for viewing the processed markdown on postman. Use any feature endpoint.
    if (process.env.RETURN_MARKDOWN_ONLY === "true") {
      return res.json({ processedMarkdown: markdown });
    }

    let parsed;

    // Two-step flow for Acronym // Updated now four steps 0-3 (09/22)
if (featureType === 'acronym') {
  // Step 0: GPT-based markdown cleaning/restructuring
  const step0SystemPrompt = `
You are an academic assistant helping students prepare for exams.

Task:
- Read the provided study material.
- Lightly summarize it into a structured study guide using the exact format below.
- “Lightly summarize” means shorten sentences and remove redundancy while preserving every concept, definition, and example from the original text.
- Do not add new explanations or interpretations.
- Do not include metadata, objectives and the likes.
- Separate the terms into distinct sections whenever they represent different or clearly separable concepts.

Output format:
Title: <Concise overall title of the content.>
sections: <Section title 1 based on the overall terms>
terms: <Key term or compound terms from the content>

sections: <Section title 2 based on the overall terms>
terms: <Key term or compound terms from the content>
...
and so on and so forth.

`;

  const step0UserPrompt = `Content to process:\n---\n${markdown}\n---`;

  const step0Output = await generateWithGPT({
    userPrompt: step0UserPrompt,
    systemPrompt: step0SystemPrompt,
    temperature: 0
  });

  console.log("[acronym Step0] Raw GPT Output:\n", step0Output);

  let cleanedMarkdown = stripFenced(step0Output || '');
  if (!cleanedMarkdown) {
    console.warn('[acronym Step0] Empty output from GPT. Falling back to local postprocessMarkdown.');
    cleanedMarkdown = postprocessMarkdown(markdown, req.file?.mimetype || req.body.sourceType);
  }
  markdown = cleanedMarkdown;

  if (process.env.RETURN_MARKDOWN_ONLY === "true") {
    return res.json({ processedMarkdown: markdown });
  }

  // Step 1: Extract terms/groups
  const step1SystemPrompt = `

You are an academic assistant generating acronyms and mnemonic sentences from JSON input. Follow these rules strictly:

1. Letter Assignment:
- For each term, set "letter" = first character of the first word of the term.
- Preserve all terms exactly as they appear.
2. Mnemonic Sentence (keyPhrase):
- Must have exactly the same number of words as terms.
- Each word must start with the corresponding "letter" of that term, in order.
- Include repeated letters; do not skip, merge, or drop any.
- The words can relate to the meaning of the terms, but must not use the terms themselves.
- If you cannot make a meaningful mnemonic for a letter, use a generic placeholder word starting with that letter (e.g., “Lovely” for “L”), but do not skip or omit any letter.
3. Output Structure:
- Keep all other fields exactly as in the input.
- Output must be valid JSON with this schema:
 Do not invent new terms or change existing ones — only organize and create mnemonics.

 Critical Rule:
- Do not skip, merge, or alter the order of letters.
- Do not modify terms.
- Do not reduce repeated letters in the mnemonic.

Return strict JSON only in this format:

{
  "title": "<Concise overall title>",
  "acronymGroups": [
    {
      "id": "q1",
      "keyPhrase": "<Mnemonic sentence>",
      "title": "<Group title>",
      "contents": [
        { "letter": "<First letter>", "word": "<Term 1>" },
        { "letter": "<First letter>", "word": "<Term 2>" }
      ]
    }
  ]
}



`;

  const step1UserPrompt = `Content to process:\n---\n${markdown}\n---`;

  const step1Output = await generateWithGPT({
    userPrompt: step1UserPrompt,
    systemPrompt: step1SystemPrompt,
    temperature: 0
  });

  console.log("[acronym Step1] Raw GPT Output:\n", step1Output);

  let step1Parsed;
  try {
    step1Parsed = JSON.parse(step1Output.replace(/```json\s*/i, '').replace(/```$/, '').trim());
  } catch (err) {
    console.error(`[acronym Step1] Failed to parse JSON:`, err);
    console.error(`[acronym Step1] Raw Output:\n`, step1Output);
    return res.status(500).json({ error: `Invalid GPT Step1 output for acronym` });
  }

  // Step 2: Generate acronyms & mnemonics
  const step2SystemPrompt = `


Your task is to validate and correct this structure according to these rules:
1. Each contents item must have its "letter" equal to the first letter (case-insensitive) of its "word".
- If mismatched, correct the "letter" field to match the first letter of "word".
2. The "keyPhrase" must be a mnemonic sentence whose initial letters (ignoring case and punctuation) match the sequence of "letter" values in "contents".
- Make sure "keyPhrase" is complete and is not missing word in the "contents".
- If it doesn’t match, rewrite "keyPhrase" so that it correctly reflects each word in "contents".
3. Preserve all other text fields (title, id, group title, etc.) as is.
4. Return only the corrected JSON, keeping the same structure.



`;

  const step2UserPrompt = `Here is the extracted data:\n---\n${JSON.stringify(step1Parsed, null, 2)}\n---`;

  const step2Output = await generateWithGPT({
    userPrompt: step2UserPrompt,
    systemPrompt: step2SystemPrompt,
    temperature: 0
  });

  console.log("[acronym Step2] Raw GPT Output:\n", step2Output);
  

  let step2Parsed;
  try {
    step2Parsed = JSON.parse(step2Output.replace(/```json\s*/i, '').replace(/```$/, '').trim());
  } catch (err) {
    console.error(`[acronym Step2] Failed to parse JSON:`, err);
    console.error(`[acronym Step2] Raw Output:\n`, step2Output);
    return res.status(500).json({ error: `Invalid GPT Step2 output for acronym` });
  }

// Comment this out to enable Step 3 validation (09/22)
  parsed = step2Parsed;
// 

//Uncomment below to enable Step 3 validation if you want to include step 3 again. (09/22)
// Step 3: Validation & Finalization
//   const step3SystemPrompt = `
// You are a validator and corrector for acronym mnemonics. Follow these rules strictly:

// 1. Letter Accuracy:
// - Each "letter" field must exactly match the first character of the first word in the corresponding entry; if it’s a compound word, only use the first word for reference.
// - Correct any mismatches; do not remove or change any terms.

// 2. Mnemonic Sentence (keyPhrase) Accuracy:
// - The "keyPhrase" must have exactly one word per letter, in order. For compound words, count only the first word.
// - Each word in the sentence must start with the corresponding "letter", including repeated letters.
// - Do not skip, merge, or omit any letters.
// - The words can relate to the meaning of the terms but must not repeat the terms themselves.
// - If a meaningful word cannot be found for a letter, use a generic placeholder starting with that letter.

// 3. Preserve Terms and Order:
// - Do not change the "word" fields or their order.
// - Only correct the "letter" and "keyPhrase" fields as needed.
// - If a field in "letter" matches the "keyPhase" field, leave it unchanged (preserve as is).

// 4. Output Format:
// - Return only valid JSON with the exact same schema as input.
// - Maintain all other fields exactly as in the input.

// Example Correction #1
// Input (problematic):
// {
//   "keyPhrase": "Smart Tech Operates Rapidly",
//   "title": "Software Components",
//   "contents": [
//     { "letter": "S", "word": "Server" },
//     { "letter": "T", "word": "Thread Pool" },
//     { "letter": "O", "word": "Operating System" },
//     { "letter": "R", "word": "Router" },
//     { "letter": "R", "word": "Registry" }
//   ]
// }
// Problem:
// - The original keyPhrase has only one “R” word (Rapidly) but there are two “R” letters in the contents.

// Corrected Output:
// {
//   "keyPhrase": "Smart Tech Operates Rapidly Reliably",
//   "title": "Software Components",
//   "contents": [
//     { "letter": "S", "word": "Server" },
//     { "letter": "T", "word": "Thread Pool" },
//     { "letter": "O", "word": "Operating System" },
//     { "letter": "R", "word": "Router" },
//     { "letter": "R", "word": "Registry" }
//   ]
// }

// Explanation of the correction in example correct #1:
// - Each word in keyPhrase now corresponds exactly to the letter of the term.
// - Both "R" entries are preserved and reflected in the mnemonic.
// - Order of terms is maintained.
// - No letters or terms are skipped, merged, or altered.

// Example Correction #2
// Input (problematic):
// {
//   "keyPhrase": "Silly Ants Playfully Paint In Colorful Caves",
//   "title": "Requirements of a Professional",
//   "contents": [
//     { "letter": "S", "word": "Specialized knowledge" },
//     { "letter": "A", "word": "Autonomy" },
//     { "letter": "P", "word": "Professional code" },
//     { "letter": "P", "word": "Personal code" },
//     { "letter": "I", "word": "Institutional code" },
//     { "letter": "C", "word": "Community code" }
//   ]
// }

// Corrected Output:
// {
//   "keyPhrase": "Silly Ants Playfully Paint In Colorful",
//   "title": "Requirements of a Professional",
//   "contents": [
//     { "letter": "S", "word": "Specialized knowledge" },
//     { "letter": "A", "word": "Autonomy" },
//     { "letter": "P", "word": "Professional code" },
//     { "letter": "P", "word": "Personal code" },
//     { "letter": "I", "word": "Institutional code" },
//     { "letter": "C", "word": "Community code" }
//   ]
// }

// Explanation of the correction in example correction #2:
// - Each word in keyPhrase now corresponds exactly to the first letter of each term in contents, in order.
// - The overall order of terms remains consistent with the original.
// - No letters or terms were omitted, merged, or altered; only the extra word (“Caves”) was removed to ensure a one-to-one alignment.

// `;

//   const step3UserPrompt = `
// Here is the generated JSON from Step 2:
// ${JSON.stringify(step2Parsed, null, 2)}
// `;

//   const step3Output = await generateWithGPT({
//     userPrompt: step3UserPrompt,
//     systemPrompt: step3SystemPrompt,
//     temperature: 0
//   });

//   console.log("[acronym Step3] Raw GPT Output:\n", step3Output);

//   try {
//     parsed = JSON.parse(step3Output.replace(/```json\s*/i, '').replace(/```$/, '').trim());
//   } catch (err) {
//     console.error(`[acronym Step3] Failed to parse JSON:`, err);
//     console.error(`[acronym Step3] Raw Output:\n`, step3Output);
//     parsed = step2Parsed; // fallback if validation fails
//   }



} else if (featureType === 'terms') {
  // Two-step flow for Terms
  const step1SystemPrompt = `
You are an academic assistant.

Tasks:
1. Clean the provided text: fix formatting, normalize headings, lists, and spacing.
2. Identify and extract ALL possible terms, concepts, or keywords that are explicitly defined or explained in the text.
   - Include acronyms, technical jargon, commands, principles, and key subject terms.
   - A "definition" means any sentence or phrase that explains what the term is, what it means, or it's purpose.
   - If a term is mentioned but not defined, do not include it.
   - If a term has multiple valid definitions in the text, merge them into a single clear definition.
3. Definitions should not contain the term itself at the beginning (avoid circular definitions).
4. If the definition is too long, condense it while preserving the original meaning.

Return strict JSON in this format:

{
  "title": "<Concise overall title>",
  "questions": [
    {
      "id": "q1",
      "term": "<Term or concept>",
      "definition": "<Definition text only>"
    }
  ]
}}
  
`;

  const step1UserPrompt = `Content to process:\n---\n${markdown}\n---`;

  const step1Output = await generateWithGPT({
    userPrompt: step1UserPrompt,
    systemPrompt: step1SystemPrompt,
    temperature: 0
  });

  // GPT raw output for first step, for debugging.
  console.log("[terms Step1] Raw GPT Output:\n", step1Output);

  let step1Parsed;
  try {
    step1Parsed = JSON.parse(step1Output.replace(/```json\s*/i, '').replace(/```$/, '').trim());
  } catch (err) {
    console.error(`[terms Step1] Failed to parse JSON:`, err);
    console.error(`[terms Step1] Raw Output:\n`, step1Output);
    return res.status(500).json({ error: `Invalid GPT Step1 output for terms` });
  }

  // Step 2: add distractors aka final output
  const step2SystemPrompt = `
You are an exam-prep assistant.

Based on the provided JSON of terms and correct definitions, create multiple-choice style data:

Rules:
- Keep the correct definition exactly as given.
- Add 3 wrong options (distractors) that are plausible but incorrect.  2 wrong options should have long definition (30 words). 1 wrong option should be short (15 words).
- Wrong options must not be identical to the correct definition.
- Wrong options must be conceptually related but distinct.
- Return strict JSON in this schema:

{
  "title": "<Concise overall title of the content>",
  "questions": [
    {
      "id": "q1",
      "term": "<Term or concept>",
      "definition": [
        { "text": "<CORRECT DEFINITION>", "type": "correct" },
        { "text": "<WRONG OPTION 1>", "type": "wrong" },
        { "text": "<WRONG OPTION 2>", "type": "wrong" },
        { "text": "<WRONG OPTION 3>", "type": "wrong" }
      ]
    }
  ]
}
  `;

  const step2UserPrompt = `Here is the extracted data:\n---\n${JSON.stringify(step1Parsed, null, 2)}\n---`;

  const step2Output = await generateWithGPT({
    userPrompt: step2UserPrompt,
    systemPrompt: step2SystemPrompt,
    temperature: 0
  });

  // GPT raw output for second step, for debugging.
  console.log("[terms Step1] Raw GPT Output:\n", step2Output);

  try {
    parsed = JSON.parse(step2Output.replace(/```json\s*/i, '').replace(/```$/, '').trim());
  } catch (err) {
    console.error(`[terms Step2] Failed to parse JSON:`, err);
    console.error(`[terms Step2] Raw Output:\n`, step2Output);
    return res.status(500).json({ error: `Invalid GPT Step2 output for terms` });
  }

} else {
  // Single-step flow for summarize/explain
  const userPrompt = `Content to process:\n---\n${markdown}\n---`;

  const gptOutput = await generateWithGPT({ userPrompt, systemPrompt, temperature });

  // GPT raw output for debugging. for summarize/explain.
  console.log(`[${featureType} Raw GPT Output]:\n`, gptOutput);

  try {
    parsed = JSON.parse(gptOutput.replace(/```json\s*/i, '').replace(/```$/, '').trim());
  } catch (err) {
    console.error(`[${featureType} GPT] Failed to parse JSON:`, err);
    console.error(`[${featureType} GPT] Raw Output:\n`, gptOutput);
    return res.status(500).json({ error: `Invalid GPT output for ${featureType}` });
  }
}


    // Firestore Saving
    const reviewerRef = db
      .collection('users')
      .doc(uid)
      .collection('folders')
      .doc(folderId)
      .collection('reviewers')
      .doc(reviewerId);

    switch (featureType) {
      case 'acronym': {
        await reviewerRef.set({ id: reviewerId, title: parsed.title || 'Untitled', createdAt: new Date(), startDate: new Date() });

        const saveBatch = db.batch();
        for (const group of parsed.acronymGroups || []) {
          const contentRef = reviewerRef.collection('content').doc(group.id);
          saveBatch.set(contentRef, { id: group.id, keyPhrase: group.keyPhrase, title: group.title });

          group.contents.forEach((item, index) => {
            const itemRef = contentRef.collection('contents').doc(index.toString());
            saveBatch.set(itemRef, { letter: item.letter, word: item.word });
          });
        }
        await saveBatch.commit();
        break;
      }

      case 'terms': {
        await reviewerRef.set({ id: reviewerId, title: parsed.title || 'Untitled', createdAt: new Date(), startDate: new Date() });

        const saveBatch = db.batch();
        for (const q of parsed.questions || []) {
          if (!q?.term || !Array.isArray(q.definition)) continue;

          const definitions = q.definition
            .filter(d => d?.text && d?.type)
            .map(d => ({ text: d.text.trim(), type: d.type }));

          if (definitions.length === 0) continue;

          const qRef = reviewerRef.collection('questions').doc(q.id || undefined);
          saveBatch.set(qRef, { term: q.term.trim(), definition: definitions });
        }
        await saveBatch.commit();
        break;
      }

      case 'summarize':
      case 'explain': {
        const reviewerData = { id: reviewerId, reviewers: [parsed], createdAt: new Date(), startDate: new Date() };
        await reviewerRef.set(reviewerData);
        break;
      }
    }

  
    // Return consistent response
    res.json({ reviewers: [{ id: reviewerId, ...parsed }] });

  } catch (err) {
    console.error(`[${featureType} Feature] Error:`, err);
    res.status(400).json({ error: err.message || `Failed to process ${featureType}` });
  }
}


// Exported Feature Functions
export const acronymFeature = (req, res) => processFeature(req, res, 'acronym');
export const termsFeature = (req, res) => processFeature(req, res, 'terms');
export const summarizeFeature = (req, res) => processFeature(req, res, 'summarize');
export const explainFeature = (req, res) => processFeature(req, res, 'explain');
