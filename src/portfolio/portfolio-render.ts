/**
 * Server-side print-friendly HTML renderer for a Portfolio item.
 * We do NOT ship a Markdown library on the backend to keep the
 * dependency footprint small — the HTML page it returns loads the
 * common `marked` and `DOMPurify` scripts from the allowed CDN at
 * open time and sanitizes the Markdown in the browser before
 * printing. The browser's own Print dialog becomes the "Save as PDF"
 * action.
 */
export function renderPrintablePortfolioHtml(item: {
  title: string;
  slug: string;
  shortSummary: string | null;
  status: string;
  isNda: boolean;
  contentMarkdown: string;
  tags: Array<{ tag: { displayName: string } }>;
  updatedAt: Date;
}): string {
  const title = escapeHtml(item.title);
  const summary = item.shortSummary ? escapeHtml(item.shortSummary) : '';
  const tags = item.tags
    .map((t) => `<span class="tag">${escapeHtml(t.tag.displayName)}</span>`)
    .join('');
  const markdownJson = JSON.stringify(item.contentMarkdown ?? '');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title} — Portfolio</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js"></script>
  <style>
    @page { size: A4; margin: 20mm 18mm; }
    html, body { padding: 0; margin: 0; }
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      color: #1a1a1a;
      line-height: 1.55;
      font-size: 11.5pt;
      max-width: 760px;
      margin: 0 auto;
      padding: 24px;
    }
    header {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-bottom: 18px;
      margin-bottom: 24px;
      border-bottom: 2px solid #0369A1;
    }
    header h1 {
      margin: 0;
      font-size: 28pt;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: #0a0a0f;
      line-height: 1.15;
    }
    header .summary {
      font-size: 12.5pt;
      color: #475569;
      line-height: 1.5;
    }
    header .meta {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      font-size: 10pt;
      color: #64748b;
    }
    .status {
      padding: 2px 10px;
      border-radius: 999px;
      background: rgba(3, 105, 161, 0.1);
      color: #0369A1;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      font-size: 8.5pt;
    }
    .nda {
      padding: 2px 10px;
      border-radius: 999px;
      background: rgba(220, 38, 38, 0.1);
      color: #b91c1c;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      font-size: 8.5pt;
    }
    .tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 2px;
    }
    .tag {
      font-family: ui-monospace, 'JetBrains Mono', monospace;
      font-size: 9pt;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(15, 23, 42, 0.06);
      color: #334155;
    }
    article h1, article h2, article h3, article h4 {
      font-family: 'Georgia', serif;
      color: #0a0a0f;
      page-break-after: avoid;
    }
    article h2 { font-size: 18pt; margin-top: 1.4em; }
    article h3 { font-size: 14pt; margin-top: 1.2em; }
    article p { margin: 0.6em 0; }
    article ul, article ol { margin: 0.6em 0 0.6em 1.2em; }
    article code {
      font-family: ui-monospace, 'JetBrains Mono', monospace;
      font-size: 10pt;
      padding: 1px 5px;
      background: rgba(15, 23, 42, 0.05);
      border-radius: 3px;
    }
    article pre {
      background: #0f172a;
      color: #e2e8f0;
      padding: 12px 14px;
      border-radius: 6px;
      overflow-x: auto;
      page-break-inside: avoid;
    }
    article pre code {
      background: none;
      color: inherit;
      padding: 0;
      font-size: 9.5pt;
    }
    article blockquote {
      margin: 0.8em 0;
      padding: 6px 14px;
      border-left: 3px solid #0369A1;
      background: rgba(3, 105, 161, 0.05);
      color: #334155;
    }
    article table {
      border-collapse: collapse;
      width: 100%;
      margin: 1em 0;
      font-size: 10pt;
      page-break-inside: avoid;
    }
    article th, article td {
      border: 1px solid rgba(15, 23, 42, 0.14);
      padding: 6px 10px;
      text-align: left;
    }
    article th {
      background: rgba(15, 23, 42, 0.04);
    }
    article img { max-width: 100%; height: auto; }
    footer {
      margin-top: 32px;
      padding-top: 12px;
      border-top: 1px solid rgba(15, 23, 42, 0.1);
      font-size: 9pt;
      color: #94a3b8;
    }
    .print-cta {
      position: fixed;
      top: 16px;
      right: 16px;
      padding: 8px 16px;
      border-radius: 8px;
      border: none;
      background: #0369A1;
      color: #ffffff;
      font: 600 13px system-ui, sans-serif;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(3, 105, 161, 0.3);
    }
    @media print {
      .print-cta { display: none; }
    }
  </style>
</head>
<body>
  <button class="print-cta" onclick="window.print()">Print / Save as PDF</button>
  <header>
    <h1>${title}</h1>
    ${summary ? `<p class="summary">${summary}</p>` : ''}
    <div class="meta">
      <span class="status">${escapeHtml(item.status.toLowerCase())}</span>
      ${item.isNda ? '<span class="nda">NDA</span>' : ''}
      ${tags ? `<div class="tags">${tags}</div>` : ''}
    </div>
  </header>
  <article id="content">
    <noscript>JavaScript is required to render the Markdown body.</noscript>
  </article>
  <footer>
    Portfolio · exported ${new Date().toISOString().slice(0, 10)}
  </footer>
  <script>
    const raw = ${markdownJson};
    try {
      const dirty = (window.marked && window.marked.parse) ? window.marked.parse(raw) : raw;
      const clean = window.DOMPurify ? window.DOMPurify.sanitize(dirty, { ADD_ATTR: ['target'] }) : dirty;
      document.getElementById('content').innerHTML = clean;
    } catch (err) {
      document.getElementById('content').textContent = raw;
    }
    // Auto-open print dialog once the content is parsed.
    setTimeout(() => { try { window.print(); } catch (e) {} }, 400);
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
