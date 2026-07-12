// Rendu markdown MINIMAL et sur-mesure pour les bulles de conversation.
//
// Principe de securite : AUCUN HTML source ne traverse. Chaque tranche de
// texte est echappee (escapeHtml) AVANT toute transformation ; les seules
// balises presentes en sortie sont celles emises ici, avec du contenu deja
// echappe. Pas de dependance externe (marked/DOMPurify) : le sous-ensemble
// supporte est volontairement petit — fences, code inline, gras/italique,
// liens http(s), listes plates, titres, citations — suffisant pour des
// reponses d'agents. Extensible (tableaux, diffs) quand la vue conversation
// deviendra la surface principale.

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// --- Inline ----------------------------------------------------------------

// Transforme une tranche de texte BRUT (hors code inline) : echappe d'abord,
// puis applique gras / italique / liens sur le texte echappe. Les URLs ne
// peuvent pas sortir de l'attribut href : les guillemets sont deja `&quot;`.
const renderInlineText = (raw: string): string => {
  let text = escapeHtml(raw);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italique : `*mot*` sans espace colle aux bornes (evite « 2 * 3 * 4 »).
  text = text.replace(/\*(\S(?:[^*\n]*\S)?)\*/g, "<em>$1</em>");
  text = text.replace(
    /\[([^\]]+)\]\((https?:[^\s)]+)\)/g,
    (_match, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  return text;
};

// Le code inline est extrait AVANT les autres transformations pour que son
// contenu (des `*`, des crochets…) ne soit jamais reinterprete.
const renderInline = (raw: string): string =>
  raw
    .split(/(`[^`\n]+`)/g)
    .map((part) =>
      part.length > 2 && part.startsWith("`") && part.endsWith("`")
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : renderInlineText(part),
    )
    .join("");

// --- Blocs -----------------------------------------------------------------

const FENCE = /^\s{0,3}(```|~~~)\s*([\w#+.-]*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

const isBlockBoundary = (line: string): boolean =>
  !line.trim() ||
  FENCE.test(line) ||
  BULLET.test(line) ||
  ORDERED.test(line) ||
  HEADING.test(line) ||
  QUOTE.test(line);

const renderCodeBlock = (code: string, lang: string): string => {
  const langBadge = lang ? `<span class="chat-code-lang">${escapeHtml(lang)}</span>` : "<span></span>";
  return (
    `<div class="chat-code">` +
    `<div class="chat-code-bar">${langBadge}` +
    `<button type="button" class="chat-code-copy" title="Copier le code"><i data-lucide="copy"></i></button>` +
    `</div>` +
    `<pre><code>${escapeHtml(code)}</code></pre>` +
    `</div>`
  );
};

/**
 * Rend un texte markdown en HTML sur. Toujours utilisable sur du contenu
 * hostile : le texte source ne peut injecter aucune balise.
 */
export const renderMarkdown = (source: string): string => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1];
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        buffer.push(lines[index]);
        index += 1;
      }
      index += 1; // saute la cloture (ou EOF si fence non fermee)
      html.push(renderCodeBlock(buffer.join("\n"), fence[2] ?? ""));
      continue;
    }

    const listMatch = line.match(BULLET) ?? line.match(ORDERED);
    if (listMatch) {
      const pattern = BULLET.test(line) ? BULLET : ORDERED;
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(pattern);
        if (!item) break;
        items.push(`<li>${renderInline(item[1])}</li>`);
        index += 1;
      }
      const tag = pattern === ORDERED ? "ol" : "ul";
      html.push(`<${tag} class="chat-md-list">${items.join("")}</${tag}>`);
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      html.push(`<p class="chat-md-h chat-md-h${level}">${renderInline(heading[2])}</p>`);
      index += 1;
      continue;
    }

    const quote = line.match(QUOTE);
    if (quote) {
      const buffer: string[] = [quote[1]];
      index += 1;
      while (index < lines.length) {
        const next = lines[index].match(QUOTE);
        if (!next) break;
        buffer.push(next[1]);
        index += 1;
      }
      html.push(
        `<blockquote class="chat-md-quote">${buffer.map(renderInline).join("<br />")}</blockquote>`,
      );
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // Paragraphe : accumule jusqu'a la prochaine construction speciale.
    const buffer: string[] = [];
    while (index < lines.length && !isBlockBoundary(lines[index])) {
      buffer.push(lines[index]);
      index += 1;
    }
    html.push(`<p>${buffer.map(renderInline).join("<br />")}</p>`);
  }

  return html.join("");
};
