/* RuninqVic - persistence: IndexedDB autosave + .rvproj project files */
(function (root) {
  const RV = (root.RV = root.RV || {});
  const DB = 'runinqvic', VER = 1;

  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, VER);
      r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets'); if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  function tx(store, mode, fn) {
    return open().then((db) => new Promise((res, rej) => {
      const t = db.transaction(store, mode); const s = t.objectStore(store); const out = fn(s);
      t.oncomplete = () => { db.close(); res(out && out.result !== undefined ? out.result : out); };
      t.onerror = () => { db.close(); rej(t.error); };
    }));
  }

  RV.store = {
    putAsset: (id, rec) => tx('assets', 'readwrite', (s) => s.put(rec, id)),
    getAsset: (id) => tx('assets', 'readonly', (s) => s.get(id)),
    deleteAsset: (id) => tx('assets', 'readwrite', (s) => s.delete(id)),
    allAssetKeys: () => tx('assets', 'readonly', (s) => s.getAllKeys()),
    saveProject: (p) => tx('meta', 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(p)), 'project')),
    loadProject: () => tx('meta', 'readonly', (s) => s.get('project')),
    clearAll: async () => { await tx('assets', 'readwrite', (s) => s.clear()); await tx('meta', 'readwrite', (s) => s.clear()); },
    /* remove assets no longer referenced */
    async gc(project) {
      const used = new Set();
      project.slides.forEach((s) => s.assetId && used.add(s.assetId));
      project.music.tracks.forEach((t) => t.assetId && used.add(t.assetId));
      const keys = await this.allAssetKeys();
      for (const k of keys) if (!used.has(k)) await this.deleteAsset(k);
    },
  };

  function blobToDataURL(blob) {
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  }
  async function dataURLToBlob(url) { return await (await fetch(url)).blob(); }

  /* .rvproj = JSON { app, version, project, assets:[{id, kind, name, type, data}] } */
  RV.serializeProject = async function (project, assets) {
    const out = { app: 'RuninqVic', version: RV.VERSION, savedAt: new Date().toISOString(), project: JSON.parse(JSON.stringify(project)), assets: [] };
    const seen = new Set();
    for (const s of project.slides) {
      if (!s.assetId || seen.has(s.assetId)) continue; seen.add(s.assetId);
      const rec = await RV.store.getAsset(s.assetId); if (!rec) continue;
      out.assets.push({ id: s.assetId, kind: rec.kind || (s.type === 'video' ? 'video' : 'image'), name: rec.name, type: rec.blob.type, data: await blobToDataURL(rec.blob) });
    }
    for (const t of project.music.tracks) {
      if (!t.assetId || seen.has(t.assetId)) continue; seen.add(t.assetId);
      const rec = await RV.store.getAsset(t.assetId); if (!rec) continue;
      out.assets.push({ id: t.assetId, kind: 'audio', name: rec.name, type: rec.blob.type, data: await blobToDataURL(rec.blob) });
    }
    return new Blob([JSON.stringify(out)], { type: 'application/json' });
  };

  RV.parseProjectFile = async function (file) {
    const j = JSON.parse(await file.text());
    if (!j || j.app !== 'RuninqVic' || !j.project) throw new Error('RuninqVic 프로젝트 파일이 아닙니다.');
    const assets = [];
    for (const a of j.assets || []) assets.push({ id: a.id, kind: a.kind, name: a.name, blob: await dataURLToBlob(a.data) });
    return { project: j.project, assets };
  };
})(typeof window !== 'undefined' ? window : globalThis);
