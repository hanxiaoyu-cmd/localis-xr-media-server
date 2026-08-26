'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface FolderEntry {
  name: string;
  path: string;
}

interface FolderLocation extends FolderEntry {
  kind?: string;
}

interface FolderBrowseResponse {
  currentPath: string;
  parentPath?: string;
  folders: FolderEntry[];
  locations: FolderLocation[];
  alreadyAdded?: boolean;
  truncated?: boolean;
}

type FolderActivity = 'idle' | 'loading' | 'scanning';

interface FolderBrowserModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectFolder: (folderPath: string) => Promise<void>;
}

const FOLDER_BROWSE_TIMEOUT_MS = 7_000;

function normalizedFolderPath(folderPath: string) {
  return folderPath.replace(/[\\/]+$/, '').toLocaleLowerCase();
}

function sameFolderPath(first: string, second: string) {
  return normalizedFolderPath(first) === normalizedFolderPath(second);
}

function folderLocationGlyph(kind?: string) {
  if (kind === 'drive') return '▰';
  if (kind === 'home') return '⌂';
  if (kind === 'desktop') return '▦';
  if (kind === 'documents') return '▤';
  if (kind === 'downloads') return '↓';
  if (kind === 'media') return '▶';
  return '◇';
}

function folderBreadcrumbs(folderPath: string): FolderEntry[] {
  if (!folderPath) return [];

  const windowsDrive = /^([a-z]:)[\\/]*(.*)$/i.exec(folderPath);
  if (windowsDrive) {
    const rootPath = `${windowsDrive[1]}\\`;
    const crumbs: FolderEntry[] = [{ name: windowsDrive[1], path: rootPath }];
    let currentPath = rootPath;
    for (const segment of windowsDrive[2].split(/[\\/]+/).filter(Boolean)) {
      currentPath = `${currentPath}${currentPath.endsWith('\\') ? '' : '\\'}${segment}`;
      crumbs.push({ name: segment, path: currentPath });
    }
    return crumbs;
  }

  if (/^[\\/]{2}/.test(folderPath)) {
    const segments = folderPath.split(/[\\/]+/).filter(Boolean);
    if (segments.length >= 2) {
      let currentPath = `\\\\${segments[0]}\\${segments[1]}`;
      const crumbs: FolderEntry[] = [{ name: `${segments[0]} / ${segments[1]}`, path: currentPath }];
      for (const segment of segments.slice(2)) {
        currentPath = `${currentPath}\\${segment}`;
        crumbs.push({ name: segment, path: currentPath });
      }
      return crumbs;
    }
  }

  const absolute = folderPath.startsWith('/');
  const segments = folderPath.split('/').filter(Boolean);
  const crumbs: FolderEntry[] = absolute ? [{ name: '/', path: '/' }] : [];
  let currentPath = absolute ? '' : segments.shift() || folderPath;
  if (!absolute) crumbs.push({ name: currentPath, path: currentPath });
  for (const segment of segments) {
    currentPath = `${currentPath}/${segment}`;
    crumbs.push({ name: segment, path: currentPath || '/' });
  }
  return crumbs.length > 0 ? crumbs : [{ name: folderPath, path: folderPath }];
}

async function browseJsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw Object.assign(new Error(String(body.message || body.error || `HTTP ${response.status}`)), { status: response.status });
  return body as T;
}

export function FolderBrowserModal({ open, onOpenChange, onSelectFolder }: FolderBrowserModalProps) {
  const [folderPath, setFolderPath] = useState('');
  const [folderBrowser, setFolderBrowser] = useState<FolderBrowseResponse>();
  const [folderActivity, setFolderActivity] = useState<FolderActivity>('idle');
  const [folderError, setFolderError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const activityRef = useRef<FolderActivity>('idle');
  const browseAbortRef = useRef<AbortController | undefined>(undefined);
  const browseRequestRef = useRef(0);
  const openChangeRef = useRef(onOpenChange);

  useEffect(() => {
    openChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  const folderBusy = folderActivity !== 'idle';
  const folderCrumbs = useMemo(() => folderBreadcrumbs(folderBrowser?.currentPath || ''), [folderBrowser?.currentPath]);
  const canSelectFolder = Boolean(
    folderBrowser?.currentPath
    && !folderBrowser.alreadyAdded
    && !folderError
    && sameFolderPath(folderPath, folderBrowser.currentPath),
  );

  const beginFolderActivity = useCallback((activity: Exclude<FolderActivity, 'idle'>) => {
    if (activityRef.current !== 'idle') return false;
    dialogRef.current?.focus();
    activityRef.current = activity;
    setFolderActivity(activity);
    return true;
  }, []);

  const finishFolderActivity = useCallback(() => {
    activityRef.current = 'idle';
    setFolderActivity('idle');
  }, []);

  const browseFolder = useCallback(async (requestedPath: string) => {
    if (!beginFolderActivity('loading')) return;
    const requestId = browseRequestRef.current + 1;
    browseRequestRef.current = requestId;
    const controller = new AbortController();
    browseAbortRef.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FOLDER_BROWSE_TIMEOUT_MS);
    const nextPath = requestedPath.trim();
    setFolderError('');
    if (nextPath) setFolderPath(nextPath);
    try {
      const result = await browseJsonFetch<FolderBrowseResponse>(`/api/library/folders/browse?path=${encodeURIComponent(nextPath)}`, { signal: controller.signal });
      if (requestId !== browseRequestRef.current) return;
      setFolderBrowser(result);
      setFolderPath(result.currentPath);
    } catch (cause) {
      if (requestId !== browseRequestRef.current) return;
      if (timedOut) setFolderError('读取目录超时，请检查磁盘或网络连接后重试');
      else if (!controller.signal.aborted) setFolderError(cause instanceof Error ? cause.message : '无法读取这个位置，请检查路径后重试');
    } finally {
      window.clearTimeout(timeout);
      if (requestId === browseRequestRef.current) {
        browseAbortRef.current = undefined;
        finishFolderActivity();
      }
    }
  }, [beginFolderActivity, finishFolderActivity]);

  const closeFolderBrowser = useCallback(() => {
    if (activityRef.current === 'loading') {
      browseRequestRef.current += 1;
      browseAbortRef.current?.abort();
      browseAbortRef.current = undefined;
      finishFolderActivity();
    }
    openChangeRef.current(false);
  }, [finishFolderActivity]);

  useEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => dialogRef.current?.focus(), 0);

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFolderBrowser();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleDialogKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [closeFolderBrowser, open]);

  useEffect(() => {
    if (!open || activityRef.current === 'scanning') return;
    setFolderError('');
    setFolderBrowser(undefined);
    setFolderPath('');
    void browseFolder('');
  }, [browseFolder, open]);

  useEffect(() => () => {
    browseRequestRef.current += 1;
    browseAbortRef.current?.abort();
  }, []);

  const addFolder = async () => {
    const selectedPath = folderBrowser?.currentPath.trim();
    if (!selectedPath || !canSelectFolder || !beginFolderActivity('scanning')) return;
    setFolderError('');
    try {
      await onSelectFolder(selectedPath);
      setFolderPath('');
      openChangeRef.current(false);
    } catch (cause) {
      setFolderError(cause instanceof Error ? cause.message : '添加文件夹失败');
    } finally {
      finishFolderActivity();
    }
  };

  if (!open) return null;

  return (
    <div className="modal-backdrop folder-browser-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeFolderBrowser(); }}>
      <section
        className="folder-modal folder-browser-modal"
        ref={dialogRef}
        role="dialog"
        data-folder-browser-dialog
        aria-modal="true"
        aria-labelledby="folder-dialog-title"
        aria-describedby="folder-dialog-description"
        aria-busy={folderBusy}
        tabIndex={-1}
      >
        <header className="folder-browser-header">
          <span className="folder-browser-mark" aria-hidden="true"><span className="folder-icon large" /></span>
          <div>
            <p className="eyebrow">COMPUTER LIBRARY</p>
            <h2 id="folder-dialog-title">选择媒体文件夹</h2>
            <p id="folder-dialog-description">Localis 会递归扫描所选目录中的视频与音频，文件只留在这台电脑。</p>
          </div>
          <button className="folder-browser-close" type="button" aria-label="关闭文件夹浏览器" onClick={closeFolderBrowser}>×</button>
        </header>

        <div className="folder-browser-layout">
          <aside className="folder-locations" aria-label="快捷位置">
            <span className="folder-browser-label">快捷位置</span>
            <div>
              {(folderBrowser?.locations || []).map((location) => (
                <button
                  key={`${location.kind || 'folder'}-${location.path}`}
                  className={folderBrowser && sameFolderPath(folderBrowser.currentPath, location.path) ? 'active' : ''}
                  type="button"
                  disabled={folderBusy}
                  onClick={() => void browseFolder(location.path)}
                >
                  <i aria-hidden="true">{folderLocationGlyph(location.kind)}</i>
                  <span>{location.name}</span>
                </button>
              ))}
              {!folderBrowser && <span className="folder-location-loading">正在读取快捷位置…</span>}
            </div>
          </aside>

          <div className="folder-browser-main">
            <span className="folder-browser-label">当前位置</span>
            <nav className="folder-breadcrumbs" aria-label="当前文件夹路径">
              {folderCrumbs.length > 0 ? folderCrumbs.map((crumb, index) => (
                <span key={crumb.path}>
                  {index > 0 && <i aria-hidden="true">›</i>}
                  <button
                    type="button"
                    aria-current={index === folderCrumbs.length - 1 ? 'location' : undefined}
                    disabled={folderBusy}
                    onClick={() => void browseFolder(crumb.path)}
                  >{crumb.name}</button>
                </span>
              )) : <span className="folder-path-placeholder">正在定位…</span>}
            </nav>

            <form className="folder-path-form" onSubmit={(event) => { event.preventDefault(); void browseFolder(folderPath); }}>
              <label className="visually-hidden" htmlFor="folder-path-input">手动输入文件夹完整路径</label>
              <span aria-hidden="true">⌕</span>
              <input
                id="folder-path-input"
                aria-label="手动输入文件夹完整路径"
                placeholder="输入完整路径，例如 D:\Videos"
                value={folderPath}
                disabled={folderBusy}
                spellCheck={false}
                onChange={(event) => setFolderPath(event.target.value)}
              />
              <button type="submit" disabled={folderBusy || !folderPath.trim()}>前往</button>
            </form>

            <div className="folder-browser-toolbar">
              <button type="button" disabled={folderBusy || !folderBrowser?.parentPath} onClick={() => { if (folderBrowser?.parentPath) void browseFolder(folderBrowser.parentPath); }}><span aria-hidden="true">↑</span> 返回上级</button>
              <span>{folderBrowser ? folderBrowser.truncated ? `仅显示前 ${folderBrowser.folders.length} 个子文件夹` : `${folderBrowser.folders.length} 个子文件夹` : '读取目录中'}</span>
            </div>

            <div className="folder-list" aria-live="polite" aria-busy={folderActivity === 'loading'}>
              {folderActivity === 'loading' ? (
                <div className="folder-loading-state" role="status"><i aria-hidden="true" /><strong>正在加载目录</strong><span>正在读取这台电脑上的文件夹…</span></div>
              ) : folderBrowser?.folders.length ? (
                folderBrowser.folders.map((folder) => (
                  <button key={folder.path} type="button" disabled={folderBusy} onClick={() => void browseFolder(folder.path)}>
                    <span className="folder-icon browser-folder-icon" aria-hidden="true" />
                    <span><strong>{folder.name}</strong><small>{folder.path}</small></span>
                    <i aria-hidden="true">›</i>
                  </button>
                ))
              ) : folderBrowser ? (
                <div className="folder-empty-state"><span className="folder-icon large" aria-hidden="true" /><strong>这里没有子文件夹</strong><span>可以直接选择当前目录，或输入其他路径。</span></div>
              ) : (
                <div className="folder-empty-state"><strong>还没有可显示的目录</strong><span>请检查路径后重试。</span></div>
              )}
            </div>
          </div>
        </div>

        {folderError && <div className="inline-error folder-error folder-browser-error" role="alert"><span>{folderError}</span><button type="button" disabled={folderBusy} onClick={() => void browseFolder(folderPath)}>重试</button></div>}

        {folderActivity === 'scanning' && (
          <div className="folder-scanning-status" role="status" aria-live="assertive"><i aria-hidden="true" /><span><strong>正在扫描媒体</strong><small>正在分析视频与音频信息，完成前请保持此窗口打开。</small></span></div>
        )}

        <footer className="folder-browser-footer">
          <div>
            <span>将要添加</span>
            <strong title={folderBrowser?.currentPath}>{folderBrowser?.currentPath || '请选择一个目录'}</strong>
            {folderBrowser?.alreadyAdded && <small>此目录已在媒体库中</small>}
          </div>
          <button className="folder-cancel-button" type="button" onClick={closeFolderBrowser}>取消</button>
          <button className={`add-button folder-select-button ${folderActivity === 'scanning' ? 'is-scanning' : ''}`} type="button" disabled={folderBusy || !canSelectFolder} onClick={() => void addFolder()}>
            {folderActivity === 'scanning' ? '正在扫描媒体…' : folderBrowser?.alreadyAdded ? '此目录已添加' : '选择当前目录'}
          </button>
        </footer>
      </section>
    </div>
  );
}
