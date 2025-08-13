import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "../firebase";
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";
import { FiPlus, FiSearch, FiEdit, FiTrash2, FiX, FiCheck } from "react-icons/fi";

export default function AdminKatalog() {
  const nav = useNavigate();

  // Data
  const [cats, setCats] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  // Forms
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");

  // Realtime
  useEffect(() => {
    const offCats = onSnapshot(query(collection(db, "categories"), orderBy("order", "asc")), s => {
      setCats(s.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    const offSrv = onSnapshot(collection(db, "services"), s => {
      setServices(s.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return () => { offCats(); offSrv(); };
  }, []);

  const countByCat = useMemo(() => {
    const m = new Map();
    for (const s of services) m.set(s.categoryId, (m.get(s.categoryId) || 0) + 1);
    return m;
  }, [services]);

  const filtered = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return t ? cats.filter(c => (c.name || "").toLowerCase().includes(t)) : cats;
  }, [cats, filter]);

  async function addCategory(e) {
    e.preventDefault();
    const CLEAN = newName.trim();
    if (!CLEAN) return setError("Naziv kategorije ne može biti prazan.");
    if (cats.some(c => (c.name || "").trim().toLowerCase() === CLEAN.toLowerCase()))
      return setError("Kategorija sa tim nazivom već postoji.");

    setIsAdding(true);
    try {
      await addDoc(collection(db, "categories"), {
        name: CLEAN,
        order: (cats?.length || 0) + 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNewName(""); setError("");
    } catch (err) {
      console.error(err); setError("Greška prilikom dodavanja kategorije.");
    } finally { setIsAdding(false); }
  }

  async function renameCategory(id, name) {
    const CLEAN = name.trim();
    if (!CLEAN) return;
    const current = cats.find(c => c.id === id);
    if (current && (current.name || "").trim() === CLEAN) { setEditingId(null); setEditingName(""); return; }
    if (cats.some(c => c.id !== id && (c.name || "").trim().toLowerCase() === CLEAN.toLowerCase()))
      return setError("Kategorija sa tim nazivom već postoji.");

    try {
      await updateDoc(doc(db, "categories", id), { name: CLEAN, updatedAt: serverTimestamp() });
      setEditingId(null); setEditingName("");
    } catch (err) {
      console.error(err); setError("Greška prilikom preimenovanja kategorije.");
    }
  }

  async function removeCategory(id) {
    if (!confirm("Obrisati kategoriju? (Usluge ostaju u bazi)")) return;
    try { await deleteDoc(doc(db, "categories", id)); }
    catch (err) { console.error(err); setError("Greška prilikom brisanja kategorije."); }
  }

  const addBtnStyle = { ...addBtn, ...(isAdding || !newName.trim() ? { opacity:.6, cursor:"not-allowed" } : {}) };

  return (
    <div style={wrap}>
      <div style={panel}>
        <h2 style={title}>Katalog usluga — kategorije</h2>

        {/* INPUT + DUGME: tačno jedan pored drugog, mali razmak */}
        <form onSubmit={addCategory} style={topBar}>
          <div style={addBox}>
            <span style={addIcon}><FiPlus/></span>
            <input
              style={addInput}
              placeholder="Nova kategorija (npr. Masaže)"
              value={newName}
              onChange={e => { setNewName(e.target.value); if (error) setError(""); }}
              aria-label="Unesite naziv nove kategorije"
            />
          </div>
          <button style={addBtnStyle} type="submit" disabled={isAdding || !newName.trim()}>
            {isAdding ? "Dodavanje…" : "Dodaj"}
          </button>
        </form>

        {error && <div style={{color:"#ff5fa2",margin:"8px auto 0",maxWidth:820,textAlign:"center",fontWeight:700}}>{error}</div>}

        {/* Pretraga */}
        <div style={searchRow}>
          <div style={filterBox}>
            <span style={filterIcon}><FiSearch/></span>
            <input
              style={filterInput}
              placeholder="Pretraga kategorija…"
              value={filter}
              onChange={e=>setFilter(e.target.value)}
              aria-label="Pretraži kategorije"
            />
          </div>
        </div>

        {/* Grid */}
        {loading ? (
          <div style={{color:"#fff",textAlign:"center"}}>Učitavanje…</div>
        ) : (
          <div style={grid}>
            {filtered.map(cat => {
              const isEditing = editingId === cat.id;
              const count = countByCat.get(cat.id) || 0;

              return (
                <div key={cat.id} style={tile}>
                  <div style={marble}/>
                  <div style={tileActions}>
                    {!isEditing ? (
                      <>
                        <button style={tileActionBtn} title="Preimenuj" onClick={e=>{e.stopPropagation(); setEditingId(cat.id); setEditingName(cat.name || "");}}><FiEdit/></button>
                        <button style={{...tileActionBtn,background:"#ffe1e1",color:"#7a1b1b"}} title="Obriši" onClick={e=>{e.stopPropagation(); removeCategory(cat.id);}}><FiTrash2/></button>
                      </>
                    ) : (
                      <>
                        <button style={{...tileActionBtn,background:"#efefef"}} title="Otkaži" onClick={e=>{e.stopPropagation(); setEditingId(null); setEditingName("");}}><FiX/></button>
                        <button style={{...tileActionBtn,background:"linear-gradient(135deg,#ff5fa2,#ff7fb5)",color:"#fff"}} title="Sačuvaj" onClick={e=>{e.stopPropagation(); renameCategory(cat.id, editingName);}}><FiCheck/></button>
                      </>
                    )}
                  </div>

                  {!isEditing ? (
                    <button style={tileButton} onClick={()=>nav(`/admin/katalog/${cat.id}`)}>
                      <div style={tileName}>{cat.name}</div>
                      <div style={badge}>{count} usl.</div>
                    </button>
                  ) : (
                    <div style={editRow} onClick={e=>e.stopPropagation()}>
                      <input
                        style={editInput}
                        value={editingName}
                        onChange={e=>setEditingName(e.target.value)}
                        onKeyDown={e=>{
                          if (e.key==="Enter") renameCategory(cat.id, editingName);
                          if (e.key==="Escape") { setEditingId(null); setEditingName(""); }
                        }}
                        onBlur={()=>{ if (editingId===cat.id && editingName.trim()) renameCategory(cat.id, editingName); }}
                        autoFocus
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {!filtered.length && <div style={{color:"#fff",textAlign:"center"}}>Nema rezultata.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== STYLES ===== */

const wrap = {
  minHeight: "100vh",
  background: ["url('/slika8.webp') center/cover no-repeat fixed","linear-gradient(135deg,#f0f0f0,#d9d9d9)"].join(", "),
  padding: "clamp(16px,4vw,24px)",
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
};

const panel = {
  width: "min(1280px,100%)",
  background: "rgba(255,255,255,.14)",
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 28,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(20px,4vw,32px)",
};

const title = {
  margin: "0 0 24px",
  color: "#000000ff",
  textAlign: "center",
  fontWeight: 900,
  fontSize: "clamp(24px,4vw,36px)",
  letterSpacing: ".5px",
};

/* >>> Ovo pravi “input + dugme” blok kao kompaktnu liniju sa malim razmakom */
const topBar = {
  display: "flex",
  alignItems: "center",
  gap: 100,                // jako mali razmak
  width: "fit-content",  // širina = sadržaj (input + dugme)
  margin: "16px auto 0", // centrirano
  
};

const addBox = {
  position: "relative",
  width: 520,        // fiksna ugodna širina inputa
  maxWidth: "72vw",
};

const addInput = {
  width: "100%",
  height: 40,
  padding: "0 12px 0 36px",
  borderRadius: 10,
  border: "1px solid #ececec",
  background: "#fff",
  fontSize: 14,
  boxShadow: "0 6px 14px rgba(0,0,0,.06)",
};

const addIcon = { position: "absolute", left: 12, top: 11, opacity: .7, fontSize: 16 };

const addBtn = {
  width: 110,          // kompaktno dugme
  height: 40,
  border: "none",
  borderRadius: 10,
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  fontWeight: 800,
  cursor: "pointer",
  padding: "0 14px",
  boxShadow: "0 8px 18px rgba(255,127,181,.3)",
};

const searchRow = { maxWidth: 820, margin: "10px auto 12px" };
const filterBox = { position: "relative" };
const filterIcon = { position: "absolute", left: 10, top: 8, opacity: .65, fontSize: 14 };
const filterInput = {
  width: "100%", height: 34, padding: "0 10px 0 32px", borderRadius: 10,
  border: "1px solid rgba(255,255,255,.5)", background: "rgba(255,255,255,.24)",
  color: "#fff", outline: "none", fontSize: 14,
};

const grid = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
  marginTop: 12,
};

const tile = { position: "relative", borderRadius: 20, overflow: "hidden", border: "1px solid #ececec", boxShadow: "0 16px 34px rgba(0,0,0,.14)" };
const marble = { position: "absolute", inset: 0, background: "url('/slika6.webp') center/cover no-repeat", opacity: .98 };
const tileActions = { position: "absolute", top: 8, right: 8, display: "flex", gap: 8, zIndex: 2 };
const tileActionBtn = { height: 36, width: 36, borderRadius: 10, border: "none", background: "#efefef", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
const tileButton = { position: "relative", display: "grid", placeItems: "center", width: "100%", height: 140, cursor: "pointer", padding: 12, background: "rgba(255,255,255,.1)", border: "none", outline: "none", zIndex: 1 };
const tileName = { fontWeight: 900, fontSize: 20, textAlign: "center", color: "#2d2d2d", textShadow: "0 1px 0 rgba(255,255,255,.8)" };
const badge = { position: "absolute", right: 10, bottom: 10, background: "rgba(255,255,255,.85)", border: "1px solid #eee", borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 800, color: "#444" };
const editRow = { padding: 12, position: "relative", zIndex: 1, background: "rgba(255,255,255,.85)" };
const editInput = { width: "100%", height: 38, borderRadius: 10, border: "1px solid #ddd", padding: "0 10px", fontSize: 14 };
