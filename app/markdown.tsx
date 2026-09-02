"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Small, dependency-free Markdown renderer for agent replies. Supports headings,
 * paragraphs, bold/italic/code, links, bullet and numbered lists, block quotes,
 * fenced code, and pipe tables. Everything is rendered as React nodes, never HTML.
 */

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index += 1}`;
    if (token.startsWith("**")) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link && /^https?:\/\//.test(link[2])) nodes.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>);
      else nodes.push(token);
    } else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function tableRow(line: string) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function renderBlocks(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  const nextKey = () => `md-${key += 1}`;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) { code.push(lines[index]); index += 1; }
      index += 1;
      blocks.push(<pre key={nextKey()}><code>{code.join("\n")}</code></pre>);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = inline(heading[2], nextKey());
      blocks.push(level === 1 ? <h2 key={nextKey()}>{content}</h2> : level === 2 ? <h3 key={nextKey()}>{content}</h3> : <h4 key={nextKey()}>{content}</h4>);
      index += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[index + 1])) {
      const header = tableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) { rows.push(tableRow(lines[index])); index += 1; }
      blocks.push(
        <div className="md-table-wrap" key={nextKey()}>
          <table>
            <thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, `${key}-h${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inline(cell, `${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*•]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*[-*•]\s+/, "")); index += 1; }
      blocks.push(<ul key={nextKey()}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `${key}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*\d+[.)]\s+/, "")); index += 1; }
      blocks.push(<ol key={nextKey()}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `${key}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^\s*>\s?/, "")); index += 1; }
      blocks.push(<blockquote key={nextKey()}>{inline(quote.join(" "), `${key}-q`)}</blockquote>);
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|```|\s*[-*•]\s|\s*\d+[.)]\s|\s*>|\s*\|)/.test(lines[index])) { paragraph.push(lines[index]); index += 1; }
    blocks.push(<p key={nextKey()}>{paragraph.map((part, partIndex) => <Fragment key={partIndex}>{partIndex ? <br /> : null}{inline(part, `${key}-${partIndex}`)}</Fragment>)}</p>);
  }
  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={`markdown${className ? ` ${className}` : ""}`}>{renderBlocks(text)}</div>;
}
