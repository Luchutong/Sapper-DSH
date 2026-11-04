import { useEffect, useRef, useState } from 'react'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { BrowserContext } from '../dsh-adapter/client.js'

/** pickDirectory is native-only; listDirectory preserves typed capability errors. */
export function DirectoryPicker({ workspace, initialPath, onPicked, onClose }: {
  workspace: NonNullable<BrowserContext['uiWorkspace']>
  initialPath: string
  onPicked(path: string): void
  onClose(): void
}) {
  const [listing, setListing] = useState<DirectoryListing>(),
    [location, setLocation] = useState(initialPath),
    [pending, setPending] = useState(true),
    [error, setError] = useState(''),
    [hidden, setHidden] = useState(false),
    scan = useRef<AbortController>()
  const list = async (value?: string) => {
    scan.current?.abort()
    const controller = new AbortController()
    scan.current = controller
    setPending(true)
    setError('')
    try {
      if (!workspace.listDirectory) {
        const chosen = await workspace.pickDirectory()
        if (!controller.signal.aborted) {
          if (chosen) onPicked(chosen)
          onClose()
        }
        return
      }
      const next = await workspace.listDirectory(value || undefined, controller.signal)
      if (controller.signal.aborted) return
      setListing(next)
      setLocation(next.path)
    } catch (e) {
      if (controller.signal.aborted) return
      const failure = (e as { rpcError?: { code?: string; details?: { capability?: string } } }).rpcError
      if (failure?.code === 'directory-picker/unavailable' && failure.details?.capability === 'native') {
        try {
          const chosen = await workspace.pickDirectory()
          if (!controller.signal.aborted) {
            if (chosen) onPicked(chosen)
            onClose()
          }
        } catch (nativeError) {
          if (!controller.signal.aborted) setError((nativeError as Error).message)
        }
      } else setError((e as Error).message)
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }
  useEffect(() => {
    void list(initialPath)
    return () => scan.current?.abort()
  }, [])
  return (
    <section className="sp-directory sp-card" role="region" aria-label="选择比赛根目录">
      <h3>选择比赛根目录</h3>
      <form className="sp-form-row" onSubmit={(e) => { e.preventDefault(); void list(location) }}>
        <input aria-label="浏览目录路径" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="输入宿主机上的绝对路径" />
        <button type="submit" disabled={pending}>打开路径</button>
        <button type="button" disabled={pending} onClick={() => { void list() }}>主目录</button>
      </form>
      {pending && <p role="status">正在打开目录…</p>}
      {error && <p role="alert" className="sp-error">{error}</p>}
      {listing && <>
        <nav className="sp-actions" aria-label="目录层级">
          {listing.crumbs.map((crumb) => <button type="button" key={crumb.path} disabled={pending} onClick={() => { void list(crumb.path) }}>{crumb.name}</button>)}
        </nav>
        <label><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> 显示隐藏目录</label>
        <ul aria-label="子目录">
          {listing.entries.filter((entry) => hidden || !entry.hidden).map((entry) => <li key={entry.path}><button type="button" disabled={pending} onClick={() => { void list(entry.path) }}>📁 {entry.name}</button></li>)}
        </ul>
        {!listing.entries.some((entry) => hidden || !entry.hidden) && <p className="sp-muted">此目录没有可见的子目录，可直接选用。</p>}
        {listing.truncated && <p role="status">子目录较多，仅显示部分；可输入完整路径前往其他目录。</p>}
        <p className="sp-directory-path">{listing.path}</p>
      </>}
      <div className="sp-actions">
        <button type="button" className="sp-primary" disabled={pending || !listing} onClick={() => { onPicked(listing!.path); onClose() }}>使用此目录</button>
        <button type="button" onClick={onClose}>取消选择</button>
      </div>
    </section>
  )
}
