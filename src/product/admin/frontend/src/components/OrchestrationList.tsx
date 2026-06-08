import React, { useEffect, useMemo, useState } from 'react'
import {
  listOrchestrations,
  getOrchestration,
  upsertOrchestration,
  deleteOrchestration,
  listVersions,
  getVersion,
  restoreVersion,
} from '../api'

export default function OrchestrationList() {
  const [items, setItems] = useState<any[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [editorValue, setEditorValue] = useState<string>('')
  const [page, setPage] = useState(0)
  const [perPage, setPerPage] = useState(10)

  useEffect(() => { fetchList() }, [])
  useEffect(() => { fetchList(page, perPage) }, [page, perPage])

  const [total, setTotal] = useState(0)

  async function fetchList(p = page, pp = perPage) {
    const data = await listOrchestrations(p, pp)
    setItems(data.items || [])
    setTotal(data.total || 0)
  }

  async function openEdit(id: string) {
    setSelected(id)
    const data = await getOrchestration(id)
    setEditorValue(JSON.stringify(data.definition, null, 2))
  }

  async function createNew() {
    const id = prompt('Enter new orchestration id (e.g. file-upload-and-mail)')
    if (!id) return
    setSelected(id)
    setEditorValue(JSON.stringify({ steps: [] }, null, 2))
  }

  async function save() {
    if (!selected) return
    let def
    try { def = JSON.parse(editorValue) } catch (err) { alert('Invalid JSON'); return }
    await upsertOrchestration(selected, { definition: def })
    await fetchList()
    alert('Saved')
  }

  async function remove(id: string) {
    if (!confirm(`Delete orchestration ${id}?`)) return
    await deleteOrchestration(id)
    setSelected(null)
    await fetchList()
  }

  async function showHistory(id: string) {
    const rows = await listVersions(id)
    const choice = prompt('Versions:\n' + rows.map((r: any, i: number) => `${i+1}. v${r.version} (${r.createdAt}) by ${r.createdBy}`).join('\n') + '\nEnter number to view/restore')
    if (!choice) return
    const idx = Number(choice) - 1
    if (Number.isNaN(idx) || idx < 0 || idx >= rows.length) return
    const v = rows[idx]
    const ver = await getVersion(id, v.id)
    if (!confirm('Restore this version?\n' + JSON.stringify(ver.definition, null, 2))) return
    await restoreVersion(id, v.id)
    alert('Restored')
    await fetchList()
  }

  const [diffOpen, setDiffOpen] = useState(false)
  const [diffLeft, setDiffLeft] = useState<string>('')
  const [diffRight, setDiffRight] = useState<string>('')

  async function showDiff(id: string) {
    const rows = await listVersions(id)
    if (!rows || rows.length === 0) { alert('No versions'); return }
    const latest = rows[0]
    const ver = await getVersion(id, latest.id)
    const cur = await getOrchestration(id)
    setDiffLeft(JSON.stringify(cur.definition, null, 2))
    setDiffRight(JSON.stringify(ver.definition, null, 2))
    setDiffOpen(true)
  }

  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const pagedItems = items

  return (
    <div style={{ display: 'flex', gap: 20, padding: 12, fontFamily: 'Segoe UI, Roboto, system-ui, sans-serif' }}>
      <div style={{ width: 360, borderRight: '1px solid #eee', paddingRight: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Catalog</h3>
          <div><button onClick={createNew} style={{ padding: '6px 10px' }}>New</button></div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <div style={{ fontSize: 12, color: '#666' }}>{items.length} items</div>
          <div>
            <label style={{ fontSize: 12, color: '#666', marginRight: 6 }}>Per page</label>
            <select value={perPage} onChange={e => { setPerPage(Number(e.target.value)); setPage(0) }}>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={25}>25</option>
            </select>
          </div>
        </div>

        <ul style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
          {pagedItems.map(i => (
            <li key={i.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 6px', borderBottom: '1px solid #f2f2f2' }}>
              <div style={{ flex: 1 }}>
                <button onClick={() => openEdit(i.id)} style={{ marginRight: 8, padding: '4px 8px' }}>{i.id}</button>
                <strong style={{ marginLeft: 6 }}>{i.title ?? ''}</strong>
                <div style={{ fontSize: 12, color: '#888' }}>{i.enabled ? '' : '(disabled)'}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => showHistory(i.id)} style={{ padding: '4px 8px' }}>History</button>
                <button onClick={() => showDiff(i.id)} style={{ padding: '4px 8px' }}>Diff</button>
                <button onClick={() => remove(i.id)} style={{ padding: '4px 8px', color: 'white', background: '#d9534f', border: 'none', borderRadius: 4 }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
          <div style={{ fontSize: 12 }}>Page {page + 1} / {totalPages}</div>
          <div>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{ marginRight: 6 }}>&lt; Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}>Next &gt;</button>
          </div>
        </div>
      </div>

      <div style={{ flex: 1 }}>
        {selected ? (
          <div>
            <h3>Editing: {selected}</h3>
            <textarea value={editorValue} onChange={e => setEditorValue(e.target.value)} rows={20} style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, padding: 8, border: '1px solid #ddd', borderRadius: 4 }} />
            <div style={{ marginTop: 8 }}>
              <button onClick={save} style={{ padding: '6px 12px' }}>Save</button>
              <button onClick={() => { setSelected(null); setEditorValue('') }} style={{ marginLeft: 8, padding: '6px 12px' }}>Close</button>
            </div>
          </div>
        ) : (
          <div style={{ color: '#666' }}>Select an orchestration to edit</div>
        )}
      </div>
      {diffOpen && (
        <div style={{ position: 'fixed', left: 0, top: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '90%', height: '80%', background: 'white', padding: 12, display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <h4>Current</h4>
              <textarea value={diffLeft} readOnly style={{ width: '100%', height: '100%', fontFamily: 'monospace' }} />
            </div>
            <div style={{ flex: 1 }}>
              <h4>Version</h4>
              <textarea value={diffRight} readOnly style={{ width: '100%', height: '100%', fontFamily: 'monospace' }} />
            </div>
            <div style={{ position: 'absolute', right: 20, top: 20 }}>
              <button onClick={() => setDiffOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
