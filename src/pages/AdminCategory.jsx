
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

  // Reorder state
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);

  // Mobile long-press drag
  const [isTouchDrag, setIsTouchDrag] = useState(false);
  const [isLongPress, setIsLongPress] = useState(false);
  const [holdTimer, setHoldTimer] = useState(null);
  const touchRef = useRef({ startY: 0, activeId: null });

  const finalPrice = useMemo(() => {
    const p = Number(price) || 0;
    const d = Number(discount) || 0;
    return Math.max(0, Math.round(p * (1 - d / 100)));
  }, [price, discount]);

  // Debounce utility for smoother touch movements
  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };
  const debouncedSetOverId = debounce(setOverId, 50);

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

  // Global touch event listeners for long-press drag
  useEffect(() => {
    if (!isLongPress) return;

    const handleMove = (e) => {
      e.preventDefault();
      onTouchMove(e);
    };
    const handleEnd = () => onTouchEnd();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleEnd);
    window.addEventListener("touchcancel", handleEnd);

    return () => {
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
      window.removeEventListener("touchcancel", handleEnd);
      document.body.style.overflow = prevOverflow;
    };
  }, [isLongPress]);

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

  /* ==================== Reorder helpers ==================== */
  const canReorder = catId !== "discounts";
  const idsFromList = (list) => list.map((x) => x.id);
  const moveId = (listIds, fromId, toId) => {
    if (fromId === toId || !fromId || !toId) return listIds;
    const arr = listIds.slice();
    const fromIdx = arr.indexOf(fromId);
    const toIdx = arr.indexOf(toId);
    if (fromIdx < 0 || toIdx < 0) return arr;
    const [item] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, item);
    return arr;
  };
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

  // Desktop DnD
  function onDragStart(e, id) {
    if (!canReorder) return e.preventDefault();
    setDragId(id);
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e, id) {
    if (!canReorder) return;
    e.preventDefault();
    if (id !== overId) setOverId(id);
  }
  async function onDrop(e, id) {
    if (!canReorder) return;
    e.preventDefault();
    const visibleIds = idsFromList(services);
    const newIds = moveId(visibleIds, dragId, id);
    setDragId(null);
    setOverId(null);
    if (!dragId) return;
    applyLocalOrder(newIds);
    await persistOrder(newIds);
  }
  function onDragEnd() {
    setDragId(null);
    setOverId(null);
  }

  // Mobile long-press DnD
  function onTouchStart(e, id) {
    if (!canReorder) return;

    e.preventDefault();
    touchRef.current.startY = e.touches[0].clientY;
    touchRef.current.activeId = id;
    setDragId(id);

    if (navigator.vibrate) {
      navigator.vibrate(50);
    }

    const t = setTimeout(() => {
      setIsLongPress(true);
      setIsTouchDrag(true);
      if (navigator.vibrate) {
        navigator.vibrate(100);
      }
    }, 200);
    setHoldTimer(t);
  }

  function rowCenterY(el) {
    const rect = el.getBoundingClientRect();
    return rect.top + rect.height / 2;
  }
  function allRowEls() {
    return Array.from(document.querySelectorAll(".srv-row"));
  }
  function idFromRowEl(el) {
    return el?.getAttribute("data-id");
  }
  function nearestIdByY(y) {
    let best = null;
    let bestDist = Infinity;
    const rows = allRowEls();
    console.log("Rows found:", rows.length); // Debug: Check if all rows are detected
    for (const el of rows) {
      const id = idFromRowEl(el);
      if (!id) continue;
      const cy = rowCenterY(el);
      const d = Math.abs(cy - y);
      console.log(`Row ${id}: centerY=${cy}, touchY=${y}, distance=${d}`); // Debug
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    console.log("Nearest ID:", best); // Debug
    return best;
  }

  function onTouchMove(e) {
    if (!dragId || !canReorder) return;

    const y = e.touches[0].clientY;
    console.log("Touch move: y=", y); // Debug

    // Auto-scroll
    const scrollContainer = document.querySelector(".admincat-row").parentElement || document.body;
    const scrollThreshold = 100;
    const scrollSpeed = 10;
    if (y < scrollThreshold && scrollContainer.scrollTop > 0) {
      scrollContainer.scrollBy({ top: -scrollSpeed, behavior: "smooth" });
    } else if (y > window.innerHeight - scrollThreshold) {
      scrollContainer.scrollBy({ top: scrollSpeed, behavior: "smooth" });
    }

    if (!isLongPress) {
      if (Math.abs(y - touchRef.current.startY) > 12) {
        if (holdTimer) clearTimeout(holdTimer);
        setHoldTimer(null);
        setDragId(null);
        setOverId(null);
        setIsTouchDrag(false);
      }
      return;
    }

    e.preventDefault();
    const nearest = nearestIdByY(y);
    if (nearest && nearest !== overId) {
      debouncedSetOverId(nearest);
      console.log("Over ID updated:", nearest); // Debug
    }
  }

  async function onTouchEnd() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      setHoldTimer(null);
    }

    if (!isLongPress) {
      setIsTouchDrag(false);
      setDragId(null);
      setOverId(null);
      return;
    }

    setIsLongPress(false);
    setIsTouchDrag(false);

    if (!dragId || !overId) {
      setDragId(null);
      setOverId(null);
      document.body.style.overflow = "";
      console.log("Drag cancelled: no dragId or overId"); // Debug
      return;
    }

    const visibleIds = idsFromList(services);
    const newIds = moveId(visibleIds, dragId, overId);
    console.log("New order:", newIds); // Debug
    const moved = dragId;
    setDragId(null);
    setOverId(null);
    document.body.style.overflow = "";

    if (moved) {
      applyLocalOrder(newIds);
      await persistOrder(newIds);
    }
  }

  return (
    <div style={wrap} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div style={panel}>
        <style>{css}</style>

        {/* GORNJI BLOK */}
        <div className="admincat-top">
          <div className="admincat-topbar" style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
            <button className="btn-ghost" style={ghostBtn} onClick={() => nav("/admin/katalog")}>← Nazad</button>
            <h2 className="admincat-title" style={title}>{catName || "Kategorija"}</h2>
          </div>

          {/* EDIT NAZIVA */}
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

        {/* FORMA ZA USLUGU */}
        <form onSubmit={saveService} style={formBase} className="admincat-form">
          <input
            style={inp}
            placeholder="Naziv usluge"
            value={name}
            onChange={e => setName(e.target.value)}
          />
          <input
            style={inp}
            type="number" min="0"
            placeholder="Trajanje (min)"
            value={durationMin}
            onChange={e => setDurationMin(e.target.value)}
          />
          <input
            style={inp}
            type="number" min="0"
            placeholder="Cena (RSD)"
            value={price}
            onChange={e => setPrice(e.target.value)}
          />
          <input
            style={inp}
            type="number" min="0" max="90"
            placeholder="Popust % (opciono)"
            value={discount}
            onChange={e => setDiscount(e.target.value)}
          />
          <div className="price-preview">Nova cena: {isNaN(finalPrice) ? 0 : finalPrice} RSD</div>
          <button className="btn-primary" style={btn} type="submit" disabled={saving}>
            {saving ? "Čuvam..." : editing ? "Sačuvaj uslugu" : "Dodaj uslugu"}
          </button>
          {editing && (
            <button className="btn-ghost" style={ghostBtn} type="button" onClick={resetForm}>
              Otkaži
            </button>
          )}
        </form>

        <div style={list}>
          {services.map(s => {
            const isEditing = editing === s.id;
            const currentPrice = isEditing ? Number(price) || 0 : s.basePrice;
            const currentDiscount = isEditing ? Number(discount) || 0 : s.discountPercent || 0;
            const currentFinal = isEditing
              ? Math.max(0, Math.round((Number(price) || 0) * (1 - (Number(discount) || 0) / 100)))
              : s.finalPrice;

            return (
              <div
                key={s.id}
                data-id={s.id}
                onContextMenu={(e) => e.preventDefault()}
                style={{
                  ...row,
                  cursor: canReorder ? "grab" : "default",
                  touchAction: "none",
                  userSelect: "none",
                  WebkitUserSelect: "none",
                  WebkitTouchCallout: "none",
                  ...(dragId === s.id && isLongPress
                    ? {
                        transform: "scale(1.1) translateY(2px)",
                        boxShadow: "0 12px 24px rgba(0,0,0,.4)",
                        zIndex: 999,
                        opacity: 0.9,
                        border: "2px solid #ff5fa2",
                      }
                    : {}),
                  ...(overId === s.id && dragId !== s.id
                    ? {
                        border: "2px dashed #ff5fa2",
                        background: "rgba(255, 95, 162, 0.1)",
                      }
                    : {}),
                }}
                className={`admincat-row srv-row ${overId === s.id && dragId !== s.id ? "drop-target" : ""}`}
                draggable={canReorder}
                onDragStart={(e) => onDragStart(e, s.id)}
                onDragOver={(e) => onDragOver(e, s.id)}
                onDrop={(e) => onDrop(e, s.id)}
                onDragEnd={onDragEnd}
                onTouchStart={(e) => onTouchStart(e, s.id)}
              >
                <div style={{ userSelect: "none", WebkitUserSelect: "none" }}>
                  <div style={{ fontWeight: 900 }}>{isEditing ? (name || s.name) : s.name}</div>
                  <div style={{ opacity: .8, fontSize: 13 }}>
                    {(isEditing ? Number(durationMin) || 0 : s.durationMin) || 0} min · {currentPrice || 0} RSD{" "}
                    {currentDiscount ? `· popust ${currentDiscount}% → ${currentFinal || 0} RSD` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, pointerEvents: dragId === s.id && isLongPress ? "none" : "auto" }}>
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
const list = { display: "grid", gap: 10, maxHeight: "60vh", overflowY: "auto" };
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
  transition: "transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease",
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
  .srv-row, .srv-row * {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .srv-row.drop-target::before {
    content: "";
    display: block;
    height: 3px;
    background: #ff5fa2;
    position: absolute;
    top: -3px;
    left: 0;
    right: 0;
    opacity: 0.8;
  }
  .srv-row {
    position: relative;
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