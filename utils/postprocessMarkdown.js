/**
 * Normalize and clean extracted Markdown text before feeding to GPT.
 * 
 * @param {string} markdown - Raw markdown or extracted text
 * @param {'pdf' | 'pptx' | 'docx'} sourceType - Type of source file
 * @returns {string} - Cleaned, normalized Markdown
 */



function isCaptionLine(line) {
  if (!line || line.length > 100) return false;

  const patterns = [
    /^Figure\s+\d+(\.\d+)?[:\-]/i,
    /^Image\s+\d+[:\-]?/i,
    /^Chart\s+\d+[:\-]?/i,
    /^Diagram\s+\d+[:\-]?/i,
    /^\(?Figure\s+\d+.*\)?$/i,
  ];

  return patterns.some((pat) => pat.test(line.trim()));
}


export function postprocessMarkdown(markdown, sourceType) {
  //For Debugging in terminal, to show the processed text. It is limited to 500. Can be changed. For preview purposes.
  console.log(`[postprocessMarkdown] Received (${sourceType}):`, markdown.slice(0, 5000)); // remove .slice(0, 2000)) if you don't want it but it could freeze you terminal if the text is huge.


  let text = markdown;

  // S1: Normalize line endings
  text = text.replace(/\r\n/g, '\n');

  // S1.5: Remove figure/image/chart lines/captions (for .docx only)
  //NOTE: add this prompt for revieweing captions before ignoring --> "Ignore lines starting with [Caption] unless they include relevant definitions or explanations."
if (sourceType === 'docx') {
  text = text
    .split('\n')
    .map((line) => {
      if (isCaptionLine(line)) {
        return `[Caption] ${line.trim()}`;
      }
      return line;
    })
    .join('\n');
}



  // S2: Normalize bullet symbols to Markdown dash
  text = text.replace(/^[\s•‣–-]{1,3}(?=\S)/gm, '- ');

  // S3: Normalize numbered and lettered list items (1), 1., a), i. → 1.)
  text = text.replace(/^(\s*)(\(?[0-9a-zA-Z]{1,3}[\).\]])(\s+)/gm, (match, indent, marker, space) => {
    // Always convert to "1. " style for Markdown
    let normalized = marker
      .replace(/^[\(\[]?/, '')     // Remove opening ( or [
      .replace(/[\)\]\.]$/, '');   // Remove closing ) or . or ]
    
    // If it's a letter like a, b, i, ii — convert to lowercase
    if (/^[a-zA-Z]+$/.test(normalized)) {
      normalized = normalized.toLowerCase();
    }

    return `${indent}${normalized}. `;
  });


// NOTE: Refactored S4 (09/22) so it doesn't force merge after every line break, only when it makes sense.
// S4: Merge broken lines into full paragraphs, but keep headings/terms intact
text = text.replace(/([^\n]+)\n(?=[^\n])/g, (match, prevLine) => {
  const trimmed = prevLine.trim();

  // 1. Don't merge if it's a Markdown heading
  if (/^#{1,6}\s/.test(trimmed)) return match;

  // 2. Don't merge if it's a bullet or list item
  if (/^\s*([-*])\s+[A-Za-z0-9].*$/.test(trimmed)) {
    // Normalize "-" or "*" bullets to "•" and ensure new line
    return '\n• ' + trimmed.replace(/^[-*]\s+/, '') + '\n';
  }

  // 3. Don't merge if it's a numbered list item
  if (/^\s*\d+\.\s+[A-Za-z0-9].*$/.test(trimmed)) {
    // Preserve numbering, force new line
    return '\n' + trimmed + '\n';
  }

  // 4. Don't merge if it's short (<= 4 words) and title-cased / acronym-like
  const words = trimmed.split(/\s+/);
  if (
    words.length <= 4 &&
    (
      /^[A-Z]/.test(words[0]) || // starts with capital
      words.some(w => /^[A-Z0-9/&]+$/.test(w)) // acronyms like UI/UX, SDK
    )
  ) {
    return match;
  }

  // 5. Otherwise merge unless it already ends with punctuation
  if (!/[.?!:;"”)]$/.test(trimmed)) {
    return trimmed + ' ';
  }

  return match;
});



  // S5: Ensure proper space after heading markers (e.g., ##Heading → ## Heading)
  text = text.replace(/^(#{1,6})([^\s#])/gm, '$1 $2');

  // S6: Remove extra blank lines (max 2 newlines in a row)
  text = text.replace(/\n{3,}/g, '\n\n');

  //For Debugging in terminal, to show the processed text. It is limited to 500. Can be changed. For preview purposes.
  console.log(`[postprocessMarkdown] Final Output (${sourceType}):`, text.slice(0, 5000)); // remove .slice(0, 2000)) if you don't want it but it could freeze you terminal if the text is huge.

  return text.trim();
}



