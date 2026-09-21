import { Fragment, type MouseEvent } from 'react';
import { tokenize, type RichNode } from '../lib/richText';
import { Ui, type UiIconName } from './Ui';
import '../styles/rich-text.css';

const LINK_ICON: Record<string, UiIconName> = { url: 'globe', email: 'mail', phone: 'phone' };

function render(nodes: RichNode[]) {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text': return <Fragment key={index}>{node.text}</Fragment>;
      case 'bold': return <strong key={index}>{render(node.children)}</strong>;
      case 'italic': return <em key={index}>{render(node.children)}</em>;
      case 'strike': return <s key={index}>{render(node.children)}</s>;
      case 'code': return <code key={index}>{node.text}</code>;
      case 'pre': return <pre key={index}>{node.text}</pre>;
      case 'link': return (
        <a key={index} className={`rich-link rich-link-${node.kind}`} href={node.href} {...(node.kind === 'url' ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})} onClick={(e: MouseEvent) => e.stopPropagation()}>
          <Ui name={LINK_ICON[node.kind]} size={13} className="rich-link-icon" />{node.text}
        </a>
      );
    }
  });
}

// Texto de un mensaje de chat: respeta saltos de línea y listas, resalta links y aplica el formato de WhatsApp.
export function RichText({ text }: { text: string }) {
  return <span className="rich-text">{render(tokenize(text))}</span>;
}
