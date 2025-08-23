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

  // Reorder state (index-based za slobodno ubacivanje)
  const [dragId, setDragId] = useState(null);     // id koji vučemo
  const [dragIndex, setDragIndex] = useState(null); // originalni index
  const [overIndex, setOverIndex] = useState(null); // gde će da se ubaci (0..N)
  const [isLongPress, setIsLongPress] = useState(false);
  const [isTouchDrag, setIsTouchDrag] = useState(false);

  // za lebdeći (floating) klon
  const [dragY, setDragY] = useState(null);
  const [dragX, setDragX] = useState(null);
  const [dragW, setDragW] = useState(null);
  const [grabOffsetY, setGrabOffsetY] = useState(0);

  const holdTimerRef = useRef(null);
  const touchRef = useRef({ startX: 0, startY: 0, activeId: null });
  const listRef = useRef(null);
  const scrollRAF = useRef(null);

  const finalPrice = useMemo(() => {
    const p = Number(price) || 0;
    const d = Number(discount) || 0;
    return Math.max(0, Math.round(p * (1 - d / 100)));
  }, [price, discount]);

  // Debounce
  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };
  const debouncedSetOverIndex = useMemo(() => debounce(setOverIndex, 30), []);

  /* ==================== load ==================== */
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

  /* ==================== global touch dok traje drag ==================== */
  useEffect(() => {
    if (!isLongPress) return;

    const handleMove = (e) => {
      e.preventDefault(); // tokom draga blokiramo default da ne “beži”
      onTouchMove(e);
    };
    const handleEnd = () => onTouchEnd();

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleEnd, { passive: true });
    window.addEventListener("touchcancel", handleEnd, { passive: true });

    return () => {
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
      window.removeEventListener("touchcancel", handleEnd);
      document.body.style.overflow = prevOverflow;
    };
  }, [isLongPress]);

  /* ==================== helpers ==================== */
  const canReorder = catId !== "discounts";
  const idsFromList = (list) => list.map((x) => x.id);

  async function persistOrderIds(newOrderIds) {
    if (!canReorder) return;
    const batch = writeBatch(db);
    let pos = 1;
    for (const id of newOrderIds) {
      batch.update(doc(db, "services", id), { order: pos++, updatedAt: serverTimestamp() });
    }
    await batch.commit();
  }

  function applyLocalOrderByIds(newIds) {
    setServices((prev) => {
      const byId = new Map(prev.map((x) => [x.id, x]));
      return newIds.map((id, idx) => ({ ...(byId.get(id) || {}), id, order: idx + 1 }));
    });
  }

  function moveToIndex(listIds, fromIndex, toIndex) {
    // pomeri element sa fromIndex na toIndex (0..N), gde toIndex je pozicija pre koje se ubacuje
    if (fromIndex == null || toIndex == null) return listIds;
    const arr = listIds.slice();
    const [item] = arr.splice(fromIndex, 1);
    // ako je originalni bio pre odredišta i vukli smo nadole, pošto smo ga izbacili, toIndex se smanjuje za 1
    const adj = fromIndex < toIndex ? toIndex - 1 : toIndex;
    arr.splice(adj, 0, item);
    return arr;
  }

  /* ==================== auto-scroll ==================== */
  function startAutoScrollIfNeeded(clientY) {
    cancelAutoScroll();
    const container = listRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const threshold = 60;
    const speed = 12;

    function step() {
      const y = window._lastTouchY ?? clientY;
      const nearTop = y < rect.top + threshold;
      const nearBottom = y > rect.bottom - threshold;

      if (nearTop && container.scrollTop > 0) {
        container.scrollTop = Math.max(0, container.scrollTop - speed);
        scrollRAF.current = requestAnimationFrame(step);
      } else if (nearBottom && container.scrollTop < container.scrollHeight - container.clientHeight) {
        container.scrollTop = Math.min(
          container.scrollHeight - container.clientHeight,
          container.scrollTop + speed
        );
        scrollRAF.current = requestAnimationFrame(step);
      }
    }
    scrollRAF.current = requestAnimationFrame(step);
  }
  function cancelAutoScroll() {
    if (scrollRAF.current) {
      cancelAnimationFrame(scrollRAF.current);
      scrollRAF.current = null;
    }
  }

  /* ==================== “edit/save” ==================== */
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

  /* ==================== Desktop DnD (ostavljeno da radi) ==================== */
  function onDragStart(e, id) {
    if (!canReorder) return e.preventDefault();
    setDragId(id);
    const idx = services.findIndex((x) => x.id === id);
    setDragIndex(idx);
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e, id) {
    if (!canReorder) return;
    e.preventDefault();
    // desktop: placeholder ispred reda na koji pređemo
    const idx = services.findIndex((x) => x.id === id);
    if (idx !== -1 && idx !== overIndex) setOverIndex(idx);
  }
  async function onDrop(e, id) {
    if (!canReorder) return;
    e.preventDefault();
    const toIdx = services.findIndex((x) => x.id === id);
    if (dragIndex == null || toIdx === -1) {
      setDragId(null); setDragIndex(null); setOverIndex(null);
      return;
    }
    const newIds = moveToIndex(idsFromList(services), dragIndex, toIdx);
    setDragId(null); setDragIndex(null); setOverIndex(null);
    applyLocalOrderByIds(newIds);
    await persistOrderIds(newIds);
  }
  function onDragEnd() {
    setDragId(null); setDragIndex(null); setOverIndex(null);
  }

  /* ==================== Mobile long-press + floating drag ==================== */
  function allRowEls() {
    return Array.from(document.querySelectorAll(".srv-row"));
  }
  function measureRowById(id) {
    const el = document.querySelector(`.srv-row[data-id="${id}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { el, rect };
  }
  function computeInsertionIndexByY(y) {
    const rows = allRowEls();
    if (!rows.length) return 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (y < mid) return i;           // pre ovog reda
    }
    return rows.length;                // na kraj
  }

  function onTouchStart(e, id) {
    if (!canReorder) return;
    const t = e.touches[0];

    touchRef.current.startX = t.clientX;
    touchRef.current.startY = t.clientY;
    touchRef.current.activeId = id;

    const idx = services.findIndex((x) => x.id === id);
    setDragId(id);
    setDragIndex(idx);

    // izmerimo red da bi floating imao istu širinu/početak,
    // i da bi “grabOffsetY” držao prst na istoj relativnoj visini kartice
    const m = measureRowById(id);
    if (m) {
      setDragX(m.rect.left);
      setDragW(m.rect.width);
      setGrabOffsetY(t.clientY - m.rect.top);
    }

    // vibracija mala
    if (navigator.vibrate) navigator.vibrate(15);

    // nema preventDefault — dozvoljen normalan skrol dok ne prođe long-press
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      setIsLongPress(true);
      setIsTouchDrag(true);
      if (navigator.vibrate) navigator.vibrate(50);
      // inicijalni prikaz placeholder-a
      setOverIndex(computeInsertionIndexByY(t.clientY));
      setDragY(t.clientY);
    }, 300);
  }

  function onTouchMove(e) {
    const t = e.touches[0];
    window._lastTouchY = t.clientY;

    if (!isLongPress) {
      // ako je korisnik krenuo da skroluje pre nego što je long-press “kliknuo”, otkaži drag
      const dx = Math.abs(t.clientX - touchRef.current.startX);
      const dy = Math.abs(t.clientY - touchRef.current.startY);
      if (dx > 12 || dy > 12) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        setDragId(null); setDragIndex(null); setOverIndex(null);
        setIsTouchDrag(false);
      }
      return;
    }

    // DRAG aktivan: pomeraj lebdeću karticu i računaj insertion index
    setDragY(t.clientY);
    const ins = computeInsertionIndexByY(t.clientY);
    if (ins !== overIndex) debouncedSetOverIndex(ins);
    startAutoScrollIfNeeded(t.clientY);
  }

  async function onTouchEnd() {
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    cancelAutoScroll();

    if (!isLongPress) {
      // kratak tap ili skrol — ništa
      setIsTouchDrag(false);
      setDragId(null); setDragIndex(null); setOverIndex(null);
      setDragY(null); setDragX(null); setDragW(null);
      return;
    }

    setIsLongPress(false);
    setIsTouchDrag(false);

    if (dragIndex == null || overIndex == null) {
      setDragId(null); setDragIndex(null); setOverIndex(null);
      setDragY(null); setDragX(null); setDragW(null);
      return;
    }

    const newIds = moveToIndex(idsFromList(services), dragIndex, overIndex);
    setDragId(null); setDragIndex(null); setOverIndex(null);
    setDragY(null); setDragX(null); setDragW(null);

    applyLocalOrderByIds(newIds);
    await persistOrderIds(newIds);
  }

  /* ==================== render ==================== */
  return (
    <div style={wrap}>
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

        {/* LISTA + placeholder + floating clone */}
        <div ref={listRef} className="admincat-list" style={list}>
          {services.map((s, idx) => {
            const isEditing = editing === s.id;
            const currentPrice = isEditing ? Number(price) || 0 : s.basePrice;
            const currentDiscount = isEditing ? Number(discount) || 0 : s.discountPercent || 0;
            const currentFinal = isEditing
              ? Math.max(0, Math.round((Number(price) || 0) * (1 - (Number(discount) || 0) / 100)))
              : s.finalPrice;

            // pre SVAKOG reda, ako je overIndex == idx, prikaži placeholder traku
            const showPlaceholderHere = isLongPress && overIndex === idx;

            return (
              <React.Fragment key={s.id}>
                {showPlaceholderHere && <div className="drop-gap" />}
                <div
                  data-id={s.id}
                  className="admincat-row srv-row"
                  style={{
                    ...row,
                    // sakrij originalni red dok vučemo njega (da ne bude duplikat; lebdeći je klon)
                    visibility: isLongPress && dragId === s.id ? "hidden" : "visible",
                    touchAction: isLongPress && dragId === s.id ? "none" : "pan-y",
                    cursor: canReorder ? "grab" : "default",
                  }}
                  draggable={false} // mobile long-press koristimo; desktop DnD i dalje radi preko mouse drag handlera gore, ali HTML5 drag nije potreban na mobile
                  onTouchStart={(e) => onTouchStart(e, s.id)}
                  onDragStart={(e) => onDragStart(e, s.id)}
                  onDragOver={(e) => onDragOver(e, s.id)}
                  onDrop={(e) => onDrop(e, s.id)}
                  onDragEnd={onDragEnd}
                >
                  <div style={{ userSelect: "none", WebkitUserSelect: "none" }}>
                    <div style={{ fontWeight: 900 }}>{isEditing ? (name || s.name) : s.name}</div>
                    <div style={{ opacity: .8, fontSize: 13 }}>
                      {(isEditing ? Number(durationMin) || 0 : s.durationMin) || 0} min · {currentPrice || 0} RSD{" "}
                      {currentDiscount ? `· popust ${currentDiscount}% → ${currentFinal || 0} RSD` : ""}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, pointerEvents: isLongPress && dragId === s.id ? "none" : "auto" }}>
                    <button className="btn-primary" style={smBtn} onClick={() => startEdit(s)}>Izmeni</button>
                    <button className="btn-danger" style={smDel} onClick={() => removeService(s.id)}>Obriši</button>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          {/* placeholder i na SAMOM KRAJU liste */}
          {isLongPress && overIndex === services.length && <div className="drop-gap" />}

          {/* floating clone koji prati prst */}
          {isLongPress && dragId && dragY != null && dragX != null && (
            <div
              className="floating-card"
              style={{
                position: "fixed",
                left: `${dragX}px`,
                top: `${Math.max(0, (dragY - grabOffsetY))}px`,
                width: `${dragW || 300}px`,
                zIndex: 9999,
                pointerEvents: "none",
                transform: "scale(1.02)",
                boxShadow: "0 18px 36px rgba(0,0,0,.35)",
                border: "2px solid #ff5fa2",
                borderRadius: 14,
                background: "#fff",
              }}
            >
              {(() => {
                const s = services[dragIndex ?? -1];
                if (!s) return null;
                const isEditing = editing === s.id;
                const currentPrice = isEditing ? Number(price) || 0 : s.basePrice;
                const currentDiscount = isEditing ? Number(discount) || 0 : s.discountPercent || 0;
                const currentFinal = isEditing
                  ? Math.max(0, Math.round((Number(price) || 0) * (1 - (Number(discount) || 0) / 100)))
                  : s.finalPrice;
                return (
                  <div style={{ ...row, margin: 0 }}>
                    <div>
                      <div style={{ fontWeight: 900 }}>{isEditing ? (name || s.name) : s.name}</div>
                      <div style={{ opacity: .8, fontSize: 13 }}>
                        {(isEditing ? Number(durationMin) || 0 : s.durationMin) || 0} min · {currentPrice || 0} RSD{" "}
                        {currentDiscount ? `· popust ${currentDiscount}% → ${currentFinal || 0} RSD` : ""}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
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

  /* placeholder traka (između redova) */
  .drop-gap {
    height: 10px;
    border-radius: 8px;
    background: rgba(255,95,162,0.25);
    border: 2px dashed #ff5fa2;
    margin: 2px 4px;
  }

  .srv-row, .srv-row * {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
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
