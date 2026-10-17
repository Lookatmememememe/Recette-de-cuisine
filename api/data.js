// Stockage partagé des recettes et des repas ajoutés depuis le site.
// Un document = un fichier JSON dans Vercel Blob. Lecture libre ; écriture protégée par le code CODE_PARTAGE.
const crypto = require('crypto');

const PREFIX = { recettes: 'recettes/', repas: 'repas/' };
const getBlob = () => global.__BLOB_STUB__ || import('@vercel/blob');

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const strList = (v, nItems, nChars) => (Array.isArray(v) ? v : []).map(x => str(x, nChars)).filter(Boolean).slice(0, nItems);

function cleanDoc(c, d) {
  if (!d || typeof d !== 'object') return null;
  if (c === 'recettes') {
    const doc = { titre: str(d.titre, 140), type: str(d.type, 60) || 'Autre', source: str(d.source, 140), portions: str(d.portions, 10),
      ing: strList(d.ing, 200, 300), etapes: strList(d.etapes, 100, 1500) };
    return doc.titre && doc.ing.length ? doc : null;
  }
  const plats = (Array.isArray(d.plats) ? d.plats : []).slice(0, 30).map(p => ({ nom: str(p && p.nom, 200), detail: str(p && p.detail, 1500), note: str(p && p.note, 500) })).filter(p => p.nom);
  const doc = { titre: str(d.titre, 140), date: str(d.date, 40), invites: str(d.invites, 10), plats, notes: str(d.notes, 2000) };
  return doc.titre && plats.length ? doc : null;
}

function codeOk(given) {
  const expected = process.env.CODE_PARTAGE || '';
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return {};
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const c = String((req.query && req.query.c) || '');
  if (!PREFIX[c]) return res.status(400).json({ error: 'collection inconnue' });
  try {
    const { list, put, del } = await getBlob();

    if (req.method === 'GET') {
      const blobs = [];
      let cursor;
      do {
        const r = await list({ prefix: PREFIX[c], cursor, limit: 1000 });
        blobs.push(...r.blobs);
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      const docs = (await Promise.all(blobs.map(async b => {
        try { const r = await fetch(b.url); return r.ok ? await r.json() : null; } catch (e) { return null; }
      }))).filter(Boolean);
      docs.sort((x, y) => (x.created || 0) - (y.created || 0));
      return res.status(200).json({ docs });
    }

    if (req.method === 'POST' || req.method === 'DELETE' || req.method === 'PUT') {
      if (!process.env.CODE_PARTAGE) return res.status(503).json({ error: 'code de partage non configuré' });
      if (!codeOk(req.headers['x-code'])) {
        await new Promise(r => setTimeout(r, 800));
        return res.status(401).json({ error: 'code incorrect' });
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        const inputs = Array.isArray(body.docs) ? body.docs.slice(0, 200) : (body.doc ? [body.doc] : []);
        const saved = [];
        for (const raw of inputs) {
          const doc = cleanDoc(c, raw);
          if (!doc) continue;
          doc.created = Date.now() + saved.length;
          doc.id = 's' + doc.created.toString(36) + crypto.randomBytes(3).toString('hex');
          await put(PREFIX[c] + doc.id + '.json', JSON.stringify(doc), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
          saved.push(doc.id);
        }
        if (!saved.length) return res.status(400).json({ error: 'document invalide' });
        return res.status(200).json({ ok: true, ids: saved });
      }

      const id = String((req.query && req.query.id) || '');
      if (!/^s[a-z0-9]{6,40}$/.test(id)) return res.status(400).json({ error: 'identifiant invalide' });
      const r = await list({ prefix: PREFIX[c] + id + '.json', limit: 5 });
      const hit = r.blobs.find(b => b.pathname === PREFIX[c] + id + '.json');
      if (!hit) return res.status(404).json({ error: 'introuvable' });

      if (req.method === 'PUT') {
        // modification : nouveau document (nouvel id, même date de création), puis suppression de l'ancien
        const body = await readBody(req);
        const doc = cleanDoc(c, body.doc);
        if (!doc) return res.status(400).json({ error: 'document invalide' });
        let created = Date.now();
        try { const old = await (await fetch(hit.url)).json(); if (old && old.created) created = old.created; } catch (e) {}
        doc.created = created;
        doc.id = 's' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
        await put(PREFIX[c] + doc.id + '.json', JSON.stringify(doc), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
        await del(hit.url);
        return res.status(200).json({ ok: true, id: doc.id });
      }

      await del(hit.url);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'méthode non autorisée' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};
