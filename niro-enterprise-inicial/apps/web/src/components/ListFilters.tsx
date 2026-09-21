import { Ui } from './Ui';
import '../styles/list-filters.css';

export interface ListFilterState { q: string; group: string; type: string; from: string; to: string }
export const EMPTY_FILTERS: ListFilterState = { q: '', group: 'all', type: '', from: '', to: '' };

export interface FilterGroup { key: string; label: string; count: number }

// Fecha local (yyyy-mm-dd de un <input type="date">) contra un instante ISO: el día "hasta" entra completo.
export function inDateRange(iso: string | null | undefined, from: string, to: string) {
  if (!from && !to) return true;
  if (!iso) return false;
  const time = new Date(iso).getTime();
  if (from && time < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && time > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
}

export function filtersActive(state: ListFilterState) {
  return Boolean(state.q || state.group !== 'all' || state.type || state.from || state.to);
}

export function ListFilters({ state, onChange, groups, types, typeLabel = 'Categoría', searchPlaceholder = 'Buscar por nombre…' }: {
  state: ListFilterState;
  onChange: (next: ListFilterState) => void;
  groups: FilterGroup[];
  types?: { key: string; label: string }[];
  typeLabel?: string;
  searchPlaceholder?: string;
}) {
  const set = (patch: Partial<ListFilterState>) => onChange({ ...state, ...patch });
  return (
    <div className="list-filters">
      <div className="list-filter-chips" role="tablist" aria-label="Estado">
        {groups.map((g) => (
          <button type="button" key={g.key} role="tab" aria-selected={state.group === g.key} className={`list-chip ${state.group === g.key ? 'active' : ''}`} onClick={() => set({ group: g.key })}>
            {g.label}<b>{g.count}</b>
          </button>
        ))}
      </div>
      <div className="list-filter-row">
        <label className="list-filter-search">
          <Ui name="search" size={14} />
          <input className="input" value={state.q} onChange={(e) => set({ q: e.target.value })} placeholder={searchPlaceholder} aria-label="Buscar" />
        </label>
        {types && (
          <label className="list-filter-field"><span>{typeLabel}</span>
            <select className="input" value={state.type} onChange={(e) => set({ type: e.target.value })}>
              <option value="">Todas</option>
              {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
        )}
        <label className="list-filter-field"><span>Desde</span><input className="input" type="date" value={state.from} max={state.to || undefined} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="list-filter-field"><span>Hasta</span><input className="input" type="date" value={state.to} min={state.from || undefined} onChange={(e) => set({ to: e.target.value })} /></label>
        {filtersActive(state) && <button type="button" className="btn secondary small list-filter-clear" onClick={() => onChange(EMPTY_FILTERS)}><Ui name="x" size={13} /> Limpiar filtros</button>}
      </div>
    </div>
  );
}

// Barra que aparece al elegir filas: contador, seleccionar/deseleccionar visibles y acción de borrado.
export function BulkBar({ selected, visible, onToggleAll, onClear, onDelete, deleteLabel = 'Eliminar seleccionadas' }: {
  selected: number; visible: number; onToggleAll: () => void; onClear: () => void; onDelete: () => void; deleteLabel?: string;
}) {
  return (
    <div className="list-bulkbar" role="region" aria-label="Acciones en lote">
      <span><b>{selected}</b> seleccionada{selected === 1 ? '' : 's'}</span>
      <button type="button" className="btn secondary small" onClick={onToggleAll}>{selected >= visible ? 'Deseleccionar visibles' : `Seleccionar las ${visible} visibles`}</button>
      <button type="button" className="btn secondary small" onClick={onClear}>Cancelar</button>
      <button type="button" className="btn danger small" onClick={onDelete}><Ui name="trash" size={14} /> {deleteLabel}</button>
    </div>
  );
}
