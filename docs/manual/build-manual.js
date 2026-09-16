/* Builds RuninqVic 사용설명서 as DOCX (docx-js) and HTML from content.js
   usage: NODE_PATH=<dir with node_modules/docx> node docs/manual/build-manual.js */
const fs = require('fs');
const path = require('path');
const C = require('./content.js');
const D = require('docx');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun, AlignmentType,
  TableOfContents, PageBreak, BorderStyle, ShadingType, LevelFormat, Header, Footer, PageNumber, ExternalHyperlink,
} = D;

const HERE = __dirname;
const IMG = (f) => path.join(HERE, 'img', f);
const OUT_DOCX = path.join(HERE, 'RuninqVic_사용설명서.docx');
const OUT_HTML = path.join(HERE, '..', '..', 'manual.html');
const FONT = '맑은 고딕';
const ORANGE = 'E8562A';
const GRAY = '666666';
const CONTENT_W = 9360; /* A4 width 11906 - margins 2*1273 */

function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }

/* ---------- DOCX builders ---------- */
const run = (text, o) => new TextRun(Object.assign({ text, font: FONT, size: 21 }, o || {}));
const para = (text, o) => new Paragraph(Object.assign({ children: [run(text)], spacing: { after: 120, line: 320 } }, o || {}));
const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [run(t, { size: 34, bold: true, color: ORANGE })], spacing: { before: 360, after: 200 }, pageBreakBefore: true });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [run(t, { size: 26, bold: true, color: '222222' })], spacing: { before: 280, after: 120 } });
const note = (t) => new Paragraph({ children: [run('TIP  ', { bold: true, color: ORANGE }), run(t)], spacing: { before: 80, after: 160, line: 320 }, indent: { left: 200 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: ORANGE, space: 8 } }, shading: { type: ShadingType.CLEAR, fill: 'FFF4EE', color: 'auto' } });
const bullet = (t) => new Paragraph({ children: [run(t)], numbering: { reference: 'bullets', level: 0 }, spacing: { after: 80, line: 300 } });
let olInstance = 0;
const numbered = (t, inst) => new Paragraph({ children: [run(t)], numbering: { reference: 'numbers', level: 0, instance: inst }, spacing: { after: 80, line: 300 } });

function cell(text, w, head) {
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: head ? { type: ShadingType.CLEAR, fill: 'FDE8DF', color: 'auto' } : undefined,
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    children: [new Paragraph({ children: [run(text, { bold: !!head, size: 19 })], spacing: { after: 0, line: 280 } })],
  });
}
function table(t) {
  const widths = t.widths; const total = widths.reduce((a, b) => a + b, 0);
  const scale = CONTENT_W / total; const w = widths.map((x) => Math.round(x * scale));
  const rows = [new TableRow({ tableHeader: true, children: t.head.map((h, i) => cell(h, w[i], true)) })];
  for (const r of t.rows) rows.push(new TableRow({ children: r.map((c, i) => cell(c, w[i], false)) }));
  return new Table({ columnWidths: w, width: { size: CONTENT_W, type: WidthType.DXA }, rows,
    borders: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' }, bottom: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' }, left: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' }, right: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD' } } });
}
function image(file, cap) {
  const buf = fs.readFileSync(IMG(file)); const sz = pngSize(buf);
  const maxW = 624; const h = Math.round(sz.h * maxW / sz.w);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, children: [new ImageRun({ type: 'png', data: buf, transformation: { width: maxW, height: h } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: [run(cap, { size: 18, color: GRAY, italics: true })] }),
  ];
}
function faq(items) {
  const out = [];
  items.forEach(([q, a]) => {
    out.push(new Paragraph({ children: [run('Q. ', { bold: true, color: ORANGE }), run(q, { bold: true })], spacing: { before: 160, after: 60 }, keepNext: true }));
    out.push(new Paragraph({ children: [run('A. ', { bold: true, color: GRAY }), run(a)], spacing: { after: 120, line: 320 }, indent: { left: 300 } }));
  });
  return out;
}
function block(b) {
  if (b.h2) return [h2(b.h2)];
  if (b.p) return [para(b.p)];
  if (b.note) return [note(b.note)];
  if (b.ul) return b.ul.map(bullet);
  if (b.ol) { olInstance++; return b.ol.map((t) => numbered(t, olInstance)); }
  if (b.table) return [table(b.table), new Paragraph({ spacing: { after: 120 }, children: [] })];
  if (b.img) return image(b.img, b.cap);
  if (b.faq) return faq(b.faq);
  return [];
}

function buildDocx() {
  const children = [];
  /* cover */
  children.push(new Paragraph({ spacing: { before: 3200 }, children: [] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run('▶ ', { size: 60, color: ORANGE }), run('RuninqVic', { size: 72, bold: true })], spacing: { after: 200 } }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run('사용설명서', { size: 48, bold: true, color: ORANGE })], spacing: { after: 300 } }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run(C.subtitle, { size: 28, color: GRAY })], spacing: { after: 2400 } }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run(C.version, { size: 22, color: GRAY })] }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ExternalHyperlink({ link: C.web, children: [run(C.web, { size: 22, color: '1A73E8', underline: {} })] })], spacing: { after: 80 } }));
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run('알씨 동영상 만들기를 대체하는 사진 슬라이드쇼 동영상 제작 프로그램', { size: 20, color: GRAY })] }));
  /* TOC */
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(new Paragraph({ children: [run('목차', { size: 34, bold: true, color: ORANGE })], spacing: { after: 240 } }));
  children.push(new TableOfContents('목차', { hyperlink: true, headingStyleRange: '1-2' }));
  /* sections */
  for (const s of C.sections) {
    children.push(h1(s.h));
    for (const b of s.body) children.push(...block(b));
  }

  const doc = new Document({
    creator: 'RuninqVic', title: C.title, description: C.subtitle,
    styles: { default: { document: { run: { font: FONT, size: 21 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 34, bold: true, color: ORANGE }, paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { font: FONT, size: 26, bold: true, color: '222222' }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
      ] },
    numbering: { config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 260 } } } }] },
      { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 480, hanging: 300 } } } }] },
    ] },
    features: { updateFields: true },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1200, left: 1273, right: 1273 } } },
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run('RuninqVic 사용설명서 v1.1', { size: 16, color: GRAY })], border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDDDDD', space: 4 } } })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: GRAY })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT_DOCX, buf); return buf.length; });
}

/* ---------- HTML ---------- */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
function htmlBlock(b) {
  if (b.h2) return `<h3 id="${esc(b.h2.split(' ')[0])}">${esc(b.h2)}</h3>`;
  if (b.p) return `<p>${linkify(b.p)}</p>`;
  if (b.note) return `<div class="tip"><b>TIP</b> ${linkify(b.note)}</div>`;
  if (b.ul) return `<ul>${b.ul.map((t) => `<li>${linkify(t)}</li>`).join('')}</ul>`;
  if (b.ol) return `<ol>${b.ol.map((t) => `<li>${linkify(t)}</li>`).join('')}</ol>`;
  if (b.table) return `<table><thead><tr>${b.table.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.table.rows.map((r) => `<tr>${r.map((c) => `<td>${linkify(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  if (b.img) return `<figure><img src="docs/manual/img/${b.img}" alt="${esc(b.cap)}" loading="lazy"><figcaption>${esc(b.cap)}</figcaption></figure>`;
  if (b.faq) return b.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${linkify(a)}</p></details>`).join('');
  return '';
}
function buildHtml() {
  const toc = C.sections.map((s, i) => `<li><a href="#s${i}">${esc(s.h)}</a></li>`).join('');
  const body = C.sections.map((s, i) => `<section id="s${i}"><h2>${esc(s.h)}</h2>${s.body.map(htmlBlock).join('\n')}</section>`).join('\n');
  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RuninqVic 사용설명서</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23ff6a1f'/%3E%3Cpath d='M24 18l22 14-22 14z' fill='%23fff'/%3E%3C/svg%3E">
<style>
:root{--accent:#e8562a;--text:#222;--muted:#666;--line:#e5e5e5;--bg:#fff;--tip:#fff4ee}
@media(prefers-color-scheme:dark){:root{--text:#e8e8ea;--muted:#a0a4ad;--line:#33363d;--bg:#17181b;--tip:#2a2320}}
*{box-sizing:border-box}body{margin:0;font-family:"Pretendard","맑은 고딕","Malgun Gothic","Segoe UI",sans-serif;color:var(--text);background:var(--bg);line-height:1.7;font-size:15.5px}
.wrap{max-width:960px;margin:0 auto;padding:24px 20px 80px}
header.top{display:flex;align-items:center;gap:12px;padding:10px 0 18px;border-bottom:1px solid var(--line);margin-bottom:24px}
header.top .logo{width:34px;height:34px;border-radius:9px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700}
header.top h1{font-size:22px;margin:0}header.top .sub{color:var(--muted);font-size:13px}
header.top a.app{margin-left:auto;background:var(--accent);color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:700;font-size:14px}
nav.toc{background:var(--tip);border-left:4px solid var(--accent);padding:14px 18px;border-radius:8px;margin-bottom:28px}
nav.toc ul{columns:2;margin:6px 0 0;padding-left:18px}nav.toc a{color:inherit;text-decoration:none}nav.toc a:hover{color:var(--accent)}
section{margin-top:44px}h2{color:var(--accent);font-size:24px;border-bottom:2px solid var(--accent);padding-bottom:6px;margin:0 0 14px}
h3{font-size:18px;margin:26px 0 8px}p{margin:8px 0}
table{border-collapse:collapse;width:100%;margin:12px 0 18px;font-size:14px}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--tip);white-space:nowrap}
.tip{background:var(--tip);border-left:4px solid var(--accent);padding:10px 14px;border-radius:6px;margin:12px 0}.tip b{color:var(--accent);margin-right:6px}
figure{margin:18px 0}figure img{width:100%;border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.15)}figcaption{text-align:center;color:var(--muted);font-size:13px;margin-top:6px}
details{border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:8px 0}summary{font-weight:700;cursor:pointer}details p{margin:8px 0 2px;color:var(--text)}
a{color:#1a73e8}footer{margin-top:60px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
@media print{header.top a.app,nav.toc{display:none}section{break-inside:auto}h2{break-after:avoid}figure{break-inside:avoid}}
</style></head><body><div class="wrap">
<header class="top"><div class="logo">▶</div><div><h1>RuninqVic 사용설명서</h1><div class="sub">${esc(C.subtitle)} · ${esc(C.version)}</div></div><a class="app" href="index.html">앱 열기 ›</a></header>
<nav class="toc"><b>목차</b><ul>${toc}</ul></nav>
${body}
<footer>RuninqVic v1.0 · 소스: <a href="${C.repo}" target="_blank" rel="noopener">${C.repo}</a> · Word 버전: <a href="docs/manual/RuninqVic_사용설명서.docx">RuninqVic_사용설명서.docx</a></footer>
</div></body></html>`;
  fs.writeFileSync(OUT_HTML, html, 'utf8');
  return html.length;
}

(async () => {
  const bytes = await buildDocx();
  const hl = buildHtml();
  console.log('docx', OUT_DOCX, bytes, 'bytes');
  console.log('html', OUT_HTML, hl, 'chars');
})().catch((e) => { console.error(e); process.exit(1); });
