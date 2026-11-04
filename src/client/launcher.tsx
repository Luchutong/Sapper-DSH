import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A short composer button opens a viewport portal; composer overflow cannot clip it. */
export function TaskLauncher({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false), close = useRef<HTMLButtonElement>(null), launch = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    close.current?.focus()
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false) } }
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('keydown', escape, true); launch.current?.focus() }
  }, [open])
  return <>
    <button ref={launch} type="button" aria-label="打开 Sapper 任务" aria-haspopup="dialog" onClick={event => { event.stopPropagation(); setOpen(true) }} style={{ border: '1px solid #5b87c8', borderRadius: 8, padding: '5px 10px', color: 'var(--dsw-alias-label-primary, inherit)', background: 'var(--dsw-alias-bg-base, transparent)', cursor: 'pointer', whiteSpace: 'nowrap', font: 'inherit' }}>Sapper 任务</button>
    {open && createPortal(<div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: '#0006', zIndex: 20000, display: 'grid', placeItems: 'center', padding: 20 }}>
      <section role="dialog" aria-modal="true" aria-label="Sapper 任务窗口" onClick={e => e.stopPropagation()} onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') setOpen(false); if (e.key === 'Tab') { const nodes = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]'));  const target = e.shiftKey ? nodes.at(-1) : nodes[0]; if ((e.shiftKey && document.activeElement === nodes[0]) || (!e.shiftKey && document.activeElement === nodes.at(-1))) { e.preventDefault(); target?.focus() } } }} style={{ width: 'min(1050px, 94vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base, #fff)', color: 'var(--dsw-alias-label-primary, #171923)', borderRadius: 16, boxShadow: '0 20px 70px #0005' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: '1px solid #71809644' }}><strong>Sapper · 任务与证据</strong><small>关闭窗口不会取消任务</small><button ref={close} type="button" aria-label="关闭任务窗口" onClick={() => setOpen(false)}>关闭 ✕</button></header>
        <div style={{ overflow: 'auto', padding: 12 }}>{children}</div>
      </section>
    </div>, document.body)}
  </>
}
