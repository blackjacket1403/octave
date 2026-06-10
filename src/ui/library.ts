/**
 * The music library: search the Internet Archive's public-domain audio
 * collections (free, no key, CORS-open) and stream a chosen recording into
 * the engine. Two levels: search results (albums/items), then the item's
 * individual MP3 tracks.
 */

export interface LibraryHooks {
  onTrackUrl(url: string, name: string): void;
  onOpenFile(): void;
}

interface SearchDoc {
  identifier: string;
  title?: string;
  creator?: string | string[];
}

const SEARCH_URL = (q: string) =>
  'https://archive.org/advancedsearch.php?q=' +
  encodeURIComponent(`(${q}) AND mediatype:(audio) AND format:(MP3)`) +
  '&fl[]=identifier&fl[]=title&fl[]=creator&rows=18&page=1&output=json' +
  '&sort[]=' +
  encodeURIComponent('downloads desc');

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

export class Library {
  private overlay = $<HTMLDivElement>('#library');
  private input = $<HTMLInputElement>('#libInput');
  private form = $<HTMLFormElement>('#libForm');
  private results = $<HTMLDivElement>('#libResults');
  private status = $<HTMLDivElement>('#libStatus');
  private requestSeq = 0;

  constructor(private hooks: LibraryHooks) {
    $('#libClose').addEventListener('click', () => this.close());
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) this.close();
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = this.input.value.trim();
      if (q) void this.search(q);
    });
    $('#libOpenFile').addEventListener('click', () => {
      this.close();
      this.hooks.onOpenFile();
    });
    document.querySelectorAll<HTMLButtonElement>('#library .lib-bundled button[data-url]').forEach(
      (btn) =>
        btn.addEventListener('click', () => {
          this.close();
          this.hooks.onTrackUrl(btn.dataset.url!, btn.dataset.name ?? btn.textContent ?? '');
        }),
    );
  }

  get isOpen(): boolean {
    return this.overlay.classList.contains('open');
  }

  open(): void {
    this.overlay.classList.add('open');
    setTimeout(() => this.input.focus(), 50);
  }

  close(): void {
    this.overlay.classList.remove('open');
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  private async search(q: string): Promise<void> {
    const seq = ++this.requestSeq;
    this.results.innerHTML = '';
    this.setStatus('Searching the archive…');
    try {
      const res = await fetch(SEARCH_URL(q));
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      if (seq !== this.requestSeq) return;
      const docs: SearchDoc[] = json?.response?.docs ?? [];
      if (!docs.length) {
        this.setStatus('Nothing found — try a composer or work, e.g. “Beethoven symphony 7”.');
        return;
      }
      this.setStatus(`${docs.length} recordings — choose one to see its tracks`);
      for (const d of docs) this.results.appendChild(this.renderItem(d));
    } catch {
      if (seq === this.requestSeq) this.setStatus('The archive did not answer — try again in a moment.');
    }
  }

  private renderItem(doc: SearchDoc): HTMLElement {
    const row = document.createElement('div');
    row.className = 'lib-item';
    const creator = Array.isArray(doc.creator) ? doc.creator[0] : doc.creator;
    row.innerHTML =
      `<div class="lib-title">${escapeHtml(doc.title ?? doc.identifier)}</div>` +
      (creator ? `<div class="lib-creator">${escapeHtml(creator)}</div>` : '');
    let expanded = false;
    row.addEventListener('click', () => {
      if (expanded) return;
      expanded = true;
      void this.expandTracks(row, doc);
    });
    return row;
  }

  private async expandTracks(row: HTMLElement, doc: SearchDoc): Promise<void> {
    const list = document.createElement('div');
    list.className = 'lib-tracks';
    list.textContent = 'Fetching tracks…';
    row.appendChild(list);
    try {
      const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(doc.identifier)}`);
      if (!res.ok) throw new Error(String(res.status));
      const meta = await res.json();
      const files: { name: string; format?: string; title?: string; length?: string }[] =
        meta?.files ?? [];
      const mp3s = files
        .filter((f) => f.format && /mp3/i.test(f.format) && !/_sample/i.test(f.name))
        .slice(0, 14);
      list.innerHTML = '';
      if (!mp3s.length) {
        list.textContent = 'No playable MP3s in this item.';
        return;
      }
      for (const f of mp3s) {
        const t = document.createElement('button');
        t.className = 'lib-track';
        const title = f.title || prettifyName(f.name);
        t.innerHTML =
          `<span>${escapeHtml(title)}</span>` +
          (f.length ? `<span class="lib-len">${formatLen(f.length)}</span>` : '');
        t.addEventListener('click', (e) => {
          e.stopPropagation();
          this.close();
          const url = `https://archive.org/download/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(f.name)}`;
          this.hooks.onTrackUrl(url, `${title} — ${doc.title ?? 'Internet Archive'}`);
        });
        list.appendChild(t);
      }
    } catch {
      list.textContent = 'Could not load this item.';
    }
  }
}

function prettifyName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
}

function formatLen(len: string): string {
  // archive lengths come as "mm:ss" or seconds
  if (len.includes(':')) return len;
  const s = Math.round(parseFloat(len));
  if (!isFinite(s)) return '';
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
