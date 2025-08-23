// src/pages/AdminCategory.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { db } from "../firebase";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, onSnapshot, addDoc,
  serverTimestamp, orderBy, writeBatch
} from "firebase/firestore";

export default function AdminCategory() {
  const { categoryId } = useParams();
  const catId = categoryId;
  const nav = useNavigate();

  const [catName, setCatName] = useState("");
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState([]);

  const [editing, setEditing] = useState(null);
  const [name, setName] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [saving, setSaving] = useState(false);

  // Reorder state (shared)
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  // Mobile: tap-to-move
  const [isMobile, setIsMobile] = useState(false);
  const [selectedId, setSelectedId] = useState(null); // prvi tap (koji se premešta)

  // Auto-scroll target (za stare delove koji ga koriste)
  const listRef = useRef(null);

  const finalPrice = useMemo(() => {
    const p = Number(price) || 0;
    const d = Number(discount) || 0;
    return Math.max(0, Math.round(p * (1 - d / 100)));
  }, [price, discount]);

  // Debounce utility
  const debounce = (fn, ms) => {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
  const debouncedSetOverId = useMemo(() => debounce(setOverId, 50), []);

  // Detect mobile (touch) – ovde uslovljavamo "tap → tap" režim
  useEffect(() => {
    const touch = typeof window !== "undefined" && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
    setIsMobile(!!touch);
  }, []);

  // Učitavanje
  useEffect(() => {
    if (!catId) return;

    let off = () => {};
    if (catId === "discounts") {
      (async () => {
        try {
          const snap = await getDoc(doc(db, "meta", "discounts"));
          const t = snap.exists() ? (snap.data().title || "Na popustu") : "Na popustu";
          setCatName(t);
        } catch {
          setCatName("Na popustu");
        }
        setLoading(false);
      })();

      off = onSnapshot(
        query(
          collection(db, "services"),
          where("discountPercent", ">", 0),
          orderBy("discountPercent", "asc"),
          orderBy("name", "asc")
        ),
        (s) => setServices(s.docs.map((d) => ({ id: d.id, ...d.data() })))
      );
    } else {
      (async () => {
        const snap = await getDoc(doc(db, "categories", catId));
        if (snap.exists()) setCatName(snap.data().name || "");
        setLoading(false);

        off = onSnapshot(
          query(
            collection(db, "services"),
            where("categoryId", "==", catId),
            orderBy("order", "asc")
          ),
          (s) => setServices(s.docs.map((d) => ({ id: d.id, ...d.data() })))
        );
      })();
    }

    return () => off();
  }, [catId]);

  // Helpers
  const canReorder = catId !== "discounts";
  const idsFromList = (list) => list.map((x) => x.id);

  // Pomera element "sa" fromIndex na "pre" toIndex;
  // ako želimo "posle targeta", koristićemo toIndex+1, a ova funkcija sama koriguje offset.
  function moveToIndex(listIds, fromIndex, toIndex) {
    if (fromIndex == null || toIndex == null) return listIds;
    const arr = listIds.slice();
    const [item] = arr.splice(fromIndex, 1);
    const adj = fromIndex < toIndex ? toIndex - 1 : toIndex;
    arr.splice(adj, 0, item);
    return arr;
  }

  async function persistOrder(newOrderIds) {
    if (!canReorder) return;
    const batch = writeBatch(db);
    let pos = 1;
    for (const id of newOrderIds) {
      batch.update(doc(db, "services", id), { order: pos++, updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }
  function applyLocalOrder(newIds) {
    setServices((prev) => {
      const byId = new Map(prev.map((x) => [x.id, x]));
      return newIds.map((id, idx) => ({ ...(byId.get(id) || {}), id, order: idx + 1 }));
    });
  }

  // Desktop DnD (ostaje isto)
  function onDragStart(e, id) {
    if (!canReorder) return e.preventDefault();
    if (isMobile) return; // na telefonu koristimo tap→tap
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e, id) {
    if (!canReorder || isMobile) return;
    e.preventDefault();
    if (id !== overId) setOverId(id);
  }
  async function onDrop(e, id) {
    if (!canReorder || isMobile) return;
    e.preventDefault();
    const visibleIds = idsFromList(services);
    const newIds = (function () {
      const fromId = dragId;
      const toId = id;
      if (!fromId || !toId) return visibleIds;
      const fromIdx = visibleIds.indexOf(fromId);
      const toIdx = visibleIds.indexOf(toId);
      if (fromIdx < 0 || toIdx < 0) return visibleIds;
      // Desktop ponašanje: ubaci NA poziciju targeta (kao ranije)
      return moveToIndex(visibleIds, fromIdx, toIdx);
    })();
    setDragId(null);
    setOverId(null);
    applyLocalOrder(newIds);
    await persistOrder(newIds);
  }
  function onDragEnd() {
    if (isMobile) return;
    setDragId(null);
    setOverId(null);
  }

  // MOBILE: tap → tap
  function onMobileRowTap(targetId) {
    if (!canReorder || !isMobile) return;

    // Ako ništa nije izabrano → izaberi polazni red
    if (!selectedId) {
      setSelectedId(targetId);
      return;
    }

    // Ako tapnemo opet na već izabrani → poništi izbor
    if (selectedId === targetId) {
      setSelectedId(null);
      return;
    }

    // Drugi tap: "ubaci posle targeta"
    const ids = idsFromList(services);
    const fromIdx = ids.indexOf(selectedId);
    const targetIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || targetIdx === -1) {
      setSelectedId(null);
      return;
    }

    const insertIndex = targetIdx + 1; // želimo POSLE targeta
    const newIds = moveToIndex(ids, fromIdx, insertIndex);

    // Odmah prikaži lokalno i sačuvaj u bazi
    applyLocalOrder(newIds);
    persistOrder(newIds).catch(console.error);

    // Poništi selekciju
    setSelectedId(null);
  }

  // Form helpers
  const resetForm = () => {
    setEditing(null);
    setName("");
    setDurationMin("");
    setPrice("");
    setDiscount("");
  };

  const saveCategoryName = async () => {
    const n = catName.trim();
    if (!n) return;

    if (catId === "discounts") {
      try {
        await updateDoc(doc(db, "meta", "discounts"), { title: n, updatedAt: serverTimestamp() });
      } catch {
        await setDoc(doc(db, "meta", "discounts"), { title: n, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      }
    } else {
      await updateDoc(doc(db, "categories", catId), { name: n, updatedAt: serverTimestamp() });
    }
    alert("Naziv kategorije sačuvan.");
  };

  const deleteCategory = async () => {
    if (catId === "discounts") return;
    if (services.length) {
      if (!confirm(`Kategorija ima ${services.length} usluga. Obrisaćeš SAMO kategoriju (usluge ostaju). Nastavi?`)) return;
    } else {
      if (!confirm("Obrisati kategoriju?")) return;
    }
    await deleteDoc(doc(db, "categories", catId));
    nav("/admin/katalog");
  };

  const startEdit = (srv) => {
    setEditing(srv.id);
    setName(srv.name || "");
    setDurationMin(String(srv.durationMin || ""));
    setPrice(String(srv.basePrice || ""));
    setDiscount(String(srv.discountPercent ?? srv.discount ?? ""));
  };

  const upsertLocalService = (id, payload) => {
    setServices((prev) => {
      const idx = prev.findIndex((x) => x.id === id);
      const nextObj = { ...(prev[idx] || {}), id, ...payload };
      if (idx >= 0) {
        const copy = prev.slice();
        copy[idx] = nextObj;
        return copy;
      }
      return [...prev, nextObj];
    });
  };
  const removeLocalService = (id) => {
    setServices((prev) => prev.filter((x) => x.id !== id));
  };

  const saveService = async (e) => {
    e?.preventDefault?.();
    if (saving) return;

    const prevObj = editing ? services.find((s) => s.id === editing) : null;
    const resolvedCategoryId = editing
      ? (prevObj?.categoryId ?? (catId === "discounts" ? "" : catId))
      : (catId === "discounts" ? "" : catId);

    const payload = {
      categoryId: resolvedCategoryId,
      name: name.trim(),
      durationMin: Number(durationMin) || 0,
      basePrice: Number(price) || 0,
      discountPercent: Number(discount) || 0,
      finalPrice,
      updatedAt: serverTimestamp(),
    };
    if (!payload.name) return;

    setSaving(true);
    try {
      if (editing) {
        upsertLocalService(editing, { ...payload, updatedAt: new Date() });
        await updateDoc(doc(db, "services", editing), payload);
        if (catId === "discounts" && payload.discountPercent <= 0) {
          removeLocalService(editing);
        }
      } else {
        const orderVal = (services?.length || 0) + 1;
        const docRef = await addDoc(collection(db, "services"), {
          ...payload,
          order: orderVal,
          createdAt: serverTimestamp(),
        });
        upsertLocalService(docRef.id, {
          ...payload,
          order: orderVal,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        if (catId === "discounts" && payload.discountPercent <= 0) {
          removeLocalService(docRef.id);
        }
      }
      resetForm();
    } catch (err) {
      console.error(err);
      alert("Greška pri čuvanju usluge.");
    } finally {
      setSaving(false);
    }
  };

  const removeService = async (id) => {
    if (!confirm("Obrisati uslugu?")) return;
    removeLocalService(id);
    try {
      await deleteDoc(doc(db, "services", id));
      if (editing === id) resetForm();
    } catch (e) {
      console.error(e);
      alert("Greška pri brisanju. Osveži stranicu.");
    }
  };

  return (
    <div style={wrap}>
      <div style={panel}>
        <style>{css}</style>

        {/* GORE */}
        <div className="admincat-top">
          <div className="admincat-topbar" style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <button className="btn-ghost" style={ghostBtn} onClick={() => nav("/admin/katalog")}>← Nazad</button>
            <h2 className="admincat-title" style={title}>{catName || "Kategorija"}</h2>
          </div>

          <div className="admincat-catrow" style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, marginBottom: 14 }}>
            <input
              style={inp}
              value={catName}
              onChange={e => setCatName(e.target.value)}
              placeholder="Naziv kategorije"
            />
            <button className="btn-primary" style={btn} onClick={saveCategoryName}>Sačuvaj naziv</button>
            {catId !== "discounts" && (
              <button className="btn-danger" style={dangerBtn} onClick={deleteCategory}>Obriši kategoriju</button>
            )}
          </div>
        </div>

        {/* FORMA */}
        <form onSubmit={saveService} style={formBase} className="admincat-form">
          <input style={inp} placeholder="Naziv usluge" value={name} onChange={e => setName(e.target.value)} />
          <input style={inp} type="number" min="0" placeholder="Trajanje (min)" value={durationMin} onChange={e => setDurationMin(e.target.value)} />
          <input style={inp} type="number" min="0" placeholder="Cena (RSD)" value={price} onChange={e => setPrice(e.target.value)} />
          <input style={inp} type="number" min="0" max="90" placeholder="Popust % (opciono)" value={discount} onChange={e => setDiscount(e.target.value)} />
          <div className="price-preview">Nova cena: {isNaN(finalPrice) ? 0 : finalPrice} RSD</div>
          <button className="btn-primary" style={btn} type="submit" disabled={saving}>
            {saving ? "Čuvam..." : editing ? "Sačuvaj uslugu" : "Dodaj uslugu"}
          </button>
          {editing && <button className="btn-ghost" style={ghostBtn} type="button" onClick={resetForm}>Otkaži</button>}
        </form>

        {/* LISTA */}
        <div ref={listRef} className="admincat-list" style={list}>
          {services.map((s) => {
            const isEditing = editing === s.id;
            const currentPrice = isEditing ? Number(price) || 0 : s.basePrice;
            const currentDiscount = isEditing ? Number(discount) || 0 : s.discountPercent || 0;
            const currentFinal = isEditing
              ? Math.max(0, Math.round((Number(price) || 0) * (1 - (Number(discount) || 0) / 100)))
              : s.finalPrice;

            const isSelected = isMobile && selectedId === s.id;

            return (
              <div
                key={s.id}
                data-id={s.id}
                className="admincat-row srv-row"
                style={{
                  ...row,
                  cursor: canReorder ? (isMobile ? "pointer" : "grab") : "default",
                  border: isSelected ? "2px solid #ff5fa2" : row.border,
                  background: isSelected ? "rgba(255,95,162,0.08)" : row.background,
                  transform: isSelected ? "scale(1.01)" : "none",
                }}
                draggable={canReorder && !isMobile}
                onDragStart={(e) => onDragStart(e, s.id)}
                onDragOver={(e) => onDragOver(e, s.id)}
                onDrop={(e) => onDrop(e, s.id)}
                onDragEnd={onDragEnd}
                onClick={() => isMobile && onMobileRowTap(s.id)}
              >
                <div style={{ userSelect: "none", WebkitUserSelect: "none" }}>
                  <div style={{ fontWeight: 900 }}>{isEditing ? (name || s.name) : s.name}</div>
                  <div style={{ opacity: .8, fontSize: 13 }}>
                    {(isEditing ? Number(durationMin) || 0 : s.durationMin) || 0} min · {currentPrice || 0} RSD{" "}
                    {currentDiscount ? `· popust ${currentDiscount}% → ${currentFinal || 0} RSD` : ""}
                  </div>
                </div>

                <div
                  style={{ display: "flex", gap: 8 }}
                  onClick={(e) => e.stopPropagation()} // da tap na dugmad ne okida selekciju
                >
                  <button className="btn-primary" style={smBtn} onClick={() => startEdit(s)}>Izmeni</button>
                  <button className="btn-danger" style={smDel} onClick={() => removeService(s.id)}>Obriši</button>
                </div>
              </div>
            );
          })}

          {!services.length && !loading && <div style={{ color: "#fff" }}>Nema usluga.</div>}
        </div>
      </div>
    </div>
  );
}

/* === styles === */
const wrap = { minHeight: "100vh", background: 'url("/slika1.webp") center/cover no-repeat fixed', padding: 24, display: "flex", justifyContent: "center", alignItems: "flex-start" };
const panel = { width: "min(1250px,100%)", background: "rgba(255,255,255,.14)", border: "1px solid rgba(255,255,255,.35)", backdropFilter: "blur(10px)", borderRadius: 28, boxShadow: "0 24px 60px rgba(0,0,0,.25)", padding: "clamp(18px,4vw,28px)" };
const title = { margin: 0, color: "#fff", fontWeight: 900, fontSize: "clamp(18px,3vw,28px)" };
const inp = {
  height: 42,
  borderRadius: 12,
  border: "1px solid #ececec",
  padding: "0 12px",
  background: "#fff",
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
};
const btn = { height: 42, border: "none", borderRadius: 12, background: "linear-gradient(135deg,#ff5fa2,#ff7fb5)", color: "#fff", fontWeight: 800, padding: "0 16px", cursor: "pointer" };
const ghostBtn = { height: 42, borderRadius: 12, border: "1px solid rgba(255,255,255,.7)", background: "transparent", color: "#fff", fontWeight: 800, padding: "0 14px", cursor: "pointer" };
const dangerBtn = { ...btn, background: "#ff5b6e" };
const formBase = {
  display: "grid",
  gap: 8,
  marginBottom: 14,
  alignItems: "center",
};
const list = { display: "grid", gap: 10, maxHeight: "60vh", overflowY: "auto", paddingBottom: 2 };
const row = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  background: "#fff",
  borderRadius: 14,
  padding: "10px 12px",
  boxShadow: "0 10px 20px rgba(0,0,0,.06)",
  flexWrap: "wrap",
  gap: 8,
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
  transition: "transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease, border 0.1s ease",
  position: "relative",
};
const smBtn = { height: 34, padding: "0 12px", border: "none", borderRadius: 10, background: "#696666ff", cursor: "pointer", fontWeight: 800, color: "#fff" };
const smDel = { ...smBtn, background: "#ffe1e1", color: "#7a1b1b" };

const css = `
  .admincat-top {
    border-radius: 20px;
    border: 1px solid rgba(255,255,255,.25);
    background: rgba(255,255,255,.10);
    backdrop-filter: blur(8px);
    padding: 12px;
    margin-bottom: 14px;
  }
  .admincat-form {
    grid-template-columns:
      minmax(220px, 2fr)
      minmax(120px, 1fr)
      minmax(120px, 1fr)
      minmax(120px, 1fr)
      minmax(160px, auto)
      minmax(150px, auto)
      minmax(120px, auto);
  }
  .admincat-form > * {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
  }
  .price-preview {
    align-self: center;
    color: #fff;
    font-weight: 800;
    padding: 0 6px;
  }
  @media (max-width: 1100px) {
    .admincat-form {
      grid-template-columns:
        minmax(200px, 1.6fr)
        repeat(3, minmax(120px, 1fr))
        minmax(160px, auto)
        minmax(150px, auto)
        minmax(120px, auto);
    }
  }
  @media (max-width: 900px) {
    .admincat-topbar {
      display: flex !important;
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
      margin-bottom: 12px !important;
    }
    .admincat-topbar .btn-ghost {
      width: 100%;
      height: 44px;
      border-radius: 12px;
      font-weight: 800;
    }
    .admincat-title {
      margin: 0;
      text-align: left;
      font-size: 22px;
      line-height: 1.2;
    }
    .admincat-catrow {
      display: grid !important;
      grid-template-columns: 1fr !important;
      gap: 8px;
      margin-bottom: 12px !important;
    }
    .admincat-catrow input {
      width: 100%;
      height: 44px;
      border-radius: 12px;
    }
    .admincat-catrow .btn-primary,
    .admincat-catrow .btn-danger {
      width: 100%;
      height: 44px;
      border-radius: 12px;
      font-weight: 800;
    }
    .admincat-form {
      grid-template-columns: 1fr !important;
    }
    .admincat-form input,
    .admincat-form button,
    .admincat-form .price-preview {
      width: 100%;
    }
    .admincat-form input {
      height: 44px;
      border-radius: 12px;
    }
    .admincat-form button {
      height: 44px;
      border-radius: 12px;
      font-weight: 800;
    }
    .admincat-row { flex-direction: column; align-items: flex-start; gap: 10px; }
    .admincat-row > div:last-child { display: flex; flex-direction: column; gap: 8px; width: 100%; }
    .admincat-row button { width: 100%; height: 42px; border-radius: 12px; font-weight: 800; }
  }
`;
