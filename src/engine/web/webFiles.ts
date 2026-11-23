// Files in the web client: a browser has no file paths, so picked / pasted / dropped `File`s are registered under a
// reference (`webfile:<id>/<name>`) that flows through the UI like the desktop's absolute paths (send preview, sendPaths,
// `engine_call_with_files`). Previews are blob: URLs; sending uploads each file to the server's `/upload` in 8 MB chunks
// (cookie + `X-Compola: 1`, same as src-tauri/src/remote/client.rs `upload`) and passes the server's references on.

const prefix = 'webfile:';
const files = new Map<string, File>();
const previews = new Map<string, string>();

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** A server-safe file name (no separators or control characters). */
const safeName = (name: string) => name.replace(/[/\\\u0000-\u001f]/g, '_').trim().slice(0, 200) || 'tệp';

export const isWebFile = (ref: string) => ref.startsWith(prefix);

/** Registers files → their references (the name is the last path segment, like a path's file name). */
export const registerFiles = (list: Iterable<File>): string[] =>
  [...list].map((file) => {
    const ref = `${prefix}${randomHex(8)}/${safeName(file.name || 'tệp')}`;
    files.set(ref, file);
    return ref;
  });

export const fileOf = (ref: string) => files.get(ref) ?? null;

/** A blob: URL to preview a registered file (kept for the page's lifetime: previews re-render). */
export const webPreviewUrl = (ref: string): string | null => {
  const file = files.get(ref);
  if (!file) return null;
  let url = previews.get(ref);
  if (!url) {
    url = URL.createObjectURL(file);
    previews.set(ref, url);
  }
  return url;
};

// MARK: - Upload

const chunkSize = 8 << 20;

const uploadError = async (res: Response, name: string) => {
  let reason = '';
  try {
    reason = ((await res.json()) as { error?: string })?.error ?? '';
  } catch {
    /* not JSON */
  }
  return `Không gửi được ${name} lên máy chủ (HTTP ${res.status}) ${reason}`.trim();
};

/** Uploads one file → the server's reference to it (`<id>/<name>`). */
export const uploadFile = async (file: File, name = safeName(file.name)): Promise<string> => {
  const id = randomHex(16);
  let offset = 0;
  let reference: string | null = null;
  do {
    const chunk = file.slice(offset, offset + chunkSize);
    const query = new URLSearchParams({ id, name, offset: String(offset) });
    let res: Response;
    try {
      res = await fetch(`/upload?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Compola': '1', 'Content-Type': 'application/octet-stream' },
        body: chunk,
      });
    } catch {
      throw `Không gửi được ${name}: mất kết nối tới máy chủ.`;
    }
    if (!res.ok) throw await uploadError(res, name);
    reference = ((await res.json()) as { path?: string })?.path ?? null;
    offset += chunk.size;
  } while (offset < file.size);
  if (!reference) throw 'Máy chủ không nhận tệp.';
  return reference;
};

/** Uploads registered files (references from `registerFiles`) → the server's references, in order. */
export const uploadRefs = async (refs: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const ref of refs) {
    const file = files.get(ref);
    if (!file) throw 'Không tìm thấy tệp đã chọn. Hãy chọn lại.';
    out.push(await uploadFile(file, ref.slice(ref.indexOf('/') + 1)));
  }
  return out;
};

// MARK: - Picking

/** The browser's file chooser (`pick`: "media" = photos and videos). Resolves [] when cancelled. */
export const pickFiles = (pick: string | null | undefined): Promise<string[]> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (pick === 'media') input.accept = 'image/*,video/*';
    input.style.display = 'none';
    let done = false;
    const finish = (refs: string[]) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(refs);
    };
    input.addEventListener('change', () => finish(registerFiles(input.files ?? [])));
    input.addEventListener('cancel', () => finish([]));
    document.body.appendChild(input);
    input.click();
  });

// MARK: - Paste

let lastPaste: { refs: string[]; at: number } | null = null;

/**
 * Captures the files of every paste (before the composer's own handler, which asks `clipboard_paste_files` for them
 * right away). Installed once by the web backend.
 */
export const capturePastes = () => {
  window.addEventListener(
    'paste',
    (e) => {
      const list = e.clipboardData?.files;
      if (list && list.length) lastPaste = { refs: registerFiles(list), at: Date.now() };
    },
    true,
  );
};

/** `clipboard_paste_files`: the files of the paste under way, or the clipboard's images (async Clipboard API). */
export const clipboardFiles = async (): Promise<string[]> => {
  if (lastPaste && Date.now() - lastPaste.at < 2000) {
    const refs = lastPaste.refs;
    lastPaste = null;
    return refs;
  }
  try {
    const items = await navigator.clipboard.read();
    const images: File[] = [];
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) images.push(new File([await item.getType(type)], `anh-dan.${type.split('/')[1] || 'png'}`, { type }));
    }
    return registerFiles(images);
  } catch {
    return [];
  }
};

// MARK: - Drag and drop

/** HTML5 drag and drop of files on the window (`onFileDrop` in the web client). */
export const onWebFileDrop = (handler: (event: { kind: 'over' } | { kind: 'leave' } | { kind: 'drop'; paths: string[] }) => void): (() => void) => {
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  let depth = 0;
  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth += 1;
    handler({ kind: 'over' });
  };
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) handler({ kind: 'leave' });
  };
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    handler({ kind: 'drop', paths: registerFiles(e.dataTransfer?.files ?? []) });
  };
  window.addEventListener('dragenter', enter);
  window.addEventListener('dragover', over);
  window.addEventListener('dragleave', leave);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragenter', enter);
    window.removeEventListener('dragover', over);
    window.removeEventListener('dragleave', leave);
    window.removeEventListener('drop', drop);
  };
};
