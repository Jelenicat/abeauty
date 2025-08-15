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
import { FiPlus, FiEdit, FiTrash2, FiX, FiCheck } from "react-icons/fi";

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
    const offCats = onSnapshot(
      query(collection(db, "categories"), orderBy("order", "asc")),
      (s) => {
        setCats(s.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      }
    );
    const offSrv = onSnapshot(collection(db, "services"), (s) => {
      setServices(s.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return () => {
      offCats();
      offSrv();
    };
  }, []);

  const countByCat = useMemo(() => {
    const m = new Map();
    for (const s of services) m.set(s.categoryId, (m.get(s.categoryId) || 0) + 1);
    return m;
  }, [services]);

  const filtered = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return t ? cats.filter((c) => (c.name || "").toLowerCase().includes(t)) : cats;
  }, [cats, filter]);

  const discountedServices = useMemo(
    () => services.filter((s) => Number(s.discountPercent || 0) > 0),
    [services]
  );

  // Virtuelna kategorija "Na popustu"
  const filteredWithDiscounts = useMemo(() => {
    const wants =
      discountedServices.length > 0 &&
      (!filter.trim() ||
        "na popustu".includes(filter.trim().toLowerCase()) ||
        "popust".includes(filter.trim().toLowerCase()));

    const base = [...filtered];
    if (wants) {
      base.unshift({
        id: "discounts",
        name: "Na popustu",
        order: -Infinity,
        _virtual: true,
      });
    }
    return base;
  }, [filtered, discountedServices.length, filter]);

  async function addCategory(e) {
    e.preventDefault();
    const CLEAN = newName.trim();
    if (!CLEAN) return setError("Naziv kategorije ne može biti prazan.");
    if (cats.some((c) => (c.name || "").trim().toLowerCase() === CLEAN.toLowerCase()))
      return setError("Kategorija sa tim nazivom već postoji.");

    setIsAdding(true);
    try {
      await addDoc(collection(db, "categories"), {
        name: CLEAN,
        order: (cats?.length || 0) + 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setNewName("");
      setError("");
    } catch (err) {
      console.error(err);
      setError("Greška prilikom dodavanja kategorije.");
    } finally {
      setIsAdding(false);
    }
  }

  async function renameCategory(id, name) {
    const CLEAN = name.trim();
    if (!CLEAN) return;
    const current = cats.find((c) => c.id === id);
    if (current && (current.name || "").trim() === CLEAN) {
      setEditingId(null);
      setEditingName("");
      return;
    }
    if (
      cats.some(
        (c) => c.id !== id && (c.name || "").trim().toLowerCase() === CLEAN.toLowerCase()
      )
    )
      return setError("Kategorija sa tim nazivom već postoji.");

    try {
      await updateDoc(doc(db, "categories", id), {
        name: CLEAN,
        updatedAt: serverTimestamp(),
      });
      setEditingId(null);
      setEditingName("");
    } catch (err) {
      console.error(err);
      setError("Greška prilikom preimenovanja kategorije.");
    }
  }

  async function removeCategory(id) {
    if (!confirm("Obrisati kategoriju? (Usluge ostaju u bazi)")) return;
    try {
      await deleteDoc(doc(db, "categories", id));
    } catch (err) {
      console.error(err);
      setError("Greška prilikom brisanja kategorije.");
    }
  }

  const addBtnStyle = {
    ...addBtn,
    ...(isAdding || !newName.trim() ? { opacity: 0.6, cursor: "not-allowed" } : {}),
  };

  return (
    <div style={wrap} className="ak-root">
      {/* Responsive + font CSS */}
      <style>{responsiveCSS}</style>

      <div style={panel} className="ak-panel">
        {/* INPUT iznad, DUGME ispod (mobile), u liniji (desktop) */}
        <form onSubmit={addCategory} style={topBar} className="ak-topbar">
          <div style={addBox}>
            <span style={addIcon}>
              <FiPlus />
            </span>
            <input
              style={addInput}
              placeholder="Nova kategorija (npr. Masaže)"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value);
                if (error) setError("");
              }}
              aria-label="Unesite naziv nove kategorije"
            />
          </div>
          <button
            style={addBtnStyle}
            type="submit"
            disabled={isAdding || !newName.trim()}
            className="ak-addbtn"
          >
            {isAdding ? "Dodavanje…" : "Dodaj"}
          </button>
        </form>

        {error && (
          <div className="ak-error">
            {error}
          </div>
        )}

        {/* Grid */}
        {loading ? (
          <div style={{ color: "#fff", textAlign: "center" }}>Učitavanje…</div>
        ) : (
          <div style={grid} className="ak-grid">
            {filteredWithDiscounts.map((cat) => {
              const isEditing = editingId === cat.id && !cat._virtual;
              const isDiscounts = cat.id === "discounts";
              const count = isDiscounts
                ? discountedServices.length
                : countByCat.get(cat.id) || 0;

              return (
                <div key={cat.id} style={tile} className="ak-tile">
                  {/* Pozadina: za “Na popustu” koristi slika3.webp */}
                  <div
                    style={{
                      ...marble,
                      background: isDiscounts
                        ? "url('/slika3.webp') center/cover no-repeat"
                        : marble.background,
                    }}
                    className="ak-marble"
                  />
                  <div style={tileActions} className="ak-actions">
                    {(!isDiscounts && !isEditing) ? (
                      <>
                        <button
                          style={tileActionBtn}
                          title="Preimenuj"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(cat.id);
                            setEditingName(cat.name || "");
                          }}
                        >
                          <FiEdit />
                        </button>
                        <button
                          style={{ ...tileActionBtn, background: "#ffe1e1", color: "#7a1b1b" }}
                          title="Obriši"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeCategory(cat.id);
                          }}
                        >
                          <FiTrash2 />
                        </button>
                      </>
                    ) : !isDiscounts ? (
                      <>
                        <button
                          style={{ ...tileActionBtn, background: "#efefef" }}
                          title="Otkaži"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(null);
                            setEditingName("");
                          }}
                        >
                          <FiX />
                        </button>
                        <button
                          style={{
                            ...tileActionBtn,
                            background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
                            color: "#fff",
                          }}
                          title="Sačuvaj"
                          onClick={(e) => {
                            e.stopPropagation();
                            renameCategory(cat.id, editingName);
                          }}
                        >
                          <FiCheck />
                        </button>
                      </>
                    ) : null}
                  </div>

                  {!isEditing ? (
                    <button
                      style={tileButton}
                      onClick={() =>
                        nav(isDiscounts ? "/admin/katalog/discounts" : `/admin/katalog/${cat.id}`)
                      }
                      className="ak-tilebtn"
                    >
                      <div style={tileName} className="ak-tilename">{cat.name}</div>
                      <div style={badge} className="ak-badge">{count} usl.</div>
                    </button>
                  ) : (
                    <div style={editRow} onClick={(e) => e.stopPropagation()}>
                      <input
                        style={editInput}
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") renameCategory(cat.id, editingName);
                          if (e.key === "Escape") {
                            setEditingId(null);
                            setEditingName("");
                          }
                        }}
                        onBlur={() => {
                          if (editingId === cat.id && editingName.trim())
                            renameCategory(cat.id, editingName);
                        }}
                        autoFocus
                      />
                    </div>
                  )}
                </div>
              );
            })}
            {!filteredWithDiscounts.length && (
              <div style={{ color: "#fff", textAlign: "center" }}>Nema rezultata.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ===== BASE STYLES (desktop-first) ===== */

const wrap = {
  minHeight: "100vh",
  background: ["url('/slika1.webp') center/cover no-repeat fixed", "linear-gradient(135deg,#f0f0f0,#d9d9d9)"].join(", "),
  padding: "clamp(12px,4vw,24px)",
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
};

const panel = {
  width: "min(1280px,100%)",
  background: "rgba(255,255,255,.14)",
  border: "1px solid rgba(255,255,255,.35)",
  backdropFilter: "blur(10px)",
  borderRadius: 20,
  boxShadow: "0 24px 60px rgba(0,0,0,.25)",
  padding: "clamp(16px,4vw,32px)",
};

/* topBar: na desktopu u liniji, na mobilnom se slaže */
const topBar = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 10,
  maxWidth: "980px",
  margin: "16px auto 0",
};

const addBox = { position: "relative", width: "100%" };
const addInput = {
  width: "100%",
  height: 44,
  padding: "0 12px 0 36px",
  borderRadius: 12,
  border: "1px solid #ececec",
  background: "#fff",
  fontSize: 14,
  boxShadow: "0 6px 14px rgba(0,0,0,.06)",
};
const addIcon = {
  position: "absolute",
  left: 12,
  top: "50%",
  transform: "translateY(-50%)",
  opacity: 0.7,
  fontSize: 16,
};
const addBtn = {
  width: "180px",
  height: 44,
  border: "none",
  borderRadius: 12,
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  fontWeight: 800,
  cursor: "pointer",
  padding: "0 14px",
  boxShadow: "0 8px 18px rgba(255,127,181,.3)",
};

const grid = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  marginTop: 14,
};

const tile = {
  position: "relative",
  borderRadius: 16,
  overflow: "hidden",
  border: "1px solid #ececec",
  boxShadow: "0 8px 20px rgba(0,0,0,.14)",
};
const marble = {
  position: "absolute",
  inset: 0,
  background: "url('/slika6.webp') center/cover no-repeat",
  opacity: 0.98,
};
const tileActions = { position: "absolute", top: 8, right: 8, display: "flex", gap: 6, zIndex: 2 };
const tileActionBtn = {
  height: 34,
  width: 34,
  borderRadius: 8,
  border: "none",
  background: "#efefef",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};
const tileButton = {
  position: "relative",
  display: "grid",
  placeItems: "center",
  width: "100%",
  height: 120,
  cursor: "pointer",
  padding: 12,
  background: "rgba(255,255,255,.1)",
  border: "none",
  outline: "none",
  zIndex: 1,
};
const tileName = {
  fontWeight: 800,
  fontSize: 20,
  textAlign: "center",
  color: "#2d2d2d",
  textShadow: "0 1px 0 rgba(255,255,255,.8)",
};
const badge = {
  position: "absolute",
  right: 10,
  bottom: 10,
  background: "rgba(255,255,255,.90)",
  border: "1px solid #eee",
  borderRadius: 999,
  padding: "3px 10px",
  fontSize: 12,
  fontWeight: 700,
  color: "#444",
};
const editRow = { padding: 12, position: "relative", zIndex: 1, background: "rgba(255,255,255,.85)" };
const editInput = { width: "100%", height: 40, borderRadius: 10, border: "1px solid #ddd", padding: "0 10px", fontSize: 14 };

/* ===== RESPONSIVE + FONT CSS ===== */
const responsiveCSS = `
/* Global font (radi ako si dodao link za Poppins u index.html) */
.ak-root, .ak-root * {
  font-family: 'Poppins', system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
}

/* Error stil */
.ak-error{
  color:#ff5fa2;
  margin:8px auto 0;
  max-width:820px;
  text-align:center;
  font-weight:700;
}

/* Tablet */
@media (max-width: 900px) {
  .ak-panel { padding: 16px; border-radius: 18px; }
  .ak-topbar { grid-template-columns: 1fr; }
  .ak-addbtn { width: 100%; }
  .ak-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
}

/* Telefon */
@media (max-width: 600px) {
  .ak-topbar { gap: 8px; margin-top: 12px; }
  .ak-grid { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
  .ak-tilebtn { height: 104px; }
  .ak-tilename { font-size: 18px !important; }
  .ak-actions { gap: 6px; }
  .ak-badge { font-size: 11px; padding: 2px 8px; right: 8px; bottom: 8px; }
}
`;
