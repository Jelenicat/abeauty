// src/pages/AdminKatalog.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
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
  setDoc,
  getDoc,
  writeBatch,
} from "firebase/firestore";
import { FiPlus, FiEdit, FiTrash2, FiX, FiCheck, FiSearch, FiArrowLeft, FiMove } from "react-icons/fi";

const isTouchDevice = () =>
  typeof window !== "undefined" &&
  ("ontouchstart" in window || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0);

export default function AdminKatalog() {
  const nav = useNavigate();

  // Data
  const [cats, setCats] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Forms
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");

  // Discount “virtual” category
  const [discountTitle, setDiscountTitle] = useState("Na popustu");

  // Desktop drag state
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [previewOrderIds, setPreviewOrderIds] = useState(null);

  // Reorder mode (manual toggle)
  const [reorderMode, setReorderMode] = useState(false);

  // Mobile tap-to-move state
  const [mobileSelectedId, setMobileSelectedId] = useState(null);

  // Refs (trenutno nisu neophodni, zadržano po potrebi)
  const tileRefs = useRef({});

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
    return () => { offCats(); offSrv(); };
  }, []);

  // Discount title
  useEffect(() => {
    let unsub = () => {};
    (async () => {
      try {
        unsub = onSnapshot(doc(db, "meta", "discounts"), (snap) => {
          setDiscountTitle(snap.exists() ? snap.data()?.title || "Na popustu" : "Na popustu");
        });
      } catch {
        const snap = await getDoc(doc(db, "meta", "discounts"));
        setDiscountTitle(snap.exists() ? snap.data()?.title || "Na popustu" : "Na popustu");
      }
    })();
    return () => unsub && unsub();
  }, []);

  const countByCat = useMemo(() => {
    const m = new Map();
    for (const s of services) m.set(s.categoryId, (m.get(s.categoryId) || 0) + 1);
    return m;
  }, [services]);

  const discountedServices = useMemo(
    () => services.filter((s) => Number(s.discountPercent || 0) > 0),
    [services]
  );

  const filtered = useMemo(() => {
    const t = filter.trim().toLowerCase();
    const ordered = [...cats].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return t ? ordered.filter((c) => (c.name || "").toLowerCase().includes(t)) : ordered;
  }, [cats, filter]);

  const filteredWithDiscounts = useMemo(() => {
    const t = filter.trim().toLowerCase();
    const wants =
      discountedServices.length > 0 &&
      (!t || (discountTitle || "Na popustu").toLowerCase().includes(t) || "popust".includes(t));
    const base = [...filtered];
    if (wants) base.unshift({ id: "discounts", name: discountTitle || "Na popustu", order: -Infinity, _virtual: true });
    return base;
  }, [filtered, discountedServices.length, filter, discountTitle]);

  const renderCats = useMemo(() => {
    const baseReal = filteredWithDiscounts.filter((c) => c.id !== "discounts");
    if (!filter.trim() && previewOrderIds && previewOrderIds.length) {
      const mapById = new Map(baseReal.map((c) => [c.id, c]));
      const arranged = [];
      for (const id of previewOrderIds) {
        const obj = mapById.get(id);
        if (obj) arranged.push(obj);
        mapById.delete(id);
      }
      for (const rest of mapById.values()) arranged.push(rest);
      return arranged;
    }
    return baseReal;
  }, [filteredWithDiscounts, previewOrderIds, filter]);

  /*** CRUD ***/
  async function addCategory(e) {
    e.preventDefault();
    const CLEAN = newName.trim();
    if (!CLEAN) return setError("Naziv kategorije ne može biti prazan.");
    if (cats.some((c) => (c.name || "").trim().toLowerCase() === CLEAN.toLowerCase()))
      return setError("Kategorija sa tim nazivom već postoji.");
    try {
      const maxOrder = cats.reduce((m, c) => Math.max(m, Number(c.order || 0)), 0) || 0;
      await addDoc(collection(db, "categories"), {
        name: CLEAN, order: maxOrder + 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
      setNewName(""); setError("");
    } catch (err) { console.error(err); setError("Greška prilikom dodavanja kategorije."); }
  }

  async function renameCategory(id, name) {
    const CLEAN = (name || "").trim();
    if (!CLEAN) return;
    if (id === "discounts") {
      try {
        await setDoc(doc(db, "meta", "discounts"),
          { title: CLEAN, updatedAt: serverTimestamp() }, { merge: true });
        setEditingId(null); setEditingName("");
      } catch (err) { console.error(err); setError("Greška prilikom čuvanja naziva popusta."); }
      return;
    }
    const current = cats.find((c) => c.id === id);
    if (current && (current.name || "").trim() === CLEAN) { setEditingId(null); setEditingName(""); return; }
    if (cats.some((c) => c.id !== id && (c.name || "").trim().toLowerCase() === CLEAN.toLowerCase()))
      return setError("Kategorija sa tim nazivom već postoji.");
    try {
      await updateDoc(doc(db, "categories", id), { name: CLEAN, updatedAt: serverTimestamp() });
      setEditingId(null); setEditingName("");
    } catch (err) { console.error(err); setError("Greška prilikom preimenovanja kategorije."); }
  }

  async function removeCategory(id) {
    if (id === "discounts") return;
    if (!confirm("Obrisati kategoriju? (Usluge ostaju u bazi)")) return;
    try { await deleteDoc(doc(db, "categories", id)); }
    catch (err) { console.error(err); setError("Greška prilikom brisanja kategorije."); }
  }

  async function persistOrderByIds(idList) {
    try {
      const batch = writeBatch(db);
      let idx = 1;
      for (const id of idList) {
        batch.update(doc(db, "categories", id), { order: idx++, updatedAt: serverTimestamp() });
      }
      await batch.commit();
    } catch (e) { console.error(e); setError("Greška prilikom čuvanja poretka."); }
  }

  /*** Desktop DnD ***/
  function onDragStart(e, id) {
    if (filter.trim()) return;
    setDragId(id);
    setDragOverId(id);
    e.dataTransfer.effectAllowed = "move";
    setPreviewOrderIds(renderCats.map((c) => c.id));
  }
  function onDragOver(e, overId) {
    if (!dragId || filter.trim()) return;
    e.preventDefault();
    if (dragOverId === overId) return;
    setDragOverId(overId);
    setPreviewOrderIds((prev) => {
      if (!prev) return prev;
      const arr = prev.filter((x) => x !== dragId);
      const idx = arr.indexOf(overId);
      if (idx === -1) return arr;
      arr.splice(idx, 0, dragId);
      return [...arr];
    });
  }
  async function onDrop(e) {
    e.preventDefault();
    if (!dragId || filter.trim()) { cleanupDrag(); return; }
    const finalIds = previewOrderIds || renderCats.map((c) => c.id);
    await persistOrderByIds(finalIds);
    cleanupDrag();
  }
  function cleanupDrag() { setDragId(null); setDragOverId(null); setPreviewOrderIds(null); }

  /*** Mobile tap-to-move ***/
  async function handleMobileTap(catId, isDiscounts = false) {
    // dozvoljeno samo kad je Ređaj i nema filtera
    if (!isTouchDevice() || !reorderMode || filter.trim()) return false;
    if (isDiscounts) return true; // (za "akcija" više ne koristimo ovaj handler — navigacija je direktna)

    if (!mobileSelectedId) {
      setMobileSelectedId(catId);
      return true;
    }

    if (mobileSelectedId === catId) {
      // tap na istu → otkaži selekciju
      setMobileSelectedId(null);
      return true;
    }

    // pomeri selektovanu ispod cilja
    await moveSelectedBelow(catId);
    setMobileSelectedId(null);
    return true;
  }

  async function moveSelectedBelow(targetId) {
    if (!mobileSelectedId || mobileSelectedId === targetId) return;
    const ids = renderCats.map((c) => c.id);
    const withoutSel = ids.filter((x) => x !== mobileSelectedId);
    const idx = withoutSel.indexOf(targetId);
    const insertAt = idx === -1 ? withoutSel.length : idx + 1;
    withoutSel.splice(insertAt, 0, mobileSelectedId);
    await persistOrderByIds(withoutSel);
  }

  const isMobile = isTouchDevice();

  const addBtnStyle = {
    ...addBtn,
    ...(!newName.trim() ? { opacity: 0.6, cursor: "not-allowed" } : {}),
  };

  return (
    <div
      style={wrap}
      className="ak-root"
      onDrop={onDrop}
      onDragOver={(e) => dragId && e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <style>{responsiveCSS}</style>

      {/* Back */}
      <div style={{ marginBottom: 16 }}>
        <button onClick={() => nav("/admin")} style={backBtn} className="ak-backbtn">
          <FiArrowLeft style={{ marginRight: 6 }} /> Nazad
        </button>
      </div>

      <div style={panel} className="ak-panel">
        {/* Add */}
        <form onSubmit={addCategory} style={topBar} className="ak-topbar">
          <div style={addBox}>
            <span style={addIcon}><FiPlus /></span>
            <input
              style={addInput}
              placeholder="Nova kategorija (npr. Masaže)"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); if (error) setError(""); }}
              aria-label="Unesite naziv nove kategorije"
              inputMode="text"
            />
          </div>
          <button style={addBtnStyle} type="submit" disabled={!newName.trim()} className="ak-addbtn">
            Dodaj
          </button>
        </form>

        {/* Search + Reorder toggle */}
        <div className="ak-searchrow" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center", marginTop: 10 }}>
          <div style={searchBox}>
            <span style={searchIcon}><FiSearch /></span>
            <input
              style={searchInput}
              placeholder="Pretraga kategorija (npr. Lice, Nokti…) "
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Pretraga kategorija"
              inputMode="search"
            />
          </div>
          <button
            type="button"
            onClick={() => { setReorderMode((v) => !v); setMobileSelectedId(null); }}
            style={{
              ...toggleBtn,
              background: reorderMode ? "linear-gradient(135deg,#ff5fa2,#ff7fb5)" : "#fff",
              color: reorderMode ? "#fff" : "#333",
              border: reorderMode ? "none" : "1px solid #ddd",
            }}
            className="ak-reorder-toggle"
          >
            <FiMove style={{ marginRight: 8 }} />
            {reorderMode ? "Ređaj: UKLJUČENO" : "Ređaj: isključeno"}
          </button>
        </div>

        {/* Hint */}
        {!filter.trim() ? (
          <div className="ak-reorder-hint" style={{ ...reorderHint, background: reorderMode ? "rgba(255,95,162,.12)" : reorderHint.background }}>
            {isMobile ? (
              <span>
                <FiMove style={{ marginRight: 6 }} />
                {reorderMode
                  ? "Ređanje (telefon): tap na prvu karticu da je selektuješ, zatim tap na drugu ispod koje želiš da bude."
                  : "Za premeštanje na telefonu uključi 'Ređaj', pa tap-tap princip."}
                {mobileSelectedId && (
                  <button onClick={() => setMobileSelectedId(null)} className="ak-cancel" style={cancelBtn}>
                    <FiX style={{ marginRight: 6 }} /> Otkaži selekciju
                  </button>
                )}
              </span>
            ) : (
              <span><FiMove style={{ marginRight: 6 }} /> Na računaru: prevuci (drag & drop) da promeniš redosled.</span>
            )}
          </div>
        ) : (
          <div className="ak-reorder-hint" style={{ ...reorderHint, opacity: 0.8 }}>
            Filtrirano – premeštanje redosleda je onemogućeno dok je pretraga aktivna.
          </div>
        )}

        {error && <div className="ak-error">{error}</div>}

        {/* Grid */}
        {loading ? (
          <div style={{ color: "#fff", textAlign: "center" }}>Učitavanje…</div>
        ) : (
          <div style={grid} className="ak-grid">
            {/* Discount tile */}
        {/* Discount tile */}
{filteredWithDiscounts.length && filteredWithDiscounts[0]?.id === "discounts" ? (
  <CategoryTile
    key="discounts"
    cat={{ id: "discounts", name: discountTitle }}
    count={discountedServices.length}
    isEditing={editingId === "discounts"}
    editingName={editingName}
    setEditingId={setEditingId}
    setEditingName={setEditingName}
    renameCategory={renameCategory}
    removeCategory={removeCategory}
    onPress={() => {
      // Ako je Ređaj uključen na telefonu i nema filtera → "progutaj" tap (ne ulazi)
      if (isTouchDevice() && reorderMode && !filter.trim()) return;
      // Inače normalno uđi u karticu
      nav("/admin/katalog/discounts");
    }}
    isDiscounts
    selectedMobile={false}
  />
) : null}

         

            {renderCats.map((cat) => {
              const isEditing = editingId === cat.id;
              const count = countByCat.get(cat.id) || 0;
              const selectedMobile = mobileSelectedId === cat.id;

              return (
                <CategoryTile
                  key={cat.id}
                  cat={cat}
                  count={count}
                  isEditing={isEditing}
                  editingName={editingName}
                  setEditingId={setEditingId}
                  setEditingName={setEditingName}
                  renameCategory={renameCategory}
                  removeCategory={removeCategory}
                  isDiscounts={false}
                  selectedMobile={selectedMobile}
                  onPress={async () => {
                    // ako smo na telefonu i u ređaj modu → tap-tap logika
                    if (await handleMobileTap(cat.id, false)) return;
                    // inače normalna navigacija
                    nav(`/admin/katalog/${cat.id}`);
                  }}
                  // Desktop drag (dozvoljen samo kad nema filtera i nismo na telefonu)
                  draggable={!isTouchDevice() && reorderMode && !filter.trim()}
                  onDragStart={(e) => onDragStart(e, cat.id)}
                  onDragOver={(e) => onDragOver(e, cat.id)}
                />
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

function CategoryTile({
  cat,
  count,
  isEditing,
  editingName,
  setEditingId,
  setEditingName,
  renameCategory,
  removeCategory,
  onPress,
  isDiscounts = false,
  draggable = false,
  onDragStart,
  onDragOver,
  selectedMobile = false,
}) {
  const displayName = isDiscounts ? (cat.name || "Na popustu") : (cat.name || "");

  return (
    <div
      ref={(el) => (el && (/** store ref only if needed **/ el.dataset && (el.dataset.id = cat.id)))}
      data-id={cat.id}
      style={tile}
      className="ak-tile"
      draggable={draggable && !isDiscounts}
      onDragStart={draggable && !isDiscounts ? (e) => onDragStart?.(e) : undefined}
      onDragOver={draggable && !isDiscounts ? (e) => onDragOver?.(e) : undefined}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div
        style={{
          ...marble,
          background: isDiscounts ? "url('/slika3.webp') center/cover no-repeat" : marble.background,
          filter: selectedMobile ? "hue-rotate(-20deg) saturate(1.2)" : undefined,
        }}
        className="ak-marble"
      />
      {!isEditing && (
        <div style={tileActions} className="ak-actions">
          {/* Edit DOZVOLJEN i za isDiscounts */}
          <button
            style={tileActionBtn}
            title="Preimenuj"
            onClick={(e) => { e.stopPropagation(); setEditingId(cat.id); setEditingName(displayName || ""); }}
            className="ak-actionbtn"
          >
            <FiEdit />
          </button>

          {/* Brisanje i dalje ZABRANJENO za isDiscounts */}
          {!isDiscounts && (
            <button
              style={{ ...tileActionBtn, background: "#ffe1e1", color: "#7a1b1b" }}
              title="Obriši"
              onClick={(e) => { e.stopPropagation(); removeCategory(cat.id); }}
              className="ak-actionbtn"
            >
              <FiTrash2 />
            </button>
          )}
        </div>
      )}

      {!isEditing ? (
        <button
          style={{
            ...tileButton,
            border: selectedMobile ? "2px solid #ff5fa2" : "none",
            boxShadow: selectedMobile ? "0 0 0 4px rgba(255,95,162,.15) inset" : tileButton.boxShadow,
          }}
          onClick={(e) => { e.preventDefault(); onPress?.(); }}
          className="ak-tilebtn"
          onContextMenu={(e) => e.preventDefault()}
        >
          <div style={tileName} className="ak-tilename">{displayName}</div>
          <div style={badge} className="ak-badge">{count} usl.</div>
        </button>
      ) : (
        <div style={editRow} className="ak-editrow" onClick={(e) => e.stopPropagation()}>
          <input
            style={editInput}
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") renameCategory(cat.id, editingName);
              if (e.key === "Escape") { setEditingId(null); setEditingName(""); }
            }}
            autoFocus
          />
          <div className="ak-editbtns" style={editBtns}>
            <button
              style={{ ...tileActionBtn, background: "#efefef" }}
              title="Otkaži"
              onClick={() => { setEditingId(null); setEditingName(""); }}
              className="ak-actionbtn"
            >
              <FiX />
            </button>
            <button
              style={{ ...tileActionBtn, background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", color: "#fff" }}
              title="Sačuvaj"
              onClick={() => renameCategory(cat.id, editingName)}
              className="ak-actionbtn"
            >
              <FiCheck />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ===== STYLES ===== */
const wrap = {
  minHeight: "100vh",
  background: ["url('/slika1.webp') center/cover no-repeat fixed", "linear-gradient(135deg,#f0f0f0,#d9d9d9)"].join(", "),
  padding: "clamp(12px,4vw,24px)",
  display: "flex",
  flexDirection: "column",
  justifyContent: "flex-start",
  alignItems: "center",
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

const backBtn = {
  display: "inline-flex",
  alignItems: "center",
  padding: "10px 16px",
  borderRadius: 12,
  border: "none",
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)",
  color: "#fff",
  fontWeight: 700,
  fontSize: 16,
  cursor: "pointer",
  boxShadow: "0 6px 14px rgba(0,0,0,.18)",
};

const topBar = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 10,
  maxWidth: 980,
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
  fontSize: 16,
  boxShadow: "0 6px 14px rgba(0,0,0,.06)",
  WebkitTapHighlightColor: "transparent",
  WebkitUserSelect: "auto",
  userSelect: "auto",
};
const addIcon = { position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", opacity: 0.7, fontSize: 16 };
const addBtn = {
  width: 180, height: 44, border: "none", borderRadius: 12,
  background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", color: "#fff", fontWeight: 800, cursor: "pointer", padding: "0 14px",
  boxShadow: "0 8px 18px rgba(255,127,181,.3)", WebkitTapHighlightColor: "transparent",
};

const searchBox = { position: "relative", width: "100%", maxWidth: 980, margin: "10px auto 0" };
const searchInput = {
  width: "100%", height: 44, padding: "0 12px 0 36px", borderRadius: 12, border: "1px solid #ececec",
  background: "#fff", fontSize: 16, boxShadow: "0 6px 14px rgba(0,0,0,.06)", WebkitTapHighlightColor: "transparent",
  WebkitUserSelect: "auto", userSelect: "auto",
};
const searchIcon = { position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", opacity: 0.6, fontSize: 16 };

const toggleBtn = {
  height: 44,
  padding: "0 14px",
  borderRadius: 12,
  border: "1px solid #ddd",
  background: "#fff",
  fontWeight: 800,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  WebkitTapHighlightColor: "transparent",
};

const reorderHint = {
  maxWidth: 980,
  margin: "10px auto 0",
  padding: "10px 12px",
  borderRadius: 10,
  background: "rgba(255,255,255,.75)",
  border: "1px solid #eee",
  fontWeight: 600,
  color: "#333",
  display: "flex",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
};

const cancelBtn = {
  marginLeft: 10,
  display: "inline-flex",
  alignItems: "center",
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#fff",
  cursor: "pointer",
  fontWeight: 700,
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
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
  touchAction: "pan-y",
};

const marble = {
  position: "absolute",
  inset: 0,
  background: "url('/slika6.webp') center/cover no-repeat",
  opacity: 0.98,
};

const tileActions = {
  position: "absolute",
  top: 8,
  right: 8,
  display: "flex",
  gap: 6,
  zIndex: 2,
};

const tileActionBtn = {
  height: 38,
  width: 38,
  borderRadius: 10,
  border: "none",
  background: "#efefef",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  WebkitTapHighlightColor: "transparent",
  WebkitUserSelect: "none",
  userSelect: "none",
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
  WebkitTapHighlightColor: "transparent",
  WebkitUserSelect: "none",
  userSelect: "none",
};

const tileName = {
  fontWeight: 800,
  fontSize: 20,
  textAlign: "center",
  color: "#2d2d2d",
  textShadow: "0 1px 0 rgba(255,255,255,.8)",
  WebkitUserSelect: "none",
  userSelect: "none",
};

const badge = {
  position: "absolute",
  right: 10,
  bottom: 10,
  background: "rgba(255,255,255,.92)",
  border: "1px solid #eee",
  borderRadius: 999,
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 700,
  color: "#444",
  WebkitUserSelect: "none",
  userSelect: "none",
};

const editRow = {
  position: "relative",
  zIndex: 1,
  background: "rgba(255,255,255,.96)",
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: 8,
  padding: 12,
  alignItems: "center",
};

const editInput = {
  width: "100%",
  height: 42,
  borderRadius: 12,
  border: "1px solid #ddd",
  padding: "0 10px",
  fontSize: 16,
};

const editBtns = { display: "flex", gap: 8 };

/* ===== RESPONSIVE + FONT CSS ===== */
const responsiveCSS = `
.ak-root, .ak-root * { font-family: 'Poppins', system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; }

/* Error stil */
.ak-error{ color:#ff5fa2; margin:8px auto 0; max-width:820px; text-align:center; font-weight:700; }

/* Tablet */
@media (max-width: 900px) {
  .ak-panel { padding: 16px; border-radius: 18px; }
  .ak-topbar { grid-template-columns: 1fr; }
  .ak-addbtn { width: 100%; }
  .ak-grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
}

/* Telefon */
@media (max-width: 600px) {
  .ak-topbar { gap: 8px; margin-top: 8px; }
  .ak-searchrow { margin-top: 6px; }
  .ak-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .ak-tilebtn { height: 108px; }
  .ak-tilename { font-size: 18px !important; }
  .ak-actions { gap: 6px; }
  .ak-badge { font-size: 11px; padding: 3px 8px; right: 8px; bottom: 8px; }
  .ak-editrow { grid-template-columns: 1fr; }
  .ak-editrow .ak-editbtns { margin-top: 8px; width: 100%; display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .ak-editrow .ak-actionbtn { width: 100%; }
}

/* Bez plavog tap highlight-a */
.ak-root button,
.ak-root input,
.ak-root .ak-tilebtn,
.ak-root .ak-actionbtn { -webkit-tap-highlight-color: transparent; }

/* Bez text-selection i touch callout-a na pločicama */
.ak-tile, .ak-tile * { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
/* Dozvoli selekciju u input poljima */
.ak-root input, .ak-root textarea { -webkit-user-select: auto; user-select: auto; }
/* Prioritet vertikalnog skrola */
.ak-tile { touch-action: pan-y; }
`;
