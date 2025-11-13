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
- “Lightly summarize” means preserving every concept, definition, and example from the original text, but fixing the flow of the content.
- Do not add new explanations.
- Group and include all related concepts into sections with appropriate section titles.
- You must include all points from the original text.

Output format (strict JSON only):

{
  "title": "<Concise overall title of the content in sentence case.>",
  "sections": [
    {
      "title": "<SECTION TITLE IN ALL CAPITAL LETTERS>",
      "summary": "<Write a lightly summarized version of the section here. Include all text that does not fit into the *concepts* fields — do not omit any content. This is not a section summary, but a cohesive version of leftover information to maintain flow.>",
      "concepts": [
        {
          "term": "<List ALL names, dates, events, terms, and phrases from the content — include every one.>",
          "explanation": "<Provide the exact or minimally rephrased explanation from the text.>",
          "example": "<Include examples only if explicitly provided in the text — list all given examples.>"
        }
      ],
      "keyTakeaways": [
        "<Important fact or point preserved verbatim or near-verbatim from the section.>",
        "<Another important fact.>",
        "<Add more if applicable.>"
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
2. Extract all content from the material, including:
- Concepts
- Definitions
- Terms, names, and key phrases
- Examples and scenarios
- Reasoning and conceptual explanations

3. Do not summarize or remove any content. Preserve everything.
4. Present the content so that it is:
- Accurate and faithful to the original material
- Clear, friendly, and relatable for a Grade 10 student
- Logical in flow, easy to read and understand
- Group and include all related concepts into sections with appropriate section titles.
- You must include all points from the original text.

Section Requirements
Each section must include:

- Explanation
- - Fully describe the concept or topic.
- - Include all terms, names, and key phrases here, with student-friendly definitions or descriptions.
- - Use simple, clear language suitable for a Grade 10 student.

- Analogy
- - Provide a relatable comparison or real-world link to help students understand the concept.

- Deepening
- - Include 3–6 or more examples or scenarios that demonstrate the concept in action.
- - Show reasoning, practical uses, or applications of the concept.
- - Use examples that connect terms and ideas from the explanation to real life.

- KeyPoints
- - Concisely summarize the main takeaways of the section.
- - Focus on the essential ideas students must remember.

Formatting Rules:
- Maintain all technical or subject-specific terms.
- Explain each term in Grade 10-friendly language within the explanation.
- Keep tone educational, friendly, and clear.
- Do not shorten content; all ideas from the source must appear.

The JSON must strictly follow this format:
{
  "title": "<Overall title of the material in sentence case.>",
  "sections": [
    {
      "title": "<Section title in all capital letters.>",
      "explanation": "<Detailed and complete explanation including all terms, names, and phrases with student-friendly descriptions. Include all text that does not fit into the *analogy*, *steps* and *keyPoints* fields — do not omit any content. >",
      "analogy": "<Simple, relatable comparison or real-world link that helps students understand.>",
      "steps": [
        "<1. Include reasoning, AI-generated demonstration, or real-world example showing the concept in action.>",
        "<2. Continue explaining deeper logic or another applied example.>",
        "<3. Continue explaining deeper logic or another applied example.>",
        "<4. Continue explaining deeper logic or another applied example.>",
        "<5. Add more insights or applications to reinforce understanding.>",
        "<Add more if applicable.>"
      ],
      "keyPoints": [
        "<Main takeaway 1>",
        "<Main takeaway 2>",
        "<Main takeaway 3>",
        "<Main takeaway 4 if applicable>"
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
Extract only existing terms from the given text (no explanations, examples, or invented terms or words).
Group all extracted terms into multiple small, concept-based sections with 2–5 related terms per section.

Rules:
1. Use only words and phrases actually present in the text.
2. Group logically by meaning — e.g., Programming Basics, Errors, OOP Concepts, Java Components, etc.
- If programming languages appear, do NOT group them under “Programming Languages.” Instead, group them into High-Level Languages and Low-Level Languages (e.g., Part 1, Part 2 if needed).
3. Each section is independent — no subsections or nesting.
4. Do not include notes, commentary, or explanations.
5. Merge duplicates (e.g., “Logic error” + “Logical error” → “Logic Error”).
6. Each section must contain 2–5 terms only.
7. If a section would exceed 5 terms, create additional sections labeled “Part 1,” “Part 2,” “Part 3,” etc. (STRICTLY FOLLOW THIS RULE NO MATTER WHAT).

8. Output format must follow exactly:
# Section Name
- Term 1
- Term 2
- Term 3

9. Output only the grouped list of terms — nothing else. No introductions, notes, or summaries.

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
- Must contain exactly the same number of words as the letters in the given term(s), in the correct order.
- Each word must begin with the corresponding letter of the term, following the exact sequence.
- STRICTLY follow the letters sequentially.
- Must not exceed 5 words in total.
- Include all repeated letters — do not skip, merge, or omit any.
- The words must not relate to the term’s meaning and must not include the term itself or any of its variations.
- If a meaningful word cannot be formed for a letter, use a neutral placeholder word that starts with that letter (e.g., “Lovely” for L, “Quick” for Q, “Bright” for B).

3. Output Structure:
- Keep all other fields exactly as in the input.
- Output must be valid JSON with this schema:
- Do not invent new terms or change existing ones — only organize and create mnemonics.

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
      "title": "<Group title that reflects the terms, but do not use the terms themselves>",
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
  parsed = step1Parsed;
  // Step 2: Generate acronyms & mnemonics
//   const step2SystemPrompt = `


// Your task is to validate and correct the JSON strictly according to these rules:

// 1. Validate letter fields in contents:
// - For each item in contents, check that "letter" matches the first letter (case-insensitive) of "word".
// - If it does not match, update "letter" to exactly match the first letter of "word".

// 2. Validate and correct keyPhrase:
// - Count the items in contents. "keyPhrase" must have exactly the same number of words.
// - Each word in "keyPhrase" must start with the corresponding "letter" of each contents item in order, but not the terms themselves.
// - Keep repeated letters; do not skip, merge, or omit any letters.
// - Do not use the terms themselves in "keyPhrase". Words may relate to the meaning of the terms or use generic placeholders.
// - If the current "keyPhrase" does not follow these rules, rewrite it so it matches the corrected sequence of letters.

// 3. Preserve all other fields exactly:
// - Do not modify title, id, group title, or the order of acronymGroups.
// - Do not remove, merge, or skip any terms or groups.

// 4. Output:
// - Return only the corrected JSON, maintaining the exact same structure.
// - The output must be valid JSON.


// `;

//   const step2UserPrompt = `Here is the extracted data:\n---\n${JSON.stringify(step1Parsed, null, 2)}\n---`;

//   const step2Output = await generateWithGPT({
//     userPrompt: step2UserPrompt,
//     systemPrompt: step2SystemPrompt,
//     temperature: 0
//   });

//   console.log("[acronym Step2] Raw GPT Output:\n", step2Output);
  

//   let step2Parsed;
//   try {
//     step2Parsed = JSON.parse(step2Output.replace(/```json\s*/i, '').replace(/```$/, '').trim());
//   } catch (err) {
//     console.error(`[acronym Step2] Failed to parse JSON:`, err);
//     console.error(`[acronym Step2] Raw Output:\n`, step2Output);
//     return res.status(500).json({ error: `Invalid GPT Step2 output for acronym` });
//   }

// Comment this out to enable Step 3 validation (09/22)
 // parsed = step2Parsed;
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
1. Clean the provided text:
- Fix formatting issues, normalize headings, lists, and spacing.
- Do not include metadata of the text.

2. Extract ALL items from the content, including:
- Terms, concepts, frameworks, and theories
- Formulas, equations, or calculations
- Specialized terminology
- Acronyms and abbreviations
- Software, tools, or equipment
- Names of people, organizations, or groups
- Locations, places, or institutions
- Events, dates, milestones, or historical references
- Laws, policies, regulations, documents, or notable works
- Any discipline-specific items relevant to understanding the material

3. Provide clear definitions or descriptions for each item:
- Definitions must not start with the term itself (avoid circular definitions).
- Keep definitions concise while preserving its original meaning.
- Rephrase MINIMALLY if needed for clarity.

4. Rundown the text one by one and capture EVERY ITEMS, but do not include items if definitions did not appear in the text.
5. DO NOT invent new items or definitions — only extract from the provided content.

Return strict JSON in this format:

{
  "title": "<Concise overall title of the material>",
  "questions": [
    {
      "id": "q1",
      "term": "<Rundown the text one by one and list ALL terms, acronyms, names, organizations, locations, events, dates, software/tools, laws, documents, notable works, concepts, frameworks, theories, formulas and any discipline-specific items mentioned in the text — include every one.>",
      "definition": "<Provide the exact or MINIMALLY rephrased explanation or description from the text.>"
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
- STRICTLY DO NOT OMIT ANY TERMS OR DEFINITIONS FROM THE PROVIDED INPUT.
- Do not change the "title" field.
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
