"""Bounded, offline text extraction. Never executes embedded content or follows links."""
import json, os, re, subprocess, sys, zipfile
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

MAX_TEXT = 200_000
MAX_PAGES = 30

def run(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=35, check=True)
    if len(result.stdout) > 2_000_000:
        raise ValueError('Extracted content is too large. Split the document into smaller files.')
    return result.stdout.decode('utf-8', errors='replace')

def xml_text(z, name):
    with z.open(name) as f:
        raw = f.read(5_000_001)
    if len(raw) > 5_000_000 or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ValueError('Unsupported or oversized document XML.')
    tree = ET.fromstring(raw)
    return '\n'.join(''.join(t.text or '' for t in n.iter() if t.tag.rsplit('}', 1)[-1] == 't')
                     for n in tree.iter() if n.tag.rsplit('}', 1)[-1] == 'p')

def extract(filename, ext):
    warnings = []
    sections = []
    if ext in ('docx', 'pptx'):
        with zipfile.ZipFile(filename) as z:
            entries = z.infolist()
            if len(entries) > 2000 or sum(i.file_size for i in entries) > 50_000_000:
                raise ValueError('The expanded document exceeds the import limit.')
            if any(i.flag_bits & 1 or i.compress_type not in (0, 8) for i in entries):
                raise ValueError('Encrypted or unsupported archives cannot be imported.')
            if len({i.filename for i in entries}) != len(entries):
                raise ValueError('Duplicate archive entries are not supported.')
            if ext == 'docx':
                sections.append(('Document', xml_text(z, 'word/document.xml')))
                warnings.append('Word text has no reliable page numbers. Check tables and reading order against the original.')
            else:
                # Follow presentation order, not slide filenames (which can differ after reorder).
                with z.open('ppt/presentation.xml') as f: raw = f.read(5_000_001)
                with z.open('ppt/_rels/presentation.xml.rels') as f: rel = f.read(5_000_001)
                if max(len(raw),len(rel)) > 5_000_000 or any(b'<!' in b for b in (raw,rel)):
                    raise ValueError('Unsupported presentation XML.')
                links = {r.get('Id'):r.get('Target') for r in ET.fromstring(rel) if r.get('TargetMode') != 'External'}
                slides = [n for n in ET.fromstring(raw).iter() if n.tag.endswith('}sldId')]
                if len(slides) > MAX_PAGES: raise ValueError('Split presentations longer than 30 slides.')
                for i,n in enumerate(slides, 1):
                    key = n.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
                    target = links.get(key, '')
                    if not re.fullmatch(r'slides/slide\d+\.xml', target): raise ValueError('Unsupported slide reference.')
                    sections.append((f'Slide {i}', xml_text(z, 'ppt/'+target)))
            warnings.append('Embedded images, charts and speaker notes are not interpreted. Upload important images separately for OCR.')
    elif ext == 'pdf':
        with open(filename,'rb') as f: magic=f.read(5)
        if magic != b'%PDF-': raise ValueError('This is not a valid PDF.')
        info = run(['pdfinfo', filename])
        match = re.search(r'^Pages:\s+(\d+)', info, re.M)
        if not match or int(match.group(1)) > MAX_PAGES: raise ValueError('Split PDFs longer than 30 pages.')
        pages = int(match.group(1))
        for page in range(1, pages+1):
            text = run(['pdftotext','-f',str(page),'-l',str(page),'-layout',filename,'-']).strip()
            if len(text) < 25:
                prefix = os.path.join(os.path.dirname(filename), 'ocr')
                run(['pdftoppm','-f',str(page),'-l',str(page),'-singlefile','-scale-to','2200','-png',filename,prefix])
                text = run(['tesseract',prefix+'.png','stdout','-l','eng+spa']).strip()
                warnings.append(f'Page {page} used OCR. Verify numbers, dates and names against the original.')
            sections.append((f'Page {page}',text))
    elif ext in ('png','jpg','jpeg','webp'):
        with open(filename,'rb') as f: magic=f.read(12)
        valid = (ext == 'png' and magic.startswith(b'\x89PNG\r\n\x1a\n')) or (ext in ('jpg','jpeg') and magic.startswith(b'\xff\xd8\xff')) or (ext == 'webp' and magic[:4] == b'RIFF' and magic[8:12] == b'WEBP')
        if not valid: raise ValueError('The image content does not match its file type.')
        text = run(['tesseract',filename,'stdout','-l','eng+spa'])
        sections.append(('Image',text))
        warnings.append('OCR reads text, not the meaning of diagrams. Verify the original before publishing.')
    elif ext == 'html':
        class Page(HTMLParser):
            def __init__(self):
                super().__init__(); self.skip=[]; self.parts=[]
            def handle_starttag(self, tag, attrs):
                if tag in ('script','style','nav','header','footer','noscript','svg'):
                    self.skip.append(tag)
                if not self.skip and tag in ('p','div','li','h1','h2','h3','br','tr'): self.parts.append('\n')
            def handle_endtag(self,tag):
                if self.skip and tag == self.skip[-1]: self.skip.pop()
            def handle_data(self,data):
                if not self.skip: self.parts.append(data)
        p=Page()
        with open(filename,encoding='utf-8',errors='replace') as f:p.feed(f.read())
        text=re.sub(r'[ \t]+',' ',' '.join(p.parts))
        sections.append(('Web page',re.sub(r'\n\s*\n+', '\n\n',text).strip()))
        warnings.append('Check that the imported page matches the selected language and jurisdiction.')
    else:
        raise ValueError('Use PNG, JPEG, WebP, PDF, DOCX or PPTX. Convert older Office files first.')
    body='\n\n'.join(f'## {label}\n{text.strip()}' for label,text in sections)
    if not any(text.strip() for _,text in sections): raise ValueError('No readable text found. Try a clearer scan or paste the text.')
    if len(body) > MAX_TEXT: raise ValueError('Extracted text exceeds 200,000 characters. Split the source.')
    return {'body':body,'warnings':warnings}

if __name__ == '__main__':
    try:
        # Limits are inherited by parser/OCR children; no network is used.
        if os.name != 'nt':
            import resource
            resource.setrlimit(resource.RLIMIT_AS,(768*1024*1024,768*1024*1024))
            resource.setrlimit(resource.RLIMIT_FSIZE,(32*1024*1024,32*1024*1024))
            resource.setrlimit(resource.RLIMIT_CPU,(90,90))
        print(json.dumps(extract(sys.argv[1],sys.argv[2]),ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error':str(e)[:250]})); sys.exit(1)
