import { useEffect, useMemo, useState } from 'react';
import { Ui } from './Ui';
import '../styles/api-docs.css';

// Documentación navegable: se arma sola desde /api/v1/openapi.json, así nunca queda desfasada del servidor.
interface OpenApiSchema { type?: string; format?: string; enum?: string[]; items?: OpenApiSchema; properties?: Record<string, OpenApiSchema>; required?: string[]; description?: string; example?: unknown; default?: unknown; maxLength?: number; nullable?: boolean; $ref?: string; oneOf?: OpenApiSchema[] }
interface Param { name: string; in: string; required?: boolean; description?: string; schema?: OpenApiSchema }
interface Operation { tags?: string[]; summary?: string; description?: string; parameters?: Param[]; requestBody?: { required?: boolean; content: Record<string, { schema?: OpenApiSchema; example?: unknown }> }; responses?: Record<string, { description?: string }> }
interface OpenApi { info: { title: string; version: string; description?: string }; tags?: { name: string; description?: string }[]; paths: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, OpenApiSchema> } }

const METHOD_ORDER = ['get', 'post', 'patch', 'put', 'delete'];

function resolve(schema: OpenApiSchema | undefined, doc: OpenApi): OpenApiSchema | undefined {
  if (!schema) return undefined;
  if (schema.$ref) return resolve(doc.components?.schemas?.[schema.$ref.split('/').pop() || ''], doc);
  return schema;
}

function typeLabel(schema: OpenApiSchema | undefined, doc: OpenApi): string {
  const resolved = resolve(schema, doc);
  if (!resolved) return '—';
  if (resolved.enum) return resolved.enum.join(' | ');
  if (resolved.type === 'array') return `lista de ${typeLabel(resolved.items, doc)}`;
  if (resolved.oneOf) return resolved.oneOf.map((option) => typeLabel(option, doc)).join(' o ');
  return resolved.format ? `${resolved.type} (${resolved.format})` : resolved.type || 'objeto';
}

/** Ejemplo de cuerpo: usa el example del contrato o lo arma con los campos del esquema. */
function bodyExample(operation: Operation, doc: OpenApi): string | null {
  const json = operation.requestBody?.content?.['application/json'];
  if (!json) {
    const multipart = operation.requestBody?.content?.['multipart/form-data'];
    if (!multipart) return null;
    const schema = resolve(multipart.schema, doc);
    const fields = Object.keys(schema?.properties || {});
    return fields.length ? `# multipart/form-data\n${fields.map((field) => `-F "${field}=…"`).join(' \\\n')}` : null;
  }
  if (json.example) return JSON.stringify(json.example, null, 2);
  const schema = resolve(json.schema, doc);
  if (!schema?.properties) return null;
  const example: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    const resolved = resolve(value, doc);
    example[key] = resolved?.example ?? resolved?.default ?? (resolved?.enum ? resolved.enum[0] : resolved?.type === 'array' ? [] : resolved?.type === 'boolean' ? true : resolved?.type === 'integer' || resolved?.type === 'number' ? 0 : '…');
  }
  return JSON.stringify(example, null, 2);
}

function curlFor(method: string, path: string, base: string, operation: Operation, doc: OpenApi): string {
  const url = `${base}${path.replace(/\{(\w+)\}/g, ':$1')}`;
  const lines = [`curl -X ${method.toUpperCase()} ${url} \\`, `  -H "Authorization: Bearer nr_live_TU_CLAVE"`];
  const body = bodyExample(operation, doc);
  if (body && body.startsWith('# multipart')) {
    lines[lines.length - 1] += ' \\';
    lines.push(...body.split('\n').slice(1).map((line) => `  ${line}`));
  } else if (body) {
    lines[lines.length - 1] += ' \\';
    lines.push('  -H "Content-Type: application/json" \\');
    lines.push(`  -d '${body.replace(/\n\s*/g, '')}'`);
  }
  return lines.join('\n');
}

export function ApiDocs({ base }: { base: string }) {
  const [doc, setDoc] = useState<OpenApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/openapi.json').then((res) => res.json()).then(setDoc).catch(() => setError('No se pudo cargar la documentación.'));
  }, []);

  const groups = useMemo(() => {
    if (!doc) return [];
    const byTag = new Map<string, { method: string; path: string; operation: Operation }[]>();
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        const tag = operation.tags?.[0] || 'General';
        byTag.set(tag, [...(byTag.get(tag) || []), { method, path, operation }]);
      }
    }
    const search = query.trim().toLowerCase();
    const tags: { name: string; description?: string }[] = doc.tags || [...byTag.keys()].map((name) => ({ name }));
    return tags
      .map((tag) => ({
        name: tag.name,
        description: tag.description,
        items: (byTag.get(tag.name) || [])
          .filter((item) => !search || `${item.method} ${item.path} ${item.operation.summary || ''}`.toLowerCase().includes(search))
          .sort((a, b) => METHOD_ORDER.indexOf(a.method) - METHOD_ORDER.indexOf(b.method))
      }))
      .filter((group) => group.items.length > 0);
  }, [doc, query]);

  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(null), 1500); } catch { /* sin portapapeles */ }
  }

  if (error) return <div className="alert error">{error}</div>;
  if (!doc) return <p className="api-docs-loading">Cargando documentación…</p>;

  return (
    <div className="api-docs">
      <div className="api-docs-toolbar">
        <label className="api-docs-search">
          <Ui name="search" size={14} />
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar endpoint: sms, webhook, estado…" aria-label="Buscar en la documentación" />
        </label>
        <span className="api-docs-version">{doc.info.title} · v{doc.info.version}</span>
      </div>

      {groups.map((group) => (
        <section className="api-docs-group" key={group.name}>
          <header>
            <h3>{group.name}</h3>
            {group.description && <p>{group.description}</p>}
          </header>

          {group.items.map(({ method, path, operation }) => {
            const key = `${method}-${path}`;
            const expanded = open === key;
            const body = bodyExample(operation, doc);
            const curl = curlFor(method, path, base, operation, doc);
            return (
              <article className={`api-endpoint ${expanded ? 'open' : ''}`} key={key}>
                <button type="button" className="api-endpoint-head" onClick={() => setOpen(expanded ? null : key)} aria-expanded={expanded}>
                  <span className={`api-method ${method}`}>{method.toUpperCase()}</span>
                  <code>{path}</code>
                  <span className="api-endpoint-summary">{operation.summary}</span>
                  <Ui name={expanded ? 'chevron-left' : 'chevron-right'} size={14} />
                </button>

                {expanded && (
                  <div className="api-endpoint-body">
                    {operation.description && <p className="api-endpoint-desc">{operation.description}</p>}

                    {operation.parameters && operation.parameters.length > 0 && (
                      <div className="api-docs-block">
                        <h4>Parámetros</h4>
                        <table className="api-docs-table">
                          <thead><tr><th>Nombre</th><th>Dónde</th><th>Tipo</th><th>Detalle</th></tr></thead>
                          <tbody>
                            {operation.parameters.map((param) => (
                              <tr key={param.name}>
                                <td><code>{param.name}</code>{param.required && <em> obligatorio</em>}</td>
                                <td>{param.in === 'path' ? 'en la ruta' : 'en la URL'}</td>
                                <td>{typeLabel(param.schema, doc)}</td>
                                <td>{param.description || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {body && (
                      <div className="api-docs-block">
                        <h4>Cuerpo del pedido</h4>
                        <pre className="api-docs-code">{body}</pre>
                      </div>
                    )}

                    <div className="api-docs-block">
                      <div className="api-docs-block-head">
                        <h4>Ejemplo listo para usar</h4>
                        <button type="button" className="api-doc-copy" onClick={() => copy(curl, key)}>{copied === key ? '¡Copiado!' : 'Copiar'}</button>
                      </div>
                      <pre className="api-docs-code">{curl}</pre>
                    </div>

                    {operation.responses && (
                      <div className="api-docs-block">
                        <h4>Respuestas</h4>
                        <ul className="api-docs-responses">
                          {Object.entries(operation.responses).map(([code, response]) => (
                            <li key={code}><b className={Number(code) < 300 ? 'ok' : 'bad'}>{code}</b> {response.description}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}
