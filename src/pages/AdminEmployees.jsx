// src/pages/AdminEmployees.jsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import {
  collection, addDoc, updateDoc, deleteDoc, doc,
  onSnapshot, query, orderBy, serverTimestamp
} from "firebase/firestore";

export default function AdminEmployees() {
  // podaci
  const [employees, setEmployees] = useState([]);
  const [cats, setCats] = useState([]);
  const [allServices, setAllServices] = useState([]);

  // forma
  const [editing, setEditing] = useState(null); // null | employee obj
  const [name, setName] = useState("");
  const [selectedCats, setSelectedCats] = useState(new Set());      // category ids
  const [selectedServices, setSelectedServices] = useState(new Set()); // service ids
  const [loading, setLoading] = useState(true);

  // --- učitavanje realtime ---
  useEffect(() => {
    const offEmp = onSnapshot(
      query(collection(db, "employees"), orderBy("name", "asc")),
      (snap) => setEmployees(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );

    const offCats = onSnapshot(
      query(collection(db, "categories"), orderBy("order", "asc")),
      (snap) => setCats(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    );

    const offServices = onSnapshot(collection(db, "services"), (snap) => {
      const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      arr.sort((a,b) => (a.order ?? 0) - (b.order ?? 0) || (a.name||"").localeCompare(b.name||""));
      setAllServices(arr);
      setLoading(false);
    });

    return () => { offEmp(); offCats(); offServices(); };
  }, []);

  // pomoćni: usluge grupisane po kategoriji
  const servicesByCat = useMemo(() => {
    const map = new Map();
    for (const s of allServices) {
      if (!map.has(s.categoryId)) map.set(s.categoryId, []);
      map.get(s.categoryId).push(s);
    }
    return map;
  }, [allServices]);

  // util: slug iz imena -> /public/employees/<slug>.jpg
  const slugify = (str) =>
    String(str || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .toLowerCase();

  // Ako doc ima photoUrl koristi njega; inače pretpostavi /employees/<slug>.jpg
  const photoSrcFor = (emp) =>
    (emp.photoUrl && String(emp.photoUrl)) || `/employees/${slugify(emp.name)}.jpg`;

  // --- handlers ---
  const resetForm = () => {
    setEditing(null);
    setName("");
    setSelectedCats(new Set());
    setSelectedServices(new Set());
  };

  const startEdit = (emp) => {
    setEditing(emp);
    setName(emp.name || "");
    setSelectedCats(new Set(emp.categories || []));
    setSelectedServices(new Set(emp.services || []));
    // auto-scroll blago prema editoru
    setTimeout(() => {
      document.getElementById(`emp-${emp.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  };

  const saveEmployee = async (e) => {
    e?.preventDefault?.();
    if (!name.trim()) return;

    const payload = {
      name: name.trim(),
      categories: Array.from(selectedCats),
      services: Array.from(selectedServices),
      updatedAt: serverTimestamp(),
      createdAt: editing
        ? (employees.find(x => x.id === editing.id)?.createdAt ?? serverTimestamp())
        : serverTimestamp(),
    };

    if (editing) {
      await updateDoc(doc(db, "employees", editing.id), payload);
    } else {
      await addDoc(collection(db, "employees"), payload);
    }
    resetForm();
  };

  const removeEmployee = async (id) => {
    if (!confirm("Obrisati zaposlenog?")) return;
    await deleteDoc(doc(db, "employees", id));
    if (editing?.id === id) resetForm();
  };

  // klik na kategoriju: dodeli/ukloni celu kategoriju
  const toggleCategory = (catId) => {
    const next = new Set(selectedCats);
    if (next.has(catId)) next.delete(catId); else next.add(catId);
    setSelectedCats(next);

    // ako je kategorija uključena — ukloni pojedinačne usluge te kategorije
    if (next.has(catId)) {
      const nextServices = new Set(selectedServices);
      (servicesByCat.get(catId) || []).forEach(s => nextServices.delete(s.id));
      setSelectedServices(nextServices);
    }
  };

  // klik na uslugu (radi samo ako kategorija NIJE čekirana)
  const toggleService = (srv) => {
    if (selectedCats.has(srv.categoryId)) return;
    const next = new Set(selectedServices);
    if (next.has(srv.id)) next.delete(srv.id); else next.add(srv.id);
    setSelectedServices(next);
  };

  // fallback za <img> — ako slika ne postoji u /public, vrati inicijale
  const ImgOrFallback = ({ src, name }) => {
    const [error, setError] = useState(false);
    if (!src || error) {
      return (
        <div style={squareFallback}>
          <div style={initialsInSquare}>
            {String(name || "?").split(" ").map(s=>s[0]).slice(0,2).join("").toUpperCase()}
          </div>
        </div>
      );
    }
    return <img src={src} alt={name} style={squareImg} onError={()=>setError(true)} />;
  };

  /* ===== RENDER ===== */
  return (
    <div style={wrap}>
      <div style={panel}>
   

        {/* forma za dodavanje/izmene (ime) */}
        <form onSubmit={saveEmployee} style={form}>
          <input
            value={name}
            onChange={e=>setName(e.target.value)}
            placeholder="Ime i prezime zaposlenog"
            style={inp}
          />
          <div style={{display:"flex", gap:8, alignItems:"flex-end"}}>
            {editing && <button type="button" onClick={resetForm} style={ghostBtn}>Otkaži</button>}
            <button type="submit" style={btn}>{editing ? "Sačuvaj izmene" : "Dodaj zaposlenog"}</button>
          </div>
        </form>

        {/* GRID kartice radnica (klik otvara inline editor ispod) */}
        <div style={empGrid}>
          {employees.map((emp) => {
            const isSel = editing?.id === emp.id;
            return (
              <React.Fragment key={emp.id}>
                <div
                  id={`emp-${emp.id}`}
                  style={empCard(isSel)}
                  onClick={() => startEdit(emp)}
                  title="Klikni za izmenu"
                >
                  <div style={square}>
                    <ImgOrFallback src={photoSrcFor(emp)} name={emp.name} />
                  </div>
                  <div style={empName}>{emp.name}</div>

                  {isSel && (
                    <div style={cardActions}>
                      <button
                        style={smDel}
                        onClick={(e)=>{ e.stopPropagation(); removeEmployee(emp.id); }}
                      >
                        Obriši
                      </button>
                    </div>
                  )}
                </div>

                {/* INLINE editor: dodela kategorija/usluga ispod selektovane kartice */}
                {isSel && (
                  <div style={inlineEditor}>
                    <div style={inlineHeader}>
                      <div style={{fontWeight:900}}>
                        Dodela kategorija i usluga — {editing?.name}
                      </div>
                      <div style={{display:"flex", gap:8}}>
                        <button type="button" onClick={resetForm} style={ghostBtn}>Otkaži</button>
                        <button type="button" onClick={saveEmployee} style={btn}>Sačuvaj izmene</button>
                      </div>
                    </div>

                    <div style={grid}>
                      {cats.map(cat => {
                        const catChecked = selectedCats.has(cat.id);
                        const services = servicesByCat.get(cat.id) || [];
                        return (
                          <div key={cat.id} style={catCard}>
                            <div style={catHead}>
                              <label style={{display:"flex", alignItems:"center", gap:10}}>
                                <input
                                  type="checkbox"
                                  checked={catChecked}
                                  onChange={()=>toggleCategory(cat.id)}
                                />
                                <span style={{fontWeight:900, letterSpacing:.2}}>{cat.name}</span>
                              </label>
                              <span style={catHint}>
                                {catChecked ? "• uključene sve usluge" : "odaberi pojedinačno"}
                              </span>
                            </div>

                            {/* >>> ispravka: uklonjena suvišna viticaste } <<< */}
                            <div style={srvList}>
                              {services.map(s => {
                                const disabled = catChecked;
                                const checked = disabled ? true : selectedServices.has(s.id);
                                return (
                                  <label
                                    key={s.id}
                                    style={srvItem(!!checked, disabled)}
                                    title={disabled ? "Pokriveno kategorijom" : ""}
                                  >
                                    <input
                                      type="checkbox"
                                      disabled={disabled}
                                      checked={!!checked}
                                      onChange={()=>toggleService(s)}
                                      style={{display:"none"}}
                                    />
                                    <span style={srvDot(!!checked)} />
                                    <span style={{flex:1}}>{s.name}</span>
                                  </label>
                                );
                              })}
                              {!services.length && (
                                <div style={{fontSize:12, color:"#888"}}>Nema usluga u ovoj kategoriji.</div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </React.Fragment>
            );
          })}
          {!employees.length && !loading && (
            <div style={{color:"#fff"}}>Još nema zaposlenih.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ===== styles ===== */
const wrap = {
  minHeight:"100vh",
  background:'url("/slika7.webp") center/cover no-repeat fixed',
  padding:24, display:"flex", justifyContent:"center", alignItems:"flex-start"
};

const panel = {
  width:"min(1200px,100%)",
  background:"rgba(255,255,255,.14)",
  border:"1px solid rgba(255,255,255,.35)",
  backdropFilter:"blur(12px)",
  borderRadius:32,
  boxShadow:"0 24px 70px rgba(0,0,0,.28)",
  padding:"clamp(18px,4vw,36px)", marginTop:16
};

const title = {
  margin:"0 0 18px",
  color:"#000",
  textAlign:"center",
  fontWeight:900,
  fontSize:"clamp(20px,3.4vw,32px)",
  letterSpacing:.3
};

const form = { display:"grid", gridTemplateColumns:"1fr auto", gap:12, margin:"10px 0 18px" };
const inp  = { height:46, borderRadius:14, border:"1px solid #eaeaea", padding:"0 14px", fontSize:15, background:"#fff", boxShadow:"0 6px 18px rgba(0,0,0,.06)" };
const btn  = { height:46, border:"none", borderRadius:14, background:"linear-gradient(135deg,#ff5fa2,#ff7fb5)", color:"#fff", fontWeight:800, cursor:"pointer", padding:"0 18px", boxShadow:"0 10px 22px rgba(255,127,181,.35)" };
const ghostBtn = { height:46, borderRadius:14, border:"1px solid rgba(255,255,255,.7)", background:"transparent", color:"#fff", fontWeight:800, padding:"0 16px", cursor:"pointer" };

const smBtn   = { height:32, padding:"0 10px", border:"none", borderRadius:10, background:"#efefef", cursor:"pointer", fontWeight:800 };
const smDel   = { ...smBtn, background:"#ffe1e1", color:"#7a1b1b" };

/* === GRID sa kvadratnim karticama === */
const empGrid = {
  display:"grid",
  gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))",
  gap:12,
  margin:"6px 0 16px"
};
const empCard = (active) => ({
  background: "rgba(255,255,255,.35)",
  border: "1px solid rgba(255,255,255,.45)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  borderRadius: 16,
  padding: 10,
  display: "grid",
  justifyItems: "center",
  gap: 8,
  cursor: "pointer",
  boxShadow: active
    ? "0 12px 28px rgba(0,0,0,.14)"
    : "0 8px 18px rgba(0,0,0,.10)",
  outline: active ? "2px solid #ffb6d0" : "none",
  transition: "box-shadow .15s ease, outline-color .15s ease, background .15s ease",
});
const square = {
  width:110,
  height:110,
  borderRadius:12,
  overflow:"hidden",
  background:"linear-gradient(135deg,#ffe3ef,#ffffff)",
  boxShadow:"0 6px 16px rgba(0,0,0,.10)",
  display:"grid",
  placeItems:"center"
};
const squareImg = { width:"100%", height:"100%", objectFit:"cover" };
const squareFallback = { ...square, background:"#f8f8f8" };
const initialsInSquare = { fontWeight:900, color:"#b15b78", fontSize:22, letterSpacing:.6 };
const empName = { fontWeight:800, fontSize:13, textAlign:"center", color:"#222", minHeight:36, lineHeight:1.2 };
const cardActions = { display:"flex", gap:8 };

/* === INLINE editor ispod kartice === */
const inlineEditor = {
  gridColumn: "1 / -1",
  background: "rgba(255,255,255,.45)",
  border: "1px solid rgba(255,255,255,.55)",
  borderRadius: 18,
  padding: 12,
  margin: "-4px 0 14px",
  boxShadow: "0 12px 28px rgba(0,0,0,.10)",
  backdropFilter: "blur(6px)"
};
const inlineHeader = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
  color: "#000"
};

/* --- sekcija dodela usluga/kategorija --- */
const grid   = { display:"grid", gap:18, gridTemplateColumns:"repeat(auto-fit, minmax(260px, 1fr))" };
const catCard = {
  background:"#fff",
  borderRadius:20,
  boxShadow:"0 16px 32px rgba(0,0,0,.10)",
  overflow:"hidden",
  border:"1px solid #f1f1f1"
};
const catHead = {
  display:"flex",
  alignItems:"center",
  justifyContent:"space-between",
  gap:10,
  padding:"12px 14px",
  background:"linear-gradient(135deg, #fafafa, #f5f5f7)",
  borderBottom:"1px solid #ececec",
  position:"sticky",
  top:0,
  zIndex:1
};
const catHint = { fontSize:12, color:"#888", fontWeight:700 };

const srvList = {
  display:"grid",
  gap:10,
  maxHeight:280,
  overflow:"auto",
  padding:12
};

const srvItem = (checked, disabled) => ({
  display:"flex",
  alignItems:"center",
  gap:10,
  padding:"10px 12px",
  borderRadius:14,
  background: "#fff",
  border: checked ? "2px solid #ff79ad" : "1px solid #ededed",
  boxShadow: checked ? "0 10px 16px rgba(255,121,173,.15)" : "0 6px 14px rgba(0,0,0,.05)",
  transition:"transform .12s ease, box-shadow .12s ease, border-color .12s ease",
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? .55 : 1,
  userSelect:"none",
});
const srvDot = (checked) => ({
  width:10, height:10, borderRadius:999,
  background: checked ? "#ff79ad" : "#d9d9d9",
  boxShadow: checked ? "0 0 0 4px rgba(255,121,173,.16)" : "none",
  flex:"0 0 auto"
});
