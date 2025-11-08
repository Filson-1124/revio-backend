import sys
import pdfplumber
import json
import re
from pdf2image import convert_from_path
import pytesseract
from pytesseract import Output
from PIL import Image, ImageEnhance, ImageFilter

# Figure/nontextual caption detection
def is_figure_caption(line):
    figure_patterns = [
        r'^Figure\s+\d+(\.\d+)?[:\-]?',
        r'^Image\s+\d+[:\-]?',
        r'^Chart\s+\d+[:\-]?',
        r'^Diagram\s+\d+[:\-]?',
        r'^Fig\.?\s+\d+.*',
    ]
    return any(re.match(pat, line.strip()) for pat in figure_patterns)

#preprocess image ifrts for better OCR
def preprocess_image(img):
    img = img.convert("L")  # grayscale
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(2.0)  #increase contrast
    img = img.filter(ImageFilter.SHARPEN)
    return img

# OCR a specific PDF page using pytesseract and pdf2imgae . issue is some PDFs have no text layer. But this fallback won't work on pdfs with heavy graphics.
def ocr_page(file_path, page_number, psm=1):
    images = convert_from_path(file_path, first_page=page_number+1, last_page=page_number+1)
    if not images:
        return ""
    img = preprocess_image(images[0])
    text = pytesseract.image_to_string(img, config=f"--psm {psm}")
    return text

def extract_text_from_pdf(file_path):
    try:
        markdown = ""
        with pdfplumber.open(file_path) as pdf:
            for page_number, page in enumerate(pdf.pages):
                # Try pdfplumber first
                text = page.extract_text()

                # Fallback to OCR if needed or text layer isnt available
                if not text or text.strip() == "":
                    # Use auto page segmentation)
                    text = ocr_page(file_path, page_number, psm=1)

                #process lines
                lines = text.split('\n') if text else []
                cleaned_lines = []

                for line in lines:
                    line = line.strip()
                    if is_figure_caption(line):
                        cleaned_lines.append(f"[Caption] {line}")
                    else:
                        cleaned_lines.append(line)

                cleaned_page = '\n'.join(cleaned_lines)
                markdown += cleaned_page + "\n\n"

        markdown = markdown.strip()

        result = {
            "success": True,
            "markdown": markdown
        }
        print(json.dumps(result))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))

if __name__ == "__main__":
    file_path = sys.argv[1]
    extract_text_from_pdf(file_path)
